import * as vscode from 'vscode';
import type { Session, SessionState } from '../core/session';

/**
 * Item permanente na status bar — projeto ativo e estado da conexão.
 *
 * O princípio é o do §8 do plano aplicado à UI: cada estado tem nome próprio
 * e uma ação óbvia. Nada de "erro ao conectar". A cor de fundo só é usada nos
 * estados que pedem ação, para que a barra não vire ruído permanente.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(session: Session) {
    this.item = vscode.window.createStatusBarItem('aiMemory.status', vscode.StatusBarAlignment.Left, 40);
    this.item.name = 'AI Memory';
    this.item.command = 'aiMemory.actions';
    this.render(session.current);
    this.subscription = session.onDidChange((state) => this.render(state));
    this.item.show();
  }

  private render(state: SessionState): void {
    const { scope, connection, endpoint } = state;
    const warn = new vscode.ThemeColor('statusBarItem.warningBackground');
    const err = new vscode.ThemeColor('statusBarItem.errorBackground');

    const lines: string[] = [`**AI Memory**`, '', `Servidor: \`${endpoint.baseUrl}\` (${endpoint.source})`];

    if (scope) {
      lines.push(`Workspace: \`${scope.workspace}\` (${scope.workspaceSource})`);
      lines.push(`Projeto: \`${scope.project}\` (${scope.projectSource})`);
      if (scope.markerPath) {
        lines.push(`Marker: \`${scope.markerPath}\``);
      }
    } else {
      lines.push('Nenhuma pasta aberta.');
    }

    if (state.cli) {
      lines.push(
        state.cli.available
          ? `CLI: disponível${state.cli.version ? ` (${state.cli.version})` : ''}`
          : `CLI: ${state.cli.reason} — opcional nas fatias 1 e 2`,
      );
    }

    const label = scope?.project ?? 'AI Memory';

    switch (connection.kind) {
      case 'checking':
        this.item.text = `$(loading~spin) ${label}`;
        this.item.backgroundColor = undefined;
        lines.push('', 'Verificando conexão…');
        break;

      case 'connected':
        if (scope && !connection.projectKnown) {
          this.item.text = `$(warning) ${label}`;
          this.item.backgroundColor = warn;
          lines.push(
            '',
            'Conectado, mas este projeto não existe no servidor.',
            '',
            'Nenhuma memória foi gravada para ele ainda — ou o escopo resolvido diverge do que o agente usa.',
          );
        } else {
          this.item.text = `$(database) ${label}`;
          this.item.backgroundColor = undefined;
          lines.push('', 'Conectado.');
        }
        break;

      case 'unauthorized':
        this.item.text = `$(key) ${label}`;
        this.item.backgroundColor = warn;
        lines.push('', 'O servidor exige um token de acesso.');
        break;

      case 'offline':
        this.item.text = `$(debug-disconnect) ${label}`;
        this.item.backgroundColor = warn;
        lines.push('', `Servidor não respondeu (${connection.detail}).`);
        break;

      case 'error':
        this.item.text = `$(error) ${label}`;
        this.item.backgroundColor = err;
        lines.push('', `O servidor respondeu com erro (${connection.detail}).`);
        break;
    }

    const tooltip = new vscode.MarkdownString(lines.join('\n\n'));
    tooltip.isTrusted = false;
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}

/**
 * Menu de ações do clique. As opções mudam com o estado: oferecer "definir
 * token" quando o servidor nem responde só empurra o usuário para o caminho
 * errado.
 */
export async function showActions(session: Session): Promise<void> {
  const state = session.current;
  const items: Array<vscode.QuickPickItem & { command: string }> = [];

  if (state.connection.kind === 'unauthorized') {
    items.push({
      label: '$(key) Definir token de acesso',
      description: 'o servidor exige autenticação',
      command: 'aiMemory.setToken',
    });
  }

  if (state.connection.kind === 'offline') {
    items.push({
      label: '$(play) Iniciar servidor',
      description: 'preenche o comando num terminal',
      command: 'aiMemory.startServer',
    });
  }

  if (state.connection.kind === 'connected' && state.scope && !state.connection.projectKnown) {
    items.push({
      label: '$(question) Por que este projeto não foi encontrado?',
      description: `${state.scope.workspace}/${state.scope.project}`,
      command: 'aiMemory.explainUnknownProject',
    });
  }

  if (session.folders.length > 1) {
    items.push({
      label: '$(folder) Trocar projeto ativo',
      description: `${session.folders.length} pastas no workspace`,
      command: 'aiMemory.selectFolder',
    });
  }

  items.push(
    {
      label: '$(cloud) GitHub Sync',
      description: 'pull e push manuais da memória',
      command: 'aiMemory.githubSync',
    },
    {
      label: '$(compass) Instalar roteamento no Copilot',
      description: 'para o agente escolher o ai-memory, não a memória embutida',
      command: 'aiMemory.installRouting',
    },
    { label: '$(refresh) Verificar conexão', description: '', command: 'aiMemory.checkConnection' },
    { label: '$(output) Abrir log', description: '', command: 'aiMemory.showLog' },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: 'AI Memory',
    placeHolder: state.scope ? `${state.scope.workspace}/${state.scope.project}` : 'nenhuma pasta aberta',
  });
  if (picked) {
    await vscode.commands.executeCommand(picked.command);
  }
}

/** Seletor de pasta ativa para workspace multi-root. */
export async function selectFolder(session: Session): Promise<void> {
  const folders = session.folders;
  if (folders.length === 0) {
    void vscode.window.showInformationMessage('Nenhuma pasta aberta neste workspace.');
    return;
  }

  const active = session.activeFolder;
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath === active?.uri.fsPath ? 'ativa' : '',
      detail: folder.uri.fsPath,
      folder,
    })),
    { title: 'Projeto ativo do AI Memory', placeHolder: 'Escolha a pasta' },
  );

  if (picked) {
    await session.setActiveFolder(picked.folder);
  }
}
