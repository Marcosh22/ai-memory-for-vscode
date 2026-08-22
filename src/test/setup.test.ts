import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  countClaudeHooks,
  deduplicateClaudeHooks,
  codexConfigDir,
  detectCodexHooks,
  detectCodexHooksAuth,
  detectCodexMcp,
  detectCodexRouting,
  detectClaudeHooks,
  detectClaudeHooksAuth,
  detectClaudeMcp,
  detectCopilotRouting,
  serverUrlForCli,
} from '../core/setup';
import { MARKER_END, MARKER_START } from '../core/routing';

/**
 * A detecção decide o que a tela de configuração oferece. Um falso positivo
 * aqui esconde do usuário exatamente o passo que faz a memória existir.
 */

let root: string;

before(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-setup-')));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeHome(name: string, files: Record<string, string>): string {
  const home = path.join(root, name);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf8');
  }
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function encodedPowerShell(script: string): string {
  return `powershell.exe -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

describe('URL do CLI gerenciado', () => {
  const managed = { command: 'powershell.exe', args: [], source: 'managed' as const };
  const pathCli = { command: 'ai-memory', args: [], source: 'path' as const };

  it('usa o host Docker para o loopback quando o wrapper Windows é gerenciado', () => {
    assert.equal(
      serverUrlForCli('http://127.0.0.1:49374', managed, 'win32'),
      'http://host.docker.internal:49374',
    );
  });

  it('não altera a URL da extensão, o CLI do PATH nem um servidor remoto', () => {
    assert.equal(serverUrlForCli('http://127.0.0.1:49374', pathCli, 'win32'), 'http://127.0.0.1:49374');
    assert.equal(serverUrlForCli('https://memory.example.com', managed, 'win32'), 'https://memory.example.com');
    assert.equal(serverUrlForCli('http://localhost:49374', managed, 'linux'), 'http://localhost:49374');
  });
});

describe('hooks do Claude Code', () => {
  it('ausentes quando não há settings.json', () => {
    assert.equal(detectClaudeHooks(fakeHome('h1', {})), false);
  });

  it('ausentes quando settings.json existe sem hooks', () => {
    const home = fakeHome('h2', {
      '.claude/settings.json': JSON.stringify({ model: 'opus', tui: {} }),
    });
    assert.equal(detectClaudeHooks(home), false);
  });

  it('ausentes quando há hooks de terceiros, sem ai-memory', () => {
    const home = fakeHome('h3', {
      '.claude/settings.json': JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'outra-coisa.sh' }] }] },
      }),
    });
    assert.equal(detectClaudeHooks(home), false);
  });

  it('presentes quando algum hook referencia ai-memory', () => {
    const home = fakeHome('h4', {
      '.claude/settings.json': JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'ai-memory hook --event session-start' }] }],
        },
      }),
    });
    assert.equal(detectClaudeHooks(home), true);
  });

  it('reconhece comandos PowerShell codificados pelo wrapper Windows', () => {
    const home = fakeHome('h6', {
      '.claude/settings.json': JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: encodedPowerShell("$env:AI_MEMORY_HOOK_URL='http://x'; & 'ai-memory.ps1'"),
                },
              ],
            },
          ],
        },
      }),
    });
    assert.equal(detectClaudeHooks(home), true);
  });

  it('JSON corrompido não derruba a detecção', () => {
    const home = fakeHome('h5', { '.claude/settings.json': '{ isto não é json' });
    assert.equal(detectClaudeHooks(home), false);
  });

  it('conta grupos do ai-memory sem contar hooks de terceiros', () => {
    const aiMemory = { hooks: [{ type: 'command', command: 'ai-memory hook' }] };
    const home = fakeHome('h7', {
      '.claude/settings.json': JSON.stringify({
        hooks: {
          SessionStart: [aiMemory, aiMemory, { hooks: [{ command: 'outro-hook' }] }],
          SessionEnd: [aiMemory],
        },
      }),
    });
    assert.equal(countClaudeHooks(home), 3);
  });

  it('remove somente duplicatas idênticas do ai-memory e cria backup', () => {
    const aiMemory = { matcher: '', hooks: [{ type: 'command', command: 'ai-memory hook' }] };
    const thirdParty = { matcher: '', hooks: [{ type: 'command', command: 'outro-hook' }] };
    const home = fakeHome('h8', {
      '.claude/settings.json': JSON.stringify({
        model: 'opus',
        hooks: { SessionStart: [aiMemory, thirdParty, aiMemory, aiMemory] },
      }),
    });

    const backup = deduplicateClaudeHooks(home);
    const repaired = JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
    ) as { model: string; hooks: { SessionStart: unknown[] } };

    assert.ok(backup);
    assert.equal(fs.existsSync(backup), true);
    assert.equal(repaired.model, 'opus');
    assert.deepEqual(repaired.hooks.SessionStart, [aiMemory, thirdParty]);
    assert.equal(countClaudeHooks(home), 1);
  });

  it('não reescreve quando não há duplicata', () => {
    const home = fakeHome('h9', {
      '.claude/settings.json': JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ command: 'ai-memory hook' }] }] },
      }),
    });
    assert.equal(deduplicateClaudeHooks(home), undefined);
  });
});

describe('token embutido nos hooks', () => {
  const TOKEN = 'abc123def456';

  it('detecta ausência do token — o modo de falha que não dá erro', () => {
    // Hooks instalados sem credencial contra servidor com auth: cada evento
    // toma 401 e a captura para sem nada indicar.
    const home = fakeHome('a1', {
      '.claude/settings.json': JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'ai-memory hook' }] }] },
      }),
    });
    assert.equal(detectClaudeHooks(home), true);
    assert.equal(detectClaudeHooksAuth(home, TOKEN), false);
  });

  it('detecta o token presente', () => {
    const home = fakeHome('a2', {
      '.claude/settings.json': JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: `ai-memory hook --auth-token ${TOKEN}` }] },
          ],
        },
      }),
    });
    assert.equal(detectClaudeHooksAuth(home, TOKEN), true);
  });

  it('detecta o token dentro de PowerShell codificado', () => {
    const home = fakeHome('a3', {
      '.claude/settings.json': JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: encodedPowerShell(
                    `$env:AI_MEMORY_AUTH_TOKEN='${TOKEN}'; & 'ai-memory.ps1'`,
                  ),
                },
              ],
            },
          ],
        },
      }),
    });
    assert.equal(detectClaudeHooksAuth(home, TOKEN), true);
  });
});

describe('MCP do Claude Code', () => {
  it('ausente sem .claude.json', () => {
    assert.equal(detectClaudeMcp(fakeHome('m1', {})), false);
  });

  it('ausente quando há outros servidores MCP mas não o ai-memory', () => {
    const home = fakeHome('m2', {
      '.claude.json': JSON.stringify({ mcpServers: { outro: { type: 'http', url: 'http://x' } } }),
    });
    assert.equal(detectClaudeMcp(home), false);
  });

  it('presente quando o ai-memory está registrado', () => {
    const home = fakeHome('m3', {
      '.claude.json': JSON.stringify({
        mcpServers: { 'ai-memory': { type: 'http', url: 'http://127.0.0.1:49374/mcp' } },
      }),
    });
    assert.equal(detectClaudeMcp(home), true);
  });
});

describe('integração do Codex', () => {
  const cleanEnv: NodeJS.ProcessEnv = {};

  it('usa ~/.codex por padrão e respeita CODEX_HOME', () => {
    const home = fakeHome('c0', {});
    assert.equal(codexConfigDir(home, cleanEnv), path.join(home, '.codex'));
    assert.equal(
      codexConfigDir(home, { CODEX_HOME: path.join(home, 'codex-custom') }),
      path.join(home, 'codex-custom'),
    );
  });

  it('detecta MCP com chave TOML simples ou entre aspas', () => {
    const simple = fakeHome('c1', {
      '.codex/config.toml': '[mcp_servers.ai-memory]\nurl = "http://127.0.0.1:49374/mcp"\n',
    });
    const quoted = fakeHome('c2', {
      '.codex/config.toml': '[mcp_servers."ai-memory"]\nurl = "http://127.0.0.1:49374/mcp"\n',
    });
    assert.equal(detectCodexMcp(simple, cleanEnv), true);
    assert.equal(detectCodexMcp(quoted, cleanEnv), true);
  });

  it('não confunde outro servidor MCP com ai-memory', () => {
    const home = fakeHome('c3', {
      '.codex/config.toml': '[mcp_servers.context7]\ncommand = "npx"\n',
    });
    assert.equal(detectCodexMcp(home, cleanEnv), false);
  });

  it('detecta hooks.json e a credencial incorporada', () => {
    const token = 'codex-secret-123';
    const home = fakeHome('c4', {
      '.codex/hooks.json': JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: `ai-memory hook --auth-token ${token}` }] },
          ],
        },
      }),
    });
    assert.equal(detectCodexHooks(home, cleanEnv), true);
    assert.equal(detectCodexHooksAuth(home, token, cleanEnv), true);
    assert.equal(detectCodexHooksAuth(home, 'outro-token', cleanEnv), false);
  });

  it('detecta hooks inline no config.toml', () => {
    const home = fakeHome('c5', {
      '.codex/config.toml': [
        '[[hooks.SessionStart]]',
        '[[hooks.SessionStart.hooks]]',
        'type = "command"',
        'command = "ai-memory hook --event session-start"',
      ].join('\n'),
    });
    assert.equal(detectCodexHooks(home, cleanEnv), true);
  });
});

describe('roteamento do Copilot', () => {
  it('ausente sem o arquivo', () => {
    const folder = path.join(root, 'r1');
    fs.mkdirSync(folder, { recursive: true });
    assert.equal(detectCopilotRouting(folder), false);
  });

  it('ausente quando o arquivo existe sem o bloco', () => {
    const folder = path.join(root, 'r2', '.github');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'copilot-instructions.md'), '# Instruções\n', 'utf8');
    assert.equal(detectCopilotRouting(path.join(root, 'r2')), false);
  });

  it('presente com o bloco delimitado', () => {
    const folder = path.join(root, 'r3', '.github');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'copilot-instructions.md'),
      `# Instruções\n\n${MARKER_START}\nbloco\n${MARKER_END}\n`,
      'utf8',
    );
    assert.equal(detectCopilotRouting(path.join(root, 'r3')), true);
  });

  it('menção inline não conta como instalado', () => {
    const folder = path.join(root, 'r4', '.github');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'copilot-instructions.md'),
      `O bloco vai entre \`${MARKER_START}\` e \`${MARKER_END}\`.\n`,
      'utf8',
    );
    assert.equal(detectCopilotRouting(path.join(root, 'r4')), false);
  });
});

describe('roteamento do Codex', () => {
  it('detecta somente o bloco delimitado em AGENTS.md', () => {
    const folder = fakeHome('cr1', {
      'AGENTS.md': `# Agentes\n\n${MARKER_START}\nbloco\n${MARKER_END}\n`,
    });
    assert.equal(detectCodexRouting(folder), true);

    const absent = fakeHome('cr2', { 'AGENTS.md': '# Agentes\n' });
    assert.equal(detectCodexRouting(absent), false);
  });
});
