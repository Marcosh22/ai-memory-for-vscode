import * as vscode from 'vscode';
import { ApiError, search, type SearchHit } from '../core/client';
import { log } from '../core/log';
import type { Session } from '../core/session';
import { openPage } from './page';

/**
 * Busca por QuickPick (§6 e §9 do plano) — o idioma do editor, como o Cmd+P.
 * Ninguém precisa aprender uma caixa de busca nova numa sidebar.
 *
 * Dois detalhes que quebrariam em silêncio:
 *
 * 1. O QuickPick filtra os itens pelo texto digitado. Como a filtragem aqui é
 *    do servidor (FTS5, que casa corpo e entidades, não só título), um hit
 *    perfeitamente relevante cujo título não contém o termo seria escondido
 *    pelo próprio widget. `alwaysShow` desliga esse filtro por item.
 *
 * 2. `rank` do FTS5 é NEGATIVO e menor é melhor. Ordenar decrescente, que é
 *    o reflexo natural para "score", inverteria a relevância.
 */

const DEBOUNCE_MS = 250;

interface HitItem extends vscode.QuickPickItem {
  readonly hit: SearchHit;
}

export async function showSearch(session: Session): Promise<void> {
  const state = session.current;
  if (state.connection.kind !== 'connected') {
    await vscode.commands.executeCommand('aiMemory.checkConnection');
    return;
  }

  const scoped = { current: state.scope !== undefined };
  const globalButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('globe'),
    tooltip: 'Alternar entre este projeto e todos os projetos',
  };

  const quickPick = vscode.window.createQuickPick<HitItem>();
  quickPick.matchOnDescription = false;
  quickPick.matchOnDetail = false;
  quickPick.buttons = [globalButton];
  applyTitle();

  let timer: NodeJS.Timeout | undefined;
  let generation = 0;

  const run = async (value: string): Promise<void> => {
    const query = value.trim();
    if (query.length === 0) {
      quickPick.items = [];
      quickPick.busy = false;
      return;
    }

    const token = ++generation;
    quickPick.busy = true;

    try {
      const options = await session.clientOptions();
      const scope = scoped.current ? session.projectScope : undefined;
      const hits = await search(query, scope, options);
      if (token !== generation) {
        return; // resposta obsoleta, uma busca mais nova já saiu
      }
      quickPick.items = hits
        .slice()
        .sort((a, b) => a.rank - b.rank)
        .map(toItem);
    } catch (error) {
      if (token !== generation) {
        return;
      }
      const detail = error instanceof ApiError ? error.message : String(error);
      log.warn(`busca falhou: ${detail}`);
      quickPick.items = [];
    } finally {
      if (token === generation) {
        quickPick.busy = false;
      }
    }
  };

  quickPick.onDidChangeValue((value) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => void run(value), DEBOUNCE_MS);
  });

  quickPick.onDidTriggerButton((button) => {
    if (button === globalButton) {
      scoped.current = !scoped.current && session.projectScope !== undefined ? true : !scoped.current;
      // Sem escopo disponível, só o modo global faz sentido.
      if (session.projectScope === undefined) {
        scoped.current = false;
      }
      applyTitle();
      void run(quickPick.value);
    }
  });

  quickPick.onDidAccept(() => {
    const picked = quickPick.selectedItems[0];
    quickPick.hide();
    if (picked) {
      void openPage(
        { workspace: picked.hit.workspace, project: picked.hit.project },
        picked.hit.path,
      );
    }
  });

  quickPick.onDidHide(() => {
    if (timer) {
      clearTimeout(timer);
    }
    quickPick.dispose();
  });

  quickPick.show();

  function applyTitle(): void {
    const scope = session.projectScope;
    quickPick.title = 'Buscar na memória';
    quickPick.placeholder =
      scoped.current && scope
        ? `Buscando em ${scope.workspace}/${scope.project} — o ícone alterna para todos os projetos`
        : 'Buscando em todos os projetos — o ícone alterna para o projeto atual';
  }
}

function toItem(hit: SearchHit): HitItem {
  return {
    label: hit.title || hit.path,
    description: hit.path,
    detail: cleanSnippet(hit.snippet),
    // Desliga a filtragem client-side do widget: quem filtrou foi o FTS5.
    alwaysShow: true,
    hit,
  };
}

/**
 * O snippet vem com marcadores `<mark>` do FTS5. O QuickPick não renderiza
 * HTML, então eles apareceriam crus. Remover é melhor que mostrar tags.
 */
function cleanSnippet(snippet: string): string {
  return snippet
    .replace(/<\/?mark>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
