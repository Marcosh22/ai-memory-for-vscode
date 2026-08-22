import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderPortableCheckpoint } from '../core/checkpoint';
import type { Overview } from '../core/client';

describe('checkpoint portátil', () => {
  it('inclui status, handoff e referências necessárias para outra máquina', () => {
    const body = renderPortableCheckpoint(
      { workspace: 'default', project: 'app' },
      overview(false),
      '2026-08-22T12:00:00.000Z',
    );
    assert.match(body, /# Checkpoint portátil — app/);
    assert.match(body, /Implementação concluída/);
    assert.match(body, /- Validar em outra máquina/);
    assert.match(body, /\[\[_rules\/conventions\.md\]\]/);
    assert.match(body, /Observações: 12/);
  });

  it('não publica texto de handoff redigido', () => {
    const body = renderPortableCheckpoint(
      { workspace: 'default', project: 'app' },
      overview(true),
      '2026-08-22T12:00:00.000Z',
    );
    assert.match(body, /omitido porque pertence a outro operador/);
    assert.doesNotMatch(body, /Implementação concluída/);
  });
});

function overview(redacted: boolean): Overview {
  return {
    handoff: {
      agent: 'codex', at: '2026-08-22T11:00:00Z', redacted,
      summary: 'Implementação concluída', next_steps: ['Validar em outra máquina'],
    },
    briefing: {
      counts: { pages_latest: 3, pages_all: 3, sessions: 2, observations: 12 },
      last_observation_at: '2026-08-22T11:59:00Z', pending_handoff_count: 1,
      rules: [{ path: '_rules/conventions.md', title: 'Convenções', kind: 'rule', updated_at: '2026-08-22' }],
      slots: [], recent_pages: [],
    },
    health: { stale: 0, duplicates: 0, contradictions: 0, orphans: 0 },
  };
}
