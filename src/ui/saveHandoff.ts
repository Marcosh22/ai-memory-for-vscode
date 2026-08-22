import * as vscode from 'vscode';
import { ApiError } from '../core/client';
import { log } from '../core/log';
import { beginHandoff } from '../core/mcp';
import type { Session } from '../core/session';

/** Salva um bastão agora; útil ao trocar de agente sem encerrar a sessão. */
export async function saveHandoff(session: Session): Promise<void> {
  const state = session.current;
  const scope = session.projectScope;
  if (!scope || state.connection.kind !== 'connected' || !state.connection.projectKnown) {
    void vscode.window.showWarningMessage(
      'Conecte o AI Memory a um projeto reconhecido antes de salvar o handoff.',
    );
    return;
  }

  const summary = await vscode.window.showInputBox({
    title: `Salvar handoff — ${scope.project}`,
    prompt: 'Onde o trabalho parou?',
    placeHolder: 'Ex.: Integração pronta; falta validar o fluxo no Windows.',
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'O resumo é obrigatório.',
  });
  if (summary === undefined) return;

  const next = await vscode.window.showInputBox({
    title: `Salvar handoff — ${scope.project}`,
    prompt: 'Próximos passos (opcional; separe com ponto e vírgula)',
    placeHolder: 'Executar teste integrado; revisar logs',
    ignoreFocusOut: true,
  });
  if (next === undefined) return;

  try {
    await beginHandoff({
      ...scope,
      summary: summary.trim(),
      nextSteps: next.split(';').map((item) => item.trim()).filter(Boolean),
    }, await session.clientOptions());
    log.info(`handoff salvo manualmente  workspace=${scope.workspace} project=${scope.project}`);
    session.invalidate();
    await session.refresh('handoff salvo manualmente');
    void vscode.window.showInformationMessage(`Handoff salvo em ${scope.workspace}/${scope.project}.`);
  } catch (error) {
    const detail = error instanceof ApiError ? error.message : String(error);
    log.error(`falha ao salvar handoff: ${detail}`);
    const choice = await vscode.window.showErrorMessage(
      `Não foi possível salvar o handoff (${detail}).`, 'Abrir log',
    );
    if (choice === 'Abrir log') log.show();
  }
}
