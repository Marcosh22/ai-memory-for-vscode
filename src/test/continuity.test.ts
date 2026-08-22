import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyPortableConfig,
  continuityBranch,
  hasPortableConfig,
  suggestPortableIdentity,
  validPortableIdentity,
} from '../core/continuity';

const scope = { workspace: 'minha-equipe', project: 'cifra-editor' };

describe('configuração portátil', () => {
  it('cria identidade, briefing e branch determinística', () => {
    const result = applyPortableConfig('', scope);
    assert.match(result, /workspace = "minha-equipe"/);
    assert.match(result, /project = "cifra-editor"/);
    assert.match(result, /\[briefing\][\s\S]*inject_on_session_start = true/);
    assert.match(result, /git_branch = "ai-memory-sync\/minha-equipe\/cifra-editor"/);
    assert.equal(hasPortableConfig(result, scope), true);
  });

  it('preserva opções existentes e é idempotente', () => {
    const existing = 'drop_subagent_captures = "true"\n\n[briefing]\nmax_chars = 9000\n';
    const once = applyPortableConfig(existing, scope);
    const twice = applyPortableConfig(once, scope);
    assert.equal(twice, once);
    assert.match(once, /drop_subagent_captures = "true"/);
    assert.match(once, /max_chars = 9000/);
  });

  it('gera branch válida e estável por projeto', () => {
    assert.equal(continuityBranch(scope), 'ai-memory-sync/minha-equipe/cifra-editor');
  });

  it('normaliza uma identidade antiga para o contrato portátil', () => {
    assert.equal(validPortableIdentity('AI Memory for VSCode'), false);
    assert.equal(suggestPortableIdentity('AI Memory for VSCode'), 'ai-memory-for-vscode');
    assert.equal(validPortableIdentity('ai-memory-for-vscode'), true);
  });
});
