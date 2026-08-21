import * as assert from 'node:assert/strict';
import { before, describe, it, type TestContext } from 'node:test';

import { ApiError } from '../core/client';
import { callTool, fetchRoutingBlock } from '../core/mcp';
import { applyRoutingBlock, MARKER_END, MARKER_START } from '../core/routing';
import { detectServer, live } from './support';

/**
 * O bloco de roteamento vem do servidor, não de uma cópia embutida na
 * extensão. Estes testes verificam esse caminho inteiro — a chamada MCP, o
 * desembrulho do payload e o encaixe no patch — contra um servidor real.
 *
 * Se o upstream mudar a forma de `memory_install_self_routing`, é aqui que
 * aparece, e não em silêncio na hora de escrever no repositório de alguém.
 */

before(detectServer);

describe('fetchRoutingBlock', () => {
  it('traz o bloco canônico já delimitado pelos marcadores', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    const block = await fetchRoutingBlock(ctx);

    assert.ok(block.trim().startsWith(MARKER_START), 'o bloco precisa abrir com o marcador de início');
    assert.ok(block.trim().endsWith(MARKER_END), 'o bloco precisa fechar com o marcador de fim');
    assert.ok(block.length > 500, 'bloco suspeitosamente curto');
    assert.match(block, /ai-memory/, 'o bloco precisa falar do ai-memory');
  });

  it('o bloco do servidor passa direto pelo patch, sem ajuste', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    // A junção que importa: o que o servidor devolve tem que ser aceito pelo
    // applyRoutingBlock sem nenhuma normalização no meio do caminho.
    const block = await fetchRoutingBlock(ctx);

    const created = applyRoutingBlock(undefined, block);
    assert.ok(created.ok, created.ok ? '' : created.reason);
    assert.equal(created.action, 'created');

    // E reinstalar é no-op, que é a propriedade que torna o comando seguro
    // de rodar de novo.
    const again = applyRoutingBlock(created.content, block);
    assert.ok(again.ok);
    assert.equal(again.action, 'unchanged');
  });

  it('preserva conteúdo do usuário ao redor do bloco', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    const block = await fetchRoutingBlock(ctx);
    const existing = '# Instruções do projeto\n\nSempre usar TypeScript estrito.\n';

    const patch = applyRoutingBlock(existing, block);
    assert.ok(patch.ok);
    assert.equal(patch.action, 'appended');
    assert.match(patch.content, /Sempre usar TypeScript estrito\./);
  });
});

describe('callTool', () => {
  it('desembrulha o JSON aninhado em content[].text', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    const payload = await callTool<{ counts?: Record<string, number> }>('memory_status', {}, ctx);
    assert.ok(payload.counts, 'memory_status precisa devolver counts já desembrulhado');
  });

  it('tool inexistente vira ApiError, não exceção crua', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    // memory_search não existe — é o nome que o doc do upstream sugere e que
    // custou tempo no spike.
    await assert.rejects(
      () => callTool('memory_search', { q: 'x' }, ctx),
      (error: unknown) => error instanceof ApiError,
    );
  });

  it('sem token vira unauthorized quando o servidor exige auth', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    if (!ctx.token) {
      t.skip('servidor sem auth configurada');
      return;
    }
    await assert.rejects(
      () => callTool('memory_status', {}, { baseUrl: ctx.baseUrl, token: undefined }),
      (error: unknown) => error instanceof ApiError && error.kind === 'unauthorized',
    );
  });
});
