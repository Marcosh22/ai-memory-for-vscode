# Arquitetura

## Responsabilidade da extensão

Esta extensão é uma camada de integração e leitura para o servidor `ai-memory`. Ela não substitui
o servidor, não mantém uma segunda base de memória e não altera o checkout de código do usuário.

```text
Claude Code / Codex / Copilot
              │ MCP e hooks
              ▼
       servidor ai-memory ativo
              │ HTTP API
              ▼
          extensão VS Code
              │
     árvore · busca · handoff · GitHub Sync
```

O servidor ativo pode ser local ou compartilhado numa VPS. Há somente um por janela; GitHub Sync
é transporte/backup de páginas e nunca implementa dual-write entre duas instâncias.

O Copilot recebe um `McpHttpServerDefinitionProvider` da extensão. Claude Code e Codex têm suas
próprias configurações MCP e hooks, instaladas pelo CLI oficial do `ai-memory` através do onboarding
visual.

## Escopo

O par `(workspace, project)` identifica a memória lógica. O arquivo `.ai-memory.toml` pode declarar
esses nomes e é procurado a partir do diretório de trabalho do agente. Sem um projeto explícito,
`project_strategy = "repo-root"` deriva o nome do repositório no host, pois um servidor em Docker
não consegue descobrir corretamente o checkout do host.

Em Windows, a comparação de caminhos ignora caixa para acompanhar o comportamento do NTFS. Um
marcador mais próximo vence; a divergência de escopo é mostrada na status bar e no log.

## Superfícies de leitura

Uma chamada de overview alimenta a status bar, a árvore e o aviso de handoff. A árvore mostra
handoff, regras, slots e páginas recentes. A busca usa o endpoint de pesquisa do servidor e mantém
os resultados mesmo quando o termo aparece somente no corpo ou nas entidades da página.

Ler um handoff pela extensão não o consome. O consumo automático pertence ao SessionStart do agente
seguinte.

## Captura e roteamento

Os hooks capturam eventos do ciclo de vida dos agentes. O bloco de roteamento é obtido do servidor
por `memory_install_self_routing`, para não criar uma cópia divergente na extensão. A instalação
preserva conteúdo fora dos marcadores `ai-memory:start` e `ai-memory:end`.

O Copilot tem memória própria. Por isso, publicar as ferramentas MCP não garante que ele as escolha;
as instruções de roteamento orientam a intenção para `ai-memory`.

## Fontes técnicas

- [Formas reais da API](api-shapes.md)
- [Protocolo de sincronização](github-sync.md)
- [Plano de continuidade entre agentes e máquinas](continuity-plan.md)
