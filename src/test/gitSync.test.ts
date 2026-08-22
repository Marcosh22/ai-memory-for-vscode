import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SyncRepository, gitAvailable, validateBranch } from '../core/gitSync';
import { portablePage, type MemoryBundle } from '../core/memorySync';

let root = '';
let hasGit = false;

before(async () => {
  hasGit = await gitAvailable();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-git-sync-'));
});

after(() => {
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('SyncRepository', () => {
  it('publica e recupera um bundle por uma branch dedicada', async (t) => {
    if (!hasGit) {
      t.skip('git indisponível');
      return;
    }
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore', windowsHide: true });

    const first = new SyncRepository(path.join(root, 'first'), remote, 'ai-memory-sync');
    await first.initialize();
    first.writeBundle(bundle('# Primeira versão\n'));
    await first.commit('primeira memória');
    const published = await first.push();

    const second = new SyncRepository(path.join(root, 'second'), remote, 'ai-memory-sync');
    await second.initialize();
    const remoteCommit = await second.fetchRemote();
    assert.equal(remoteCommit, published);
    assert.ok(remoteCommit);
    await second.checkoutRemote(remoteCommit);
    const restored = await second.readBundleAt(remoteCommit);

    assert.equal(restored.pages[0]?.body, '# Primeira versão\n');
    assert.equal(restored.project.project, 'app');
  });

  it('valida nomes de branch antes de chamar o Git', () => {
    assert.doesNotThrow(() => validateBranch('ai-memory-sync'));
    assert.doesNotThrow(() => validateBranch('memory/equipe-a'));
    assert.throws(() => validateBranch('../main'));
    assert.throws(() => validateBranch('branch com espaço'));
    assert.throws(() => validateBranch('-opcao'));
  });
});

function bundle(body: string): MemoryBundle {
  return {
    schema: 1,
    project: { workspace: 'default', project: 'app' },
    pages: [
      portablePage({
        path: 'notes/contexto.md',
        title: 'Contexto',
        kind: 'note',
        tier: 'semantic',
        pinned: false,
        tags: [],
        body,
      }),
    ],
  };
}
