# GitHub Sync manual — protocolo v1

## Objetivo

Sincronizar a memória consolidada de um projeto entre instalações locais do `ai-memory` sem
servidor remoto e sem colocar o SQLite sob controle de versão.

O fluxo é sempre iniciado por uma pessoa. Não há timer, watcher, push ao encerrar o editor ou
pull ao abrir um projeto.

A extensão oferece dois fluxos compostos, ainda iniciados explicitamente:

- **Encerrar trabalho e sincronizar**: finaliza a sessão, grava `handoffs/latest.md` e publica;
- **Preparar para continuar**: recebe a memória, valida o checkpoint e a configuração dos agentes.

## Modelo

```text
Claude/Codex ↔ ai-memory local ↔ extensão ↔ branch Git ↔ extensão ↔ ai-memory local
```

O checkout Git fica em `ExtensionContext.globalStorageUri/github-sync/<hash>`. Ele é separado do
checkout aberto no VS Code, portanto nenhuma operação de sincronização troca ou modifica a branch
de código do usuário.

Os perfis ficam em `workspaceState`, indexados por `(workspace, project)`, e contêm apenas URL,
branch e o commit da última sincronização. Credenciais não são persistidas pelo módulo; o processo
Git usa o mecanismo de autenticação já configurado na máquina.

## Formato versionado

```text
.ai-memory-sync/
  manifest.json
  pages/
    decisions/
      db.md
    sessions/
      2026-08-21.md
```

`.ai-memory-sync/manifest.json` declara `schema: 1`, o escopo e, para cada página, path, título, kind, tier,
pin, tags, TTL e SHA-256. O hash cobre corpo e metadados importáveis. Datas de exportação não
entram no manifesto, para um Push sem alterações continuar sendo no-op.

O parser recusa paths absolutos, `..`, backslash, manifesto incompatível, arquivo ausente e hash
divergente. Uma branch que ainda não possui `.ai-memory-sync/manifest.json` é uma origem vazia válida;
manifesto presente mas corrompido é erro.

## Pull

1. Busca a branch remota sem tags.
2. Exporta o estado local pela API de leitura.
3. Carrega o commit da última sincronização como base e faz merge de três vias.
4. Se a mesma página mudou local e remotamente, para antes de qualquer escrita e pede que a
   pessoa escolha qual lado vence nesses paths.
5. Atualiza o checkout interno e reimporta somente páginas diferentes.
6. Cada importação chama `memory_write_page`; nunca escreve o wiki ou o SQLite diretamente.

## Push

1. Confere a ponta remota. Se ela avançou desde o último sync, exige Pull.
2. Exporta todas as páginas atuais do projeto.
3. Combina com páginas existentes no remoto sem propagar exclusões.
4. Grava manifesto e Markdown no checkout interno.
5. Cria um commit apenas quando existe diferença e executa push sem force.

## Exclusões e conflitos

O schema 1 não possui tombstones. Se uma página existir apenas em um lado, ela sobrevive. Isso é
intencional: em sincronização de memória, ressuscitar uma nota é menos destrutivo do que apagar
conhecimento sem conseguir provar que a exclusão foi deliberada.

Quando os hashes local e remoto diferem do hash-base para o mesmo path, o merge não escolhe
vencedor sozinho. A interface lista os paths e oferece uma escolha global entre esta máquina e o
GitHub; diff e resolução página a página ficam para uma versão futura.

## Fora do schema 1

- Observações brutas de hooks.
- Linhas e estado de consumo dos handoffs.
- Exclusões distribuídas.
- Criptografia ponta a ponta.
- Permissões por página ou por usuário.
- Outros provedores além de remotos Git compatíveis com o Git instalado.

`handoffs/latest.md` é uma página consolidada comum e por isso entra no schema. O estado do handoff
real — ID, autoria operacional, aceite e expiração — continua fora dele.

Sessões consolidadas aparecem normalmente porque são páginas Markdown sob `sessions/`. Para
portar observações e handoffs com fidelidade, o upstream precisa oferecer um contrato de
importação que preserve IDs, autoria, ordenação e estado sem contornar o single-writer.
