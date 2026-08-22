# Plano persistente de continuidade

## Objetivo

Permitir que uma pessoa troque entre Claude Code, Codex, Copilot e computadores sem repetir
arquitetura, regras de negócio, padrões de implementação, decisões e estado do trabalho.

O projeto deve suportar dois modos sem criar duas implementações de memória:

1. **Local + Git:** cada máquina possui seu servidor local; Git transporta páginas e checkpoints.
2. **Servidor compartilhado:** todas as máquinas usam um servidor `ai-memory` em uma VPS; Git
   continua disponível como histórico, backup e modo offline.

## Modelo arquitetural

```text
                           transporte opcional
                       ┌────────────────────────┐
                       │ Git privado por projeto│
                       └────────────▲───────────┘
                                    │ páginas/checkpoint
                                    │
Claude / Codex / Copilot ──► servidor ativo ◄── extensão VS Code
                              │
                              ├─ local, no modo Local + Git
                              └─ VPS, no modo Servidor compartilhado
```

Há sempre **um único servidor ativo por janela**. A extensão nunca escreve simultaneamente num
servidor local e num servidor remoto. Isso evita conflito, duplicação de sessões e handoffs
divergentes.

O par `(workspace, project)` é a identidade portátil. A URL do servidor escolhe a instância; ela
não altera a identidade da memória.

## Invariantes

- O servidor `ai-memory` permanece a fonte de verdade durante uma sessão.
- Git transporta somente páginas consolidadas e checkpoints, nunca SQLite, token ou observações
  brutas.
- `.ai-memory.toml` deve declarar `workspace` e `project` explicitamente em projetos portáteis.
- Regras, decisões e padrões duráveis são páginas; handoff é estado transitório.
- `handoffs/latest.md` é o checkpoint portátil, não um substituto do handoff real.
- Token fica no `SecretStorage`; configuração portátil nunca contém credenciais.
- Cada projeto usa uma branch própria, derivada de `workspace/project`.
- Trocar de modo exige migração explícita; não existe dual-write.

## Modo 1 — Local + Git

### Saída da máquina A

Um único comando **Encerrar trabalho e sincronizar** deve:

1. finalizar a sessão quando o agente não possuir `SessionEnd` confiável;
2. aguardar a página de sessão aparecer;
3. criar ou atualizar `handoffs/latest.md`;
4. executar Pull, resolver conflitos e executar Push;
5. confirmar o commit remoto e mostrar `Pronto para continuar em outra máquina`.

### Entrada na máquina B

Um comando **Preparar para continuar** deve:

1. iniciar ou detectar o servidor local;
2. validar token e `(workspace, project)`;
3. descobrir a configuração Git portátil;
4. executar Pull;
5. validar a presença do checkpoint, regras fixadas e páginas recentes;
6. validar MCP, hooks, roteamento e briefing do agente escolhido;
7. mostrar `Pronto para Claude`, `Pronto para Codex` ou as limitações do Copilot.

Depois do Pull, o SessionStart deve receber o briefing automaticamente. O usuário não deve precisar
saber o path de `handoffs/latest.md`.

## Modo 2 — Servidor compartilhado em VPS

Todas as máquinas configuram a mesma URL HTTPS e tokens próprios. O servidor remoto passa a ser a
fonte de verdade para páginas, sessões, observações e handoffs.

Requisitos operacionais:

- HTTPS válido; a porta interna do `ai-memory` não deve ficar exposta diretamente à internet;
- autenticação obrigatória e tokens revogáveis;
- backup persistente do data dir;
- health check, logs e política de atualização;
- acesso preferencial por VPN privada ou proxy reverso com limitação de tráfego;
- configuração de CORS/transporte conforme o contrato do servidor;
- teste de latência e comportamento offline dos hooks.

GitHub Sync continua habilitado, mas muda de função:

- exportação versionada das páginas;
- recuperação de desastre;
- auditoria e leitura offline;
- migração de volta para um servidor local.

Como todas as máquinas apontam para a mesma instância, somente uma delas precisa publicar o backup
Git. A extensão deve impedir jobs concorrentes de backup para o mesmo projeto.

## Migração Local + Git → VPS

1. Na máquina local, executar **Encerrar trabalho e sincronizar**.
2. Criar a instância vazia e segura na VPS.
3. Alterar temporariamente o servidor ativo para a VPS.
4. Executar Pull para importar todas as páginas consolidadas.
5. Validar escopo, contagens, regras, checkpoint e busca.
6. Configurar MCP e hooks de cada máquina para a URL da VPS.
7. Marcar a VPS como servidor ativo somente depois da validação.

Observações e handoffs históricos do SQLite local não migram pelo schema Git v1. O checkpoint e as
páginas de sessão preservam a continuidade útil. Uma migração integral dependerá de API oficial de
export/import do upstream.

## Experiência de configuração

A extensão deve apresentar um painel **Continuidade** com:

```text
Modo                 Local + Git | VPS compartilhada
Servidor ativo       URL, versão e saúde
Projeto              workspace/project e origem do marker
Captura              Claude / Codex / Copilot
Briefing              habilitado / ausente
Git                  remoto, branch e commit
Último checkpoint    data, máquina e agente
Estado               pronto | ação necessária | bloqueado
```

Configuração não secreta sugerida no repositório:

```toml
workspace = "minha-equipe"
project = "meu-produto"

[briefing]
inject_on_session_start = true
max_chars = 6000

[vscode_continuity]
git_branch = "ai-memory-sync/minha-equipe/meu-produto"
```

A URL do repositório pode ser descoberta do perfil do VS Code ou solicitada uma vez por máquina.
Tokens e URL privada da VPS permanecem em configuração de máquina/SecretStorage.

## Plano de entrega

### Fase A — Git utilizável agora

- [x] Corrigir documentação e mensagens que prometem `SessionEnd` confiável no Codex.
- [x] Criar/validar marker explícito e habilitar briefing no onboarding.
- [x] Adotar branch exclusiva por projeto e recusar manifesto de outro escopo.
- [x] Implementar **Encerrar trabalho e sincronizar**.
- [x] Implementar **Preparar para continuar**.
- [x] Exibir último commit/checkpoint e avisar quando o remoto estiver mais novo.
- [x] Incluir checkpoint no briefing de início sem exigir prompt manual.
- [x] Testar servidor A → Git → servidor B com regra, decisão e checkpoint reais.
- [x] Provar a injeção do briefing por um hook real de SessionStart no servidor B.

### Fase B — Servidor compartilhado

- [ ] Adicionar escolha explícita de modo Local/VPS.
- [ ] Tratar servidor remoto como externo: nunca oferecer start/stop local.
- [ ] Validar HTTPS, autenticação, versão e latência.
- [ ] Reconfigurar MCP e hooks para a URL escolhida com pós-condição real.
- [ ] Implementar migração assistida Local + Git → VPS.
- [ ] Manter Git como backup manual antes de automatizar qualquer job.
- [ ] Documentar backup, restore, rotação de token e rollback.

### Fase C — Confiabilidade

- [ ] Teste integrado com duas máquinas lógicas e dois servidores locais.
- [ ] Teste integrado com duas extensões apontando para um servidor compartilhado.
- [ ] Diagnóstico de captura por evento real, não apenas presença de configuração.
- [ ] Resolução de conflito por página com diff.
- [ ] Telemetria local de uso das superfícies, sem conteúdo de memória.

## Gate para a próxima versão instalável

Não gerar uma nova versão para uso diário até a Fase A provar este cenário:

```text
Claude na máquina A
  → registra uma regra, uma decisão e estado atual
  → Encerrar trabalho e sincronizar
  → commit remoto confirmado

Codex na máquina B com servidor vazio
  → Preparar para continuar
  → Pull e importação
  → SessionStart recebe briefing
  → recupera regra, decisão e checkpoint sem explicação manual
```

O teste deve verificar conteúdo e escopo, não apenas contagem de páginas ou exit code.

## Definição de pronto

O produto está pronto quando a extensão consegue responder, antes de abrir o agente:

> Esta máquina está usando o projeto correto, possui a memória mais recente e o agente escolhido
> receberá automaticamente as regras e o estado necessário para continuar.

Se qualquer parte não puder ser provada, a interface deve mostrar a ação necessária em vez de
apresentar estado verde.
