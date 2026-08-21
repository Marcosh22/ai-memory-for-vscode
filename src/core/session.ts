import * as vscode from 'vscode';
import {
  ApiError,
  clearCache,
  getOverview,
  listProjects,
  type Overview,
  type ProjectScope,
} from './client';
import { probeCli, type CliProbe } from './cli';
import { resolveEndpoint, type ResolvedEndpoint } from './endpoint';
import { log } from './log';
import { describeScope, isKnownProject, resolveScope, type ResolvedScope } from './scope';
import type { Secrets } from './secrets';

/**
 * Estado compartilhado: qual projeto está ativo, qual o estado da conexão e
 * qual o último overview.
 *
 * Existe como módulo próprio porque três superfícies dependem do mesmo dado —
 * status bar, árvore e notificação de handoff. Todas leem o mesmo estado e
 * reagem ao mesmo evento em vez de cada uma resolver escopo e sondar o
 * servidor por conta própria, o que as faria divergir entre si.
 *
 * `GET /overview` devolve handoff + briefing + health numa única round-trip.
 * É literalmente a chamada da home view, e as três superfícies saem dela.
 */

export type ConnectionState =
  | { readonly kind: 'checking' }
  /** Servidor respondeu. `projectKnown` distingue projeto existente de escopo órfão. */
  | { readonly kind: 'connected'; readonly projectKnown: boolean }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'offline'; readonly detail: string }
  | { readonly kind: 'error'; readonly detail: string };

export interface SessionState {
  readonly endpoint: ResolvedEndpoint;
  /** `undefined` quando nenhuma pasta está aberta — a janela de dev abre assim. */
  readonly scope: ResolvedScope | undefined;
  readonly connection: ConnectionState;
  readonly overview: Overview | undefined;
  readonly cli: CliProbe | undefined;
}

const ACTIVE_FOLDER_KEY = 'aiMemory.activeFolder';

export class Session implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<SessionState>();
  readonly onDidChange = this.changeEmitter.event;

  private state: SessionState;
  private refreshToken = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: Secrets,
  ) {
    this.state = {
      endpoint: resolveEndpoint(),
      scope: undefined,
      connection: { kind: 'checking' },
      overview: undefined,
      cli: undefined,
    };
  }

  get current(): SessionState {
    return this.state;
  }

  /** Escopo do projeto ativo, pronto para as chamadas de API. */
  get projectScope(): ProjectScope | undefined {
    const scope = this.state.scope;
    return scope ? { workspace: scope.workspace, project: scope.project } : undefined;
  }

  async clientOptions(): Promise<{ baseUrl: string; token: string | undefined }> {
    return { baseUrl: this.state.endpoint.baseUrl, token: await this.secrets.getToken() };
  }

  get folders(): readonly vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
  }

  get activeFolder(): vscode.WorkspaceFolder | undefined {
    const folders = this.folders;
    if (folders.length === 0) {
      return undefined;
    }
    const stored = this.context.workspaceState.get<string>(ACTIVE_FOLDER_KEY);
    return folders.find((folder) => folder.uri.toString() === stored) ?? folders[0];
  }

  async setActiveFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_FOLDER_KEY, folder.uri.toString());
    await this.refresh('pasta ativa alterada');
  }

  /** Invalida o cache de páginas — servidor ou credencial diferentes. */
  invalidate(): void {
    clearCache();
  }

  /**
   * Re-resolve escopo, sonda o servidor, valida o projeto e busca o overview.
   *
   * Toda a I/O é tolerante a falha: servidor fora do ar deixa a extensão num
   * estado nomeado, nunca numa exceção. Chamadas concorrentes são descartadas
   * pela mais recente.
   */
  async refresh(reason: string): Promise<void> {
    const token = ++this.refreshToken;
    const endpoint = resolveEndpoint();
    log.info(`Session refresh  reason=${reason}  serverUrl=${endpoint.baseUrl} source=${endpoint.source}`);

    const folder = this.activeFolder;
    const scope = folder ? resolveScope(folder.uri.fsPath) : undefined;
    if (scope) {
      log.info(describeScope(scope));
    } else {
      log.info('nenhuma pasta aberta — escopo indefinido');
    }

    this.publish({ ...this.state, endpoint, scope, connection: { kind: 'checking' } });

    const result = await this.probe(endpoint, scope);
    if (token !== this.refreshToken) {
      return; // um refresh mais novo assumiu
    }
    this.publish({ ...this.state, endpoint, scope, ...result });
  }

  /** Detecção do binário. Separada do refresh porque muda raramente. */
  async refreshCli(): Promise<void> {
    const cli = await probeCli();
    this.publish({ ...this.state, cli });
  }

  private async probe(
    endpoint: ResolvedEndpoint,
    scope: ResolvedScope | undefined,
  ): Promise<{ connection: ConnectionState; overview: Overview | undefined }> {
    const authToken = await this.secrets.getToken();
    const options = { baseUrl: endpoint.baseUrl, token: authToken };

    try {
      const projects = await listProjects(options);
      const projectKnown = scope ? isKnownProject(scope, projects) : false;

      if (!scope || !projectKnown) {
        if (scope) {
          // Não é erro de conexão — é escopo órfão, e precisa ser dito. Uma
          // árvore vazia seria indistinguível de um projeto sem páginas.
          log.warn(
            `escopo não encontrado no servidor  workspace=${scope.workspace} project=${scope.project}`,
          );
        }
        return { connection: { kind: 'connected', projectKnown }, overview: undefined };
      }

      const overview = await getOverview(
        { workspace: scope.workspace, project: scope.project },
        options,
      );
      return { connection: { kind: 'connected', projectKnown: true }, overview };
    } catch (error) {
      return { connection: this.toConnectionState(error), overview: undefined };
    }
  }

  private toConnectionState(error: unknown): ConnectionState {
    if (error instanceof ApiError) {
      switch (error.kind) {
        case 'unauthorized':
          return { kind: 'unauthorized' };
        case 'unreachable':
          return { kind: 'offline', detail: error.message };
        default:
          return { kind: 'error', detail: error.message };
      }
    }
    return { kind: 'error', detail: String(error) };
  }

  private publish(next: SessionState): void {
    this.state = next;
    this.changeEmitter.fire(next);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
