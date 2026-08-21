/**
 * Patch idempotente do bloco de roteamento do ai-memory num arquivo de
 * instruções.
 *
 * ## Por que existe
 *
 * Publicar as tools MCP não faz o modelo escolhê-las. Descoberto no spike: um
 * pedido genérico como "estado da memória" é roteado para a ferramenta de
 * memória EMBUTIDA do Copilot, não para o ai-memory — e a resposta vem com
 * confiança, usando a memória errada, sem nada indicando o erro.
 *
 * O upstream resolve isso com um bloco de uso nas instruções do projeto
 * (`ai-memory install-instructions` / `memory_install_self_routing`), mas os
 * alvos são `CLAUDE.md` e `AGENTS.md`. Nenhum dos dois escreve em
 * `.github/copilot-instructions.md`, então o mecanismo de roteamento do
 * upstream não alcança o Copilot. Este módulo fecha essa lacuna.
 *
 * O TEXTO do bloco não mora aqui: vem do servidor, via
 * `memory_install_self_routing`, que é a fonte única do upstream. Copiá-lo
 * para cá garantiria divergência na primeira atualização.
 *
 * As regras abaixo são as que a própria tool documenta em `notes`.
 */

export const MARKER_START = '<!-- ai-memory:start -->';
export const MARKER_END = '<!-- ai-memory:end -->';

export type RoutingAction = 'created' | 'replaced' | 'appended' | 'unchanged';

export type RoutingPatch =
  | { readonly ok: true; readonly content: string; readonly action: RoutingAction }
  /** Estado ambíguo: melhor recusar que corromper o arquivo de alguém. */
  | { readonly ok: false; readonly reason: string };

/**
 * Aplica `block` a `existing`.
 *
 * - arquivo ausente        → só o bloco, com newline final
 * - sem marcadores         → anexa, separado por uma linha em branco
 * - com marcadores         → substitui APENAS o bloco delimitado
 * - marcadores ambíguos    → recusa
 *
 * Marcador só conta quando está sozinho na própria linha. Menção inline
 * (num exemplo de código, por exemplo) é ignorada de propósito — foi por
 * isso que a tool documentou essa regra.
 */
export function applyRoutingBlock(existing: string | undefined, block: string): RoutingPatch {
  const trimmedBlock = block.trim();
  if (!trimmedBlock.startsWith(MARKER_START) || !trimmedBlock.endsWith(MARKER_END)) {
    return { ok: false, reason: 'o bloco recebido do servidor não está delimitado pelos marcadores' };
  }

  if (existing === undefined) {
    return { ok: true, content: `${trimmedBlock}\n`, action: 'created' };
  }

  // Preserva a quebra de linha dominante do arquivo. No Windows, reescrever
  // um arquivo CRLF com LF marca todas as linhas como alteradas no diff.
  const eol = dominantEol(existing);
  const lines = existing.split(/\r?\n/);

  const starts = lines
    .map((line, index) => (line.trim() === MARKER_START ? index : -1))
    .filter((index) => index >= 0);
  const ends = lines
    .map((line, index) => (line.trim() === MARKER_END ? index : -1))
    .filter((index) => index >= 0);

  if (starts.length === 0 && ends.length === 0) {
    const base = existing.replace(/\s+$/, '');
    const separator = base.length > 0 ? `${eol}${eol}` : '';
    return {
      ok: true,
      content: `${base}${separator}${withEol(trimmedBlock, eol)}${eol}`,
      action: 'appended',
    };
  }

  if (starts.length !== 1 || ends.length !== 1) {
    return {
      ok: false,
      reason: `marcadores ai-memory ambíguos no arquivo (${starts.length} de início, ${ends.length} de fim) — ajuste à mão antes de reinstalar`,
    };
  }

  const [start] = starts as [number];
  const [end] = ends as [number];
  if (end < start) {
    return { ok: false, reason: 'o marcador de fim aparece antes do de início' };
  }

  const before = lines.slice(0, start);
  const after = lines.slice(end + 1);
  const next = [...before, ...trimmedBlock.split('\n'), ...after].join(eol);

  const normalized = next.endsWith(eol) ? next : `${next}${eol}`;
  if (normalized === existing) {
    return { ok: true, content: normalized, action: 'unchanged' };
  }
  return { ok: true, content: normalized, action: 'replaced' };
}

function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function withEol(text: string, eol: string): string {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** Frase de resultado para a UI. */
export function describeAction(action: RoutingAction, target: string): string {
  switch (action) {
    case 'created':
      return `${target} criado com o bloco de roteamento do ai-memory.`;
    case 'replaced':
      return `Bloco de roteamento atualizado em ${target}.`;
    case 'appended':
      return `Bloco de roteamento adicionado ao final de ${target}.`;
    case 'unchanged':
      return `${target} já estava atualizado.`;
  }
}
