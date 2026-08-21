import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolução de (workspace, project) — §7 do plano.
 *
 * Este módulo reproduz as regras do ai-memory, não uma aproximação delas.
 * Se ele divergir, a extensão mostra um projeto e o agente escreve em outro,
 * e nada acusa o erro. As referências são:
 *
 *   hooks/_lib.sh                        — ai_memory_find_marker,
 *                                          ai_memory_parse_toml_key,
 *                                          ai_memory_repo_root_project,
 *                                          ai_memory_marker_qs
 *   crates/ai-memory-cli/src/marker.rs   — find_marker_with_home,
 *                                          parse_key_in, checkout_root,
 *                                          repo_root_project
 *
 * Onde os dois concordam, seguimos. A única divergência deliberada está em
 * `isUnder`, documentada lá.
 */

/** Precedência do projeto, para log e UI. */
export type ProjectSource = 'marker' | 'repo-root' | 'basename';

export interface ResolvedScope {
  readonly cwd: string;
  readonly workspace: string;
  readonly workspaceSource: 'marker' | 'default';
  readonly project: string;
  readonly projectSource: ProjectSource;
  /** Caminho do `.ai-memory.toml` usado, quando houve um. */
  readonly markerPath: string | undefined;
  /** `project_strategy` efetivo — do marker ou do default de instalação. */
  readonly projectStrategy: string | undefined;
}

export interface ResolveOptions {
  /**
   * Raiz do usuário. Injetável porque a fronteira do walk depende dela, e
   * um teste precisa controlá-la — mesma razão pela qual o Rust separa
   * `find_marker` de `find_marker_with_home`.
   */
  readonly home?: string | undefined;
  /** `AI_MEMORY_PROJECT_STRATEGY`, o default assado por `install-hooks`. */
  readonly defaultStrategy?: string | undefined;
  /** Injetável para teste; por padrão consulta o git de verdade. */
  readonly repoRoot?: ((cwd: string) => string | undefined) | undefined;
}

// ---------------------------------------------------------------------------
// marker
// ---------------------------------------------------------------------------

const MARKER_NAME = '.ai-memory.toml';

/**
 * Sobe de `cwd` procurando `.ai-memory.toml`, parando na fronteira.
 *
 * A fronteira existe para não vazar a declaração de um usuário para outro em
 * máquinas compartilhadas:
 *
 *   - `cwd` dentro de `$HOME`      → para em `$HOME`
 *   - `cwd` fora de `$HOME`        → para no checkout root mais próximo
 *                                    (primeiro diretório com `.git`),
 *                                    ou no próprio `cwd` se não houver
 *   - sem `$HOME`                  → sobe até a raiz do sistema de arquivos
 *
 * A fronteira é checada DEPOIS do marker, então o diretório-fronteira também
 * é inspecionado. Marker mais próximo vence.
 */
export function findMarker(cwd: string, home?: string | undefined): string | undefined {
  const start = absoluteNormalized(cwd);
  const boundary = boundaryFor(start, home);

  let dir = start;
  for (;;) {
    const candidate = path.join(dir, MARKER_NAME);
    if (isFile(candidate)) {
      return candidate;
    }
    if (boundary !== undefined && samePath(dir, boundary)) {
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function boundaryFor(start: string, home: string | undefined): string | undefined {
  if (home === undefined || home === '') {
    return undefined;
  }
  const normalizedHome = absoluteNormalized(home);
  if (isUnder(start, normalizedHome)) {
    return normalizedHome;
  }
  return checkoutRoot(start) ?? start;
}

/** Primeiro ancestral (inclusive) que contém `.git`, arquivo ou diretório. */
function checkoutRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// TOML mínimo
// ---------------------------------------------------------------------------

/**
 * Lê `key = "valor"` no nível raiz. Sem aninhamento, sem arrays, sem tabelas —
 * cabeçalhos de seção são simplesmente ignorados porque o casamento é por
 * linha. Primeira ocorrência vence.
 *
 * Porte direto de `parse_key_in` (marker.rs). O prefixo cru é intencional:
 * numa busca por `project`, a linha `project_strategy = "x"` casa o prefixo
 * mas falha no `=` seguinte e é descartada.
 */
export function parseTomlKey(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/^\s+/, '');
    if (!trimmed.startsWith(key)) {
      continue;
    }
    let rest = trimmed.slice(key.length).replace(/^\s+/, '');
    if (!rest.startsWith('=')) {
      continue;
    }
    rest = rest.slice(1).replace(/^\s+/, '');
    if (!rest.startsWith('"')) {
      continue;
    }
    rest = rest.slice(1);
    const end = rest.indexOf('"');
    if (end >= 0) {
      return rest.slice(0, end);
    }
  }
  return undefined;
}

export interface MarkerDeclaration {
  readonly workspace: string | undefined;
  readonly project: string | undefined;
  readonly projectStrategy: string | undefined;
  readonly dropSubagentCaptures: string | undefined;
}

export function readMarker(markerPath: string): MarkerDeclaration {
  let text = '';
  try {
    text = fs.readFileSync(markerPath, 'utf8');
  } catch {
    // Marker ilegível é tratado como ausente, como no shell.
  }
  return {
    workspace: parseTomlKey(text, 'workspace'),
    project: parseTomlKey(text, 'project'),
    projectStrategy: parseTomlKey(text, 'project_strategy'),
    dropSubagentCaptures: parseTomlKey(text, 'drop_subagent_captures'),
  };
}

// ---------------------------------------------------------------------------
// repo-root
// ---------------------------------------------------------------------------

/**
 * Nome do repositório PRINCIPAL, para que worktrees vinculados e
 * subdiretórios colapsem num único projeto.
 *
 * Isto roda no host por necessidade, não por conveniência: o servidor em
 * container não enxerga o checkout, sua descoberta via libgit2 falha, e ele
 * cai em `basename(cwd)` — o que faria cada worktree virar um projeto
 * separado. Como o nosso servidor está em Docker, este caminho é o único
 * que funciona.
 *
 * `--git-common-dir` aponta para o `.git` compartilhado: num worktree ele
 * aponta para o `.git` do repositório principal, então o pai dele é sempre
 * a raiz principal.
 */
export function repoRootProject(cwd: string): string | undefined {
  if (git(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') {
    return undefined;
  }
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common) {
    return undefined;
  }
  const root = path.dirname(common);
  if (!root || root === path.parse(root).root) {
    return undefined;
  }
  const name = path.basename(root);
  return name === '' ? undefined : name;
}

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// resolução
// ---------------------------------------------------------------------------

/**
 * Ordem idêntica à de `ai_memory_marker_qs`:
 *
 *   1. marker declara workspace / project / project_strategy
 *   2. sem strategy no marker, o default de instalação preenche
 *   3. sem project explícito e strategy repo-root, deriva do repositório
 *   4. o que sobrar cai em basename(cwd) e workspace "default"
 *
 * Um `project` explícito no marker sempre vence a strategy.
 */
export function resolveScope(cwd: string, options: ResolveOptions = {}): ResolvedScope {
  const home = options.home !== undefined ? options.home : os.homedir();
  const resolveRepoRoot = options.repoRoot ?? repoRootProject;

  const markerPath = findMarker(cwd, home);
  const declared: MarkerDeclaration = markerPath
    ? readMarker(markerPath)
    : {
        workspace: undefined,
        project: undefined,
        projectStrategy: undefined,
        dropSubagentCaptures: undefined,
      };

  const strategy = declared.projectStrategy ?? options.defaultStrategy ?? undefined;

  let project = declared.project;
  let projectSource: ProjectSource = 'marker';

  if (project === undefined && isRepoRootStrategy(strategy)) {
    const derived = resolveRepoRoot(cwd);
    if (derived !== undefined) {
      project = derived;
      projectSource = 'repo-root';
    }
  }

  if (project === undefined) {
    project = path.basename(absoluteNormalized(cwd));
    projectSource = 'basename';
  }

  return {
    cwd,
    workspace: declared.workspace ?? 'default',
    workspaceSource: declared.workspace !== undefined ? 'marker' : 'default',
    project,
    projectSource,
    markerPath,
    projectStrategy: strategy,
  };
}

function isRepoRootStrategy(strategy: string | undefined): boolean {
  return strategy === 'repo-root' || strategy === 'repo_root';
}

/** Resolve cada pasta de um workspace multi-root, preservando a ordem. */
export function resolveScopes(cwds: readonly string[], options: ResolveOptions = {}): ResolvedScope[] {
  return cwds.map((cwd) => resolveScope(cwd, options));
}

// ---------------------------------------------------------------------------
// validação contra o servidor
// ---------------------------------------------------------------------------

/** Item de `GET /api/v1/projects` — array puro, ver docs/api-shapes.md. */
export interface KnownProject {
  readonly workspace_name: string;
  readonly project_name: string;
}

/**
 * O palpite local vale pouco sozinho. Um escopo que não existe no servidor
 * precisa ser dito ao usuário, nunca renderizado como árvore vazia — uma
 * árvore vazia é indistinguível de um projeto sem páginas.
 */
export function isKnownProject(
  scope: ResolvedScope,
  projects: readonly KnownProject[],
): boolean {
  return projects.some(
    (p) => p.workspace_name === scope.workspace && p.project_name === scope.project,
  );
}

/** Linha de log do §8: `workspace=… project=… source=…`. */
export function describeScope(scope: ResolvedScope): string {
  const marker = scope.markerPath ? ` marker=${scope.markerPath}` : '';
  const strategy = scope.projectStrategy ? ` strategy=${scope.projectStrategy}` : '';
  return `workspace=${scope.workspace} project=${scope.project} source=${scope.projectSource}${strategy}${marker}`;
}

// ---------------------------------------------------------------------------
// caminhos
// ---------------------------------------------------------------------------

/** Equivalente de `absolute_normalized`: canonicaliza, com fallback absoluto. */
function absoluteNormalized(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

/**
 * `Path::starts_with` do Rust, componente a componente — caminhos iguais
 * contam como "dentro".
 */
function isUnder(child: string, parent: string): boolean {
  const c = splitComponents(child);
  const p = splitComponents(parent);
  if (p.length > c.length) {
    return false;
  }
  return p.every((segment, i) => segment === c[i]);
}

function splitComponents(p: string): string[] {
  return normalizeForCompare(p)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
}

/**
 * Divergência deliberada do Rust: no Windows a comparação ignora caixa.
 *
 * `Path::starts_with` é sensível a caixa, mas o NTFS não é — e `$HOME`
 * chega com caixa variável dependendo de quem o produziu (`os.homedir()`,
 * variável de ambiente, caminho digitado). Ser mais estrito que o sistema
 * de arquivos produziria uma fronteira que falha em achar `$HOME`, fazendo
 * o walk subir demais. Errar para o lado do sistema de arquivos é o
 * comportamento correto aqui.
 */
function normalizeForCompare(p: string): string {
  const normalized = path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
