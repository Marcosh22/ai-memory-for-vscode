import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ApiError, readPage, type ClientOptions, type Overview, type ProjectScope } from '../core/client';
import { continuityBranch } from '../core/continuity';
import {
  GitSyncError,
  SyncRepository,
  gitAvailable,
  inferOrigin,
  listRemoteBranches,
  validateBranch,
} from '../core/gitSync';
import { log } from '../core/log';
import { PORTABLE_CHECKPOINT_PATH, renderPortableCheckpoint } from '../core/checkpoint';
import { writePage } from '../core/mcp';
import {
  detectClaudeHooks,
  detectClaudeMcp,
  detectCodexHooks,
  detectCodexMcp,
  detectCodexRouting,
  detectCopilotRouting,
  resolveCli,
  runCli,
} from '../core/setup';
import {
  emptyMemoryBundle,
  exportMemoryBundle,
  importMemoryBundle,
  mergeMemoryBundles,
  resolveMemoryConflicts,
  type MemoryBundle,
} from '../core/memorySync';
import type { Session } from '../core/session';
import { configurePortableProject, portableConfigReady } from './continuity';

const PROFILES_KEY = 'aiMemory.githubSync.profiles.v1';
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

export class GitHubSyncManager implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: Session,
  ) {}

  describe(scope: ProjectScope): string {
    const profile = this.profile(scope);
    if (!profile) return 'GitHub Sync: não configurado';
    const last = profile.lastSyncedAt ? relativeTime(profile.lastSyncedAt) : 'nunca sincronizado';
    return `GitHub Sync: \`${profile.branch}\` (${last})`;
  }

  async checkForRemoteChanges(): Promise<void> {
    const scope = this.session.projectScope;
    if (!scope) return;
    const profile = this.profile(scope);
    if (!profile) return;
    try {
      const repository = this.repository(scope, profile);
      await repository.initialize();
      const remote = await repository.fetchRemote();
      if (remote && remote !== profile.lastSyncedCommit) {
        const choice = await vscode.window.showInformationMessage(
          'O GitHub possui memória mais recente para este projeto.',
          'Preparar para continuar',
        );
        if (choice === 'Preparar para continuar') {
          await this.prepareToContinue();
        }
      }
    } catch (error) {
      log.warn(`não foi possível verificar memória remota: ${String(error).slice(0, 400)}`);
    }
  }

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
          label: '$(save) Publicar checkpoint',
          description: 'handoff e status → GitHub',
          detail: `Cria ou atualiza ${PORTABLE_CHECKPOINT_PATH} e sincroniza a memória.`,
          command: 'checkpoint',
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
      case 'checkpoint':
        await this.publishCheckpoint();
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

    const projectBranch = continuityBranch(scope);
    const createLabel = branches.includes(projectBranch)
      ? '$(add) Criar outra branch'
      : `$(add) Criar ${projectBranch}`;
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
        value: branches.includes(projectBranch) ? `${projectBranch}-2` : projectBranch,
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
      const remoteBundle = remoteCommit
        ? await repository.readBundleAtOrUndefined(remoteCommit)
        : undefined;
      if (
        remoteBundle &&
        (remoteBundle.project.workspace !== scope.workspace ||
          remoteBundle.project.project !== scope.project)
      ) {
        throw new GitSyncError(
          `a branch pertence a ${remoteBundle.project.workspace}/${remoteBundle.project.project}; escolha uma branch exclusiva para ${scope.workspace}/${scope.project}`,
          'remote',
        );
      }
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

  async publishCheckpoint(): Promise<void> {
    await this.session.refresh('publicar checkpoint portátil');
    const state = this.session.current;
    const scope = this.session.projectScope;
    if (
      !scope ||
      state.connection.kind !== 'connected' ||
      !state.connection.projectKnown ||
      !state.overview
    ) {
      void vscode.window.showWarningMessage(
        'Conecte o AI Memory a um projeto reconhecido antes de publicar o checkpoint.',
      );
      return;
    }

    if (!this.profile(scope)) {
      await this.configure();
      if (!this.profile(scope)) return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Publicar o status atual em ${PORTABLE_CHECKPOINT_PATH}?`,
      {
        modal: true,
        detail: 'O resumo do handoff, próximos passos e referências do projeto entrarão no repositório Git configurado. Revise a política de acesso desse repositório antes de continuar.',
      },
      'Publicar',
    );
    if (confirmed !== 'Publicar') return;

    try {
      await this.writeCheckpoint(scope, state.overview);

      if (await this.pull(true) && await this.push(true)) {
        void vscode.window.showInformationMessage(
          `Checkpoint publicado em ${PORTABLE_CHECKPOINT_PATH}.`,
        );
      }
    } catch (error) {
      this.showSyncError('Checkpoint não publicado', error);
    }
  }

  async finishAndSynchronize(storageDir: string): Promise<void> {
    if (!(await portableConfigReady(this.session))) {
      await configurePortableProject(this.session, this.context.globalStorageUri.fsPath);
      if (!(await portableConfigReady(this.session))) return;
    }

    await this.session.refresh('encerrar trabalho e sincronizar');
    const state = this.session.current;
    const scope = this.session.projectScope;
    const folder = this.session.activeFolder;
    if (
      !scope || !folder || state.connection.kind !== 'connected' ||
      !state.connection.projectKnown
    ) {
      void vscode.window.showWarningMessage(
        'Conecte o AI Memory a um projeto reconhecido antes de encerrar o trabalho.',
      );
      return;
    }

    if (!this.profile(scope)) {
      await this.configure();
      if (!this.profile(scope)) return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      'Finalizar a sessão, criar o checkpoint e sincronizar com o GitHub?',
      {
        modal: true,
        detail: `Projeto: ${scope.workspace}/${scope.project}\nO sucesso só será confirmado depois do commit remoto.`,
      },
      'Encerrar e sincronizar',
    );
    if (confirmed !== 'Encerrar e sincronizar') return;

    try {
      const cli = await resolveCli(storageDir);
      if (!cli) throw new Error('CLI do ai-memory ausente; execute AI Memory: Configurar primeiro');
      const options = await this.session.clientOptions();
      const finalized = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Finalizando sessão do AI Memory' },
        () => runCli(cli, ['finalize-session'], {
          token: options.token,
          serverUrl: options.baseUrl,
          cwd: folder.uri.fsPath,
        }),
      );
      if (!finalized.ok) throw new Error(finalized.stderr || 'finalize-session falhou');

      this.session.invalidate();
      await this.session.refresh('sessão finalizada');
      const overview = this.session.current.overview;
      if (!overview) throw new Error('servidor não devolveu o overview após finalizar a sessão');
      await this.writeCheckpoint(scope, overview);

      if (await this.pull(true) && await this.push(true)) {
        void vscode.window.showInformationMessage(
          'Pronto para continuar em outra máquina: sessão finalizada e commit remoto confirmado.',
        );
      }
    } catch (error) {
      this.showSyncError('Não foi possível encerrar e sincronizar', error);
    }
  }

  async prepareToContinue(): Promise<void> {
    if (!(await portableConfigReady(this.session))) {
      await configurePortableProject(this.session, this.context.globalStorageUri.fsPath);
      if (!(await portableConfigReady(this.session))) return;
    }

    await this.session.refresh('preparar para continuar');
    if (this.session.current.connection.kind !== 'connected') {
      void vscode.window.showWarningMessage('Inicie ou conecte o servidor antes de importar a memória.');
      return;
    }
    const scope = this.session.projectScope;
    if (!scope) return;
    if (!this.profile(scope)) {
      await this.configure();
      if (!this.profile(scope)) return;
    }
    if (!(await this.pull(true))) return;

    await this.session.refresh('memória importada para continuar');
    const checkpoint = await this.checkpointAvailable(scope);
    const folder = this.session.activeFolder;
    const home = os.homedir();
    const folderPath = folder?.uri.fsPath;
    const readiness = [
      `Memória: ${this.session.current.connection.kind === 'connected' && this.session.current.connection.projectKnown ? 'pronta' : 'projeto não reconhecido'}`,
      `Checkpoint: ${checkpoint ? PORTABLE_CHECKPOINT_PATH : 'não publicado'}`,
      `Claude Code: ${detectClaudeMcp(home) && detectClaudeHooks(home) ? 'pronto' : 'requer Configurar'}`,
      `Codex: ${detectCodexMcp(home) && detectCodexHooks(home) && !!folderPath && detectCodexRouting(folderPath) ? 'pronto' : 'requer Configurar'}`,
      `Copilot: ${folderPath && detectCopilotRouting(folderPath) ? 'pronto para leitura MCP' : 'requer roteamento'}`,
    ];
    const needsSetup = readiness.some((line) => line.includes('requer'));
    const choice = await vscode.window.showInformationMessage(
      checkpoint ? 'Memória carregada. Pronto para iniciar o agente.' : 'Memória carregada, mas não há checkpoint portátil.',
      { modal: true, detail: readiness.join('\n') },
      ...(needsSetup ? ['Configurar agentes'] : []),
    );
    if (choice === 'Configurar agentes') {
      await vscode.commands.executeCommand('aiMemory.setup');
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
    this.changeEmitter.fire();
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

  private async writeCheckpoint(scope: ProjectScope, overview: Overview): Promise<void> {
    await writePage({
      ...scope,
      path: PORTABLE_CHECKPOINT_PATH,
      title: `Checkpoint portátil — ${scope.project}`,
      body: renderPortableCheckpoint(scope, overview, new Date().toISOString()),
      tier: 'semantic',
      tags: ['checkpoint', 'handoff', 'portable'],
      pinned: true,
    }, await this.session.clientOptions());
    this.session.invalidate();
    await this.session.refresh('checkpoint portátil criado');
  }

  private async checkpointAvailable(scope: ProjectScope): Promise<boolean> {
    try {
      await readPage(scope, PORTABLE_CHECKPOINT_PATH, await this.session.clientOptions());
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'not-found') return false;
      throw error;
    }
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
    this.changeEmitter.fire();
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

  dispose(): void {
    this.changeEmitter.dispose();
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
