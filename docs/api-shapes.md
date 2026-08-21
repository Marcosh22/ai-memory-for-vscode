# Formas reais de `/api/v1` — servidor v1.28.0

Capturado de um servidor em execução em 17 ago 2026, não do `docs/frontend-api.md` do upstream.
O documento do upstream se declara a referência de frontend e **está desatualizado** no mesmo
commit v1.28.0 — ele próprio avisa que, em conflito, o código vence.

Os tipos de `client.ts` saem daqui.

## A regra

Listagens devolvem **array puro**. Recursos singulares e agregados devolvem **objeto**.

| Endpoint | Doc do upstream | Real |
|---|---|---|
| `GET /workspaces` | `{"workspaces":[…]}` | `[…]` |
| `GET /projects` | `{"projects":[…]}` | `[…]` |
| `GET …/pages` | `{"pages":[…]}` | `[…]` |
| `GET …/recent` | `{"pages":[…]}` | `[…]` |
| `GET /search` | `{"hits":[…]}` | `[…]` |
| `GET …/pages/{*path}` | objeto | objeto — mas ver campos abaixo |
| `GET …/briefing` | objeto | objeto, confere |
| `GET …/overview` | objeto | objeto, confere |
| `GET …/handoffs` | `{"handoffs":[…]}` | `{"handoffs":[…]}`, confere |
| `GET …/sessions` | `{"sessions":[…]}` | `{"sessions":[…]}`, confere |
| `GET /graph` | `{"edges":[…]}` | `{"edges":[…]}`, confere |

## Divergências de campo

**Leitura de página** — o corpo é `body_markdown`, **não** `body`. O doc mostra `body`. É o campo
de que a fatia 2 depende para renderizar a página no documento virtual.

```
workspace, project, path, title, kind, tier, pinned,
created_at, updated_at, supersedes, frontmatter,
body_markdown, links, backlinks
```

`links` e `backlinks` trazem `{path, title, kind, workspace, project}` — com escopo em cada item,
o que permite resolver wikilink cross-project sem uma segunda chamada.

**Hit de busca** — não tem `id`, ao contrário do que o doc mostra. Tem escopo em cada hit:

```
workspace, project, path, title, kind, snippet, rank
```

`rank` é negativo e **menor é melhor** (`-0.0000018…` no exemplo), como documentado.
`snippet` traz `<mark>…</mark>` embutido — tirar para o label do QuickPick e usar para
`highlights`.

## Contrato de cache — este confere

Verificado nos headers de resposta:

| Endpoint | Header |
|---|---|
| `…/pages/{*path}` | `cache-control: private, max-age=300` + `etag: "sha256…"` |
| `…/briefing` | `cache-control: private, no-store` |

`no-store` em briefing, overview, handoffs e sessions porque dependem do ator autenticado.
Cachear qualquer um funciona hoje e vaza contexto entre operadores quando o servidor virar do time.

## Como recapturar

```bash
TOKEN=$(cat .ai-memory-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:49374/api/v1/workspaces/default/projects/scratch/pages/decisions/0001-provider-mcp.md
```
