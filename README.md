# AI Memory For VS Code

Compartilhe o contexto do seu projeto entre Claude Code, Codex e GitHub Copilot.

O AI Memory mantém uma memória de longo prazo para agentes de código: decisões, regras,
descobertas, problemas conhecidos e o estado atual do trabalho. Assim, você pode trocar de
agente ou de computador sem precisar explicar novamente todo o projeto.

## Como funciona

```text
Claude Code ─┐
Codex       ─┼─> ai-memory local ─> painel do VS Code
Copilot     ─┘             │
                           └─> GitHub Sync opcional
```

O servidor `ai-memory` roda localmente em um container Docker. A extensão fornece a integração
visual no VS Code, registra o servidor MCP para os agentes e mostra a memória do projeto em uma
árvore, busca e documentos navegáveis.

Por padrão, seus dados permanecem na máquina. O GitHub Sync é opcional e só publica as páginas
consolidadas quando você escolhe **Pull**, **Push** ou **Sincronizar**.

## O que você pode fazer

- Continuar no Codex o trabalho iniciado no Claude Code;
- Recuperar decisões e regras antigas antes de modificar o projeto;
- Pesquisar a memória do projeto por assunto;
- Ver handoffs e páginas recentes no painel lateral;
- Trabalhar em mais de um computador usando um repositório GitHub privado;
- Manter o código do produto separado dos documentos e da memória dos agentes;
- Usar a mesma memória com Claude Code, Codex CLI, extensão Codex e Copilot.

## Requisitos

- VS Code 1.101 ou mais recente;
- Docker Desktop ou Docker Engine;
- Git, somente se você quiser usar o GitHub Sync;
- Claude Code, Codex ou Copilot, conforme os agentes que você pretende integrar.

## Instalação rápida

### 1. Instale a extensão

Na página da extensão, clique em **Install**. Durante o desenvolvimento ou antes da publicação,
use **Extensions → Install from VSIX...** e selecione o arquivo `.vsix`.

### 2. Inicie o servidor local

O servidor é o único serviço externo obrigatório. Na raiz do projeto, gere um token e inicie o
container.

Linux/macOS:

```bash
docker run --rm akitaonrails/ai-memory:latest generate-auth-token > .ai-memory-token

docker run -d --name ai-memory \
  -p 127.0.0.1:49374:49374 \
  -v ai-memory-data:/data \
  -e AI_MEMORY_AUTH_TOKEN="$(cat .ai-memory-token)" \
  akitaonrails/ai-memory:latest
```

PowerShell:

```powershell
docker run --rm akitaonrails/ai-memory:latest generate-auth-token | Set-Content .ai-memory-token -NoNewline
$aiMemoryToken = (Get-Content -Raw .ai-memory-token).Trim()

docker run -d --name ai-memory `
  -p 127.0.0.1:49374:49374 `
  -v ai-memory-data:/data `
  -e AI_MEMORY_AUTH_TOKEN="$aiMemoryToken" `
  akitaonrails/ai-memory:latest
```

O token é uma credencial local. Não o publique no Git e não o coloque no repositório de memória.
O arquivo `.ai-memory-token` já deve estar no `.gitignore`.

Se o container já existir, use `docker start ai-memory`.

### 3. Configure a extensão

1. Abra a pasta do projeto no VS Code.
2. Abra o painel **AI Memory** na Activity Bar.
3. Clique na engrenagem e escolha **Configurar tudo que falta**.
4. Quando solicitado, informe o conteúdo de `.ai-memory-token`.
5. Execute **AI Memory: Verificar conexão**.

A configuração visual prepara o servidor MCP, a captura dos hooks e as instruções de roteamento
dos agentes. Ela não altera o `PATH` do sistema.

### 4. Configure os agentes

Para Claude Code e Codex, reinicie sessões que já estavam abertas. Na primeira sessão do Codex,
execute `/hooks` e aprove os hooks do AI Memory.

No Copilot Chat, use o **agent mode**. As ferramentas `memory_*` deverão aparecer como ferramentas
disponíveis. Para evitar a memória nativa do Copilot, peça explicitamente que ele use as ferramentas
do AI Memory ou instale o roteamento pelo comando **AI Memory: Instalar roteamento nas instruções
do Copilot**.

## Fluxo Claude Code → Codex

Depois de configurar os dois agentes:

1. Trabalhe normalmente no Claude Code.
2. Ao concluir uma etapa, peça para ele registrar decisões e pendências no AI Memory.
3. Crie um handoff para o próximo agente ou encerre a sessão normalmente.
4. Abra ou retome o Codex no mesmo projeto.
5. Peça para consultar o handoff e `memory_recent` antes de começar.

Para um projeto que já estava em andamento antes da instalação, retome a conversa do Claude com
`claude -c` ou `claude -r` e peça uma carga inicial da arquitetura, decisões, estado atual e
próximos passos.

## Vários computadores

Cada computador mantém seu próprio Docker e seu próprio token. Para compartilhar a memória:

1. Use um repositório GitHub **privado**, separado do código do produto.
2. Configure uma branch dedicada, normalmente `ai-memory-sync`.
3. Na máquina de origem, use **AI Memory: Encerrar trabalho e sincronizar**.
4. Na máquina de destino, configure o mesmo repositório e use
   **AI Memory: Preparar para continuar**.
5. A extensão executa o Pull, valida o checkpoint e informa a prontidão de cada agente.

O GitHub Sync transporta páginas consolidadas e mantém histórico. Ele não transporta o SQLite,
tokens, observações brutas dos hooks nem o estado transitório dos handoffs. O comando de saída
materializa o estado útil em `handoffs/latest.md` antes do Push.

## Workspace com documentos e um repositório interno

É possível manter documentos privados na raiz e o código em um repositório filho:

```text
meu-workspace/
├── .ai-memory.toml
├── docs/
└── repositorio/        # repositório Git do produto
```

Use um marcador com nomes estáveis para que máquinas diferentes compartilhem o mesmo projeto:

```toml
workspace = "minha-equipe"
project = "meu-produto"
```

O marcador da raiz é aplicado aos diretórios filhos quando o workspace está dentro da pasta do
usuário. Se o workspace contiver documentos sensíveis, mantenha-o em um repositório privado
separado e não o misture ao repositório do produto.

## Privacidade

- O servidor padrão escuta apenas em `127.0.0.1`;
- O token fica no armazenamento seguro do VS Code ou em arquivo local ignorado pelo Git;
- O código do produto não é alterado pelo GitHub Sync;
- O GitHub recebe somente as páginas que você publicar;
- Use repositório privado e nunca registre senhas, tokens, chaves privadas ou dados de clientes
  nas páginas de memória.

## Limitações atuais

- A sincronização entre máquinas é manual;
- Conflitos de edição são apresentados para uma escolha explícita;
- Exclusões ainda não são propagadas pelo protocolo de sincronização;
- O hash do manifesto continua bloqueando alterações reais, mas diferenças
  exclusivamente de final de linha (LF/CRLF) são normalizadas na leitura para
  permitir sincronização entre Windows, macOS e Linux;
- Handoffs e observações brutas ficam no servidor local;
- O servidor Docker precisa estar iniciado para leitura e captura funcionarem.

## Comandos principais

| Comando | Para que serve |
|---|---|
| **AI Memory: Configurar** | Prepara servidor, Claude Code, Codex e Copilot |
| **AI Memory: Buscar na memória** | Pesquisa páginas e decisões do projeto (`Ctrl+Alt+M`) |
| **AI Memory: Atualizar** | Atualiza a árvore e o handoff exibido |
| **AI Memory: Ver handoff aberto** | Abre o handoff sem consumi-lo |
| **AI Memory: Salvar handoff agora** | Cria um checkpoint explícito para continuar em outro agente |
| **AI Memory: Publicar checkpoint no GitHub** | Versiona status e handoff para continuar em outra máquina |
| **AI Memory: Encerrar trabalho e sincronizar** | Finaliza sessão, checkpoint e commit remoto |
| **AI Memory: Preparar para continuar** | Importa memória e valida a prontidão dos agentes |
| **AI Memory: Verificar conexão** | Testa o servidor local |
| **AI Memory: Gerenciar GitHub Sync** | Configura Pull, Push, Sincronizar e Histórico |
| **AI Memory: Abrir log** | Mostra o diagnóstico da extensão |

O checkpoint é explícito porque seu resumo passa a fazer parte do histórico do repositório
configurado. Com briefing habilitado, o SessionStart injeta páginas fixadas e regras sem exigir que
o usuário informe o path ao agente.

## Solução de problemas

**O painel mostra que o servidor está desconectado**

Confirme se o Docker está aberto e execute `docker start ai-memory`. Depois use **Verificar
conexão**.

**O agente não encontra as ferramentas `memory_*`**

Reinicie a sessão do agente. No Codex, execute `/hooks` e aprove os hooks. No Copilot, confirme
que você está no agent mode e instale o roteamento nas instruções do projeto.

**A memória aparece vazia**

Verifique se o projeto está usando o mesmo `.ai-memory.toml` e o mesmo par `workspace/project`.
O painel informa a origem do escopo para ajudar a localizar essa divergência.

**O Pull não traz a memória esperada**

Confirme o repositório privado, a branch e o projeto configurados. Use **Histórico** para verificar
se a outra máquina realmente publicou um commit.

## Para desenvolvedores

Detalhes de arquitetura, testes, contrato da API e decisões de implementação ficam nos arquivos:

- `docs/architecture.md`
- `docs/development.md`
- `docs/api-shapes.md`
- `docs/github-sync.md`
- `docs/continuity-plan.md`

```bash
npm install
npm test
```

Os testes de integração precisam do servidor `ai-memory` em execução; sem ele, os testes que
dependem da rede são marcados como pulados.

## Licença

MIT. O servidor de memória usado por esta extensão é o projeto [ai-memory](https://github.com/akitaonrails/ai-memory).
