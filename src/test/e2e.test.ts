import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';

import { listProjects } from '../core/client';
import { isKnownProject, resolveScope } from '../core/scope';
import { mcpUrl } from '../core/urls';
import { detectServer, live, mcpCall, toolPayload } from './support';

/**
 * Teste integrado do passo 8 — a cadeia inteira que representa o valor da
 * extensão:
 *
 *   checkout limpo → resolver projeto → publicar servidor MCP →
 *   descobrir tools → executar uma tool → resultado
 *
 * **sem editar `.vscode/mcp.json`, sem escrever JSON, sem configuração
 * adicional de MCP.** Se esse caminho exigir uma etapa manual, a tese da
 * extensão não se sustentou.
 *
 * O que fica de fora: a perna Copilot — descoberta e execução PELO agente.
 * Isso exige um extension host real e uma mensagem de chat enviada por uma
 * pessoa. O que este teste garante é que, se essa perna falhar, o problema
 * está entre editor e extensão, porque tudo abaixo já está verificado.
 */

before(detectServer);

let checkout: string;

before(() => {
  // Um checkout limpo: sem marker, sem git, sem config de MCP.
  checkout = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-e2e-')));
  fs.mkdirSync(path.join(checkout, 'src'), { recursive: true });
});

after(() => {
  fs.rmSync(checkout, { recursive: true, force: true });
});

describe('cadeia completa', () => {
  it('1. checkout limpo resolve para basename, sem marker nem git', () => {
    const scope = resolveScope(checkout, { home: path.dirname(checkout) });

    assert.equal(scope.project, path.basename(checkout));
    assert.equal(scope.projectSource, 'basename');
    assert.equal(scope.workspace, 'default');
    assert.equal(scope.markerPath, undefined);
  });

  it('2. o checkout não tem nenhuma configuração de MCP — e não precisa ter', () => {
    // A tese da extensão em uma asserção: o provider publica o servidor por
    // API, então não existe arquivo de config no repositório.
    assert.equal(fs.existsSync(path.join(checkout, '.vscode', 'mcp.json')), false);
    assert.equal(fs.existsSync(path.join(checkout, '.vscode')), false);
  });

  it('3. o servidor responde e o projeto novo ainda não existe nele', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    const scope = resolveScope(checkout, { home: path.dirname(checkout) });
    const projects = await listProjects(ctx);

    assert.ok(projects.length > 0, 'o servidor precisa conhecer algum projeto');
    assert.equal(
      isKnownProject(scope, projects),
      false,
      'um checkout recém-criado não pode existir no servidor — é o caso do escopo órfão',
    );
  });

  it('4. o endpoint MCP publicado é o que o servidor atende', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    // A MESMA função que monta o McpHttpServerDefinition em produção.
    const url = mcpUrl(ctx.baseUrl);
    assert.equal(url, `${ctx.baseUrl}/mcp`);

    const result = await mcpCall(ctx, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0.0.1' },
    });

    const info = result.result?.['serverInfo'] as { name?: string; version?: string } | undefined;
    assert.equal(info?.name, 'ai-memory');
    assert.ok(info?.version, 'o servidor precisa se identificar com versão');
  });

  it('5. tools/list traz as tools de memória — e memory_search não existe', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    const result = await mcpCall(ctx, 'tools/list', {}, 2);
    const tools = (result.result?.['tools'] ?? []) as Array<{ name: string }>;
    const names = new Set(tools.map((tool) => tool.name));

    // As oito de leitura, conforme `tool_call_is_write` no servidor.
    for (const expected of [
      'memory_query',
      'memory_read_page',
      'memory_read_session_observations',
      'memory_recent',
      'memory_briefing',
      'memory_explore',
      'memory_status',
      'memory_install_self_routing',
    ]) {
      assert.ok(names.has(expected), `tool de leitura ausente: ${expected}`);
    }

    assert.equal(
      names.has('memory_search'),
      false,
      'memory_search não existe — pedir por esse nome falha por nome inválido, não por protocolo',
    );
  });

  it('6. tools/call memory_status devolve payload do ai-memory', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    // memory_status e não memory_query: numa base vazia a busca devolve zero
    // hits, e zero hits não distingue "funcionou, índice vazio" de "falhou
    // em silêncio". status independe de projeto e sempre devolve payload.
    const result = await mcpCall(ctx, 'tools/call', { name: 'memory_status', arguments: {} }, 3);

    assert.equal(result.result?.['isError'], false);
    const payload = toolPayload(result) as { counts?: Record<string, number> } | undefined;
    assert.ok(payload?.counts, 'memory_status precisa devolver counts');
    assert.equal(typeof payload.counts['pages_latest'], 'number');
  });

  it('7. uma tool de leitura devolve conteúdo que só o ai-memory tem', async (t: TestContext) => {
    const ctx = live(t);
    if (!ctx) {
      return;
    }
    // A prova irrefutável: conteúdo gravado via MCP, sem origem alternativa
    // possível. Foi assim que o spike foi validado contra a memória embutida
    // do Copilot, que competia pela mesma intenção.
    const result = await mcpCall(
      ctx,
      'tools/call',
      {
        name: 'memory_read_page',
        arguments: { workspace: 'default', project: 'scratch', path: 'decisions/0001-provider-mcp.md' },
      },
      4,
    );

    assert.equal(result.result?.['isError'], false);
    const text = JSON.stringify(toolPayload(result));
    assert.match(text, /registerMcpServerDefinitionProvider/);
  });
});
