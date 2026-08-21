import * as vscode from 'vscode';
import type { OverviewHandoff } from '../core/client';
import { log } from '../core/log';
import type { Session } from '../core/session';

/**
 * Handoff na abertura do projeto (§6 do plano).
 *
 * REGRA DURA: ler nunca consome a baton. A leitura via `/api/v1` deixa o
 * handoff aberto de propósito, e `memory_handoff_accept` — que consome — não
 * é chamado em lugar nenhum desta fatia. Consumir por engano tira o contexto
 * do próximo agente, e não há como devolver.
 */

export const HANDOFF_SCHEME = 'ai-memory-handoff';

const NOTIFIED_KEY = 'aiMemory.lastNotifiedHandoff';

const HANDOFF_URI = vscode.Uri.from({ scheme: HANDOFF_SCHEME, path: '/handoff.md' });

export class HandoffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  private readonly subscription: vscode.Disposable;

  constructor(private readonly session: Session) {
    this.subscription = session.onDidChange(() => this.changeEmitter.fire(HANDOFF_URI));
  }

  provideTextDocumentContent(): string {
    const state = this.session.current;
    const handoff = state.overview?.handoff;
    if (!handoff) {
      return '> Nenhum handoff aberto para este projeto.\n';
    }
    return render(handoff, state.scope?.project ?? '');
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}

function render(handoff: OverviewHandoff, project: string): string {
  const lines: string[] = [
    `# Handoff — ${handoff.project ?? project}`,
    '',
    `Deixado por \`${handoff.agent}\` em ${formatDate(handoff.at)}.`,
    '',
  ];

  if (handoff.redacted) {
    lines.push(
      '> O conteúdo deste handoff pertence a outro operador e não é servido para esta credencial.',
      '',
      'Os metadados acima continuam visíveis; o texto, não.',
      '',
    );
    return lines.join('\n');
  }

  if (handoff.summary) {
    lines.push('## Onde parou', '', handoff.summary, '');
  }

  const questions = handoff.open_questions ?? [];
  if (questions.length > 0) {
    lines.push('## Perguntas em aberto', '', ...questions.map((q) => `- ${q}`), '');
  }

  const steps = handoff.next_steps ?? [];
  if (steps.length > 0) {
    lines.push('## Próximos passos', '', ...steps.map((s) => `- ${s}`), '');
  }

  lines.push(
    '---',
    '',
    '_Este handoff continua **aberto**. Lê-lo aqui não o consome — o próximo agente ainda o recebe._',
    '',
  );

  return lines.join('\n');
}

function formatDate(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : new Date(parsed).toLocaleString();
}

export async function showHandoff(): Promise<void> {
  const document = await vscode.workspace.openTextDocument(HANDOFF_URI);
  await vscode.languages.setTextDocumentLanguage(document, 'markdown');
  await vscode.window.showTextDocument(document, { preview: true });
}

/**
 * Notificação discreta na abertura do projeto.
 *
 * Deduplicada pelo timestamp do handoff: um refresh de conexão não pode
 * reavisar sobre o mesmo baton, ou a notificação vira ruído e o usuário
 * aprende a ignorá-la.
 */
export async function maybeNotifyHandoff(
  session: Session,
  context: vscode.ExtensionContext,
): Promise<void> {
  const handoff = session.current.overview?.handoff;
  if (!handoff) {
    return;
  }

  const seen = context.workspaceState.get<string>(NOTIFIED_KEY);
  if (seen === handoff.at) {
    return;
  }
  await context.workspaceState.update(NOTIFIED_KEY, handoff.at);

  log.info(`handoff aberto encontrado  agent=${handoff.agent} at=${handoff.at}`);

  const VER = 'Ver resumo';
  const choice = await vscode.window.showInformationMessage(
    `${handoff.agent} parou aqui ${relativeDay(handoff.at)}.`,
    VER,
    'Dispensar',
  );
  if (choice === VER) {
    await showHandoff();
  }
}

function relativeDay(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return 'antes';
  }
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) {
    return 'hoje';
  }
  if (days === 1) {
    return 'ontem';
  }
  if (days < 30) {
    return `há ${days} dias`;
  }
  return `em ${new Date(then).toLocaleDateString()}`;
}
