/**
 * Construção de URL — puro, sem `vscode`, para que o teste integrado
 * verifique a URL de produção em vez de uma cópia dela.
 */

/** Loopback na porta padrão do ai-memory. */
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:49374';

/** Remove barras finais. A URL configurada pode incluir um `--base-path`. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Endpoint MCP publicado ao Copilot via `McpHttpServerDefinition`. */
export function mcpUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/mcp`;
}

/** Endpoint de leitura da API. */
export function apiUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}/api/v1${path}`;
}
