import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  listPages,
  readPage,
  type ClientOptions,
  type PageKind,
  type ProjectScope,
} from './client';
import { writePage } from './mcp';

export const SYNC_SCHEMA = 1;
export const SYNC_ROOT = '.ai-memory-sync';
export const MANIFEST_FILE = `${SYNC_ROOT}/manifest.json`;
const PAGES_ROOT = `${SYNC_ROOT}/pages`;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 10_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export interface PortablePage {
  readonly path: string;
  readonly title: string;
  readonly kind: PageKind;
  readonly tier: string;
  readonly pinned: boolean;
  readonly tags: readonly string[];
  readonly expiresAt?: string | undefined;
  readonly body: string;
  readonly hash: string;
}

export interface MemoryBundle {
  readonly schema: typeof SYNC_SCHEMA;
  readonly project: ProjectScope;
  readonly pages: readonly PortablePage[];
}

interface ManifestPage {
  readonly path: string;
  readonly title: string;
  readonly kind: PageKind;
  readonly tier: string;
  readonly pinned: boolean;
  readonly tags: readonly string[];
  readonly expires_at?: string | undefined;
  readonly hash: string;
}

interface Manifest {
  readonly schema: number;
  readonly project: ProjectScope;
  readonly pages: readonly ManifestPage[];
}

export interface MergeResult {
  readonly bundle: MemoryBundle;
  readonly conflicts: readonly string[];
}

export type ConflictWinner = 'local' | 'remote';

/** Exporta a fonte portátil do projeto; SQLite e caminhos locais nunca entram no bundle. */
export async function exportMemoryBundle(
  scope: ProjectScope,
  options: ClientOptions,
  progress?: ((done: number, total: number, page: string) => void) | undefined,
): Promise<MemoryBundle> {
  const refs = await listPages(scope, options);
  let done = 0;
  const pages = await mapConcurrent(refs, 6, async (ref) => {
    const detail = await readPage(scope, ref.path, options);
    const tags = stringArray(detail.frontmatter['tags']).sort();
    const expiresAt = stringValue(detail.frontmatter['expires_at']);
    const page = portablePage({
      path: detail.path,
      title: detail.title,
      kind: detail.kind,
      tier: detail.tier,
      pinned: detail.pinned,
      tags,
      expiresAt,
      body: detail.body_markdown,
    });
    done += 1;
    progress?.(done, refs.length, ref.path);
    return page;
  });

  return bundleFor(scope, pages);
}

export function emptyMemoryBundle(scope: ProjectScope): MemoryBundle {
  return bundleFor(scope, []);
}

export function portablePage(input: Omit<PortablePage, 'hash'>): PortablePage {
  assertSafePagePath(input.path);
  const normalized = {
    ...input,
    tags: [...input.tags].sort(),
  };
  return { ...normalized, hash: pageHash(normalized) };
}

/**
 * Merge de três vias sem propagar exclusões. A ausência de uma página
 * nunca apaga a cópia do outro lado neste primeiro protocolo.
 */
export function mergeMemoryBundles(
  base: MemoryBundle,
  local: MemoryBundle,
  remote: MemoryBundle,
): MergeResult {
  assertSameProject(base, local);
  assertSameProject(base, remote);

  const basePages = pageMap(base);
  const localPages = pageMap(local);
  const remotePages = pageMap(remote);
  const paths = new Set([...basePages.keys(), ...localPages.keys(), ...remotePages.keys()]);
  const merged: PortablePage[] = [];
  const conflicts: string[] = [];

  for (const pagePath of [...paths].sort()) {
    const before = basePages.get(pagePath);
    const here = localPages.get(pagePath);
    const there = remotePages.get(pagePath);

    // Exclusão não se propaga: se apenas um lado ainda possui a página,
    // ele vence. Tombstones entram numa versão posterior do protocolo.
    if (!here || !there) {
      const survivor = here ?? there;
      if (survivor) {
        merged.push(survivor);
      }
      continue;
    }

    if (here.hash === there.hash) {
      merged.push(here);
    } else if (!before) {
      conflicts.push(pagePath);
    } else if (here.hash === before.hash) {
      merged.push(there);
    } else if (there.hash === before.hash) {
      merged.push(here);
    } else {
      conflicts.push(pagePath);
    }
  }

  return { bundle: bundleFor(local.project, merged), conflicts };
}

/** Aplica uma escolha humana aos paths que o merge recusou decidir sozinho. */
export function resolveMemoryConflicts(
  result: MergeResult,
  local: MemoryBundle,
  remote: MemoryBundle,
  winner: ConflictWinner,
): MemoryBundle {
  assertSameProject(local, remote);
  assertSameProject(result.bundle, local);
  const pages = pageMap(result.bundle);
  const source = pageMap(winner === 'local' ? local : remote);
  for (const pagePath of result.conflicts) {
    const selected = source.get(pagePath);
    if (!selected) {
      throw new Error(`conflito sem página ${winner}: ${pagePath}`);
    }
    pages.set(pagePath, selected);
  }
  return bundleFor(local.project, [...pages.values()]);
}

/** Importa somente páginas diferentes, sempre pela tool oficial de escrita. */
export async function importMemoryBundle(
  bundle: MemoryBundle,
  local: MemoryBundle,
  options: ClientOptions,
  progress?: ((done: number, total: number, page: string) => void) | undefined,
): Promise<number> {
  assertSameProject(local, bundle);
  const localPages = pageMap(local);
  const changed = bundle.pages.filter((page) => localPages.get(page.path)?.hash !== page.hash);
  let done = 0;

  for (const page of changed) {
    await writePage(
      {
        workspace: bundle.project.workspace,
        project: bundle.project.project,
        path: page.path,
        title: page.title,
        body: page.body,
        tier: page.tier,
        tags: page.tags,
        pinned: page.pinned,
        expiresAt: page.expiresAt,
      },
      options,
    );
    done += 1;
    progress?.(done, changed.length, page.path);
  }
  return changed.length;
}

/** Grava o bundle num checkout gerenciado pela extensão. */
export function writeMemoryBundle(root: string, bundle: MemoryBundle): void {
  const pagesRoot = path.join(root, ...PAGES_ROOT.split('/'));
  fs.mkdirSync(pagesRoot, { recursive: true });

  for (const page of bundle.pages) {
    const target = pageFile(root, page.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, page.body, 'utf8');
  }

  const manifest = serializeManifest(bundle);
  const target = path.join(root, MANIFEST_FILE);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, manifest, 'utf8');
  fs.renameSync(temporary, target);
}

export function serializeManifest(bundle: MemoryBundle): string {
  const manifest: Manifest = {
    schema: SYNC_SCHEMA,
    project: bundle.project,
    pages: bundle.pages.map((page) => ({
      path: page.path,
      title: page.title,
      kind: page.kind,
      tier: page.tier,
      pinned: page.pinned,
      tags: page.tags,
      ...(page.expiresAt ? { expires_at: page.expiresAt } : {}),
      hash: page.hash,
    })),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function parseMemoryBundle(
  manifestText: string,
  readBody: (pagePath: string) => Promise<string>,
): Promise<MemoryBundle> {
  if (Buffer.byteLength(manifestText, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('manifesto de sincronização excede o limite de 2 MiB');
  }
  const parsed = JSON.parse(manifestText) as Partial<Manifest>;
  if (parsed.schema !== SYNC_SCHEMA || !isProjectScope(parsed.project) || !Array.isArray(parsed.pages)) {
    throw new Error(`manifesto de sincronização incompatível (esperado schema ${SYNC_SCHEMA})`);
  }
  if (parsed.pages.length > MAX_PAGES) {
    throw new Error(`manifesto de sincronização excede o limite de ${MAX_PAGES} páginas`);
  }

  const pages: PortablePage[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.pages) {
    validateManifestPage(raw);
    if (seen.has(raw.path)) {
      throw new Error(`página duplicada no manifesto: ${raw.path}`);
    }
    seen.add(raw.path);
    const body = await readBody(raw.path);
    if (Buffer.byteLength(body, 'utf8') > MAX_PAGE_BYTES) {
      throw new Error(`página excede o limite de 2 MiB: ${raw.path}`);
    }
    let page = portablePage({
      path: raw.path,
      title: raw.title,
      kind: raw.kind,
      tier: raw.tier,
      pinned: raw.pinned,
      tags: raw.tags,
      expiresAt: raw.expires_at,
      body,
    });
    if (page.hash !== raw.hash) {
      // Git pode materializar Markdown com CRLF mesmo quando o manifesto foi
      // criado sobre LF (por configuração global, atributos ou um checkout
      // antigo). Só aceitamos a divergência quando normalizar *exclusivamente*
      // os finais de linha reproduz exatamente o hash assinado pelo manifesto.
      // Qualquer outra alteração continua falhando fechada.
      const normalizedBody = body.replace(/\r\n/g, '\n');
      const normalized = portablePage({
        path: raw.path,
        title: raw.title,
        kind: raw.kind,
        tier: raw.tier,
        pinned: raw.pinned,
        tags: raw.tags,
        expiresAt: raw.expires_at,
        body: normalizedBody,
      });
      if (normalized.hash !== raw.hash) {
        throw new Error(`conteúdo divergente do manifesto: ${raw.path}`);
      }
      page = normalized;
    }
    pages.push(page);
  }
  return bundleFor(parsed.project, pages);
}

export async function readMemoryBundle(root: string): Promise<MemoryBundle> {
  const manifest = fs.readFileSync(path.join(root, MANIFEST_FILE), 'utf8');
  return parseMemoryBundle(manifest, async (pagePath) =>
    fs.readFileSync(pageFile(root, pagePath), 'utf8'),
  );
}

function bundleFor(scope: ProjectScope, pages: readonly PortablePage[]): MemoryBundle {
  return {
    schema: SYNC_SCHEMA,
    project: { workspace: scope.workspace, project: scope.project },
    pages: [...pages].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function pageHash(page: Omit<PortablePage, 'hash'>): string {
  const stable = JSON.stringify({
    path: page.path,
    title: page.title,
    kind: page.kind,
    tier: page.tier,
    pinned: page.pinned,
    tags: [...page.tags].sort(),
    expiresAt: page.expiresAt ?? null,
    body: page.body,
  });
  return createHash('sha256').update(stable).digest('hex');
}

function pageMap(bundle: MemoryBundle): Map<string, PortablePage> {
  return new Map(bundle.pages.map((page) => [page.path, page]));
}

function pageFile(root: string, pagePath: string): string {
  assertSafePagePath(pagePath);
  return path.join(root, ...PAGES_ROOT.split('/'), ...pagePath.split('/'));
}

export function assertSafePagePath(pagePath: string): void {
  const segments = pagePath.split('/');
  if (
    pagePath.length === 0 ||
    path.isAbsolute(pagePath) ||
    pagePath.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`caminho de página inseguro: ${pagePath}`);
  }
}

function assertSameProject(a: MemoryBundle, b: MemoryBundle): void {
  if (a.project.workspace !== b.project.workspace || a.project.project !== b.project.project) {
    throw new Error(
      `escopo incompatível: ${a.project.workspace}/${a.project.project} e ${b.project.workspace}/${b.project.project}`,
    );
  }
}

function isProjectScope(value: unknown): value is ProjectScope {
  const candidate = value as Partial<ProjectScope> | undefined;
  return typeof candidate?.workspace === 'string' && typeof candidate.project === 'string';
}

function validateManifestPage(value: unknown): asserts value is ManifestPage {
  const page = value as Partial<ManifestPage> | undefined;
  if (
    typeof page?.path !== 'string' ||
    typeof page.title !== 'string' ||
    typeof page.kind !== 'string' ||
    !PAGE_KIND_PATTERN.test(page.kind) ||
    typeof page.tier !== 'string' ||
    typeof page.pinned !== 'boolean' ||
    !Array.isArray(page.tags) ||
    !page.tags.every((tag) => typeof tag === 'string') ||
    typeof page.hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(page.hash)
  ) {
    throw new Error('entrada de página inválida no manifesto de sincronização');
  }
  assertSafePagePath(page.path);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) {
        return;
      }
      result[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}
