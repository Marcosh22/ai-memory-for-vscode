import { logger } from './logger';

/**
 * Cliente HTTP de `/api/v1` — o único lugar da extensão que faz `fetch`.
 *
 * Concentrar aqui é o que torna a migração para servidor de time uma mudança
 * de um arquivo: header de auth, política de cache por endpoint e tradução de
 * erro moram todos neste módulo.
 *
 * IMPORTANTE — as formas vêm de `docs/api-shapes.md`, capturadas de um
 * servidor v1.28.0 em execução, e NÃO de `docs/frontend-api.md` do upstream,
 * que está desatualizado. A regra observada: listagens devolvem array puro,
 * recursos singulares e agregados devolvem objeto.
 */

export type ApiErrorKind = 'unauthorized' | 'forbidden' | 'not-found' | 'unreachable' | 'http-error';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly timeoutMs?: number;
}

/** Escopo de um projeto. Nomes podem conter espaços e maiúsculas — o servidor aceita. */
export interface ProjectScope {
  readonly workspace: string;
  readonly project: string;
}

// ---------------------------------------------------------------------------
// tipos de resposta
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  readonly workspace_name: string;
  readonly project_name: string;
  readonly page_count: number;
  readonly last_updated: string | null;
}

/**
 * `kind` vem do frontmatter ou da família de path: `_rules/`, `_slots/`,
 * `sessions/`, `decisions/`, `gotchas/`, `concepts/`, `procedures/`,
 * `notes/`. O resto cai em `fact`.
 */
export type KnownPageKind =
  | 'rule'
  | 'slot'
  | 'session'
  | 'decision'
  | 'gotcha'
  | 'concept'
  | 'procedure'
  | 'note'
  | 'fact';

/** O servidor pode acrescentar famílias de página sem exigir nova extensão. */
export type PageKind = KnownPageKind | (string & {});

export interface PageRef {
  readonly path: string;
  readonly title: string;
  readonly kind: PageKind;
  readonly tier?: string;
  readonly updated_at: string;
}

export interface BriefingCounts {
  readonly pages_latest: number;
  readonly pages_all: number;
  readonly sessions: number;
  readonly observations: number;
}

export interface Briefing {
  readonly counts: BriefingCounts;
  readonly last_observation_at: string | null;
  readonly pending_handoff_count: number;
  readonly rules: readonly PageRef[];
  readonly slots: readonly PageRef[];
  readonly recent_pages: readonly PageRef[];
}

/**
 * Handoff como o `/overview` devolve — forma MAIS ENXUTA que a do
 * `/handoffs`: sem `id`, sem `state`, sem `files_touched`. Um handoff de
 * outro operador chega com `redacted: true` e os campos de prosa ausentes,
 * então tudo que é texto é opcional aqui.
 */
export interface OverviewHandoff {
  readonly agent: string;
  readonly at: string;
  readonly project?: string;
  readonly summary?: string;
  readonly open_questions?: readonly string[];
  readonly next_steps?: readonly string[];
  readonly redacted?: boolean;
}

export interface Health {
  readonly stale: number;
  readonly duplicates: number;
  readonly contradictions: number;
  readonly orphans: number;
}

export interface Overview {
  readonly handoff: OverviewHandoff | null;
  readonly briefing: Briefing;
  readonly health: Health;
}

/** Hit de busca. Não tem `id`, ao contrário do que o doc do upstream mostra. */
export interface SearchHit {
  readonly workspace: string;
  readonly project: string;
  readonly path: string;
  readonly title: string;
  readonly kind: PageKind;
  /** Contém marcadores `<mark>` do FTS5. */
  readonly snippet: string;
  /** Rank do FTS5 — MENOR é melhor. */
  readonly rank: number;
}

export interface PageLink {
  readonly path: string;
  readonly title: string;
  readonly kind: PageKind;
  readonly workspace: string;
  readonly project: string;
}

/** Leitura de página. O corpo é `body_markdown`, NÃO `body`. */
export interface PageDetail {
  readonly workspace: string;
  readonly project: string;
  readonly path: string;
  readonly title: string;
  readonly kind: PageKind;
  readonly tier: string;
  readonly pinned: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body_markdown: string;
  readonly links: readonly PageLink[];
  readonly backlinks: readonly PageLink[];
}

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

export async function listProjects(options: ClientOptions): Promise<ProjectSummary[]> {
  return apiGet<ProjectSummary[]>('/projects', options);
}

/**
 * Home view numa única round-trip: handoff + briefing + health.
 *
 * `no-store` no servidor porque depende do ator autenticado — nunca cachear.
 */
export async function getOverview(
  scope: ProjectScope,
  options: ClientOptions,
  limit = 10,
): Promise<Overview> {
  return apiGet<Overview>(`${scopePath(scope)}/overview?limit=${limit}`, options);
}

/** Lista todas as páginas atuais de um projeto. A API não pagina este endpoint. */
export async function listPages(
  scope: ProjectScope,
  options: ClientOptions,
): Promise<PageRef[]> {
  return apiGet<PageRef[]>(`${scopePath(scope)}/pages`, options);
}

export async function search(
  query: string,
  scope: ProjectScope | undefined,
  options: ClientOptions,
  limit = 30,
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (scope) {
    // Escopo parcial é rejeitado com 400 — os dois vão juntos ou nenhum vai.
    params.set('workspace', scope.workspace);
    params.set('project', scope.project);
  }
  return apiGet<SearchHit[]>(`/search?${params.toString()}`, options);
}

/**
 * Leitura de página, com `ETag` / `If-None-Match`.
 *
 * É o único endpoint cacheável do conjunto que usamos: o servidor devolve
 * `private, max-age=300` mais um ETag SHA-256. Briefing, overview, handoffs e
 * sessions são `no-store` e não passam por aqui.
 */
export async function readPage(
  scope: ProjectScope,
  path: string,
  options: ClientOptions,
): Promise<PageDetail> {
  const url = `${scopePath(scope)}/pages/${encodePagePath(path)}`;
  return apiGet<PageDetail>(url, options, pageCache);
}

function scopePath(scope: ProjectScope): string {
  return `/workspaces/${encodeURIComponent(scope.workspace)}/projects/${encodeURIComponent(scope.project)}`;
}

/** O path da página é um wildcard: as barras são separadores, não dados. */
function encodePagePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

// ---------------------------------------------------------------------------
// transporte
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly etag: string;
  readonly value: unknown;
}

const pageCache = new Map<string, CacheEntry>();

/** Esvazia o cache de páginas — usado quando o servidor ou o token mudam. */
export function clearCache(): void {
  pageCache.clear();
}

async function apiGet<T>(
  path: string,
  options: ClientOptions,
  cache?: Map<string, CacheEntry>,
): Promise<T> {
  const url = `${options.baseUrl}/api/v1${path}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const cached = cache?.get(url);
  if (cached) {
    headers['If-None-Match'] = cached.etag;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
  } catch (error) {
    const detail = describeNetworkError(error);
    logger.warn(`GET /api/v1${path} -> falhou (${detail})`);
    throw new ApiError('unreachable', detail);
  }

  // Só o status entra no log. Corpo nunca — pode conter memória de outro ator.
  logger.info(`GET /api/v1${path} -> ${response.status}`);

  if (response.status === 304 && cached) {
    return cached.value as T;
  }

  if (!response.ok) {
    throw new ApiError(kindForStatus(response.status), `HTTP ${response.status}`, response.status);
  }

  const value = (await response.json()) as T;

  if (cache) {
    const etag = response.headers.get('etag');
    if (etag) {
      cache.set(url, { etag, value });
    }
  }

  return value;
}

function kindForStatus(status: number): ApiErrorKind {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    default:
      return 'http-error';
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
