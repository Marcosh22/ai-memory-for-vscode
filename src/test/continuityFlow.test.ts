import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { applyPortableConfig, continuityBranch } from '../core/continuity';
import { SyncRepository } from '../core/gitSync';
import { emptyMemoryBundle, mergeMemoryBundles, portablePage, type MemoryBundle } from '../core/memorySync';

describe('continuidade máquina A → Git → máquina B', () => {
  it('transporta identidade, regra, decisão e checkpoint sem contexto manual', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-continuity-'));
    try {
      const scope = { workspace: 'equipe', project: 'produto' };
      const marker = applyPortableConfig('', scope);
      assert.match(marker, /inject_on_session_start = true/);

      const remote = path.join(root, 'memory.git');
      execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore', windowsHide: true });
      const branch = continuityBranch(scope);
      const machineA = new SyncRepository(path.join(root, 'machine-a'), remote, branch);
      await machineA.initialize();
      machineA.writeBundle(bundle(scope));
      await machineA.commit('checkpoint máquina A');
      const published = await machineA.push();

      const machineB = new SyncRepository(path.join(root, 'machine-b'), remote, branch);
      await machineB.initialize();
      const remoteCommit = await machineB.fetchRemote();
      assert.equal(remoteCommit, published);
      assert.ok(remoteCommit);
      const incoming = await machineB.readBundleAt(remoteCommit);
      const localB = emptyMemoryBundle(scope);
      const restored = mergeMemoryBundles(localB, localB, incoming).bundle;

      assert.deepEqual(restored.project, scope);
      assert.match(page(restored, '_rules/business.md').body, /assinatura ativa/);
      assert.match(page(restored, 'decisions/database.md').body, /PostgreSQL/);
      assert.match(page(restored, 'handoffs/latest.md').body, /Implementar renovação/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function bundle(project: MemoryBundle['project']): MemoryBundle {
  const common = { tier: 'semantic', pinned: true, tags: [] as string[] };
  return {
    schema: 1,
    project,
    pages: [
      portablePage({
        ...common, path: '_rules/business.md', title: 'Regra de assinatura', kind: 'rule',
        body: 'Somente contas com assinatura ativa podem publicar.',
      }),
      portablePage({
        ...common, path: 'decisions/database.md', title: 'Banco principal', kind: 'decision',
        body: 'PostgreSQL é o banco transacional principal.',
      }),
      portablePage({
        ...common, path: 'handoffs/latest.md', title: 'Checkpoint portátil', kind: 'fact',
        body: 'Próximo passo: Implementar renovação automática.',
      }),
    ],
  };
}

function page(bundle: MemoryBundle, pagePath: string) {
  const found = bundle.pages.find((candidate) => candidate.path === pagePath);
  assert.ok(found, `página ausente: ${pagePath}`);
  return found;
}
