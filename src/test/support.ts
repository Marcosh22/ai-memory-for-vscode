import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import { DEFAULT_SERVER_URL, apiUrl } from '../core/urls';

/**
 * Apoio para os testes que falam com um servidor ai-memory de verdade.
 *
 * A escolha por testes de integração aqui é deliberada: o risco inteiro
 * deste projeto é divergência de contrato com o ai-memory — o
 * `docs/frontend-api.md` do upstream já estava errado sobre a forma das
 * respostas. Um teste com `fetch` mockado verificaria o mock, não o contrato.
 *
 * Sem servidor no ar, os testes se marcam como pulados em vez de falhar:
 * quebrar a suíte porque o Docker está parado seria ruído, não sinal.
 */

export const SERVER_URL = process.env['AI_MEMORY_SERVER_URL']?.trim() || DEFAULT_SERVER_URL;

export interface LiveContext {
  readonly baseUrl: string;
  readonly token: string | undefined;
}

let available = false;
let token: string | undefined;

/** Lê o token do arquivo que o README documenta. Ausência é aceitável. */
function readToken(): string | undefined {
  const candidate = path.join(process.cwd(), '.ai-memory-token');
  try {
    const value = fs.readFileSync(candidate, 'utf8').trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Chamar de um `before()`. Decide se a suíte roda. */
export async function detectServer(): Promise<void> {
  token = readToken();
  try {
    const response = await fetch(apiUrl(SERVER_URL, '/workspaces'), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    available = response.ok;
  } catch {
    available = false;
  }
}

/**
 * Devolve o contexto vivo, ou marca o teste como pulado e devolve
 * `undefined`. O chamador retorna cedo.
 */
export function live(t: TestContext): LiveContext | undefined {
  if (!available) {
    t.skip(`servidor ai-memory indisponível em ${SERVER_URL}`);
    return undefined;
  }
  return { baseUrl: SERVER_URL, token };
}

export function isAvailable(): boolean {
  return available;
}

// ---------------------------------------------------------------------------
// MCP sobre HTTP
// ---------------------------------------------------------------------------

export interface JsonRpcResult {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
}

/**
 * Uma chamada JSON-RPC ao endpoint MCP. O transporte roda `stateful=false`,
 * então cada requisição é uma sessão própria — não há handshake a preservar
 * entre chamadas.
 */
export async function mcpCall(
  ctx: LiveContext,
  method: string,
  params: Record<string, unknown>,
  id = 1,
): Promise<JsonRpcResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (ctx.token) {
    headers['Authorization'] = `Bearer ${ctx.token}`;
  }

  const response = await fetch(`${ctx.baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`MCP ${method} -> HTTP ${response.status}`);
  }
  return (await response.json()) as JsonRpcResult;
}

/** Extrai o payload de texto de um `tools/call`, que vem como JSON aninhado. */
export function toolPayload(result: JsonRpcResult): unknown {
  const content = (result.result?.['content'] ?? []) as Array<{ type: string; text?: string }>;
  const text = content.find((part) => part.type === 'text')?.text;
  return text === undefined ? undefined : JSON.parse(text);
}
