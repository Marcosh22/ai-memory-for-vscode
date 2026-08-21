import * as vscode from 'vscode';
import { log } from './log';

/**
 * Token em SecretStorage desde o dia 1 (§9 do plano), mesmo com o servidor
 * local sem auth. O caminho de código já fica pronto para quando o servidor
 * virar compartilhado, e o token nunca encosta em settings.json.
 */

const TOKEN_KEY = 'aiMemory.authToken';

export class Secrets {
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChangeEmitter.event;

  constructor(private readonly storage: vscode.SecretStorage) {}

  async getToken(): Promise<string | undefined> {
    const value = await this.storage.get(TOKEN_KEY);
    return value && value.length > 0 ? value : undefined;
  }

  async setToken(token: string): Promise<void> {
    await this.storage.store(TOKEN_KEY, token);
    log.info('Auth token stored in SecretStorage');
    this.onChangeEmitter.fire();
  }

  async clearToken(): Promise<void> {
    await this.storage.delete(TOKEN_KEY);
    log.info('Auth token cleared from SecretStorage');
    this.onChangeEmitter.fire();
  }

  dispose(): void {
    this.onChangeEmitter.dispose();
  }
}

/**
 * Prompt de token. Só pode ser chamado de um contexto onde interação é
 * permitida — resolveMcpServerDefinition ou um comando explícito. Nunca de
 * provideMcpServerDefinitions, que a API proíbe explicitamente.
 */
export async function promptForToken(baseUrl: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Token de acesso do ai-memory',
    prompt: `O servidor em ${baseUrl} exige autenticação. Gere um token com "ai-memory generate-auth-token".`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'Cole o token aqui',
  });
}
