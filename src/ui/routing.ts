import * as vscode from 'vscode';
import { ApiError } from '../core/client';
import { log } from '../core/log';
import { fetchRoutingBlock } from '../core/mcp';
import { applyRoutingBlock, describeAction } from '../core/routing';
import type { Session } from '../core/session';

/**
 * Instala o bloco de roteamento do ai-memory no arquivo de instruções que o
 * Copilot lê.
 *
 * Fecha a lacuna descoberta no spike: o Copilot tem memória própria e disputa
 * a mesma intenção, e o mecanismo de roteamento do upstream
 * (`install-instructions`) só escreve em `CLAUDE.md` e `AGENTS.md`. Sem isto,
 * a extensão entrega ferramentas que o modelo não escolhe.
 *
 * O arquivo é do repositório do usuário, então a escrita é sempre explícita:
 * comando nomeado, confirmação dizendo o que vai acontecer, e o arquivo abre
 * depois para revisão.
 */

/** Verificado no bundle do copilot-chat 0.61: é o caminho que ele lê. */
const TARGET = '.github/copilot-instructions.md';

export async function installCopilotRouting(session: Session): Promise<void> {
  const folder = session.activeFolder;
  if (!folder) {
    void vscode.window.showInformationMessage(
      'Abra uma pasta antes de instalar o roteamento — o arquivo é gravado no repositório.',
    );
    return;
  }

  const target = vscode.Uri.joinPath(folder.uri, ...TARGET.split('/'));

  let block: string;
  try {
    const options = await session.clientOptions();
    block = await fetchRoutingBlock(options);
  } catch (error) {
    const detail = error instanceof ApiError ? error.message : String(error);
    log.error(`falha ao buscar o bloco de roteamento: ${detail}`);
    const LOG = 'Abrir log';
    const choice = await vscode.window.showErrorMessage(
      `Não foi possível buscar o bloco de roteamento do servidor (${detail}).`,
      LOG,
    );
    if (choice === LOG) {
      log.show();
    }
    return;
  }

  const existing = await readIfExists(target);
  const patch = applyRoutingBlock(existing, block);

  if (!patch.ok) {
    void vscode.window.showWarningMessage(
      `${TARGET} não pôde ser atualizado: ${patch.reason}.`,
    );
    return;
  }

  if (patch.action === 'unchanged') {
    void vscode.window.showInformationMessage(describeAction(patch.action, TARGET));
    return;
  }

  const confirmed = await confirm(patch.action, existing !== undefined);
  if (!confirmed) {
    return;
  }

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.github'));
  await vscode.workspace.fs.writeFile(target, Buffer.from(patch.content, 'utf8'));
  log.info(`bloco de roteamento ${patch.action} em ${TARGET}`);

  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document);
  void vscode.window.showInformationMessage(describeAction(patch.action, TARGET));
}

async function confirm(action: string, fileExists: boolean): Promise<boolean> {
  const verb =
    action === 'created' ? 'criar' : action === 'appended' ? 'adicionar ao final de' : 'atualizar o bloco em';

  const detail = [
    `O bloco vem do servidor ai-memory, via memory_install_self_routing — a mesma fonte que o upstream usa para CLAUDE.md e AGENTS.md.`,
    '',
    fileExists
      ? 'Apenas o trecho entre os marcadores ai-memory é tocado. O resto do arquivo é preservado.'
      : 'O arquivo ainda não existe e será criado.',
    '',
    'Sem isso, pedidos genéricos sobre memória tendem a acionar a memória embutida do Copilot em vez do ai-memory.',
  ].join('\n');

  const choice = await vscode.window.showInformationMessage(
    `${capitalize(verb)} ${TARGET}?`,
    { modal: true, detail },
    'Instalar',
  );
  return choice === 'Instalar';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function readIfExists(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}
