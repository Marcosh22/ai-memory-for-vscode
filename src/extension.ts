import * as vscode from 'vscode';
import { log } from './core/log';
import { describeScope } from './core/scope';
import { promptForToken, Secrets } from './core/secrets';
import { Session } from './core/session';
import { AiMemoryServerProvider, PROVIDER_ID } from './mcp/provider';
import { HandoffContentProvider, HANDOFF_SCHEME, maybeNotifyHandoff, showHandoff } from './ui/handoff';
import { openPage, PageContentProvider, SCHEME, WikilinkProvider } from './ui/page';
import { installCopilotRouting } from './ui/routing';
import { showSearch } from './ui/search';
import { showSetup } from './ui/setup';
import { selectFolder, showActions, StatusBar } from './ui/status';
import { startServerFlow } from './ui/startServer';
import { GitHubSyncManager } from './ui/sync';
import { MemoryTreeProvider } from './ui/tree';

/**
 * Ativa em `onStartupFinished`: registrar o provider MCP precisa acontecer na
 * ativação, mas nada aqui pode atrasar a abertura do editor. Toda a I/O de
 * rede é assíncrona, time-boxed e tolerante a falha — servidor fora do ar
 * deixa a extensão num estado nomeado, nunca numa exceção (§10 do plano).
 */
export function activate(context: vscode.ExtensionContext): void {
  log.init(context);

  const secrets = new Secrets(context.secrets);
  const session = new Session(context, secrets);
  const provider = new AiMemoryServerProvider(secrets);
  const statusBar = new StatusBar(session);
  const tree = new MemoryTreeProvider(session);
  const pages = new PageContentProvider(session);
  const handoffs = new HandoffContentProvider(session);
  const githubSync = new GitHubSyncManager(context, session);

  context.subscriptions.push(
    { dispose: () => secrets.dispose() },
    session,
    { dispose: () => provider.dispose() },
    statusBar,
    { dispose: () => tree.dispose() },
    { dispose: () => handoffs.dispose() },
    vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider),
    vscode.window.registerTreeDataProvider('aiMemory.memory', tree),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, pages),
    vscode.workspace.registerTextDocumentContentProvider(HANDOFF_SCHEME, handoffs),
    vscode.languages.registerDocumentLinkProvider({ scheme: SCHEME }, new WikilinkProvider()),
  );
  log.info(`MCP provider registrado  id=${PROVIDER_ID}`);

  // Republica a definição MCP e revalida o estado quando a config ou o token
  // mudam, para o editor reavaliar o servidor sem exigir reload da janela.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('aiMemory.serverUrl')) {
        provider.refresh('serverUrl alterada');
        void session.refresh('serverUrl alterada');
      }
    }),
    secrets.onDidChange(() => {
      provider.refresh('token alterado');
      void session.refresh('token alterado');
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void session.refresh('pastas do workspace alteradas');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiMemory.showLog', () => log.show()),
    vscode.commands.registerCommand('aiMemory.githubSync', () => githubSync.show()),
    vscode.commands.registerCommand('aiMemory.githubSyncConfigure', () => githubSync.configure()),
    vscode.commands.registerCommand('aiMemory.githubSyncPull', () => githubSync.pull()),
    vscode.commands.registerCommand('aiMemory.githubSyncPush', () => githubSync.push()),
    vscode.commands.registerCommand('aiMemory.githubSyncNow', () => githubSync.synchronize()),
    vscode.commands.registerCommand('aiMemory.actions', () => showActions(session)),
    vscode.commands.registerCommand('aiMemory.selectFolder', () => selectFolder(session)),
    vscode.commands.registerCommand('aiMemory.startServer', () => startServerFlow()),
    vscode.commands.registerCommand('aiMemory.search', () => showSearch(session)),
    vscode.commands.registerCommand('aiMemory.setup', () =>
      showSetup(session, context.globalStorageUri.fsPath),
    ),
    vscode.commands.registerCommand('aiMemory.installRouting', () => installCopilotRouting(session)),
    vscode.commands.registerCommand('aiMemory.showHandoff', () => showHandoff()),
    vscode.commands.registerCommand('aiMemory.refresh', async () => {
      session.invalidate();
      await session.refresh('atualização manual');
    }),

    vscode.commands.registerCommand('aiMemory.openPage', async (path?: string) => {
      const scope = session.projectScope;
      if (!scope || typeof path !== 'string') {
        return;
      }
      await openPage(scope, path);
    }),

    vscode.commands.registerCommand('aiMemory.checkConnection', async () => {
      await session.refresh('verificação manual');
      const { connection, endpoint, scope } = session.current;
      const where = scope ? `${scope.workspace}/${scope.project}` : endpoint.baseUrl;

      switch (connection.kind) {
        case 'connected':
          if (scope && !connection.projectKnown) {
            await vscode.commands.executeCommand('aiMemory.explainUnknownProject');
          } else {
            void vscode.window.showInformationMessage(`AI Memory conectado — ${where}.`);
          }
          break;
        case 'unauthorized':
          void vscode.window.showWarningMessage(
            `${endpoint.baseUrl} exige um token de acesso.`,
            'Definir token',
          ).then((choice) => {
            if (choice) {
              void vscode.commands.executeCommand('aiMemory.setToken');
            }
          });
          break;
        case 'offline':
          void vscode.window
            .showWarningMessage(
              `Nenhum servidor ai-memory respondeu em ${endpoint.baseUrl} (${connection.detail}).`,
              'Iniciar servidor',
              'Abrir log',
            )
            .then((choice) => {
              if (choice === 'Iniciar servidor') {
                void startServerFlow();
              } else if (choice === 'Abrir log') {
                log.show();
              }
            });
          break;
        case 'error':
          void vscode.window
            .showErrorMessage(`${endpoint.baseUrl} respondeu com erro (${connection.detail}).`, 'Abrir log')
            .then((choice) => {
              if (choice) {
                log.show();
              }
            });
          break;
        case 'checking':
          break;
      }
    }),

    /**
     * Escopo órfão é a falha silenciosa da §7: a extensão continua
     * funcionando e mostra a memória de um projeto que ninguém está usando.
     * Aqui ela é dita em voz alta, com a proveniência de cada campo — que é
     * o que permite descobrir onde a divergência começou.
     */
    vscode.commands.registerCommand('aiMemory.explainUnknownProject', async () => {
      const { scope, endpoint } = session.current;
      if (!scope) {
        void vscode.window.showInformationMessage('Nenhuma pasta aberta neste workspace.');
        return;
      }

      const origem =
        scope.projectSource === 'marker'
          ? `declarado em ${scope.markerPath}`
          : scope.projectSource === 'repo-root'
            ? 'derivado da raiz do repositório git'
            : 'derivado do nome da pasta';

      const choice = await vscode.window.showWarningMessage(
        `O projeto "${scope.workspace}/${scope.project}" não existe em ${endpoint.baseUrl}.`,
        { modal: true, detail: [
          `Nome do projeto: ${origem}.`,
          '',
          'Isso é esperado se nenhum agente gravou memória para este projeto ainda.',
          '',
          'Se um agente já gravou, o escopo resolvido aqui diverge do que ele usa — compare com um .ai-memory.toml no repositório.',
        ].join('\n') },
        'Abrir log',
      );
      if (choice === 'Abrir log') {
        log.show();
      }
    }),

    vscode.commands.registerCommand('aiMemory.setToken', async () => {
      const token = await promptForToken(session.current.endpoint.baseUrl);
      if (token) {
        await secrets.setToken(token);
        void vscode.window.showInformationMessage('Token do ai-memory salvo.');
      }
    }),

    vscode.commands.registerCommand('aiMemory.clearToken', async () => {
      await secrets.clearToken();
      void vscode.window.showInformationMessage('Token do ai-memory removido.');
    }),
  );

  // Primeira sondagem fora do caminho crítico da ativação. A notificação de
  // handoff só dispara depois que o overview chegou — e ler NUNCA consome a
  // baton, então o próximo agente continua recebendo o contexto.
  void (async () => {
    await session.refresh('ativação');
    await maybeNotifyHandoff(session, context);
    await session.refreshCli();
    const { scope } = session.current;
    if (scope) {
      log.info(describeScope(scope));
    }
  })();
}

export function deactivate(): void {
  // Nada a desfazer: a extensão não é dona de nenhum processo. O daemon
  // ai-memory sobrevive ao fechamento da janela por construção (§5 do plano).
}
