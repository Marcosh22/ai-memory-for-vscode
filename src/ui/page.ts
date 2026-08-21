import * as vscode from 'vscode';
import { ApiError, readPage, type PageLink, type ProjectScope } from '../core/client';
import { log } from '../core/log';
import type { Session } from '../core/session';

/**
 * Leitura de página como documento virtual (§6 e §9 do plano).
 *
 * Sem webview: um `TextDocumentContentProvider` entrega o markdown ao editor
 * de verdade, e tema, busca, copy/paste, dobra e preview vêm de graça. Um
 * webview custaria manutenção de CSS, tema e acessibilidade para entregar
 * menos.
 *
 * O documento é read-only por construção — o scheme não tem
 * `FileSystemProvider`, então o editor não oferece salvar.
 */

export const SCHEME = 'ai-memory';

/** `ai-memory:/<path da página>?ws=<workspace>&proj=<projeto>` */
export function pageUri(scope: ProjectScope, path: string): vscode.Uri {
  const query = new URLSearchParams({ ws: scope.workspace, proj: scope.project }).toString();
  return vscode.Uri.from({ scheme: SCHEME, path: `/${path}`, query });
}

export function parsePageUri(uri: vscode.Uri): { scope: ProjectScope; path: string } | undefined {
  const params = new URLSearchParams(uri.query);
  const workspace = params.get('ws');
  const project = params.get('proj');
  if (!workspace || !project) {
    return undefined;
  }
  return { scope: { workspace, project }, path: uri.path.replace(/^\//, '') };
}

export class PageContentProvider implements vscode.TextDocumentContentProvider {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly session: Session) {}

  refresh(uri: vscode.Uri): void {
    this.changeEmitter.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parsed = parsePageUri(uri);
    if (!parsed) {
      return '> URI de página inválida.';
    }

    try {
      const options = await this.session.clientOptions();
      const page = await readPage(parsed.scope, parsed.path, options);
      return compose(page.body_markdown, page.links, page.backlinks, parsed.scope);
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'not-found') {
        return `> A página \`${parsed.path}\` não existe em \`${parsed.scope.workspace}/${parsed.scope.project}\`.`;
      }
      const detail = error instanceof Error ? error.message : String(error);
      log.error(`falha ao ler página ${parsed.path}: ${detail}`);
      return `> Não foi possível ler \`${parsed.path}\` (${detail}).`;
    }
  }
}

/**
 * Corpo fiel, navegação anexada.
 *
 * O `[[wikilink]]` inline fica como está — o corpo mostrado é o corpo real.
 * A navegação clicável vai num rodapé com links markdown de verdade, que
 * funcionam tanto no editor quanto no preview. O `DocumentLinkProvider`
 * abaixo cuida do ctrl+clique nos wikilinks inline, que só funciona no editor.
 */
function compose(
  body: string,
  links: readonly PageLink[],
  backlinks: readonly PageLink[],
  scope: ProjectScope,
): string {
  const sections: string[] = [body.trimEnd()];

  const render = (label: string, items: readonly PageLink[]): void => {
    if (items.length === 0) {
      return;
    }
    const rendered = items
      .map((link) => {
        const target = pageUri({ workspace: link.workspace, project: link.project }, link.path);
        const foreign =
          link.workspace !== scope.workspace || link.project !== scope.project
            ? ` _(${link.workspace}/${link.project})_`
            : '';
        return `- [${link.title}](${target.toString()})${foreign}`;
      })
      .join('\n');
    sections.push(`### ${label}\n\n${rendered}`);
  };

  render('Links', links);
  render('Referenciado por', backlinks);

  return sections.length > 1 ? `${sections.join('\n\n---\n\n')}\n` : `${sections[0]}\n`;
}

/** Torna `[[alvo]]` navegável por ctrl+clique dentro do editor. */
export class WikilinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const parsed = parsePageUri(document.uri);
    if (!parsed) {
      return [];
    }

    const links: vscode.DocumentLink[] = [];
    const text = document.getText();
    const pattern = /\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;

    for (const match of text.matchAll(pattern)) {
      const target = match[1]?.trim();
      if (!target || match.index === undefined) {
        continue;
      }
      const range = new vscode.Range(
        document.positionAt(match.index),
        document.positionAt(match.index + match[0].length),
      );
      links.push(new vscode.DocumentLink(range, pageUri(parsed.scope, withMarkdownExtension(target))));
    }

    return links;
  }
}

/** Wikilinks costumam omitir a extensão; o path da API sempre a inclui. */
function withMarkdownExtension(target: string): string {
  return /\.[a-z0-9]+$/i.test(target) ? target : `${target}.md`;
}

/** Abre a página no editor. O preview nativo fica a um clique. */
export async function openPage(scope: ProjectScope, path: string): Promise<void> {
  const uri = pageUri(scope, path);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(document, 'markdown');
  await vscode.window.showTextDocument(document, { preview: true });
}
