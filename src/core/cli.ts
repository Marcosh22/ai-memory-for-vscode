import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

/**
 * Detecção do binário `ai-memory`.
 *
 * O binário é OPCIONAL. Quem instala por Docker — o caminho recomendado pelo
 * upstream, e o nosso — normalmente não tem `ai-memory` no PATH. A extensão
 * funciona inteira sem ele nas fatias 1 e 2, porque toda a leitura é HTTP.
 * Ele só passa a ser necessário na fatia 3, quando entra escrita.
 *
 * Por isso a ausência é um estado normal, reportado como informação, não
 * como erro.
 */

export interface CliStatus {
  readonly available: true;
  readonly version: string | undefined;
  readonly dataDir: string | undefined;
}

export interface CliMissing {
  readonly available: false;
  readonly reason: string;
}

export type CliProbe = CliStatus | CliMissing;

/**
 * `ai-memory status --json`. Não contata o servidor — reporta o estado local
 * do binário e do data dir.
 */
export async function probeCli(timeoutMs = 5000): Promise<CliProbe> {
  try {
    const { stdout } = await execFileAsync('ai-memory', ['status', '--json'], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const parsed = parseStatus(stdout);
    logger.info(`CLI detectado  version=${parsed.version ?? 'desconhecida'}`);
    return { available: true, ...parsed };
  } catch (error) {
    const reason = describeSpawnError(error);
    logger.info(`CLI ausente  ${reason}`);
    return { available: false, reason };
  }
}

function parseStatus(stdout: string): { version: string | undefined; dataDir: string | undefined } {
  try {
    const json = JSON.parse(stdout) as Record<string, unknown>;
    return {
      version: typeof json['version'] === 'string' ? json['version'] : undefined,
      dataDir: typeof json['data_dir'] === 'string' ? json['data_dir'] : undefined,
    };
  } catch {
    // Binário presente mas saída inesperada — ainda conta como disponível.
    return { version: undefined, dataDir: undefined };
  }
}

function describeSpawnError(error: unknown): string {
  const code = (error as { code?: string | number } | undefined)?.code;
  if (code === 'ENOENT') {
    return 'não encontrado no PATH';
  }
  if (code === 'ETIMEDOUT') {
    return 'timeout';
  }
  return typeof code === 'string' ? code : String(code ?? error);
}
