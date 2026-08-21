import { execFileSync } from 'node:child_process';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  findMarker,
  isKnownProject,
  parseTomlKey,
  resolveScope,
  resolveScopes,
  type ResolvedScope,
} from '../core/scope';

/**
 * Matriz da §7 do plano. Fixtures reais em disco: o algoritmo é inteiramente
 * sobre existência de arquivos, fronteiras de diretório e estado do git —
 * um filesystem mockado testaria o mock, não a paridade.
 *
 * `home` é sempre explícito. A fronteira do walk depende dele, e o tmpdir
 * real fica dentro de $HOME no Windows, o que esconderia metade dos casos.
 */

let root: string;

/** Raiz de teste, já canonicalizada — realpath pode reescrever o tmpdir. */
function fixture(...segments: string[]): string {
  return path.join(root, ...segments);
}

function mkdirp(...segments: string[]): string {
  const dir = fixture(...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMarker(dir: string, contents: string): void {
  fs.writeFileSync(path.join(dir, '.ai-memory.toml'), contents, 'utf8');
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function gitInit(dir: string): void {
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 15000, windowsHide: true });
  };
  run('init', '--initial-branch=main');
  run('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init');
}

before(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-scope-')));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('caso 1 — marker no diretório atual', () => {
  it('resolve pelo marker do próprio checkout', () => {
    const home = mkdirp('c1');
    const repo = mkdirp('c1', 'repo');
    writeMarker(repo, 'workspace = "movvia"\nproject = "portais"\n');

    const scope = resolveScope(repo, { home });

    assert.equal(scope.workspace, 'movvia');
    assert.equal(scope.project, 'portais');
    assert.equal(scope.projectSource, 'marker');
    assert.equal(scope.workspaceSource, 'marker');
  });
});

describe('caso 2 — marker em ancestral', () => {
  it('sobe a árvore até o primeiro marker', () => {
    const home = mkdirp('c2');
    const repo = mkdirp('c2', 'repo');
    const deep = mkdirp('c2', 'repo', 'src', 'feature', 'component');
    writeMarker(repo, 'workspace = "acme"\n');

    const scope = resolveScope(deep, { home });

    assert.equal(scope.workspace, 'acme');
    assert.equal(scope.markerPath, path.join(repo, '.ai-memory.toml'));
  });

  it('marker mais próximo vence o mais distante', () => {
    const home = mkdirp('c2b');
    const outer = mkdirp('c2b', 'outer');
    const inner = mkdirp('c2b', 'outer', 'inner');
    writeMarker(outer, 'workspace = "de-fora"\n');
    writeMarker(inner, 'workspace = "de-dentro"\n');

    assert.equal(resolveScope(inner, { home }).workspace, 'de-dentro');
  });
});

describe('caso 3 — project explícito', () => {
  it('vence basename(cwd)', () => {
    const home = mkdirp('c3');
    const pkg = mkdirp('c3', 'monorepo', 'packages', 'ui');
    writeMarker(fixture('c3', 'monorepo'), 'workspace = "acme"\nproject = "monorepo-todo"\n');

    const scope = resolveScope(pkg, { home });

    assert.equal(scope.project, 'monorepo-todo');
    assert.notEqual(scope.project, 'ui');
  });

  it('vence project_strategy = repo-root', () => {
    const home = mkdirp('c3b');
    const repo = mkdirp('c3b', 'repo');
    writeMarker(repo, 'project = "pinado"\nproject_strategy = "repo-root"\n');

    const scope = resolveScope(repo, {
      home,
      repoRoot: () => 'nome-do-repo',
    });

    assert.equal(scope.project, 'pinado');
    assert.equal(scope.projectSource, 'marker');
  });
});

describe('caso 4 — project_strategy = repo-root', () => {
  it('deriva do repositório quando não há project pinado', () => {
    const home = mkdirp('c4');
    const sub = mkdirp('c4', 'repo', 'src', 'deep');
    writeMarker(fixture('c4', 'repo'), 'workspace = "oss"\nproject_strategy = "repo-root"\n');

    const scope = resolveScope(sub, { home, repoRoot: () => 'repo' });

    assert.equal(scope.project, 'repo');
    assert.equal(scope.projectSource, 'repo-root');
  });

  it('aceita a grafia repo_root', () => {
    const home = mkdirp('c4b');
    const repo = mkdirp('c4b', 'repo');
    writeMarker(repo, 'project_strategy = "repo_root"\n');

    assert.equal(resolveScope(repo, { home, repoRoot: () => 'derivado' }).project, 'derivado');
  });

  it('fora de um repositório git, mantém basename — não inventa', () => {
    const home = mkdirp('c4c');
    const dir = mkdirp('c4c', 'sem-git');
    writeMarker(dir, 'project_strategy = "repo-root"\n');

    const scope = resolveScope(dir, { home, repoRoot: () => undefined });

    assert.equal(scope.project, 'sem-git');
    assert.equal(scope.projectSource, 'basename');
  });

  it('o default de instalação preenche a strategy quando o marker não pina', () => {
    const home = mkdirp('c4d');
    const repo = mkdirp('c4d', 'repo');
    writeMarker(repo, 'workspace = "acme"\n');

    const scope = resolveScope(repo, {
      home,
      defaultStrategy: 'repo-root',
      repoRoot: () => 'principal',
    });

    assert.equal(scope.project, 'principal');
    assert.equal(scope.projectSource, 'repo-root');
  });

  it('a strategy do marker vence o default de instalação', () => {
    const home = mkdirp('c4e');
    const repo = mkdirp('c4e', 'repo');
    writeMarker(repo, 'project_strategy = "basename"\n');

    const scope = resolveScope(repo, {
      home,
      defaultStrategy: 'repo-root',
      repoRoot: () => 'nao-deveria-ser-usado',
    });

    assert.equal(scope.project, 'repo');
    assert.equal(scope.projectSource, 'basename');
  });
});

describe('caso 5 — git worktree', { skip: hasGit() ? false : 'git indisponível' }, () => {
  it('worktree vinculado colapsa no mesmo projeto do repo principal', () => {
    const home = mkdirp('c5');
    const main = mkdirp('c5', 'projeto-principal');
    gitInit(main);
    writeMarker(main, 'workspace = "oss"\nproject_strategy = "repo-root"\n');

    const tree = fixture('c5', 'wt-feature');
    execFileSync('git', ['worktree', 'add', tree, '-b', 'feature'], {
      cwd: main,
      stdio: 'ignore',
      timeout: 20000,
      windowsHide: true,
    });

    // O worktree fica fora da árvore do marker, então declara o seu.
    writeMarker(tree, 'workspace = "oss"\nproject_strategy = "repo-root"\n');

    const principal = resolveScope(main, { home });
    const worktree = resolveScope(tree, { home });

    assert.equal(principal.project, 'projeto-principal');
    assert.equal(
      worktree.project,
      'projeto-principal',
      'o worktree precisa colapsar no nome do repo principal, não em wt-feature',
    );
    assert.equal(worktree.projectSource, 'repo-root');
  });
});

describe('caso 6 — workspace multi-root', () => {
  it('resolve cada pasta independentemente, na ordem', () => {
    const home = mkdirp('c6');
    const a = mkdirp('c6', 'projeto-a');
    const b = mkdirp('c6', 'projeto-b');
    writeMarker(a, 'workspace = "cliente-x"\nproject = "api"\n');

    const scopes = resolveScopes([a, b], { home });

    assert.equal(scopes.length, 2);
    assert.equal(scopes[0]?.project, 'api');
    assert.equal(scopes[0]?.workspace, 'cliente-x');
    assert.equal(scopes[1]?.project, 'projeto-b');
    assert.equal(scopes[1]?.workspace, 'default');
  });
});

describe('caso 7 — sem marker', () => {
  it('cai em basename(cwd) e workspace default — caminho normal, não erro', () => {
    const home = mkdirp('c7');
    const repo = mkdirp('c7', 'meu-repo');

    const scope = resolveScope(repo, { home });

    assert.equal(scope.project, 'meu-repo');
    assert.equal(scope.projectSource, 'basename');
    assert.equal(scope.workspace, 'default');
    assert.equal(scope.workspaceSource, 'default');
    assert.equal(scope.markerPath, undefined);
  });
});

describe('caso 8 — projeto inexistente no servidor', () => {
  const scope = (workspace: string, project: string): ResolvedScope => ({
    cwd: '/tmp/x',
    workspace,
    workspaceSource: 'default',
    project,
    projectSource: 'basename',
    markerPath: undefined,
    projectStrategy: undefined,
  });

  const known = [
    { workspace_name: 'default', project_name: 'scratch' },
    { workspace_name: 'acme', project_name: 'api' },
  ];

  it('reconhece um par (workspace, project) conhecido', () => {
    assert.equal(isKnownProject(scope('default', 'scratch'), known), true);
  });

  it('rejeita projeto que não existe', () => {
    assert.equal(isKnownProject(scope('default', 'inexistente'), known), false);
  });

  it('rejeita o nome certo no workspace errado', () => {
    assert.equal(isKnownProject(scope('default', 'api'), known), false);
  });
});

describe('fronteira do walk', () => {
  it('para em $HOME e ignora marker acima dele', () => {
    const above = mkdirp('b1');
    const home = mkdirp('b1', 'home');
    const repo = mkdirp('b1', 'home', 'repo');
    writeMarker(above, 'workspace = "vazado-de-outro-usuario"\n');

    assert.equal(findMarker(repo, home), undefined);
    assert.equal(resolveScope(repo, { home }).workspace, 'default');
  });

  it('inspeciona o próprio $HOME antes de parar', () => {
    const home = mkdirp('b2', 'home');
    const repo = mkdirp('b2', 'home', 'repo');
    writeMarker(home, 'workspace = "pessoal"\n');

    assert.equal(resolveScope(repo, { home }).workspace, 'pessoal');
  });

  it('fora de $HOME, para no checkout root', () => {
    const home = mkdirp('b3', 'home');
    const acima = mkdirp('b3', 'fora');
    const checkout = mkdirp('b3', 'fora', 'checkout');
    const dentro = mkdirp('b3', 'fora', 'checkout', 'src');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    writeMarker(acima, 'workspace = "acima-do-checkout"\n');

    assert.equal(findMarker(dentro, home), undefined);
  });

  it('fora de $HOME e sem git, inspeciona apenas o cwd', () => {
    const home = mkdirp('b4', 'home');
    const pai = mkdirp('b4', 'fora');
    const filho = mkdirp('b4', 'fora', 'filho');
    writeMarker(pai, 'workspace = "do-pai"\n');

    assert.equal(findMarker(filho, home), undefined);
    assert.equal(findMarker(pai, home), path.join(pai, '.ai-memory.toml'));
  });

  it('reconhece .git como arquivo, não só diretório', () => {
    const home = mkdirp('b5', 'home');
    const acima = mkdirp('b5', 'fora');
    const checkout = mkdirp('b5', 'fora', 'wt');
    const dentro = mkdirp('b5', 'fora', 'wt', 'src');
    fs.writeFileSync(path.join(checkout, '.git'), 'gitdir: /outro/lugar\n', 'utf8');
    writeMarker(acima, 'workspace = "nao-deve-vazar"\n');

    assert.equal(findMarker(dentro, home), undefined);
  });
});

describe('parse do marker', () => {
  it('não confunde project com project_strategy', () => {
    const text = 'project_strategy = "repo-root"\n';
    assert.equal(parseTomlKey(text, 'project'), undefined);
    assert.equal(parseTomlKey(text, 'project_strategy'), 'repo-root');
  });

  it('aceita espaçamento irregular e ausência de espaços', () => {
    assert.equal(parseTomlKey('   workspace   =   "x"  \n', 'workspace'), 'x');
    assert.equal(parseTomlKey('workspace="y"\n', 'workspace'), 'y');
  });

  it('primeira ocorrência vence', () => {
    assert.equal(parseTomlKey('workspace = "um"\nworkspace = "dois"\n', 'workspace'), 'um');
  });

  it('ignora cabeçalhos de seção — o casamento é por linha', () => {
    const text = '[recall]\ndefault_global = "true"\nworkspace = "acme"\n';
    assert.equal(parseTomlKey(text, 'workspace'), 'acme');
  });

  it('ignora valor sem aspas, como o shell', () => {
    assert.equal(parseTomlKey('workspace = acme\n', 'workspace'), undefined);
  });

  it('ignora aspas não terminadas e segue para a próxima linha', () => {
    assert.equal(parseTomlKey('workspace = "quebrado\nworkspace = "ok"\n', 'workspace'), 'ok');
  });

  it('lida com CRLF', () => {
    assert.equal(parseTomlKey('workspace = "win"\r\nproject = "p"\r\n', 'project'), 'p');
  });
});
