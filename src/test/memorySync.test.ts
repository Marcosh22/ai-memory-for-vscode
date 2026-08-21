import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { ProjectScope } from '../core/client';
import {
  assertSafePagePath,
  emptyMemoryBundle,
  mergeMemoryBundles,
  portablePage,
  readMemoryBundle,
  resolveMemoryConflicts,
  writeMemoryBundle,
  type MemoryBundle,
  type PortablePage,
} from '../core/memorySync';

const SCOPE: ProjectScope = { workspace: 'default', project: 'app' };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('bundle portátil', () => {
  it('round-trip preserva markdown e metadados sem SQLite', async () => {
    const root = temporaryDirectory();
    const original = bundle(page('decisions/db.md', '# Banco\n\nUsar Postgres.', {
      tier: 'semantic',
      pinned: true,
      tags: ['adr', 'database'],
      expiresAt: '2026-12-31',
    }));

    writeMemoryBundle(root, original);
    const restored = await readMemoryBundle(root);

    assert.deepEqual(restored, original);
    assert.equal(fs.existsSync(path.join(root, '.ai-memory-sync', 'pages', 'decisions', 'db.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.ai-memory-sync', 'manifest.json')), true);
  });

  it('o hash é estável e muda quando o conteúdo muda', () => {
    const first = page('notes/a.md', '# A');
    const again = page('notes/a.md', '# A');
    const changed = page('notes/a.md', '# A\n\nNovo');

    assert.equal(first.hash, again.hash);
    assert.notEqual(first.hash, changed.hash);
  });

  it('recusa arquivo alterado fora do manifesto', async () => {
    const root = temporaryDirectory();
    writeMemoryBundle(root, bundle(page('notes/a.md', '# A')));
    fs.writeFileSync(
      path.join(root, '.ai-memory-sync', 'pages', 'notes', 'a.md'),
      '# Conteúdo adulterado',
      'utf8',
    );

    await assert.rejects(() => readMemoryBundle(root), /conteúdo divergente/);
  });

  it('recusa traversal e caminhos não portáteis', () => {
    assert.throws(() => assertSafePagePath('../segredo.md'));
    assert.throws(() => assertSafePagePath('/absoluto.md'));
    assert.throws(() => assertSafePagePath('notes\\windows.md'));
    assert.doesNotThrow(() => assertSafePagePath('notes/seguro.md'));
  });
});

describe('merge manual de três vias', () => {
  it('combina alterações feitas em páginas diferentes', () => {
    const originalA = page('notes/a.md', '# A');
    const originalB = page('notes/b.md', '# B');
    const base = bundle(originalA, originalB);
    const local = bundle(page('notes/a.md', '# A\n\nLocal'), originalB);
    const remote = bundle(originalA, page('notes/b.md', '# B\n\nRemoto'));

    const result = mergeMemoryBundles(base, local, remote);

    assert.deepEqual(result.conflicts, []);
    assert.equal(result.bundle.pages.find((item) => item.path === 'notes/a.md')?.body, '# A\n\nLocal');
    assert.equal(result.bundle.pages.find((item) => item.path === 'notes/b.md')?.body, '# B\n\nRemoto');
  });

  it('bloqueia quando a mesma página mudou dos dois lados', () => {
    const base = bundle(page('notes/a.md', '# A'));
    const local = bundle(page('notes/a.md', '# A\n\nLocal'));
    const remote = bundle(page('notes/a.md', '# A\n\nRemoto'));

    const result = mergeMemoryBundles(base, local, remote);

    assert.deepEqual(result.conflicts, ['notes/a.md']);
  });

  it('só resolve conflito depois de uma escolha explícita', () => {
    const base = bundle(page('notes/a.md', '# A'));
    const local = bundle(page('notes/a.md', '# A\n\nLocal'));
    const remote = bundle(page('notes/a.md', '# A\n\nRemoto'));
    const result = mergeMemoryBundles(base, local, remote);

    assert.equal(resolveMemoryConflicts(result, local, remote, 'local').pages[0]?.body, '# A\n\nLocal');
    assert.equal(resolveMemoryConflicts(result, local, remote, 'remote').pages[0]?.body, '# A\n\nRemoto');
  });

  it('não propaga exclusão enquanto o protocolo não tiver tombstones', () => {
    const original = page('notes/a.md', '# A');
    const base = bundle(original);
    const local = emptyMemoryBundle(SCOPE);
    const remote = bundle(original);

    const result = mergeMemoryBundles(base, local, remote);

    assert.equal(result.bundle.pages.length, 1);
    assert.equal(result.bundle.pages[0]?.path, 'notes/a.md');
  });
});

function bundle(...pages: PortablePage[]): MemoryBundle {
  return { schema: 1, project: SCOPE, pages };
}

function page(
  pagePath: string,
  body: string,
  metadata: {
    tier?: string;
    pinned?: boolean;
    tags?: readonly string[];
    expiresAt?: string;
  } = {},
): PortablePage {
  return portablePage({
    path: pagePath,
    title: body.match(/^#\s+(.+)$/m)?.[1] ?? pagePath,
    kind: 'note',
    tier: metadata.tier ?? 'semantic',
    pinned: metadata.pinned ?? false,
    tags: metadata.tags ?? [],
    expiresAt: metadata.expiresAt,
    body,
  });
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-sync-'));
  temporaryDirectories.push(directory);
  return directory;
}
