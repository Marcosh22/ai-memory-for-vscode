import type { Overview, ProjectScope } from './client';

export const PORTABLE_CHECKPOINT_PATH = 'handoffs/latest.md';

export function renderPortableCheckpoint(
  scope: ProjectScope,
  overview: Overview,
  generatedAt: string,
): string {
  const { briefing, handoff, health } = overview;
  const lines = [
    `# Checkpoint portátil — ${scope.project}`,
    '',
    `Gerado em ${generatedAt}.`,
    '',
    '## Estado da memória',
    '',
    `- Páginas atuais: ${briefing.counts.pages_latest}`,
    `- Sessões: ${briefing.counts.sessions}`,
    `- Observações: ${briefing.counts.observations}`,
    `- Última observação: ${briefing.last_observation_at ?? 'não disponível'}`,
    `- Saúde: ${health.stale} obsoletas, ${health.duplicates} duplicadas, ${health.contradictions} contradições, ${health.orphans} órfãs`,
    '',
  ];

  if (handoff?.redacted) {
    lines.push('## Handoff', '', '> Handoff omitido porque pertence a outro operador.', '');
  } else if (handoff) {
    lines.push(
      '## Handoff aberto',
      '',
      `Agente: ${handoff.agent}`,
      `Criado em: ${handoff.at}`,
      '',
    );
    if (handoff.summary) lines.push('### Onde parou', '', handoff.summary, '');
    appendList(lines, 'Perguntas em aberto', handoff.open_questions);
    appendList(lines, 'Próximos passos', handoff.next_steps);
  } else {
    lines.push('## Handoff', '', 'Nenhum handoff estava aberto no momento deste checkpoint.', '');
  }

  appendRefs(lines, 'Regras relevantes', briefing.rules);
  appendRefs(lines, 'Páginas recentes', briefing.recent_pages);
  lines.push(
    '---',
    '',
    '_Checkpoint versionado pelo AI Memory for VS Code para continuidade entre máquinas._',
    '',
  );
  return lines.join('\n');
}

function appendList(lines: string[], title: string, values?: readonly string[]): void {
  if (values && values.length > 0) lines.push(`### ${title}`, '', ...values.map((value) => `- ${value}`), '');
}

function appendRefs(
  lines: string[],
  title: string,
  refs: Overview['briefing']['recent_pages'],
): void {
  if (refs.length > 0) lines.push(`## ${title}`, '', ...refs.map((ref) => `- [[${ref.path}]] — ${ref.title}`), '');
}
