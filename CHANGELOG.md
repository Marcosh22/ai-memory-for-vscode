# Changelog

## 0.1.0 (pré-release) — 2026-08-22

Primeiro release beta voltado à continuidade entre agentes e máquinas.

### Adicionado

- Integração MCP nativa com o GitHub Copilot sem editar `.vscode/mcp.json`.
- Configuração assistida do ai-memory, autenticação e diagnóstico no Output Channel.
- Navegação, busca, overview, páginas e handoffs dentro do VS Code.
- Configuração portátil de `workspace` e `project` por `.ai-memory.toml`.
- GitHub Sync com branch isolada por projeto.
- Fluxos **Encerrar trabalho e sincronizar** e **Preparar para continuar**.
- Checkpoint portátil em `handoffs/latest.md` e briefing automático no início da sessão.
- Configuração e diagnóstico das integrações com Claude Code, Codex e Copilot.

### Corrigido

- Falsos conflitos de manifesto causados por conversão LF/CRLF no Windows.
- Duplicação de hooks do Claude Code.
- Leitura de handoff sem consumo destrutivo.

### Limitações conhecidas

- O Codex não oferece um evento confiável de fim de sessão; use **Encerrar trabalho e sincronizar** para garantir o handoff final.
- O modo de servidor compartilhado em VPS ainda não faz parte deste release.
- A continuidade via Git requer configuração inicial do GitHub Sync em cada máquina.
