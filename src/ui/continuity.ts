import * as vscode from 'vscode';
import {
  applyPortableConfig,
  hasPortableConfig,
  suggestPortableIdentity,
  validPortableIdentity,
} from '../core/continuity';
import { resolveCli, runCli } from '../core/setup';
import type { Session } from '../core/session';

const MARKER = '.ai-memory.toml';

export async function portableConfigReady(session: Session): Promise<boolean> {
  const folder = session.activeFolder;
  const scope = session.projectScope;
  if (!folder || !scope) return false;
  const text = await readText(vscode.Uri.joinPath(folder.uri, MARKER));
  return text !== undefined && hasPortableConfig(text, scope);
}

export async function configurePortableProject(session: Session, storageDir: string): Promise<void> {
  const folder = session.activeFolder;
  const scope = session.projectScope;
  if (!folder || !scope) {
    void vscode.window.showInformationMessage('Abra uma pasta antes de preparar a continuidade.');
    return;
  }

  if (!validPortableIdentity(scope.workspace)) {
    void vscode.window.showErrorMessage(
      `O workspace "${scope.workspace}" não é portátil. Renomeie-o para usar apenas minúsculas, números, ponto, hífen ou underscore.`,
    );
    return;
  }

  const portableScope = {
    workspace: scope.workspace,
    project: validPortableIdentity(scope.project)
      ? scope.project
      : suggestPortableIdentity(scope.project),
  };
  const migrate = portableScope.project !== scope.project &&
    session.current.connection.kind === 'connected' &&
    session.current.connection.projectKnown;
  const target = vscode.Uri.joinPath(folder.uri, MARKER);
  const existing = await readText(target) ?? '';
  const next = applyPortableConfig(existing, portableScope);
  if (next === existing.replace(/\r\n/g, '\n')) {
    void vscode.window.showInformationMessage('A configuração portátil já está pronta.');
    return;
  }

  const confirmed = await vscode.window.showInformationMessage(
    `Preparar ${MARKER} para continuidade entre agentes e máquinas?`,
    {
      modal: true,
      detail: [
        `Identidade: ${portableScope.workspace}/${portableScope.project}`,
        ...(migrate ? [`A memória existente será renomeada de "${scope.project}" sem apagar páginas.`] : []),
        'Habilita briefing automático no SessionStart e define uma branch Git exclusiva.',
        'Opções existentes no arquivo serão preservadas.',
      ].join('\n'),
    },
    'Preparar',
  );
  if (confirmed !== 'Preparar') return;

  await vscode.workspace.fs.writeFile(target, Buffer.from(next, 'utf8'));
  if (migrate) {
    const cli = await resolveCli(storageDir);
    if (!cli) {
      await restore(target, existing);
      void vscode.window.showErrorMessage('CLI do ai-memory ausente; a identidade antiga foi preservada.');
      return;
    }
    const options = await session.clientOptions();
    const renamed = await runCli(cli, [
      'rename-project', '--workspace', scope.workspace,
      '--from', scope.project, '--to', portableScope.project,
    ], { token: options.token, serverUrl: options.baseUrl, cwd: folder.uri.fsPath });
    if (!renamed.ok) {
      await restore(target, existing);
      void vscode.window.showErrorMessage(
        `Não foi possível migrar a identidade; o marker foi restaurado (${renamed.stderr}).`,
      );
      return;
    }
  }
  await session.refresh('configuração portátil criada');
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document);
  void vscode.window.showInformationMessage('Projeto preparado para continuidade.');
}

async function restore(uri: vscode.Uri, previous: string): Promise<void> {
  if (previous.length > 0) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(previous, 'utf8'));
  } else {
    await vscode.workspace.fs.delete(uri);
  }
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return undefined;
  }
}
