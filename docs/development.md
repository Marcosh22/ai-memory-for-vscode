# Desenvolvimento e testes

## Ambiente

```bash
npm install
npm run compile
npm test
```

Para testar o extension host, pressione `F5` no VS Code. O servidor `ai-memory` precisa estar em
execução para os testes de contrato e cadeia MCP.

## Camadas de teste

- `scope.test.ts`: matriz de markers, repositórios, worktrees, multi-root e fronteiras do walk;
- `client.test.ts`: contrato HTTP real, formas das respostas, cache e tradução de erros;
- `mcp.test.ts` e `e2e.test.ts`: registro, descoberta e execução das tools MCP;
- `routing.test.ts`: instalação idempotente e preservação do arquivo de instruções;
- `gitSync.test.ts` e `memorySync.test.ts`: bundle portátil, merge de três vias e conflitos;
- `continuityFlow.test.ts`: identidade, regra, decisão e checkpoint entre duas máquinas lógicas;
- `realContinuity.test.ts`: transferência entre dois servidores reais quando as URLs de teste são informadas;
- `setup.test.ts`: detecção de hooks, MCP, token e roteamento de Claude/Codex/Copilot.

O teste de dois servidores usa `AI_MEMORY_TEST_SERVER_A`, `AI_MEMORY_TEST_SERVER_B` e,
opcionalmente, `AI_MEMORY_TEST_TOKEN`. Sem as duas URLs ele é marcado como pulado.

O gate de briefing deve usar o hook nativo num servidor descartável com marker montado. O resultado
esperado é `hookSpecificOutput.additionalContext` contendo uma página `_rules/` fixada e
`handoffs/latest.md`; um `{}` vazio não prova briefing e normalmente indica autenticação ausente.

Os testes de integração que precisam de rede local são marcados como pulados quando o servidor não
está disponível. Isso permite executar a suíte pura sem transformar Docker parado em falha falsa.

## Empacotamento

```bash
npx @vscode/vsce package
```

O `vscode:prepublish` compila TypeScript antes de montar o VSIX. Recursos de marca ficam em
`resources/` e são incluídos no pacote.

## Decisões importantes

- A extensão usa o contrato observado no servidor, não formas antigas da documentação upstream;
- O transporte MCP roda sem estado entre requisições;
- O GitHub Sync usa checkout interno e nunca troca a branch aberta no editor;
- O bundle portátil contém páginas Markdown e manifesto, não SQLite, token ou observações brutas;
- Exclusões não são propagadas enquanto o protocolo não possuir tombstones;
- A captura e a leitura são configuradas explicitamente pelo usuário, pois alteram configurações
  globais dos agentes ou arquivos do projeto.
