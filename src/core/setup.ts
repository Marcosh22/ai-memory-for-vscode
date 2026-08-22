import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { logger } from './logger';
import { MARKER_START } from './routing';

const execFileAsync = promisify(execFile);

/**
 * Detecção e execução do onboarding.
 *
 * ## Por que existe
 *
 * A §2 do plano diz que a extensão existe para resolver **configuração** —
 * mas a primeira versão resolvia só o registro MCP do Copilot. Ligar a
 * captura do Claude Code continuava sendo quatro passos manuais de terminal,
 * o que contradiz a própria tese: sem captura, a memória fica vazia para
 * sempre e todas as superfícies de leitura mostram nada.
 *
 * Este módulo detecta o que falta e executa o que dá para executar. Nada aqui
 * roda sozinho: cada ação é disparada explicitamente pelo usuário, porque
 * mexem em config global (`~/.claude/`) ou no repositório.
 *
 * A execução é sempre delegada ao CLI do ai-memory. Reimplementar
 * `install-hooks` em TypeScript seria copiar a parte mais difícil do upstream
 * e garantir divergência na primeira atualização.
 */

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** De onde veio: informação para o log e para a UI. */
  readonly source: 'path' | 'managed';
}

// ---------------------------------------------------------------------------
// detecção
// ---------------------------------------------------------------------------

/** Hooks de ciclo de vida do Claude Code apontando para o ai-memory. */
export function detectClaudeHooks(homeDir: string): boolean {
  const settings = readJson(path.join(homeDir, '.claude', 'settings.json'));
  if (!settings || typeof settings !== 'object') {
    return false;
  }
  const hooks = (settings as Record<string, unknown>)['hooks'];
  return hooks !== undefined && containsConfigValue(hooks, 'ai-memory');
}

/**
 * Os hooks carregam credencial?
 *
 * Verificação de pós-condição, não decoração. Se o servidor exige auth e o
 * token não foi embutido nos comandos de hook, cada evento toma `401` e a
 * captura para — **sem erro visível em lugar nenhum**. É o pior modo de falha
 * de todo o setup: tudo parece instalado e a memória nunca enche.
 */
export function detectClaudeHooksAuth(homeDir: string, token: string): boolean {
  const settings = readJson(path.join(homeDir, '.claude', 'settings.json'));
  const hooks = (settings as Record<string, unknown> | undefined)?.['hooks'];
  return hooks !== undefined && containsConfigValue(hooks, token);
}

/** Quantidade de grupos de hook que pertencem ao ai-memory. */
export function countClaudeHooks(homeDir: string): number {
  const settings = readJson(path.join(homeDir, '.claude', 'settings.json'));
  const hooks = (settings as Record<string, unknown> | undefined)?.['hooks'];
  if (!hooks || typeof hooks !== 'object') {
    return 0;
  }
  let count = 0;
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    count += groups.filter((group) => containsConfigValue(group, 'ai-memory')).length;
  }
  return count;
}

/**
 * Remove apenas grupos idênticos do ai-memory e preserva hooks de terceiros.
 * Retorna o backup criado, ou undefined quando não havia duplicatas.
 */
export function deduplicateClaudeHooks(homeDir: string): string | undefined {
  const target = path.join(homeDir, '.claude', 'settings.json');
  const settings = readJson(target);
  if (!settings || typeof settings !== 'object') {
    return undefined;
  }
  const root = settings as Record<string, unknown>;
  const hooks = root['hooks'];
  if (!hooks || typeof hooks !== 'object') {
    return undefined;
  }

  let changed = false;
  const nextHooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups;
      continue;
    }
    const seen = new Set<string>();
    nextHooks[event] = groups.filter((group) => {
      if (!containsConfigValue(group, 'ai-memory')) {
        return true;
      }
      const signature = JSON.stringify(group);
      if (seen.has(signature)) {
        changed = true;
        return false;
      }
      seen.add(signature);
      return true;
    });
  }
  if (!changed) {
    return undefined;
  }

  const backup = `${target}.ai-memory-backup-${Date.now()}`;
  fs.copyFileSync(target, backup);
  root['hooks'] = nextHooks;
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
  return backup;
}

/** Entrada MCP do ai-memory na config do Claude Code. */
export function detectClaudeMcp(homeDir: string): boolean {
  const config = readJson(path.join(homeDir, '.claude.json'));
  if (!config || typeof config !== 'object') {
    return false;
  }
  const servers = (config as Record<string, unknown>)['mcpServers'];
  if (!servers || typeof servers !== 'object') {
    return false;
  }
  return Object.keys(servers as Record<string, unknown>).some((name) => name.includes('ai-memory'));
}

/** Diretório de configuração compartilhado pelo Codex CLI e pela extensão IDE. */
export function codexConfigDir(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env['CODEX_HOME']?.trim();
  return configured ? path.resolve(configured) : path.join(homeDir, '.codex');
}

/** Entrada MCP do ai-memory na configuração TOML do Codex. */
export function detectCodexMcp(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const config = readText(path.join(codexConfigDir(homeDir, env), 'config.toml'));
  return (
    config !== undefined &&
    /^\s*\[\s*mcp_servers\s*\.\s*(?:ai-memory|"ai-memory"|'ai-memory')\s*\]\s*(?:#.*)?$/m.test(
      config,
    )
  );
}

/** Hooks do ai-memory em hooks.json ou na forma TOML aceita pelo Codex. */
export function detectCodexHooks(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configDir = codexConfigDir(homeDir, env);
  const json = readJson(path.join(configDir, 'hooks.json'));
  if (json && typeof json === 'object' && containsConfigValue(json, 'ai-memory')) {
    return true;
  }

  const toml = readText(path.join(configDir, 'config.toml'));
  return (
    toml !== undefined &&
    /^\s*\[\[?hooks(?:\.|\])/m.test(toml) &&
    containsConfigValue(toml, 'ai-memory')
  );
}

/** Verifica se a credencial foi incorporada aos hooks do Codex. */
export function detectCodexHooksAuth(
  homeDir: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configDir = codexConfigDir(homeDir, env);
  const hooksJson = readText(path.join(configDir, 'hooks.json'));
  if (hooksJson && containsConfigValue(hooksJson, 'ai-memory')) {
    return containsConfigValue(hooksJson, token);
  }

  const toml = readText(path.join(configDir, 'config.toml'));
  return (
    toml !== undefined &&
    /^\s*\[\[?hooks(?:\.|\])/m.test(toml) &&
    containsConfigValue(toml, 'ai-memory') &&
    containsConfigValue(toml, token)
  );
}

/** Bloco de roteamento nas instruções que o Copilot lê. */
export function detectCopilotRouting(folderPath: string): boolean {
  return detectRoutingFile(path.join(folderPath, '.github', 'copilot-instructions.md'));
}

/** Bloco de roteamento no AGENTS.md lido pelo Codex. */
export function detectCodexRouting(folderPath: string): boolean {
  return detectRoutingFile(path.join(folderPath, 'AGENTS.md'));
}

function detectRoutingFile(target: string): boolean {
  try {
    const text = fs.readFileSync(target, 'utf8');
    return text.split(/\r?\n/).some((line) => line.trim() === MARKER_START);
  } catch {
    return false;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Procura uma assinatura inclusive dentro de `powershell -EncodedCommand`.
 * O wrapper Windows usa UTF-16LE/Base64 para impedir que o shell externo
 * expanda `$env:` antes da hora; a configuração instalada é válida, mas uma
 * busca textual simples não consegue reconhecê-la.
 */
function containsConfigValue(value: unknown, needle: string): boolean {
  if (typeof value === 'string') {
    if (value.includes(needle)) {
      return true;
    }
    const encoded = value.match(/(?:^|\s)-(?:EncodedCommand|enc)\s+["']?([A-Za-z0-9+/=]+)/i)?.[1];
    if (!encoded) {
      return false;
    }
    try {
      return Buffer.from(encoded, 'base64').toString('utf16le').includes(needle);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsConfigValue(item, needle));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) =>
      containsConfigValue(item, needle),
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const WRAPPER_BASE = 'https://github.com/akitaonrails/ai-memory/releases/latest/download';

function wrapperAsset(): { asset: string; file: string } {
  return process.platform === 'win32'
    ? { asset: 'ai-memory-wrapper.ps1', file: 'ai-memory.ps1' }
    : { asset: 'ai-memory-wrapper', file: 'ai-memory' };
}

export function managedWrapperPath(storageDir: string): string {
  return path.join(storageDir, wrapperAsset().file);
}

/**
 * Resolve como invocar o CLI: primeiro o que estiver no PATH, senão a cópia
 * que a extensão gerencia.
 *
 * A cópia gerenciada vive no storage da extensão e é chamada por caminho
 * absoluto — assim o onboarding não precisa alterar o PATH do usuário, que é
 * uma mudança global, persistente e que exige terminal novo para valer.
 */
export async function resolveCli(storageDir: string): Promise<CommandSpec | undefined> {
  if (await commandWorks('ai-memory', ['--version'])) {
    return { command: 'ai-memory', args: [], source: 'path' };
  }

  const managed = managedWrapperPath(storageDir);
  if (!fs.existsSync(managed)) {
    return undefined;
  }

  return process.platform === 'win32'
    ? {
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', managed],
        source: 'managed',
      }
    : { command: managed, args: [], source: 'managed' };
}

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 15000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Baixa o wrapper oficial e confere o SHA-256 publicado.
 *
 * A verificação não é cerimônia: o arquivo baixado vira um script executável
 * na máquina do usuário. Baixar e executar sem conferir seria entregar
 * execução de código a qualquer coisa que consiga se pôr no meio.
 */
export async function downloadWrapper(storageDir: string): Promise<string> {
  const { asset, file } = wrapperAsset();
  const destination = path.join(storageDir, file);

  logger.info(`baixando wrapper do ai-memory: ${asset}`);
  const [payload, checksumText] = await Promise.all([
    fetchBuffer(`${WRAPPER_BASE}/${asset}`),
    fetchText(`${WRAPPER_BASE}/${asset}.sha256`),
  ]);

  const expected = checksumText.trim().split(/\s+/)[0]?.toLowerCase();
  const actual = createHash('sha256').update(payload).digest('hex');
  if (!expected || expected !== actual) {
    throw new Error(`checksum do ${asset} não confere — download descartado`);
  }

  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(destination, payload);
  if (process.platform !== 'win32') {
    fs.chmodSync(destination, 0o755);
  }
  logger.info(`wrapper instalado em ${destination}`);
  return destination;
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }
  return response.text();
}

// ---------------------------------------------------------------------------
// execução
// ---------------------------------------------------------------------------

export interface CliRun {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Roda um subcomando do CLI. O token vai por ambiente, nunca por argumento —
 * argumentos aparecem na lista de processos do sistema.
 */
export async function runCli(
  spec: CommandSpec,
  args: readonly string[],
  options: {
    readonly token?: string | undefined;
    readonly serverUrl?: string | undefined;
    readonly cwd?: string | undefined;
  } = {},
): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.token) {
    env['AI_MEMORY_AUTH_TOKEN'] = options.token;
  }
  if (options.serverUrl) {
    env['AI_MEMORY_SERVER_URL'] = options.serverUrl;
  }

  logger.info(`ai-memory ${args.join(' ')}`);
  try {
    const { stdout, stderr } = await execFileAsync(spec.command, [...spec.args, ...args], {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env,
      cwd: options.cwd,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    logger.warn(`ai-memory ${args[0] ?? ''} falhou: ${(err.stderr || err.message || '').slice(0, 400)}`);
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}
