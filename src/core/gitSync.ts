import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { logger } from './logger';
import {
  MANIFEST_FILE,
  SYNC_ROOT,
  parseMemoryBundle,
  readMemoryBundle,
  writeMemoryBundle,
  type MemoryBundle,
} from './memorySync';

const execFileAsync = promisify(execFile);

export class GitSyncError extends Error {
  constructor(
    message: string,
    readonly kind: 'git-missing' | 'authentication' | 'remote' | 'dirty' | 'command',
  ) {
    super(message);
    this.name = 'GitSyncError';
  }
}

export interface GitHistoryEntry {
  readonly commit: string;
  readonly at: string;
  readonly subject: string;
}

export class SyncRepository {
  constructor(
    readonly directory: string,
    readonly remoteUrl: string,
    readonly branch: string,
  ) {
    validateBranch(branch);
  }

  async initialize(): Promise<void> {
    fs.mkdirSync(this.directory, { recursive: true });
    if (!fs.existsSync(path.join(this.directory, '.git'))) {
      await git(['init', '--initial-branch', this.branch], this.directory, 'inicializar cache');
    }
    await git(['config', 'user.name', 'AI Memory VS Code'], this.directory, 'configurar autor');
    await git(['config', 'user.email', 'ai-memory@localhost'], this.directory, 'configurar autor');
    // O hash do manifesto cobre bytes do Markdown. Conversão automática de
    // LF/CRLF no checkout faria um arquivo íntegro parecer corrompido.
    await git(['config', 'core.autocrlf', 'false'], this.directory, 'configurar line endings');

    const remote = await gitOptional(['remote', 'get-url', 'origin'], this.directory);
    if (remote === undefined) {
      await git(['remote', 'add', 'origin', this.remoteUrl], this.directory, 'configurar remoto');
    } else if (remote.trim() !== this.remoteUrl) {
      await git(['remote', 'set-url', 'origin', this.remoteUrl], this.directory, 'atualizar remoto');
    }

    if (await this.isDirty()) {
      throw new GitSyncError(
        'o cache interno possui uma operação incompleta; abra o log antes de continuar',
        'dirty',
      );
    }
  }

  async fetchRemote(): Promise<string | undefined> {
    const ref = `refs/heads/${this.branch}`;
    const found = await git(['ls-remote', '--heads', 'origin', ref], this.directory, 'consultar branch');
    const commit = found.trim().split(/\s+/)[0];
    if (!commit) {
      return undefined;
    }
    await git(
      ['fetch', '--no-tags', 'origin', `+${ref}:refs/remotes/origin/${this.branch}`],
      this.directory,
      'baixar branch',
    );
    return commit;
  }

  async head(): Promise<string | undefined> {
    return gitOptional(['rev-parse', '--verify', 'HEAD'], this.directory);
  }

  async checkoutRemote(remoteCommit: string): Promise<void> {
    const tracked = await this.remoteTrackingCommit();
    if (tracked !== remoteCommit) {
      throw new GitSyncError('a branch remota mudou durante a sincronização; tente novamente', 'remote');
    }
    await git(
      ['checkout', '-B', this.branch, `refs/remotes/origin/${this.branch}`],
      this.directory,
      'atualizar cache',
    );
  }

  async readBundleAt(revision: string): Promise<MemoryBundle> {
    const manifest = await this.show(revision, MANIFEST_FILE);
    return parseMemoryBundle(manifest, (pagePath) =>
      this.show(revision, `${SYNC_ROOT}/pages/${pagePath}`),
    );
  }

  /** `undefined` significa branch válida ainda sem o protocolo, nunca bundle corrompido. */
  async readBundleAtOrUndefined(revision: string): Promise<MemoryBundle | undefined> {
    // Primeiro prova que a revisão existe. Sem isto um cache quebrado seria
    // confundido com uma branch nova e o próximo push poderia ocultar o erro.
    await git(['cat-file', '-e', `${revision}^{commit}`], this.directory, 'validar versão');
    const manifestExists = await gitExitCode(
      ['cat-file', '-e', `${revision}:${MANIFEST_FILE}`],
      this.directory,
    );
    if (manifestExists === 1) {
      return undefined;
    }
    if (manifestExists !== 0) {
      throw new GitSyncError('não foi possível validar o manifesto remoto', 'command');
    }
    return this.readBundleAt(revision);
  }

  async readWorkingBundle(): Promise<MemoryBundle> {
    return readMemoryBundle(this.directory);
  }

  writeBundle(bundle: MemoryBundle): void {
    writeMemoryBundle(this.directory, bundle);
  }

  async commit(message: string): Promise<string | undefined> {
    await git(['add', '--', SYNC_ROOT], this.directory, 'preparar memória');
    const changed = await gitExitCode(['diff', '--cached', '--quiet'], this.directory);
    if (changed === 0) {
      return this.head();
    }
    if (changed !== 1) {
      throw new GitSyncError('não foi possível comparar as alterações de memória', 'command');
    }
    await git(['commit', '-m', message], this.directory, 'criar versão');
    return this.head();
  }

  async push(): Promise<string> {
    await git(
      ['push', 'origin', `HEAD:refs/heads/${this.branch}`],
      this.directory,
      'enviar memória',
    );
    const head = await this.head();
    if (!head) {
      throw new GitSyncError('o Git não devolveu o commit publicado', 'command');
    }
    return head;
  }

  async history(limit = 30): Promise<GitHistoryEntry[]> {
    const head = await this.head();
    if (!head) {
      return [];
    }
    const output = await git(
      ['log', `-${limit}`, '--format=%H%x09%cI%x09%s'],
      this.directory,
      'ler histórico',
    );
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [commit = '', at = '', ...subject] = line.split('\t');
        return { commit, at, subject: subject.join('\t') };
      });
  }

  private async show(revision: string, file: string): Promise<string> {
    return git(['show', `${revision}:${gitPath(file)}`], this.directory, 'ler versão');
  }

  private async remoteTrackingCommit(): Promise<string | undefined> {
    return gitOptional(
      ['rev-parse', '--verify', `refs/remotes/origin/${this.branch}`],
      this.directory,
    );
  }

  private async isDirty(): Promise<boolean> {
    const status = await git(['status', '--porcelain'], this.directory, 'verificar cache');
    return status.trim().length > 0;
  }
}

export async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function inferOrigin(cwd: string): Promise<string | undefined> {
  return gitOptional(['remote', 'get-url', 'origin'], cwd);
}

export async function listRemoteBranches(remoteUrl: string, cwd: string): Promise<string[]> {
  const output = await git(['ls-remote', '--heads', remoteUrl], cwd, 'listar branches');
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/refs\/heads\/(.+)$/)?.[1])
    .filter((branch): branch is string => branch !== undefined)
    .sort();
}

export function validateBranch(branch: string): void {
  if (
    branch.length === 0 ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    /[\s~^:?*\\\[\]]/.test(branch) ||
    branch.split('/').some((part) => part.length === 0 || part.startsWith('.') || part.endsWith('.lock'))
  ) {
    throw new Error(`nome de branch inválido: ${branch}`);
  }
}

function gitPath(file: string): string {
  return file.replaceAll('\\', '/');
}

async function git(args: readonly string[], cwd: string, operation: string): Promise<string> {
  logger.info(`GitHub Sync: ${operation}`);
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  } catch (error) {
    throw translateGitError(error, operation);
  }
}

async function gitOptional(args: readonly string[], cwd: string): Promise<string | undefined> {
  try {
    return await git(args, cwd, 'consultar repositório');
  } catch {
    return undefined;
  }
}

async function gitExitCode(args: readonly string[], cwd: string): Promise<number> {
  try {
    await execFileAsync('git', [...args], {
      cwd,
      timeout: 30000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return 0;
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    return typeof code === 'number' ? code : -1;
  }
}

function translateGitError(error: unknown, operation: string): GitSyncError {
  const value = error as { code?: number | string; stderr?: string; message?: string };
  if (value.code === 'ENOENT') {
    return new GitSyncError('Git não foi encontrado nesta máquina', 'git-missing');
  }
  const detail = redactCredentials(value.stderr || value.message || String(error)).trim().slice(0, 800);
  const lower = detail.toLowerCase();
  const kind =
    lower.includes('authentication') ||
    lower.includes('could not read username') ||
    lower.includes('permission denied')
      ? 'authentication'
      : lower.includes('repository not found') || lower.includes('remote repository')
        ? 'remote'
        : 'command';
  return new GitSyncError(`${operation} falhou${detail ? `: ${detail}` : ''}`, kind);
}

function redactCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***@');
}
