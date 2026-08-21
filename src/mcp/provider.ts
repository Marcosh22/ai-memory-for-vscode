import * as vscode from 'vscode';
import { log } from '../core/log';
import { describeProbe, mcpUrl, probe, resolveEndpoint } from '../core/endpoint';
import { promptForToken, Secrets } from '../core/secrets';
import { offerToStartServer } from '../ui/startServer';

/**
 * Provider MCP — o caminho crítico do projeto (§5 do plano).
 *
 * Publica o servidor ai-memory dinamicamente para o Copilot, sem
 * .vscode/mcp.json, sem commit de config no repo e sem start manual na MCP
 * view.
 *
 * A divisão de responsabilidade entre os dois métodos vem da própria API:
 *
 *   provideMcpServerDefinitions — chamado avidamente pelo editor. A doc é
 *     explícita: "extensions should not take actions which would require user
 *     interaction, such as authentication". Então aqui é barato e mudo:
 *     monta a definição a partir da config e devolve.
 *
 *   resolveMcpServerDefinition — chamado quando o editor precisa iniciar o
 *     servidor. Aqui interação é permitida, e é onde entram o probe de vida e
 *     o prompt de token. Propriedades não-readonly (uri, headers, version)
 *     podem ser modificadas antes de devolver.
 */

export const PROVIDER_ID = 'aiMemory.servers';
const SERVER_LABEL = 'AI Memory';

export class AiMemoryServerProvider
  implements vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition>
{
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this.changeEmitter.event;

  constructor(private readonly secrets: Secrets) {}

  /** Republica a definição — chamado quando a URL ou o token mudam. */
  refresh(reason: string): void {
    log.info(`MCP definitions refresh  reason=${reason}`);
    this.changeEmitter.fire();
  }

  provideMcpServerDefinitions(): vscode.McpHttpServerDefinition[] {
    const { baseUrl, source } = resolveEndpoint();
    const url = mcpUrl(baseUrl);
    log.info(`MCP provider offering server  url=${url}  source=${source}`);
    return [new vscode.McpHttpServerDefinition(SERVER_LABEL, vscode.Uri.parse(url))];
  }

  async resolveMcpServerDefinition(
    server: vscode.McpHttpServerDefinition,
  ): Promise<vscode.McpHttpServerDefinition | undefined> {
    const { baseUrl } = resolveEndpoint();
    log.info(`MCP server resolve started  url=${server.uri.toString()}`);

    let token = await this.secrets.getToken();
    let result = await probe(baseUrl, token);

    if (result.kind === 'unauthorized') {
      log.info('MCP authentication required');
      const entered = await promptForToken(baseUrl);
      if (!entered) {
        log.warn('MCP server resolve aborted — token não fornecido');
        return undefined;
      }
      await this.secrets.setToken(entered);
      token = entered;
      result = await probe(baseUrl, token);
    }

    if (result.kind !== 'ok') {
      const message = describeProbe(result, baseUrl);
      log.error(`MCP connection failed  ${result.kind}`);
      void offerToStartServer(message);
      // Erro em vez de undefined: a doc diz que o editor cancela a tool call
      // pendente e devolve esta mensagem ao modelo. Vale ser específico.
      throw new Error(`ai-memory indisponível. ${message}`);
    }

    if (token) {
      server.headers = { ...server.headers, Authorization: `Bearer ${token}` };
    }

    log.info('MCP server resolved');
    return server;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
