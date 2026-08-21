import * as vscode from 'vscode';
import type { Overview, PageKind, PageRef } from '../core/client';
import type { Session, SessionState } from '../core/session';

/**
 * Árvore da memória — alimentada por um único `GET /overview`, o mesmo que
 * abastece o status bar e a notificação de handoff.
 *
 * Nota de escopo: "Sessões" não está aqui. Sessões vivem em `/sessions`, um
 * endpoint separado, e incluí-las custaria uma segunda round-trip por
 * refresh. Fora que, com Copilot, a contagem é sempre zero — sessões só
 * existem via hooks de ciclo de vida, que o Copilot não expõe.
 *
 * Estado vazio nunca é ambíguo: desconectado, escopo órfão e projeto sem
 * páginas são três nós diferentes, com texto diferente. Uma árvore vazia
 * silenciosa seria indistinguível de um projeto que ainda não tem memória.
 */

type Node = SectionNode | PageNode | MessageNode | DetailNode;

class SectionNode {
  readonly type = 'section';
  constructor(
    readonly label: string,
    readonly children: Node[],
    readonly icon: string,
    readonly description?: string,
  ) {}
}

class PageNode {
  readonly type = 'page';
  constructor(readonly page: PageRef) {}
}

class DetailNode {
  readonly type = 'detail';
  constructor(
    readonly label: string,
    readonly icon: string,
  ) {}
}

class MessageNode {
  readonly type = 'message';
  constructor(
    readonly label: string,
    readonly icon: string,
    readonly command?: vscode.Command,
  ) {}
}

const KIND_ICONS: Record<PageKind, string> = {
  rule: 'law',
  slot: 'symbol-variable',
  session: 'history',
  decision: 'milestone',
  gotcha: 'warning',
  concept: 'lightbulb',
  procedure: 'list-ordered',
  note: 'note',
  fact: 'symbol-string',
};

export class MemoryTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private readonly subscription: vscode.Disposable;

  constructor(private readonly session: Session) {
    this.subscription = session.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case 'section': {
        const item = new vscode.TreeItem(
          node.label,
          node.children.length > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.description !== undefined) {
          item.description = node.description;
        }
        item.contextValue = 'section';
        return item;
      }

      case 'page': {
        const item = new vscode.TreeItem(node.page.title || node.page.path);
        item.description = relativeTime(node.page.updated_at);
        item.tooltip = new vscode.MarkdownString(
          `\`${node.page.path}\`\n\n${node.page.kind} · atualizada ${relativeTime(node.page.updated_at)}`,
        );
        item.iconPath = new vscode.ThemeIcon(KIND_ICONS[node.page.kind] ?? 'file');
        item.contextValue = 'page';
        item.command = {
          command: 'aiMemory.openPage',
          title: 'Abrir página',
          arguments: [node.page.path],
        };
        return item;
      }

      case 'detail': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.label;
        return item;
      }

      case 'message': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.command) {
          item.command = node.command;
        }
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (node) {
      return node.type === 'section' ? node.children : [];
    }
    return this.rootNodes(this.session.current);
  }

  private rootNodes(state: SessionState): Node[] {
    switch (state.connection.kind) {
      case 'checking':
        return [new MessageNode('Verificando conexão…', 'loading~spin')];

      case 'offline':
        return [
          new MessageNode(`Servidor não respondeu (${state.connection.detail})`, 'debug-disconnect'),
          new MessageNode('Iniciar servidor', 'play', {
            command: 'aiMemory.startServer',
            title: 'Iniciar servidor',
          }),
        ];

      case 'unauthorized':
        return [
          new MessageNode('O servidor exige um token de acesso', 'key', {
            command: 'aiMemory.setToken',
            title: 'Definir token',
          }),
        ];

      case 'error':
        return [
          new MessageNode(`Erro do servidor (${state.connection.detail})`, 'error', {
            command: 'aiMemory.showLog',
            title: 'Abrir log',
          }),
        ];

      case 'connected':
        break;
    }

    if (!state.scope) {
      return [new MessageNode('Nenhuma pasta aberta neste workspace', 'folder')];
    }

    if (!state.connection.projectKnown) {
      return [
        new MessageNode(
          `"${state.scope.workspace}/${state.scope.project}" não existe no servidor`,
          'warning',
          { command: 'aiMemory.explainUnknownProject', title: 'Entender' },
        ),
      ];
    }

    const overview = state.overview;
    if (!overview) {
      return [new MessageNode('Sem dados de overview', 'question')];
    }

    return this.overviewNodes(overview);
  }

  private overviewNodes(overview: Overview): Node[] {
    const nodes: Node[] = [];
    const { briefing, handoff } = overview;

    if (handoff) {
      const children: Node[] = [];
      if (handoff.redacted) {
        children.push(new DetailNode('Conteúdo restrito a outro operador', 'lock'));
      } else {
        if (handoff.summary) {
          children.push(new DetailNode(handoff.summary, 'comment'));
        }
        for (const question of handoff.open_questions ?? []) {
          children.push(new DetailNode(question, 'question'));
        }
        for (const step of handoff.next_steps ?? []) {
          children.push(new DetailNode(step, 'arrow-right'));
        }
      }
      nodes.push(
        new SectionNode(
          `Handoff de ${handoff.agent}`,
          children,
          'inbox',
          relativeTime(handoff.at),
        ),
      );
    }

    pushPages(nodes, 'Regras', briefing.rules, 'law');
    pushPages(nodes, 'Slots', briefing.slots, 'symbol-variable');
    pushPages(nodes, 'Recentes', briefing.recent_pages, 'history');

    if (nodes.length === 0) {
      return [new MessageNode('Nenhuma memória gravada para este projeto ainda', 'info')];
    }

    nodes.push(
      new SectionNode('Resumo', [], 'graph', `${briefing.counts.pages_latest} páginas`),
    );

    return nodes;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}

function pushPages(nodes: Node[], label: string, pages: readonly PageRef[], icon: string): void {
  if (pages.length === 0) {
    return;
  }
  nodes.push(new SectionNode(label, pages.map((page) => new PageNode(page)), icon, String(pages.length)));
}

/** Data relativa curta. Datas absolutas em UI de relance custam leitura. */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) {
    return 'agora';
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${Math.floor(minutes)} min`;
  }
  const hours = minutes / 60;
  if (hours < 24) {
    return `${Math.floor(hours)} h`;
  }
  const days = hours / 24;
  if (days < 30) {
    return `${Math.floor(days)} d`;
  }
  return new Date(then).toLocaleDateString();
}
