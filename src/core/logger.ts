/**
 * Seam de log, sem dependência do `vscode`.
 *
 * Existe para que `client.ts`, `cli.ts` e `scope.ts` — a lógica que vale a
 * pena testar — rodem em Node puro. Antes disso eles importavam `log.ts`, que
 * importa `vscode`, e qualquer teste fora do extension host falhava no
 * import. O módulo `log.ts` registra a implementação real na ativação.
 *
 * O contrato de segurança do §8 do plano continua valendo em qualquer
 * implementação: nunca registrar token, header de autorização, corpo de
 * resposta ou conteúdo de memória.
 */

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Padrão silencioso: em teste e fora do editor não há para onde escrever. */
const silent: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

let active: Logger = silent;

export function setLogger(logger: Logger): void {
  active = logger;
}

export const logger: Logger = {
  info: (message) => active.info(message),
  warn: (message) => active.warn(message),
  error: (message) => active.error(message),
};
