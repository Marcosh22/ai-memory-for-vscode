import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type ClientOptions, type ProjectScope } from '../core/client';
import {
  GitSyncError,
  SyncRepository,
  gitAvailable,
  inferOrigin,
  listRemoteBranches,
  validateBranch,
} from '../core/gitSync';
import { log } from '../core/log';
import {
  emptyMemoryBundle,
  exportMemoryBundle,
  importMemoryBundle,
  mergeMemoryBundles,
  resolveMemoryConflicts,
  type MemoryBundle,
} from '../core/memorySync';
import type { Session } from '../core/session';

const PROFILES_KEY = 'aiMemory.githubSync.profiles.v1';
const DEFAULT_BRANCH = 'ai-memory-sync';

interface SyncProfile {
  readonly remoteUrl: string;
  readonly branch: string;
  readonly lastSyncedCommit?: string | undefined;
  readonly lastSyncedAt?: string | undefined;
}

interface SyncContext {
  readonly scope: ProjectScope;
  readonly options: ClientOptions;
  readonly folder: vscode.WorkspaceFolder;
  readonly profile: SyncProfile;
  readonly repository: SyncRepository;
}

interface BranchChoice extends vscode.QuickPickItem {
  readonly branch?: string | undefined;
  readonly create?: boolean | undefined;
}

export class GitHubSyncManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: Session,
  ) {}

  async show(): Promise<void> {
    const scope = this.session.projectScope;
    if (!scope || !this.session.activeFolder) {
      void vscode.window.showInformationMessage('Abra uma pasta para configurar o GitHub Sync.');
      return;
    }
    const profile = this.profile(scope);
    if (!profile) {
      await this.configure();
      return;
    }

    const last = profile.lastSyncedAt
      ? `última sincronização ${relativeTime(profile.lastSyncedAt)}`
      : 'ainda não sincronizado';
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(sync) Sincronizar',
          description: 'pull e depois push',
          detail: 'Combina mudanças sem sobrescrever conflitos.',
          command: 'sync',
        },
        {
          label: '$(cloud-download) Pull',
          description: 'GitHub → esta máquina',
          detail: 'Importa páginas novas ou alteradas no AI Memory local.',
          command: 'pull',
        },
        {
          label: '$(cloud-upload) Push',
          description: 'esta máquina → GitHub',
          detail: 'Publica somente depois de confirmar que a branch remota não avançou.',
          command: 'push',
        },
        {
          label: '$(history) Histórico',
          description: last,
          detail: `${profile.remoteUrl} · ${profile.branch}`,
          command: 'history',
        },
        {
          label: '$(settings-gear) Reconfigurar',
          description: profile.branch,
          detail: profile.remoteUrl,
          command: 'configure',
        },
        {
          label: '$(debug-disconnect) Desconectar',
          description: 'não apaga dados locais nem remotos',
          command: 'disconnect',
        },
      ],
      {
        title: `GitHub Sync — ${scope.workspace}/${scope.project}`,
        placeHolder: last,
      },
    );

    switch (choice?.command) {
      case 'sync':
        await this.synchronize();
        break;
      case 'pull':
        await this.pull();
        break;
      case 'push':
        await this.push();
        break;
      case 'history':
        await this.showHistory();
        break;
      case 'configure':
        await this.configure();
        break;
      case 'disconnect':
        await this.disconnect();
        break;
      case undefined:
        break;
    }
  }

  async configure(): Promise<void> {
    const scope = this.session.projectScope;
    const folder = this.session.activeFolder;
    if (!scope || !folder) {
      void vscode.window.showInformationMessage('Abra uma pasta para configurar o GitHub Sync.');
      return;
    }
    if (!(await gitAvailable())) {
      void vscode.window.showErrorMessage('Git não foi encontrado. Instale o Git e entre no GitHub pelo VS Code.');
      return;
    }

    const current = this.profile(scope);
    const suggested = current?.remoteUrl ?? (await inferOrigin(folder.uri.fsPath)) ?? '';
    const remoteUrl = await vscode.window.showInputBox({
      title: 'GitHub Sync — repositório',
      prompt: 'Cole a URL de um repositório privado ou use o origin deste projeto.',
      placeHolder: 'https://github.com/usuario/memoria-projeto.git',
      value: suggested,
      ignoreFocusOut: true,
      validateInput: validateRemoteUrl,
    });
    if (!remoteUrl) {
      return;
    }

    let branches: string[];
    try {
      branches = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Consultando branches do GitHub' },
        () => listRemoteBranches(remoteUrl, folder.uri.fsPath),
      );
    } catch (error) {
      this.showError('Não foi possível acessar o repositório', error);
      return;
    }

    const createLabel = branches.includes(DEFAULT_BRANCH)
      ? '$(add) Criar outra branch'
      : `$(add) Criar ${DEFAULT_BRANCH}`;
    const branchChoices: BranchChoice[] = [
      { label: createLabel, create: true },
      ...branches.map((branch) => ({ label: `$(git-branch) ${branch}`, branch })),
    ];
    const picked = await vscode.window.showQuickPick(
      branchChoices,
      {
        title: 'GitHub Sync — branch',
        placeHolder: 'Uma branch dedicada evita misturar memória com o código.',
      },
    );
    if (!picked) {
      return;
    }

    let branch = picked.branch;
    if (picked.create) {
      branch = await vscode.window.showInputBox({
        title: 'Nome da nova branch de memória',
        value: branches.includes(DEFAULT_BRANCH) ? `${DEFAULT_BRANCH}-2` : DEFAULT_BRANCH,
        ignoreFocusOut: true,
        validateInput: (value) => {
          try {
            validateBranch(value.trim());
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
      });
    } else {
      const confirm = await vscode.window.showWarningMessage(
        `Usar a branch existente "${branch}" para a memória?`,
        {
          modal: true,
          detail:
            'A extensão adicionará apenas a pasta .ai-memory-sync/. Recomendamos uma branch dedicada em um repositório privado.',
        },
        'Usar esta branch',
      );
      if (confirm !== 'Usar esta branch') {
        return;
      }
    }
    if (!branch) {
      return;
    }

    const profile: SyncProfile = { remoteUrl: remoteUrl.trim(), branch: branch.trim() };
    try {
      const repository = this.repository(scope, profile);
      await repository.initialize();
      const remoteCommit = await repository.fetchRemote();
      if (remoteCommit && !(await repository.head())) {
        await repository.checkoutRemote(remoteCommit);
      }
      await this.saveProfile(scope, profile);
      void vscode.window.showInformationMessage(
        `GitHub Sync configurado em ${profile.branch}. Use Pull para importar ou Push para publicar.`,
      );
    } catch (error) {
      this.showError('Não foi possível configurar o GitHub Sync', error);
    }
  }

  async pull(silent = false): Promise<boolean> {
    try {
      const ctx = await this.requireContext();
      if (!ctx) {
        return false;
      }
      const imported = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'GitHub Sync: recebendo memória',
        },
        async (progress) => {
          await ctx.repository.initialize();
          const remoteCommit = await ctx.repository.fetchRemote();
          if (!remoteCommit) {
            return { imported: 0, empty: true };
          }

          const remote = await this.bundleAtOrEmpty(ctx.repository, remoteCommit, ctx.scope);
          const base = ctx.profile.lastSyncedCommit
            ? await this.bundleAtOrEmpty(ctx.repository, ctx.profile.lastSyncedCommit, ctx.scope)
            : emptyMemoryBundle(ctx.scope);
          const local = await this.exportLocal(ctx, progress);
          const merged = mergeMemoryBundles(base, local, remote);
          let incoming = merged.bundle;
          if (merged.conflicts.length > 0) {
            const visible = merged.conflicts.slice(0, 8).join('\n');
            const rest = merged.conflicts.length > 8
              ? `\n... e mais ${merged.conflicts.length - 8}`
              : '';
            const choice = await vscode.window.showWarningMessage(
              `${merged.conflicts.length} página(s) mudaram nesta máquina e no GitHub.`,
              {
                modal: true,
                detail: `${visible}${rest}\n\nEscolha qual versão deve vencer nesses conflitos. Páginas sem conflito serão combinadas normalmente.`,
              },
              'Manter esta máquina',
              'Usar GitHub',
            );
            if (!choice) {
              return { imported: 0, empty: false, cancelled: true };
            }
            incoming = resolveMemoryConflicts(
              merged,
              local,
              remote,
              choice === 'Manter esta máquina' ? 'local' : 'remote',
            );
          }

          await ctx.repository.checkoutRemote(remoteCommit);
          const imported = await importMemoryBundle(
            incoming,
            local,
            ctx.options,
            (done, total, page) => progress.report({ message: `Importando ${done}/${total}: ${page}` }),
          );
          await this.saveProfile(ctx.scope, {
            ...ctx.profile,
            lastSyncedCommit: remoteCommit,
            lastSyncedAt: new Date().toISOString(),
          });
          return { imported, empty: false, cancelled: false };
        },
      );

      if ('cancelled' in imported && imported.cancelled) {
        return false;
      }

      await this.session.refresh('GitHub Sync pull');
      if (!silent) {
        void vscode.window.showInformationMessage(
          imported.empty
            ? 'A branch ainda não possui memória. Use Push para publicar esta máquina.'
            : imported.imported === 0
              ? 'Pull concluído: a memória local já estava atualizada.'
              : `Pull concluído: ${imported.imported} página(s) importada(s).`,
        );
      }
      return true;
    } catch (error) {
      this.showSyncError('Pull interrompido', error);
      return false;
    }
  }

  async push(silent = false): Promise<boolean> {
    try {
      const ctx = await this.requireContext();
      if (!ctx) {
        return false;
      }
      if (
        this.session.current.connection.kind !== 'connected' ||
        !this.session.current.connection.projectKnown
      ) {
        void vscode.window.showWarningMessage('Este projeto ainda não possui memória local para publicar.');
        return false;
      }

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'GitHub Sync: publicando memória',
        },
        async (progress) => {
          await ctx.repository.initialize();
          const remoteCommit = await ctx.repository.fetchRemote();
          if (remoteCommit !== ctx.profile.lastSyncedCommit) {
            const firstPublishIntoEmptyBranch =
              ctx.profile.lastSyncedCommit === undefined &&
              remoteCommit !== undefined &&
              (await this.bundleAtOrUndefined(ctx.repository, remoteCommit)) === undefined;
            if (!firstPublishIntoEmptyBranch) {
              throw new GitSyncError('a branch remota mudou; execute Pull antes do Push', 'remote');
            }
          }

          if (remoteCommit && (await ctx.repository.head()) !== remoteCommit) {
            await ctx.repository.checkoutRemote(remoteCommit);
          }

          const local = await this.exportLocal(ctx, progress);
          const remote = remoteCommit
            ? await this.bundleAtOrEmpty(ctx.repository, remoteCommit, ctx.scope)
            : emptyMemoryBundle(ctx.scope);
          // Não propaga exclusões: uma página que existe apenas no remoto
          // continua no manifesto até existir um protocolo de tombstones.
          const bundle = mergeMemoryBundles(remote, local, remote).bundle;
          ctx.repository.writeBundle(bundle);
          await ctx.repository.commit(`AI Memory: sync ${ctx.scope.workspace}/${ctx.scope.project}`);
          const commit = await ctx.repository.push();
          await this.saveProfile(ctx.scope, {
            ...ctx.profile,
            lastSyncedCommit: commit,
            lastSyncedAt: new Date().toISOString(),
          });
          return { pages: bundle.pages.length, commit };
        },
      );

      if (!silent) {
        void vscode.window.showInformationMessage(
          `Push concluído: ${result.pages} página(s), commit ${result.commit.slice(0, 7)}.`,
        );
      }
      return true;
    } catch (error) {
      this.showSyncError('Push interrompido', error);
      return false;
    }
  }

  async synchronize(): Promise<void> {
    if (await this.pull(true)) {
      if (await this.push(true)) {
        void vscode.window.showInformationMessage('Sincronização concluída: GitHub e memória local estão alinhados.');
      }
    }
  }

  async showHistory(): Promise<void> {
    try {
      const ctx = await this.requireContext();
      if (!ctx) {
        return;
      }
      await ctx.repository.initialize();
      const remote = await ctx.repository.fetchRemote();
      if (remote && !(await ctx.repository.head())) {
        await ctx.repository.checkoutRemote(remote);
      }
      const history = await ctx.repository.history();
      if (history.length === 0) {
        void vscode.window.showInformationMessage('Ainda não há versões de memória nesta branch.');
        return;
      }
      await vscode.window.showQuickPick(
        history.map((entry) => ({
          label: `$(git-commit) ${entry.subject}`,
          description: entry.commit.slice(0, 7),
          detail: new Date(entry.at).toLocaleString(),
        })),
        { title: `Histórico da memória — ${ctx.profile.branch}` },
      );
    } catch (error) {
      this.showError('Não foi possível abrir o histórico', error);
    }
  }

  private async disconnect(): Promise<void> {
    const scope = this.session.projectScope;
    if (!scope) {
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      'Desconectar este projeto do GitHub Sync?',
      { modal: true, detail: 'Nenhuma página e nenhum commit será apagado.' },
      'Desconectar',
    );
    if (confirmed !== 'Desconectar') {
      return;
    }
    const profiles = this.profiles();
    delete profiles[scopeKey(scope)];
    await this.context.workspaceState.update(PROFILES_KEY, profiles);
    void vscode.window.showInformationMessage('GitHub Sync desconectado deste projeto.');
  }

  private async requireContext(): Promise<SyncContext | undefined> {
    const scope = this.session.projectScope;
    const folder = this.session.activeFolder;
    if (!scope || !folder) {
      void vscode.window.showInformationMessage('Abra uma pasta para usar o GitHub Sync.');
      return undefined;
    }
    const profile = this.profile(scope);
    if (!profile) {
      await this.configure();
      return undefined;
    }
    if (this.session.current.connection.kind !== 'connected') {
      void vscode.window.showWarningMessage('Conecte o AI Memory local antes de sincronizar.');
      return undefined;
    }
    return {
      scope,
      folder,
      profile,
      repository: this.repository(scope, profile),
      options: await this.session.clientOptions(),
    };
  }

  private async exportLocal(
    ctx: SyncContext,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<MemoryBundle> {
    if (
      this.session.current.connection.kind !== 'connected' ||
      !this.session.current.connection.projectKnown
    ) {
      return emptyMemoryBundle(ctx.scope);
    }
    return exportMemoryBundle(ctx.scope, ctx.options, (done, total, page) =>
      progress.report({ message: `Lendo ${done}/${total}: ${page}` }),
    );
  }

  private async bundleAtOrEmpty(
    repository: SyncRepository,
    revision: string,
    scope: ProjectScope,
  ): Promise<MemoryBundle> {
    return (await this.bundleAtOrUndefined(repository, revision)) ?? emptyMemoryBundle(scope);
  }

  private async bundleAtOrUndefined(
    repository: SyncRepository,
    revision: string,
  ): Promise<MemoryBundle | undefined> {
    return repository.readBundleAtOrUndefined(revision);
  }

  private profile(scope: ProjectScope): SyncProfile | undefined {
    return this.profiles()[scopeKey(scope)];
  }

  private profiles(): Record<string, SyncProfile> {
    return { ...this.context.workspaceState.get<Record<string, SyncProfile>>(PROFILES_KEY, {}) };
  }

  private async saveProfile(scope: ProjectScope, profile: SyncProfile): Promise<void> {
    const profiles = this.profiles();
    profiles[scopeKey(scope)] = profile;
    await this.context.workspaceState.update(PROFILES_KEY, profiles);
  }

  private repository(scope: ProjectScope, profile: SyncProfile): SyncRepository {
    const identity = `${profile.remoteUrl}\0${profile.branch}\0${scope.workspace}\0${scope.project}`;
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 24);
    return new SyncRepository(
      path.join(this.context.globalStorageUri.fsPath, 'github-sync', key),
      profile.remoteUrl,
      profile.branch,
    );
  }

  private showSyncError(title: string, error: unknown): void {
    this.showError(title, error);
  }

  private showError(title: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    log.error(`${title}: ${detail.slice(0, 800)}`);
    void vscode.window.showErrorMessage(`${title}: ${detail}`, 'Abrir log').then((choice) => {
      if (choice === 'Abrir log') {
        log.show();
      }
    });
  }
}

function scopeKey(scope: ProjectScope): string {
  return `${scope.workspace}\0${scope.project}`;
}

function validateRemoteUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Informe a URL do repositório.';
  }
  if (/^https?:\/\/[^/@\s]+:[^/@\s]+@/i.test(trimmed)) {
    return 'Não coloque token ou senha na URL; use o login do Git/VS Code.';
  }
  return undefined;
}

function relativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return iso;
  }
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) {
    return 'agora';
  }
  if (minutes < 60) {
    return `há ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `há ${hours} h`;
  }
  return `há ${Math.floor(hours / 24)} d`;
}
