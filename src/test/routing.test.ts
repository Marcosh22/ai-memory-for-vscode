import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyRoutingBlock, MARKER_END, MARKER_START } from '../core/routing';

/**
 * Este módulo escreve num arquivo do repositório do usuário. As regras vêm
 * das `notes` que a própria tool `memory_install_self_routing` documenta, e
 * cada uma tem um teste — corromper o `.github/copilot-instructions.md` de
 * alguém seria um estrago difícil de perceber e chato de desfazer.
 */

const BLOCK = `${MARKER_START}\n## Long-term memory (ai-memory)\n\nconteúdo do bloco.\n${MARKER_END}`;

describe('arquivo ausente', () => {
  it('cria com o bloco e newline final', () => {
    const patch = applyRoutingBlock(undefined, BLOCK);
    assert.ok(patch.ok);
    assert.equal(patch.action, 'created');
    assert.equal(patch.content, `${BLOCK}\n`);
  });
});

describe('arquivo sem marcadores', () => {
  it('anexa separado por uma linha em branco', () => {
    const patch = applyRoutingBlock('# Instruções do projeto\n\nUse TypeScript estrito.\n', BLOCK);
    assert.ok(patch.ok);
    assert.equal(patch.action, 'appended');
    assert.match(patch.content, /Use TypeScript estrito\.\n\n<!-- ai-memory:start -->/);
    assert.ok(patch.content.endsWith('\n'));
  });

  it('arquivo vazio não ganha separador espúrio', () => {
    const patch = applyRoutingBlock('', BLOCK);
    assert.ok(patch.ok);
    assert.equal(patch.content, `${BLOCK}\n`);
  });
});

describe('arquivo com marcadores', () => {
  it('substitui apenas o bloco e preserva o resto', () => {
    const existing = [
      '# Instruções',
      '',
      'Antes do bloco.',
      '',
      MARKER_START,
      'bloco antigo, desatualizado',
      MARKER_END,
      '',
      'Depois do bloco.',
      '',
    ].join('\n');

    const patch = applyRoutingBlock(existing, BLOCK);
    assert.ok(patch.ok);
    assert.equal(patch.action, 'replaced');
    assert.match(patch.content, /Antes do bloco\./);
    assert.match(patch.content, /Depois do bloco\./);
    assert.match(patch.content, /conteúdo do bloco\./);
    assert.doesNotMatch(patch.content, /bloco antigo/);
  });

  it('reaplicar o mesmo bloco não altera nada', () => {
    const first = applyRoutingBlock('# Título\n', BLOCK);
    assert.ok(first.ok);
    const second = applyRoutingBlock(first.content, BLOCK);
    assert.ok(second.ok);
    assert.equal(second.action, 'unchanged');
    assert.equal(second.content, first.content);
  });

  it('ignora menção inline dos marcadores', () => {
    // Um marcador citado dentro de uma frase ou de um exemplo de código não
    // delimita bloco nenhum — a tool documenta essa regra explicitamente.
    const existing = [
      '# Instruções',
      '',
      `O bloco é delimitado por \`${MARKER_START}\` e \`${MARKER_END}\`.`,
      '',
    ].join('\n');

    const patch = applyRoutingBlock(existing, BLOCK);
    assert.ok(patch.ok);
    assert.equal(patch.action, 'appended', 'menção inline não pode ser tratada como delimitador');
    assert.match(patch.content, /O bloco é delimitado por/);
  });
});

describe('estados ambíguos são recusados', () => {
  it('marcador de início órfão', () => {
    const patch = applyRoutingBlock(`# T\n\n${MARKER_START}\nalgo\n`, BLOCK);
    assert.equal(patch.ok, false);
  });

  it('dois pares de marcadores', () => {
    const existing = [MARKER_START, 'a', MARKER_END, '', MARKER_START, 'b', MARKER_END, ''].join('\n');
    const patch = applyRoutingBlock(existing, BLOCK);
    assert.equal(patch.ok, false);
  });

  it('fim antes do início', () => {
    const patch = applyRoutingBlock([MARKER_END, 'x', MARKER_START].join('\n'), BLOCK);
    assert.equal(patch.ok, false);
  });

  it('bloco do servidor sem marcadores é rejeitado', () => {
    const patch = applyRoutingBlock('# T\n', 'texto solto sem delimitadores');
    assert.equal(patch.ok, false);
  });
});

describe('quebras de linha', () => {
  it('preserva CRLF do arquivo existente', () => {
    // No Windows, reescrever um arquivo CRLF com LF marca TODAS as linhas
    // como alteradas no diff — ruído que esconde a mudança real.
    const existing = ['# Instruções', '', 'Linha preservada.', ''].join('\r\n');
    const patch = applyRoutingBlock(existing, BLOCK);

    assert.ok(patch.ok);
    assert.ok(patch.content.includes('\r\n'), 'CRLF precisa sobreviver');
    assert.doesNotMatch(
      patch.content.replace(/\r\n/g, ''),
      /\n/,
      'não pode sobrar nenhuma quebra LF solta num arquivo CRLF',
    );
  });

  it('mantém LF em arquivo LF', () => {
    const patch = applyRoutingBlock('# Instruções\n\nLinha.\n', BLOCK);
    assert.ok(patch.ok);
    assert.doesNotMatch(patch.content, /\r/);
  });

  it('substituição em arquivo CRLF também sai em CRLF', () => {
    const existing = ['# T', '', MARKER_START, 'velho', MARKER_END, ''].join('\r\n');
    const patch = applyRoutingBlock(existing, BLOCK);
    assert.ok(patch.ok);
    assert.equal(patch.action, 'replaced');
    assert.doesNotMatch(patch.content.replace(/\r\n/g, ''), /\n/);
  });
});
