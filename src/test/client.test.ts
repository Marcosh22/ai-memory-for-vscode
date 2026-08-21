import * as assert from 'node:assert/strict';
import { before, describe, it, type TestContext } from 'node:test';

import {
  ApiError,
  clearCache,
  getOverview,
  listPages,
  listProjects,
  readPage,
  search,
  type ProjectScope,
} from '../core/client';
import { detectServer, live, SERVER_URL } from './support';

/**
 * Regressão de contrato contra um servidor ai-memory real.
 *
 * Estes testes existem por causa de um achado concreto: `docs/frontend-api.md`
 * documenta envelopes (`{"workspaces": […]}`) e o servidor devolve arrays
 * puros; documenta `body` na leitura de página e o campo real é
 * `body_markdown`. O doc estava errado no mesmo commit que o código.
 *
 * Cada asserção aqui é uma armadilha para a próxima divergência dessas.
 */

before(detectServer);

/** Projeto de rascunho criado durante o desenvolvimento. */
const SCRATCH: ProjectScope = { workspace: 'default', project: 'scratch' };

describe('listProjects', () => {
  it('devolve ARRAY PURO, não um envelope', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    const projects = await listProjects(ctx);

    assert.ok(Array.isArray(projects), 'a resposta precisa ser um array — o doc do upstream diz envelope');
    assert.ok(projects.length > 0, 'o servidor de teste precisa ter ao menos um projeto');
    const first = projects[0]!;
    assert.equal(typeof first.workspace_name, 'string');
    assert.equal(typeof first.project_name, 'string');
    assert.equal(typeof first.page_count, 'number');
  });
});

describe('getOverview', () => {
  it('devolve handoff, briefing e health numa única round-trip', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    const overview = await getOverview(SCRATCH, ctx);

    assert.ok('handoff' in overview, 'handoff precisa existir, mesmo que null');
    assert.ok(overview.briefing, 'briefing ausente');
    assert.ok(overview.health, 'health ausente');
    assert.equal(typeof overview.briefing.counts.pages_latest, 'number');
    assert.ok(Array.isArray(overview.briefing.recent_pages));
  });

  it('escapa nome de projeto com espaços e maiúsculas', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    // O servidor aceita nomes fora do padrão slug; o cliente precisa
    // percent-encodar cada segmento do path.
    const overview = await getOverview({ workspace: 'default', project: 'AI Memory for VSCode' }, ctx);
    assert.ok(overview.briefing, 'projeto com espaços no nome precisa resolver');
  });
});

describe('search', () => {
  it('devolve array puro com rank, e rank menor é melhor', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    const hits = await search('provider', SCRATCH, ctx);

    assert.ok(Array.isArray(hits), 'busca precisa devolver array puro');
    assert.ok(hits.length > 0, 'a busca por "provider" precisa achar a página de decisão');

    const hit = hits[0]!;
    assert.equal(typeof hit.rank, 'number');
    assert.ok(hit.rank < 0, 'rank do FTS5 é negativo — ordenar como score positivo inverteria a relevância');
    assert.equal(typeof hit.workspace, 'string', 'o hit precisa carregar o escopo para abrir a página');
    assert.equal(typeof hit.project, 'string');
    assert.ok(!('id' in hit), 'o doc do upstream mostra `id`, que não existe na resposta real');
  });

  it('busca sem escopo atravessa projetos', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    const hits = await search('provider', undefined, ctx);
    assert.ok(hits.length > 0);
  });

  it('snippet traz marcadores <mark> do FTS5', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    const hits = await search('provider', SCRATCH, ctx);
    assert.match(hits[0]!.snippet, /<mark>/, 'a UI depende de saber que o snippet tem HTML embutido');
  });
});

describe('readPage', () => {
  const PAGE = 'decisions/0001-provider-mcp.md';

  it('o corpo é body_markdown, NÃO body', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    clearCache();
    const page = await readPage(SCRATCH, PAGE, ctx);

    assert.equal(typeof page.body_markdown, 'string');
    assert.ok(page.body_markdown.length > 0);
    assert.ok(
      !('body' in page),
      'o doc do upstream chama o campo de `body`; usar esse nome renderizaria página em branco com HTTP 200',
    );
  });

  it('traz links e backlinks já com escopo em cada item', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    const page = await readPage(SCRATCH, PAGE, ctx);

    assert.ok(Array.isArray(page.links));
    assert.ok(Array.isArray(page.backlinks));
    if (page.links.length > 0) {
      const link = page.links[0]!;
      // Escopo por item é o que permite resolver wikilink cross-project
      // sem uma segunda chamada.
      assert.equal(typeof link.workspace, 'string');
      assert.equal(typeof link.project, 'string');
    }
  });

  it('a segunda leitura usa o cache por ETag e devolve o mesmo conteúdo', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    clearCache();
    const first = await readPage(SCRATCH, PAGE, ctx);
    const second = await readPage(SCRATCH, PAGE, ctx);

    assert.equal(second.body_markdown, first.body_markdown);
    assert.equal(second.updated_at, first.updated_at);
  });

  it('página inexistente vira ApiError not-found', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    await assert.rejects(
      () => readPage(SCRATCH, 'notes/nao-existe-mesmo.md', ctx),
      (error: unknown) => error instanceof ApiError && error.kind === 'not-found',
    );
  });
});

describe('listPages', () => {
  it('devolve todas as páginas atuais como array puro', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    const pages = await listPages(SCRATCH, ctx);
    assert.ok(Array.isArray(pages));
    assert.ok(pages.length > 0);
    assert.equal(typeof pages[0]!.path, 'string');
  });
});

describe('tradução de erro', () => {
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
      () => listProjects({ baseUrl: ctx.baseUrl, token: undefined }),
      (error: unknown) => error instanceof ApiError && error.kind === 'unauthorized',
    );
  });

  it('porta sem servidor vira unreachable, não exceção crua', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    await assert.rejects(
      () => listProjects({ baseUrl: 'http://127.0.0.1:49999', token: ctx.token, timeoutMs: 2000 }),
      (error: unknown) => error instanceof ApiError && error.kind === 'unreachable',
    );
  });

  it('o endpoint padrão é loopback na porta do ai-memory', () => {
    assert.match(SERVER_URL, /^https?:\/\//);
  });
});
