import * as os from 'node:os';
import * as vscode from 'vscode';
import { log } from '../core/log';
import type { Session } from '../core/session';
import {
  detectCodexHooks,
  detectCodexHooksAuth,
  detectCodexMcp,
  detectCodexRouting,
  detectClaudeHooks,
  detectClaudeHooksAuth,
  countClaudeHooks,
  deduplicateClaudeHooks,
  detectClaudeMcp,
  detectCopilotRouting,
  downloadWrapper,
  resolveCli,
  runCli,
  type CommandSpec,
} from '../core/setup';
import { installCopilotRouting } from './routing';
import { startServerFlow } from './startServer';
import { configurePortableProject, portableConfigReady } from './continuity';

/**
 * Onboarding num comando só.
 *
 * O que isto resolve: sem captura, a memória fica vazia para sempre e todas
 * as superfícies de leitura mostram nada. Ligar a captura eram quatro passos
 * de terminal — download de wrapper, PATH, `install-hooks`, `install-mcp` —
 * o que contradiz a tese da §2 de que a extensão existe para resolver
 * configuração.
 *
 * Nada roda sozinho. Cada ação mexe em config global (`~/.claude/`) ou no
 * repositório, então é sempre disparada por escolha explícita.
 */

type StepState = 'ok' | 'missing' | 'blocked' | 'warning';

interface Step {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly state: StepState;
  readonly run?: (() => Promise<void>) | undefined;
}

export async function showSetup(session: Session, storageDir: string): Promise<void> {
  const steps = await inspect(session, storageDir);
  const pending = steps.filter((step) => step.state !== 'ok' && step.run);

  const items: Array<vscode.QuickPickItem & { step?: Step; all?: boolean }> = [];

  if (pending.length > 1) {
    items.push({
      label: `$(rocket) Configurar tudo que falta`,
      detail: `${pending.length} itens: ${pending.map((step) => step.label).join(', ')}`,
      all: true,
    });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  }

  for (const step of steps) {
    items.push({
      label: `${icon(step.state)} ${step.label}`,
      ...(step.state === 'ok' ? { description: 'pronto' } : {}),
      detail: step.detail,
      step,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Configurar AI Memory',
    placeHolder:
      pending.length === 0 ? 'Tudo configurado' : `${pending.length} item(ns) pendente(s)`,
  });

  if (!picked) {
    return;
  }

  if (picked.all) {
    await runAll(pending);
  } else if (picked.step?.run) {
    await picked.step.run();
  } else if (picked.step) {
    void vscode.window.showInformationMessage(`${picked.step.label}: ${picked.step.detail}`);
    return;
  }

  await session.refresh('setup concluído');
}

async function runAll(pending: readonly Step[]): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Configurando AI Memory' },
    async (progress) => {
      for (const step of pending) {
        progress.report({ message: step.label });
        await step.run?.();
      }
    },
  );
}

function icon(state: StepState): string {
  switch (state) {
    case 'ok':
      return '$(pass-filled)';
    case 'warning':
      return '$(warning)';
    case 'blocked':
      return '$(circle-slash)';
    case 'missing':
      return '$(circle-large-outline)';
  }
}

// ---------------------------------------------------------------------------
// inspeção
// ---------------------------------------------------------------------------

async function inspect(session: Session, storageDir: string): Promise<Step[]> {
  const home = os.homedir();
  const state = session.current;
  const token = (await session.clientOptions()).token;
  const cli = await resolveCli(storageDir);
  const folder = session.activeFolder;

  const withCli = (action: (resolved: CommandSpec) => Promise<void>) => async (): Promise<void> => {
    let resolved = await resolveCli(storageDir);
    if (!resolved) {
      try {
        await downloadWrapper(storageDir);
        resolved = await resolveCli(storageDir);
      } catch (error) {
        showFailure('Não foi possível baixar o CLI', error);
        return;
      }
    }
    if (!resolved) {
      showFailure('O CLI foi baixado, mas não pôde ser executado', 'Verifique o log da extensão.');
      return;
    }
    await action(resolved);
  };

  const steps: Step[] = [];

  // 1. servidor
  const serverOk = state.connection.kind === 'connected';
  steps.push({
    id: 'server',
    label: 'Servidor ai-memory',
    detail: serverOk
      ? `respondendo em ${state.endpoint.baseUrl}`
      : `nada respondendo em ${state.endpoint.baseUrl}`,
    state: serverOk ? 'ok' : 'missing',
    run: serverOk ? undefined : async () => startServerFlow(),
  });

  const portableReady = await portableConfigReady(session);
  steps.push({
    id: 'portable-project',
    label: 'Projeto · continuidade',
    detail: !folder
      ? 'abra uma pasta para fixar identidade e briefing'
      : portableReady
        ? 'identidade, briefing e branch por projeto configurados'
        : 'fixa workspace/project e injeta regras no início de cada sessão',
    state: !folder ? 'blocked' : portableReady ? 'ok' : 'missing',
    run: folder && !portableReady
      ? async () => configurePortableProject(session, storageDir)
      : undefined,
  });

  // 2. CLI — necessário para configurar os agentes externos
  steps.push({
    id: 'cli',
    label: 'CLI do ai-memory',
    detail: cli
      ? cli.source === 'path'
        ? 'encontrado no PATH'
        : 'cópia gerenciada pela extensão'
      : 'necessário para configurar Claude Code e Codex — baixa o wrapper oficial, sem alterar seu PATH',
    state: cli ? 'ok' : 'missing',
    run: cli
      ? undefined
      : async () => {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Baixando o CLI do ai-memory' },
            async () => {
              try {
                await downloadWrapper(storageDir);
                void vscode.window.showInformationMessage('CLI do ai-memory instalado.');
              } catch (error) {
                showFailure('Não foi possível baixar o CLI', error);
              }
            },
          );
        },
  });

  // 3. captura do Claude Code — o passo que faz a memória existir
  const hooksOk = detectClaudeHooks(home);
  const hooksAuthOk = !token || !hooksOk || detectClaudeHooksAuth(home, token);
  const claudeHookCount = countClaudeHooks(home);
  const claudeHooksDuplicated = claudeHookCount > 9;
  steps.push({
    id: 'claude-hooks',
    label: 'Claude Code · captura',
    detail: !hooksOk
      ? 'Stop captura ao fim de cada resposta; SessionEnd grava o handoff ao encerrar a sessão'
      : claudeHooksDuplicated
        ? `${claudeHookCount} grupos do ai-memory instalados; o esperado é 9 — cada evento está sendo capturado mais de uma vez`
      : hooksAuthOk
        ? 'hooks instalados'
        : 'hooks instalados MAS sem token: cada evento toma 401 e a captura falha em silêncio',
    state: hooksOk ? (hooksAuthOk && !claudeHooksDuplicated ? 'ok' : 'warning') : 'missing',
    run:
      hooksOk && hooksAuthOk && !claudeHooksDuplicated
        ? undefined
        : claudeHooksDuplicated
          ? async () => {
              const confirmed = await vscode.window.showWarningMessage(
                `Remover grupos duplicados do ai-memory em ~/.claude/settings.json? Um backup será criado antes da alteração.`,
                { modal: true },
                'Reparar',
              );
              if (confirmed !== 'Reparar') {
                return;
              }
              const backup = deduplicateClaudeHooks(home);
              if (backup) {
                void vscode.window.showInformationMessage(`Hooks reparados. Backup: ${backup}`);
              }
            }
        : withCli((resolved) => installClaude(resolved, 'hooks', session, home)),
  });

  // 4. leitura do Claude Code — MCP próprio, separado do nosso provider
  const mcpOk = detectClaudeMcp(home);
  steps.push({
    id: 'claude-mcp',
    label: 'Claude Code · leitura',
    detail: mcpOk
      ? 'MCP registrado'
      : 'o Claude Code tem config MCP própria — nosso provider do VS Code serve só o Copilot',
    state: mcpOk ? 'ok' : 'missing',
    run: mcpOk
      ? undefined
      : withCli((resolved) => installClaude(resolved, 'mcp', session, home)),
  });

  // 5. captura do Codex
  const codexHooksOk = detectCodexHooks(home);
  const codexHooksAuthOk = !token || !codexHooksOk || detectCodexHooksAuth(home, token);
  steps.push({
    id: 'codex-hooks',
    label: 'Codex · captura',
    detail: !codexHooksOk
      ? 'Stop captura respostas; use Encerrar trabalho e sincronizar para garantir o handoff final'
      : codexHooksAuthOk
        ? 'hooks instalados; o Codex pedirá para confiar neles na primeira sessão'
        : 'hooks instalados MAS sem token: a captura receberia 401',
    state: codexHooksOk ? (codexHooksAuthOk ? 'ok' : 'warning') : 'missing',
    run:
      codexHooksOk && codexHooksAuthOk
        ? undefined
        : withCli((resolved) => installCodex(resolved, 'hooks', session, home)),
  });

  // 6. leitura do Codex — compartilhada pelo CLI e pela extensão IDE
  const codexMcpOk = detectCodexMcp(home);
  steps.push({
    id: 'codex-mcp',
    label: 'Codex · leitura',
    detail: codexMcpOk
      ? 'MCP registrado no config.toml compartilhado pelo CLI e pela extensão IDE'
      : 'permite ao Codex consultar e escrever na mesma memória usada pelo Claude Code',
    state: codexMcpOk ? 'ok' : 'missing',
    run: codexMcpOk
      ? undefined
      : withCli((resolved) => installCodex(resolved, 'mcp', session, home)),
  });

  // 7. roteamento do Codex no projeto
  const codexRoutingOk = folder ? detectCodexRouting(folder.uri.fsPath) : false;
  steps.push({
    id: 'codex-routing',
    label: 'Codex · roteamento',
    detail: !folder
      ? 'abra uma pasta — o bloco é gravado em AGENTS.md'
      : codexRoutingOk
        ? 'bloco instalado em AGENTS.md'
        : 'orienta o Codex a consultar a memória no início e registrar decisões importantes',
    state: !folder ? 'blocked' : codexRoutingOk ? 'ok' : 'missing',
    run: folder && !codexRoutingOk
      ? withCli((resolved) =>
          installCodex(resolved, 'routing', session, home, folder.uri.fsPath),
        )
      : undefined,
  });

  // 8. roteamento do Copilot
  const routingOk = folder ? detectCopilotRouting(folder.uri.fsPath) : false;
  steps.push({
    id: 'routing',
    label: 'Copilot · roteamento',
    detail: !folder
      ? 'abra uma pasta — o bloco é gravado no repositório'
      : routingOk
        ? 'bloco instalado em .github/copilot-instructions.md'
        : 'sem isto o Copilot tende a usar a memória embutida dele em vez do ai-memory',
    state: !folder ? 'blocked' : routingOk ? 'ok' : 'missing',
    run: folder ? async () => installCopilotRouting(session) : undefined,
  });

  return steps;
}

// ---------------------------------------------------------------------------
// ações do Claude Code
// ---------------------------------------------------------------------------

async function installClaude(
  cli: CommandSpec,
  what: 'hooks' | 'mcp',
  session: Session,
  home: string,
): Promise<void> {
  const { baseUrl, token } = await session.clientOptions();

  // O QuickPick mantém closures da inspeção inicial. Se outro passo do fluxo
  // já instalou os hooks, não os acrescente novamente com estado obsoleto.
  if (what === 'hooks' && detectClaudeHooks(home) && (!token || detectClaudeHooksAuth(home, token))) {
    void vscode.window.showInformationMessage('Os hooks do Claude Code já estão instalados.');
    return;
  }

  const target = what === 'hooks' ? '~/.claude/settings.json' : '~/.claude.json';
  const confirmed = await vscode.window.showInformationMessage(
    what === 'hooks'
      ? 'Instalar os hooks de captura do Claude Code?'
      : 'Registrar o ai-memory no MCP do Claude Code?',
    {
      modal: true,
      detail: [
        `Executa o CLI oficial do ai-memory, que grava em ${target}.`,
        '',
        what === 'hooks'
          ? 'A partir daí toda sessão do Claude Code grava memória sozinha: prompts, tool calls e um handoff ao terminar.'
          : 'A partir daí o Claude Code passa a ler a memória. Isso é separado do provider MCP do VS Code, que serve apenas o Copilot.',
      ].join('\n'),
    },
    'Instalar',
  );
  if (confirmed !== 'Instalar') {
    return;
  }

  const args =
    what === 'hooks'
      ? ['install-hooks', '--agent', 'claude-code', '--apply']
      : ['install-mcp', '--client', 'claude-code', '--apply'];

  const run = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `ai-memory ${args[0]}` },
    async () => runCli(cli, args, { token, serverUrl: baseUrl }),
  );

  if (!run.ok) {
    showFailure(`Falha em ${args[0]}`, run.stderr);
    return;
  }

  // Pós-condição: confiar no exit code aqui esconderia exatamente o modo de
  // falha que mais custa — instalado mas sem credencial.
  if (what === 'hooks') {
    if (!detectClaudeHooks(home)) {
      showFailure('install-hooks terminou sem erro, mas nenhum hook do ai-memory apareceu', run.stdout);
      return;
    }
    if (token && !detectClaudeHooksAuth(home, token)) {
      const LOG = 'Abrir log';
      const choice = await vscode.window.showWarningMessage(
        'Hooks instalados, mas sem o token embutido: seu servidor exige autenticação, então a captura tomaria 401 em silêncio.',
        LOG,
      );
      if (choice === LOG) {
        log.show();
      }
      return;
    }
    void vscode.window.showInformationMessage(
      'Captura ligada. A partir da próxima sessão o Claude Code grava memória sozinho.',
    );
    return;
  }

  if (!detectClaudeMcp(home)) {
    showFailure('install-mcp terminou sem erro, mas nenhuma entrada do ai-memory apareceu', run.stdout);
    return;
  }
  void vscode.window.showInformationMessage('Claude Code registrado — reinicie a sessão dele para valer.');
}

// ---------------------------------------------------------------------------
// ações do Codex
// ---------------------------------------------------------------------------

async function installCodex(
  cli: CommandSpec,
  what: 'hooks' | 'mcp' | 'routing',
  session: Session,
  home: string,
  folderPath?: string,
): Promise<void> {
  const { baseUrl, token } = await session.clientOptions();
  const descriptions = {
    hooks: {
      title: 'Instalar os hooks de captura do Codex?',
      target: '~/.codex/hooks.json',
      effect: 'Stop captura respostas; a extensão finaliza explicitamente a sessão antes de sincronizar.',
    },
    mcp: {
      title: 'Registrar o ai-memory no MCP do Codex?',
      target: '~/.codex/config.toml',
      effect: 'Codex CLI e extensão IDE passarão a ler e escrever na mesma memória.',
    },
    routing: {
      title: 'Instalar as instruções de uso da memória para o Codex?',
      target: 'AGENTS.md deste projeto',
      effect: 'Somente o bloco delimitado do ai-memory será criado ou atualizado.',
    },
  } as const;
  const description = descriptions[what];

  const confirmed = await vscode.window.showInformationMessage(
    description.title,
    {
      modal: true,
      detail: [
        `Executa o CLI oficial do ai-memory e atualiza ${description.target}.`,
        '',
        description.effect,
      ].join('\n'),
    },
    'Instalar',
  );
  if (confirmed !== 'Instalar') {
    return;
  }

  const args =
    what === 'hooks'
      ? ['install-hooks', '--agent', 'codex', '--apply']
      : what === 'mcp'
        ? ['install-mcp', '--client', 'codex', '--apply']
        : ['install-instructions', '--target', 'AGENTS.md', '--no-skills'];

  const run = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `ai-memory ${args[0]}` },
    async () => runCli(cli, args, { token, serverUrl: baseUrl, cwd: folderPath }),
  );

  if (!run.ok) {
    showFailure(`Falha em ${args[0]}`, run.stderr);
    return;
  }

  if (what === 'hooks') {
    if (!detectCodexHooks(home)) {
      showFailure('install-hooks terminou sem erro, mas nenhum hook do ai-memory apareceu', run.stdout);
      return;
    }
    if (token && !detectCodexHooksAuth(home, token)) {
      showFailure('Hooks do Codex instalados, mas sem o token necessário', run.stdout);
      return;
    }
    void vscode.window.showInformationMessage(
      'Captura do Codex ligada. Na próxima sessão, use /hooks para revisar e confiar nos hooks.',
    );
    return;
  }

  if (what === 'mcp') {
    if (!detectCodexMcp(home)) {
      showFailure('install-mcp terminou sem erro, mas nenhuma entrada do ai-memory apareceu', run.stdout);
      return;
    }
    void vscode.window.showInformationMessage(
      'Codex registrado — reinicie a sessão ou a extensão Codex para carregar o MCP.',
    );
    return;
  }

  if (!folderPath || !detectCodexRouting(folderPath)) {
    showFailure('install-instructions terminou sem erro, mas o bloco não apareceu em AGENTS.md', run.stdout);
    return;
  }
  void vscode.window.showInformationMessage('Instruções do Codex atualizadas em AGENTS.md.');
}

function showFailure(title: string, detail: unknown): void {
  const text = typeof detail === 'string' ? detail : String(detail);
  log.error(`${title}: ${text.slice(0, 800)}`);
  const LOG = 'Abrir log';
  void vscode.window.showErrorMessage(`${title}.`, LOG).then((choice) => {
    if (choice === LOG) {
      log.show();
    }
  });
}
