import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { clearCache, readPage } from '../core/client';
import { continuityBranch } from '../core/continuity';
import { SyncRepository } from '../core/gitSync';
import { emptyMemoryBundle, exportMemoryBundle, importMemoryBundle } from '../core/memorySync';
import { writePage } from '../core/mcp';

const serverA = process.env['AI_MEMORY_TEST_SERVER_A'];
const serverB = process.env['AI_MEMORY_TEST_SERVER_B'];
const token = process.env['AI_MEMORY_TEST_TOKEN'];

describe('continuidade com dois servidores reais', () => {
  it('exporta da máquina A e importa regras, decisão e checkpoint na máquina B', async (t) => {
    if (!serverA || !serverB) {
      t.skip('defina AI_MEMORY_TEST_SERVER_A e AI_MEMORY_TEST_SERVER_B');
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-real-continuity-'));
    try {
      const scope = { workspace: 'default', project: 'continuity-test' };
      const optionsA = { baseUrl: serverA, token };
      const optionsB = { baseUrl: serverB, token };
      await Promise.all([
        writePage({ ...scope, path: '_rules/business.md', title: 'Regra', body: 'A conta precisa estar ativa.', pinned: true }, optionsA),
        writePage({ ...scope, path: 'decisions/database.md', title: 'Decisão', body: 'Usar PostgreSQL.', pinned: true }, optionsA),
        writePage({ ...scope, path: 'handoffs/latest.md', title: 'Checkpoint', body: 'Continuar pela renovação.', pinned: true }, optionsA),
      ]);

      const outgoing = await exportMemoryBundle(scope, optionsA);
      const remote = path.join(root, 'memory.git');
      execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore', windowsHide: true });
      const source = new SyncRepository(path.join(root, 'source'), remote, continuityBranch(scope));
      await source.initialize();
      source.writeBundle(outgoing);
      await source.commit('publicar máquina A');
      await source.push();

      const destination = new SyncRepository(path.join(root, 'destination'), remote, continuityBranch(scope));
      await destination.initialize();
      const commit = await destination.fetchRemote();
      assert.ok(commit);
      const incoming = await destination.readBundleAt(commit);
      await importMemoryBundle(incoming, emptyMemoryBundle(scope), optionsB);
      clearCache();

      assert.match((await readPage(scope, '_rules/business.md', optionsB)).body_markdown, /conta precisa estar ativa/);
      assert.match((await readPage(scope, 'decisions/database.md', optionsB)).body_markdown, /PostgreSQL/);
      assert.match((await readPage(scope, 'handoffs/latest.md', optionsB)).body_markdown, /renovação/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
