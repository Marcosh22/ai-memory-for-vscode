import * as vscode from 'vscode';
import { logger } from './logger';
import { DEFAULT_SERVER_URL as DEFAULT_URL, normalizeBaseUrl } from './urls';

/**
 * Resolução de endpoint e probe de vida (§3 e §5 do plano).
 *
 * Não existe endpoint /health no ai-memory. O probe é GET /api/v1/workspaces,
 * que é read-only e barato.
 */

export { DEFAULT_SERVER_URL, mcpUrl } from './urls';

export type UrlSource = 'extension-setting' | 'env' | 'default';

export interface ResolvedEndpoint {
  /** URL base já normalizada, sem barra final. Pode incluir um --base-path. */
  readonly baseUrl: string;
  readonly source: UrlSource;
}

/**
 * Precedência: setting da extensão, depois AI_MEMORY_SERVER_URL, depois o
 * default de loopback.
 *
 * Lacuna conhecida do spike: o CLI também lê `config.toml` do data dir, entre
 * o env e o default. Entra no passo 2 junto com o resto de core/ — está aqui
 * como comentário para não virar divergência silenciosa.
 */
export function resolveEndpoint(): ResolvedEndpoint {
  const setting = vscode.workspace
    .getConfiguration('aiMemory')
    .get<string>('serverUrl', '')
    .trim();
  if (setting) {
    return { baseUrl: normalize(setting), source: 'extension-setting' };
  }

  const fromEnv = process.env.AI_MEMORY_SERVER_URL?.trim();
  if (fromEnv) {
    return { baseUrl: normalize(fromEnv), source: 'env' };
  }

  return { baseUrl: DEFAULT_URL, source: 'default' };
}

const normalize = normalizeBaseUrl;

export type ProbeResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unreachable'; readonly detail: string }
  | { readonly kind: 'http-error'; readonly status: number };

/**
 * GET /api/v1/workspaces. Toda I/O é time-boxed: servidor fora do ar não pode
 * atrasar a ativação do editor (§10 do plano).
 */
export async function probe(
  baseUrl: string,
  token: string | undefined,
  timeoutMs = 3000,
): Promise<ProbeResult> {
  const path = '/api/v1/workspaces';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  logger.info(`Server probe started  url=${baseUrl}  auth=${token ? 'bearer' : 'none'}`);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    logger.info(`GET ${path} -> ${response.status}`);

    if (response.ok) {
      logger.info('Server probe succeeded');
      return { kind: 'ok' };
    }
    if (response.status === 401) {
      return { kind: 'unauthorized' };
    }
    if (response.status === 403) {
      return { kind: 'forbidden' };
    }
    return { kind: 'http-error', status: response.status };
  } catch (error) {
    const detail = describeNetworkError(error);
    logger.warn(`Server probe failed  ${detail}`);
    return { kind: 'unreachable', detail };
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'timeout';
  }
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? error.message;
  }
  return String(error);
}

/** Mensagem de uma linha para UI. Nunca inclui corpo de resposta. */
export function describeProbe(result: ProbeResult, baseUrl: string): string {
  switch (result.kind) {
    case 'ok':
      return `Conectado a ${baseUrl}.`;
    case 'unauthorized':
      return `${baseUrl} exige um token de acesso.`;
    case 'forbidden':
      return `${baseUrl} recusou a requisição — host fora da allowlist do servidor.`;
    case 'unreachable':
      return `Nenhum servidor ai-memory respondeu em ${baseUrl} (${result.detail}).`;
    case 'http-error':
      return `${baseUrl} respondeu ${result.status}.`;
  }
}
