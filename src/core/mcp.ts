import { ApiError, type ClientOptions } from './client';
import { logger } from './logger';
import { mcpUrl } from './urls';

/**
 * Cliente MCP mínimo sobre HTTP.
 *
 * A extensão publica o servidor MCP para o Copilot, mas também precisa
 * chamá-lo por conta própria em um caso: `memory_install_self_routing`, que é
 * a fonte única do bloco de roteamento e só existe como tool MCP — não tem
 * equivalente em `/api/v1`.
 *
 * O transporte roda `stateful=false`, então cada requisição é uma sessão
 * própria: não há handshake a preservar entre chamadas, e uma única POST
 * resolve.
 */

interface JsonRpcResponse {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * Chama uma tool e devolve o payload já desembrulhado. O resultado do MCP vem
 * como `content: [{type: 'text', text: '<json>'}]` — JSON dentro de string.
 */
export async function callTool<T>(
  name: string,
  args: Record<string, unknown>,
  options: ClientOptions,
): Promise<T> {
  const url = mcpUrl(options.baseUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`MCP ${name} -> falhou (${detail})`);
    throw new ApiError('unreachable', detail);
  }

  logger.info(`MCP ${name} -> ${response.status}`);

  if (!response.ok) {
    if (response.status === 401) {
      throw new ApiError('unauthorized', 'HTTP 401', 401);
    }
    throw new ApiError('http-error', `HTTP ${response.status}`, response.status);
  }

  const body = (await response.json()) as JsonRpcResponse;
  if (body.error) {
    throw new ApiError('http-error', body.error.message ?? 'erro do MCP');
  }

  if (body.result?.['isError'] === true) {
    throw new ApiError('http-error', `a tool ${name} devolveu erro`);
  }

  const content = (body.result?.['content'] ?? []) as Array<{ type: string; text?: string }>;
  const text = content.find((part) => part.type === 'text')?.text;
  if (text === undefined) {
    throw new ApiError('http-error', `a tool ${name} não devolveu conteúdo de texto`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('http-error', `a tool ${name} devolveu texto que não é JSON`);
  }
}

/** Payload de `memory_install_self_routing`, na parte que usamos. */
export interface SelfRoutingPackage {
  readonly markered_block: string;
  readonly marker_start: string;
  readonly marker_end: string;
}

/**
 * Busca o bloco canônico do servidor.
 *
 * Deliberadamente NÃO embutimos o texto na extensão: ele é a fonte única do
 * upstream, tem quase 5 mil caracteres e evolui. Uma cópia divergiria na
 * primeira atualização do ai-memory, e o sintoma seria roteamento pior sem
 * nenhum erro visível.
 */
export async function fetchRoutingBlock(options: ClientOptions): Promise<string> {
  const pkg = await callTool<SelfRoutingPackage>('memory_install_self_routing', {}, options);
  if (typeof pkg.markered_block !== 'string' || pkg.markered_block.length === 0) {
    throw new ApiError('http-error', 'o servidor não devolveu markered_block');
  }
  return pkg.markered_block;
}

/** Metadados que a tool pública de escrita consegue restaurar sem tocar o disco do servidor. */
export interface WritePageInput {
  readonly workspace: string;
  readonly project: string;
  readonly path: string;
  readonly title?: string | undefined;
  readonly body: string;
  readonly tier?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly pinned?: boolean | undefined;
  readonly expiresAt?: string | undefined;
}

/**
 * Reimporta uma página pelo mesmo limite de escrita usado pelos agentes.
 * Isso preserva sanitização, auditoria, checkpoints e reindexação do upstream.
 */
export async function writePage(
  input: WritePageInput,
  options: ClientOptions,
): Promise<unknown> {
  const args: Record<string, unknown> = {
    workspace: input.workspace,
    project: input.project,
    path: input.path,
    body: input.body,
    pinned: input.pinned ?? false,
  };
  // Aqui o JSON é serializado por código, portanto não existe o risco de
  // escape que faz o upstream recomendar omitir title em chamadas por LLM.
  if (input.title) {
    args['title'] = input.title;
  }
  if (input.tier) {
    args['tier'] = input.tier;
  }
  if (input.tags && input.tags.length > 0) {
    args['tags'] = [...input.tags];
  }
  if (input.expiresAt) {
    args['expires_at'] = input.expiresAt;
  }
  return callTool('memory_write_page', args, options);
}
