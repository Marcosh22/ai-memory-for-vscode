import * as vscode from 'vscode';
import { setLogger } from './logger';

/**
 * Output Channel dedicado, conforme §8 do plano.
 *
 * Regra dura: o log serve para diagnosticar transporte e escopo. Nunca
 * registra token, header Authorization, corpo de resposta, conteúdo de
 * página, texto de handoff ou dado de usuário. Numa instalação de time um
 * log verboso vira vazamento entre operadores.
 *
 * O scrub abaixo é defesa em profundidade — o caminho correto é simplesmente
 * não passar segredo para cá.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[\w\-._~+/]+=*/gi, 'Bearer <redacted>'],
  [/\b(token|authorization|secret|password)\s*[=:]\s*\S+/gi, '$1=<redacted>'],
];

function scrub(message: string): string {
  return SECRET_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    message,
  );
}

class Logger {
  private channel: vscode.LogOutputChannel | undefined;

  init(context: vscode.ExtensionContext): void {
    this.channel = vscode.window.createOutputChannel('AI Memory', { log: true });
    context.subscriptions.push(this.channel);
    // A partir daqui os módulos puros passam a escrever no canal real.
    setLogger(this);
  }

  info(message: string): void {
    this.channel?.info(scrub(message));
  }

  warn(message: string): void {
    this.channel?.warn(scrub(message));
  }

  error(message: string): void {
    this.channel?.error(scrub(message));
  }

  show(): void {
    this.channel?.show(true);
  }
}

export const log = new Logger();
