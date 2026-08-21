import * as vscode from 'vscode';
import { log } from '../core/log';

/**
 * Start assistido, nunca gerenciado (§5 e §9 do plano).
 *
 * A extensão preenche o comando num terminal em vez de spawnar o daemon como
 * filho do extension host. No Windows o process tree morre junto com o pai
 * por job object, o que quebraria o critério "fechar a janela não derruba o
 * servidor" — e o `detached` + `unref()` tem semântica que varia por
 * plataforma. Terminal é idêntico em todo SO, e o usuário vê o que roda.
 *
 * Depois disso a extensão só volta a olhar pelo probe HTTP. Sem PID, sem
 * supervisão, sem restart, sem kill.
 */

interface StartOption extends vscode.QuickPickItem {
  readonly command: string;
}

const OPTIONS: StartOption[] = [
  {
    label: 'Docker',
    description: 'container em background, loopback',
    detail:
      'Exige um token: dentro do container o bind é 0.0.0.0, e o servidor recusa HTTP sem auth fora de loopback.',
    command:
      'docker run -d --name ai-memory -p 127.0.0.1:49374:49374 -v ai-memory-data:/data -e AI_MEMORY_AUTH_TOKEN="$(docker run --rm akitaonrails/ai-memory:latest generate-auth-token)" akitaonrails/ai-memory:latest',
  },
  {
    label: 'Binário nativo',
    description: 'requer ai-memory no PATH',
    detail: 'Bind em loopback dispensa token.',
    command: 'ai-memory serve --transport http --bind 127.0.0.1:49374 --enable-web',
  },
];

/** Fluxo direto, a partir de um comando explícito do usuário. */
export async function startServerFlow(): Promise<void> {
  const picked = await vscode.window.showQuickPick(OPTIONS, {
    title: 'Como iniciar o ai-memory',
    placeHolder: 'O comando é preenchido no terminal — você confirma a execução',
  });
  if (!picked) {
    return;
  }

  log.info(`start assistido escolhido: ${picked.label}`);
  const terminal = vscode.window.createTerminal('ai-memory');
  terminal.show();
  // Sem newline: o comando fica preenchido e o usuário aperta Enter. Pedir o
  // start é da extensão; executar é decisão de quem está na frente.
  terminal.sendText(picked.command, false);
}

/** Notificação de servidor indisponível, com a ação de start embutida. */
export async function offerToStartServer(message: string): Promise<void> {
  const START = 'Iniciar servidor';
  const LOG = 'Abrir log';
  const choice = await vscode.window.showWarningMessage(message, START, LOG);

  if (choice === LOG) {
    log.show();
    return;
  }
  if (choice === START) {
    await startServerFlow();
  }
}
