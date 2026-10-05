import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverRepositories, loadCatalog, readBranch, saveCatalog } from '../../src/core/catalog';
import { WorkspaceFiles } from '../../src/core/files';
import { WorkspaceSearch } from '../../src/core/search';
import { prepareWrite, readStatus } from '../../src/core/status';
import type { GitRunner, Repository } from '../../src/core/types';
import { CONTRACT_VERSION, type Branch, type HostEvents, type Observation, type RecentWorkspace, type RepositoryRow, type RepositoryStatus, type Upstream, type WorkspaceSnapshot } from '../renderer/src/contract';
import { FileService } from './file-service';
import { GitService } from './git-service';
import { RequestError, type Handlers } from './protocol';
import { StateStore } from './state';
import { SessionStateStore, validateRendererSession } from './session-state';
import type { RendererSession } from '../shared/session';
import { WatchCoordinator } from './watcher';

export interface WorkspaceContext {
  state: StateStore;
  git: GitRunner;
  dataDirectory: string;
  emit(event: keyof HostEvents, payload: unknown): void;
  confirm(title: string, detail: string): Promise<boolean>;
  choose(title: string, options: { id: string; label: string; detail?: string }[]): Promise<string | undefined>;
  rgPath?: string;
  onWatchEvent?(event: { ids: string[]; metadataIds?: string[]; branchMetadata?: { id: string; deliveredAt: number }[] }): void;
}
const identity = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const inside = (root: string, target: string) => { const relative = path.relative(root, target); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const platform = (): WorkspaceSnapshot['platform'] => process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
const unknown = <T>(generation = 0): Observation<T> => ({ state: 'unknown', generation });
type Field = 'branch' | 'status';
interface Active {
  snapshot: WorkspaceSnapshot;
  session: RendererSession | null;
  repositories: Map<string, Repository>;
  browseOnly: Set<string>;
  rows: Map<string, RepositoryRow>;
  controller: AbortController;
  git: GitRunner;
  files: WorkspaceFiles;
  fileService: FileService;
  gitService: GitService;
  watcher: WatchCoordinator;
  cache: string;
  queues: Record<Field, Set<string>>;
  running: Record<Field, Set<string>>;
  idle: (() => void)[];
  discovering: boolean;
  cacheTimer?: ReturnType<typeof setTimeout>;
  fallbackTimer?: ReturnType<typeof setInterval>;
  fallbackOffset: number;
  pendingSelection?: string;
  dirtyRows: Set<string>;
  rowTimer?: ReturnType<typeof setTimeout>;
}

/** One approved workspace. Cached display rows never authorize filesystem or Git access. */
export class WorkspaceSession {
  readonly handlers: Handlers;
  ready: Promise<void> = Promise.resolve();
  private active?: Active;
  private transitions: Promise<unknown> = Promise.resolve();
  private focused = true;
  private readonly sessions: SessionStateStore;

  constructor(private readonly context: WorkspaceContext) {
    this.sessions = new SessionStateStore(context.dataDirectory);
    this.handlers = {
      'workspace.get': () => this.snapshot,
      'workspace.recent': () => this.recent(),
      'workspace.close': async () => { await this.close(); this.context.state.setWorkspace({ roots: [], repositoryOrder: [], pinnedRepositories: [], openDocuments: [] }); await this.context.state.flush(); },
      'workspace.trust': request => this.setTrust(request.trusted),
      'repo.select': request => this.select(request.id),
      'repo.refresh': request => this.refresh(request),
    };
    Object.assign(this.handlers, { 'session.get': () => this.sessionState(), 'session.save': (value: unknown) => this.saveSession(value) });
    // Dispatch through the currently active services: an old window cannot retain
    // a handler bound to a previously authorized workspace.
    const fileMethods: (keyof Handlers)[] = ['fs.list', 'fs.read', 'fs.write', 'fs.findPaths', 'fs.createFile', 'fs.createDirectory', 'fs.prepareTransfer', 'fs.transfer', 'fs.delete', 'fs.backups', 'fs.restore', 'fs.recover', 'fs.recoveries', 'fs.readRecovery', 'fs.removeRecovery', 'fs.removeBackup', 'search.start', 'search.cancel', 'git.discard'];
    const gitMethods: (keyof Handlers)[] = ['git.diff', 'git.hunks', 'git.applyHunks', 'git.prepare', 'git.stage', 'git.unstage', 'git.commit', 'git.history', 'git.show', 'git.revisionDiff', 'git.operation', 'git.branches', 'git.createBranch', 'git.switchBranch', 'git.stashes', 'git.stash', 'git.applyStash', 'git.dropStash', 'git.remotes', 'git.fetch', 'git.pull', 'git.push', 'git.cancel'];
    for (const [methods, service] of [[fileMethods, 'fileService'], [gitMethods, 'gitService']] as const) {
      for (const method of methods) (this.handlers as Record<string, (params: unknown) => unknown>)[method] = params => {
        const current = this.requireActive();
        if ((method === 'fs.prepareTransfer' || method === 'fs.transfer') && current.discovering) throw new RequestError('unavailable', 'Repository boundaries are still being discovered. Try the transfer again when discovery finishes.');
        const handler = current[service].handlers[method];
        if (!handler) throw new RequestError('unavailable', 'This operation is unavailable.');
        return (handler as (input: unknown) => unknown)(params);
      };
    }
  }

  sessionState(): RendererSession | null { return this.active?.session ? structuredClone(this.active.session) : null; }
  async saveSession(value: unknown): Promise<void> {
    const active = this.requireActive();
    const session = validateRendererSession(value, active.snapshot.id);
    active.session = session;
    const ordered = new Map<string, RepositoryRow>();
    for (const id of session.order) if (active.rows.has(id)) ordered.set(id, active.rows.get(id)!);
    for (const [id, row] of active.rows) if (!ordered.has(id)) ordered.set(id, row);
    active.rows = ordered; active.snapshot.rows = [...ordered.values()];
    this.persistWorkspace(active);
    await this.sessions.save(session);
  }
  settled(): Promise<void> { return this.active ? this.whenIdle(this.active) : Promise.resolve(); }
  get snapshot(): WorkspaceSnapshot | null { return this.active ? structuredClone(this.active.snapshot) : null; }
  get files(): WorkspaceFiles | undefined { return this.active?.files; }
  get fileService(): FileService | undefined { return this.active?.fileService; }
  get gitService(): GitService | undefined { return this.active?.gitService; }
  repository(id: string): Repository {
    const repository = this.requireActive().repositories.get(id);
    if (!repository) throw new RequestError('unavailable', 'Repository metadata has not been verified in this workspace.');
    return { ...repository };
  }
  repositories(): Repository[] { return this.active ? [...this.active.repositories.values()].map(repository => ({ ...repository })) : []; }
  recentRoots(id: string): string[] | undefined { return this.context.state.snapshot.recentWorkspaces.find(roots => identity(JSON.stringify(roots)) === id)?.slice(); }
  diagnostics() { const active = this.active; return active ? { ...active.watcher.snapshot(), branchQueued: active.queues.branch.size, branchRunning: active.running.branch.size, statusQueued: active.queues.status.size, statusRunning: active.running.status.size } : { strategy: 'closed' }; }

  open(roots: string[]): Promise<WorkspaceSnapshot> {
    const next = this.transitions.catch(() => undefined).then(() => this.openNow(roots));
    this.transitions = next;
    return next;
  }
  close(): Promise<void> {
    const next = this.transitions.catch(() => undefined).then(() => this.closeNow());
    this.transitions = next;
    return next;
  }
  /** Focus reconciliation is bounded; it never launches a whole-workspace scan. */
  setFocused(focused: boolean): void {
    const regained = focused && !this.focused; this.focused = focused;
    if (regained && this.active) this.reconcileBounded(this.active);
  }

  private requireActive(): Active { if (!this.active) throw new RequestError('unavailable', 'Open a workspace first.'); return this.active; }
  private current(active: Active): boolean { return this.active === active && !active.controller.signal.aborted; }
  private async openNow(inputs: string[]): Promise<WorkspaceSnapshot> {
    if (!inputs.length || inputs.length > 64) throw new RequestError('boundary', 'Choose between one and 64 workspace folders.');
    const roots = [...new Set(await Promise.all(inputs.map(async input => {
      const root = await realpath(path.resolve(input));
      if (!(await stat(root)).isDirectory()) throw new RequestError('boundary', 'Workspace roots must be folders.');
      return root;
    })))];
    // Validate the replacement before closing the user's current workspace.
    const id = identity(JSON.stringify(roots));
    const cache = path.join(this.context.dataDirectory, 'cache', id);
    const files = await WorkspaceFiles.create({ roots, recoveryDirectory: path.join(this.context.dataDirectory, 'recovery', id) });
    await this.closeNow(false);
    const controller = new AbortController();
    const git: GitRunner = { run: (cwd, args, options = {}) => {
      if (!roots.some(root => inside(root, path.resolve(cwd)))) return Promise.reject(new RequestError('boundary', 'Git access is outside the approved workspace folders.'));
      if (controller.signal.aborted) return Promise.reject(new RequestError('unavailable', 'Workspace is closed.'));
      const signal = options.write ? options.signal : options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      return this.context.git.run(cwd, args, { ...options, signal });
    } };
    const saved = this.context.state.workspace;
    const session = await this.sessions.load(id);
    const order = session?.order ?? saved.repositoryOrder;
    const repositories = new Map<string, Repository>();
    const browseOnly = new Set<string>();
    const rows = new Map<string, RepositoryRow>();
    const cached = (await loadCatalog(path.join(cache, 'catalog.json'))).filter(repository => roots.some(root => inside(root, repository.root)));
    const branchCache = await this.loadBranches(cache);
    const ordered = [...cached].sort((a, b) => {
      const ai = order.indexOf(a.id); const bi = order.indexOf(b.id);
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    });
    for (const repository of ordered) rows.set(repository.id, this.row(repository, roots, branchCache.get(repository.id)));
    for (const root of roots) {
      const repository: Repository = { id: identity(root), root, name: path.basename(root) || root, available: false, error: 'Repository discovery is pending.' };
      repositories.set(repository.id, repository); browseOnly.add(repository.id);
      if (!rows.has(repository.id)) rows.set(repository.id, this.row(repository, roots));
    }
    const snapshot: WorkspaceSnapshot = {
      contract: CONTRACT_VERSION, id, name: roots.map(root => path.basename(root) || root).join(' + '), roots,
      discovery: cached.length ? 'cached' : 'discovering', trusted: this.context.state.isTrusted(roots), gitAvailable: true,
      rows: [...rows.values()], selectedId: rows.has(session?.selectedId ?? saved.selectedRepository ?? '') ? session?.selectedId ?? saved.selectedRepository : rows.keys().next().value,
      platform: platform(),
    };
    let active!: Active;
    const watcher = new WatchCoordinator(git);
    const fileService = new FileService({ files, git, consumeGitReview: (id, token, action, paths) => active.gitService.consumeReview(id, token, action, paths), invalidate: id => { if (this.current(active)) this.invalidate(active, [id]); }, search: new WorkspaceSearch(files, { rgPath: this.context.rgPath }),
      getRepository: repositoryId => { if (!this.current(active)) throw new RequestError('unavailable', 'Workspace is closed.'); return this.repository(repositoryId); },
      getRepositories: () => this.current(active) ? this.repositories() : [],
      canBrowseRepository: repositoryId => this.current(active) && browseOnly.has(repositoryId),
      isTrusted: () => this.current(active) && active.snapshot.trusted,
      confirm: this.context.confirm, emit: (event, payload) => { if (this.current(active)) this.context.emit(event, payload); },
      trackFile: (key, file) => watcher.trackFile(key, file),
      browseExclude: () => this.context.state.preferences.browseExclude,
      searchExclude: () => this.context.state.preferences.searchExclude,
    });
    const gitService = new GitService({ git,
      getRepository: repositoryId => { if (!this.current(active)) throw new RequestError('unavailable', 'Workspace is closed.'); return this.repository(repositoryId); },
      isTrusted: () => this.current(active) && active.snapshot.trusted,
      confirm: this.context.confirm, choose: this.context.choose,
      invalidate: repositoryId => { if (this.current(active)) this.invalidate(active, [repositoryId]); },
    });
    active = { snapshot, session, repositories, browseOnly, rows, controller, git, files, fileService, gitService, watcher, cache,
      queues: { branch: new Set(), status: new Set() }, running: { branch: new Set(), status: new Set() }, idle: [], discovering: true,
      fallbackOffset: 0, pendingSelection: session?.selectedId && !rows.has(session.selectedId) ? session.selectedId : undefined, dirtyRows: new Set() };
    this.active = active;
    watcher.on('invalidation', (event: { ids: string[]; metadataIds?: string[]; branchMetadata?: { id: string; deliveredAt: number }[] }) => {
      if (!this.current(active)) return;
      try { this.context.onWatchEvent?.(event); } catch { /* Instrumentation cannot break invalidation. */ }
      const { ids, metadataIds } = event;
      if (!metadataIds) this.invalidate(active, ids);
      else {
        const metadata = new Set(metadataIds);
        this.invalidate(active, ids.filter(id => metadata.has(id)));
        this.invalidate(active, ids.filter(id => !metadata.has(id)), ['status']);
      }
    });
    watcher.on('ready', () => {
      if (!this.current(active)) return;
      for (const row of active.rows.values()) if (row.monitoring !== 'degraded') { row.monitoring = 'live'; this.publishRow(active, row.id); }
    });
    watcher.on('fileChanged', ({ key }: { key: string }) => { void fileService.onFileChanged(key).catch(error => this.notice(active, message(error))); });
    watcher.on('topology', () => { if (this.current(active) && !active.discovering) { active.discovering = true; this.ready = this.discover(active); } });
    watcher.on('degraded', ({ ids, error }: { ids: string[]; error: string }) => {
      if (!this.current(active)) return;
      for (const row of active.rows.values()) if (!ids.length || ids.includes(row.id)) { row.monitoring = 'degraded'; row.monitoringError = error; this.downgrade(row); this.publishRow(active, row.id); }
      this.notice(active, error);
      if (!active.fallbackTimer) { active.fallbackTimer = setInterval(() => { if (this.focused && this.current(active)) this.reconcileBounded(active); }, 5000); active.fallbackTimer.unref(); }
    });
    this.persistWorkspace(active);
    this.context.emit('workspace', this.snapshot);
    // Yield cached rows before starting discovery, native watch enumeration or Git.
    this.ready = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      if (!this.current(active)) return;
      watcher.watchRoots(roots, { deferPlain: true });
      await this.discover(active);
    });
    this.ready.catch(error => this.notice(active, message(error)));
    return this.snapshot!;
  }

  private row(repository: Repository, roots: string[], cached?: { value: Branch; observedAt?: number }): RepositoryRow {
    const root = roots.find(root => inside(root, repository.root))!;
    return { ...repository, relativePath: path.relative(root, repository.root).split(path.sep).join('/'),
      branch: cached ? { state: 'cached', ...cached, generation: 0 } : unknown(), status: unknown() };
  }
  private async discover(active: Active): Promise<void> {
    if (!this.current(active)) return;
    active.snapshot.discovery = 'discovering'; this.context.emit('rows', { rows: [], discovery: 'discovering' });
    const seen = new Set<string>();
    try {
      const version = await active.git.run(active.snapshot.roots[0]!, ['--version'], { lane: 'metadata', timeoutMs: 10_000 });
      if (!this.current(active)) return;
      const number = /git version (\d+)\.(\d+)/.exec(version.stdout);
      if (version.exitCode || !number || Number(number[1]) < 2 || (Number(number[1]) === 2 && Number(number[2]) < 48)) throw new Error('Minv requires Git 2.48 or newer for safe passive inspection.');
      active.snapshot.gitAvailable = true; delete active.snapshot.gitError;
      const discovered = await discoverRepositories(active.snapshot.roots, active.git, repository => {
        if (!this.current(active) || !active.snapshot.roots.some(root => inside(root, repository.root))) return;
        seen.add(repository.id); this.accept(active, repository);
      });
      if (!this.current(active)) return;
      for (const repository of discovered) if (active.snapshot.roots.some(root => inside(root, repository.root))) { seen.add(repository.id); this.accept(active, repository); }
      for (const [id, row] of active.rows) if (!seen.has(id) && !active.browseOnly.has(id)) {
        const repository: Repository = { id, root: row.root, name: row.name, parentId: row.parentId, available: false, error: 'Previously known checkout is missing or no longer declared.' };
        active.repositories.set(id, repository); Object.assign(row, repository); this.downgrade(row);
        row.branch = { ...row.branch, state: 'error', error: repository.error }; row.status = { ...row.status, state: 'error', error: repository.error };
      }
      await active.files.setRepositoryRoots([...active.repositories.values()].filter(repository => repository.available).map(repository => repository.root));
      if (!this.current(active)) return;
      active.watcher.setRepositories([...active.repositories.values()]);
      active.snapshot.discovery = 'complete'; delete active.snapshot.discoveryError;
    } catch (error) {
      if (!this.current(active)) return;
      active.snapshot.discovery = 'error'; active.snapshot.discoveryError = message(error);
      active.snapshot.gitAvailable = false; active.snapshot.gitError = message(error);
      for (const row of active.rows.values()) { this.downgrade(row); row.branch = { ...row.branch, state: 'error', error: message(error) }; }
    } finally {
      if (this.current(active)) {
        active.discovering = false;
        active.watcher.watchRoots(active.snapshot.roots);
        for (const repository of active.repositories.values()) if (repository.available) this.enqueue(active, repository.id, 'status');
        this.persistWorkspace(active); this.context.emit('workspace', this.snapshot);
        this.checkIdle(active); this.scheduleSave(active);
      }
    }
  }

  private accept(active: Active, repository: Repository): void {
    active.repositories.set(repository.id, { ...repository });
    active.watcher.setRepositories([...active.repositories.values()]);
    if (repository.available) active.browseOnly.delete(repository.id);
    const existing = active.rows.get(repository.id);
    const row = existing ?? this.row(repository, active.snapshot.roots);
    Object.assign(row, repository);
    if (!repository.error) delete row.error;
    active.rows.set(repository.id, row); active.snapshot.rows = [...active.rows.values()];
    if (active.pendingSelection === repository.id) { active.snapshot.selectedId = repository.id; active.pendingSelection = undefined; }
    if (repository.available) {
      // Discovery callback and final relationship pass must not duplicate reads.
      if (!existing || existing.branch.state === 'unknown' || existing.branch.state === 'cached' || existing.branch.state === 'error') this.enqueue(active, repository.id, 'branch');
      if (repository.id === active.snapshot.selectedId && row.status.state === 'unknown') this.enqueue(active, repository.id, 'status');
    } else {
      this.downgrade(row); row.branch = { ...row.branch, state: 'error', error: repository.error || 'Not a Git checkout.' };
      row.status = { ...row.status, state: 'error', error: repository.error || 'Not a Git checkout.' };
    }
    this.publishRow(active, repository.id);
  }

  private async select(id: string): Promise<void> {
    const active = this.requireActive();
    if (!active.rows.has(id)) throw new RequestError('boundary', 'Unknown workspace repository.');
    if (active.snapshot.selectedId === id) return;
    active.pendingSelection = undefined; active.snapshot.selectedId = id; this.persistWorkspace(active);
    if (active.repositories.get(id)?.available) { this.enqueue(active, id, 'branch', true); this.enqueue(active, id, 'status', true); }
    this.context.emit('workspace', this.snapshot);
  }
  private async refresh(request: { id?: string; all?: boolean }): Promise<void> {
    const active = this.requireActive();
    if (request.id && !active.rows.has(request.id)) throw new RequestError('boundary', 'Unknown workspace repository.');
    active.watcher.retry();
    if (!active.watcher.snapshot().degraded) {
      for (const row of active.rows.values()) { row.monitoring = 'live'; delete row.monitoringError; }
      if (active.fallbackTimer) { clearInterval(active.fallbackTimer); active.fallbackTimer = undefined; }
    }
    const ids = request.all ? [...active.rows.keys()] : [request.id ?? active.snapshot.selectedId].filter((id): id is string => Boolean(id));
    this.invalidate(active, ids);
    if (request.all && !active.discovering) { active.discovering = true; this.ready = this.discover(active); }
  }
  private invalidate(active: Active, ids: string[], fields: Field[] = ['branch', 'status']): void {
    for (const id of ids) {
      const row = active.rows.get(id); if (!row) continue;
      this.downgrade(row, fields); this.publishRow(active, id);
      if (active.repositories.get(id)?.available) for (const field of fields) this.enqueue(active, id, field);
    }
  }
  private downgrade(row: RepositoryRow, fields: Field[] = ['branch', 'status']): void {
    for (const field of [...fields, ...(fields.includes('branch') ? ['upstream' as const] : [])]) {
      const observation = row[field]; if (!observation) continue;
      observation.generation++; observation.state = observation.value === undefined ? 'unknown' : 'stale';
    }
  }
  private enqueue(active: Active, id: string, field: Field, priority = false): void {
    if (!this.current(active) || !active.repositories.get(id)?.available) return;
    if (priority || id === active.snapshot.selectedId) active.queues[field] = new Set([id, ...active.queues[field]]);
    else active.queues[field].add(id);
    this.drain(active, field);
  }
  private drain(active: Active, field: Field): void {
    if (!this.current(active)) return;
    const limit = field === 'branch' ? 4 : 2;
    for (const id of active.queues[field]) {
      if (active.running[field].size >= limit) break;
      if (active.running[field].has(id)) continue;
      active.queues[field].delete(id); active.running[field].add(id);
      void this.observe(active, id, field).finally(() => { active.running[field].delete(id); this.drain(active, field); this.checkIdle(active); });
    }
  }
  private async observe(active: Active, id: string, field: Field): Promise<void> {
    const repository = active.repositories.get(id); const row = active.rows.get(id);
    if (!repository?.available || !row) return;
    const generation = row[field].generation + 1;
    Object.assign(row, { [field]: { ...row[field], generation, state: 'refreshing' } }); this.publishRow(active, id);
    const runner: GitRunner = { run: (cwd, args, options) => active.git.run(cwd, args, { ...options, ...(field === 'status' ? { lane: id === active.snapshot.selectedId ? 'foreground' : 'background' } : {}) }) };
    let sampled: { value: RepositoryStatus; at: number } | undefined;
    const publishChanging = (detail: string) => {
      if (!sampled || !this.current(active) || (row.status.observedAt ?? 0) > sampled.at) return;
      // Keep the latest invalidation generation. This is explicitly a stale
      // sampled value, not fresh data and not an authorization for any write.
      row.status = { ...row.status, value: sampled.value, state: 'stale', observedAt: sampled.at, error: detail };
      this.publishRow(active, id);
    };
    try {
      // A status used for writes is bracketed by immutable fingerprints. Capture
      // only the selected repository; background summaries do not authorize writes.
      let basisError: unknown;
      const before = field === 'status' && id === active.snapshot.selectedId
        ? await prepareWrite(repository, runner).catch(error => { basisError = error; return undefined; }) : undefined;
      const value = field === 'branch' ? await readBranch(repository, runner) : await readStatus(repository, runner);
      if (field === 'status') sampled = { value: value as RepositoryStatus, at: Date.now() };
      if (basisError) throw basisError;
      if (before && (await prepareWrite(repository, runner)).fingerprint !== before.fingerprint) throw new RequestError('stale-review', 'Repository is changing; this status sample cannot authorize a write.');
      if (!this.current(active)) return;
      if (row[field].generation !== generation) { if (field === 'status') publishChanging('Files changed while status was being observed.'); return; }
      if (before) active.gitService.recordStatusBasis(id, generation, before);
      Object.assign(row, { [field]: { value, generation, state: row.monitoring === 'degraded' ? 'stale' : 'observed', observedAt: Date.now() } });
      if (field === 'branch') void this.upstream(active, repository, value as Branch, generation);
    } catch (error) {
      if (field === 'status' && sampled) publishChanging(message(error));
      else if (this.current(active) && row[field].generation === generation) Object.assign(row, { [field]: { ...row[field], generation, state: 'error', error: message(error) } });
    }
    if (this.current(active)) this.publishRow(active, id);
  }
  private async upstream(active: Active, repository: Repository, branch: Branch, generation: number): Promise<void> {
    const row = active.rows.get(repository.id)!;
    row.upstream = { ...row.upstream, generation, state: 'refreshing' };
    try {
      let value: Upstream | undefined;
      if (branch.kind === 'branch' && branch.name) {
        const result = await active.git.run(repository.root, ['for-each-ref', '--format=%(upstream:short)%00%(upstream:track)', `refs/heads/${branch.name}`], { lane: 'background', maxBytes: 65536 });
        if (result.exitCode) throw new Error(result.stderr.trim() || 'Cannot read local upstream tracking.');
        const [name, tracking = ''] = result.stdout.trimEnd().split('\0');
        if (name) value = { name, ahead: Number(/ahead (\d+)/.exec(tracking)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(tracking)?.[1] ?? 0) };
      }
      if (this.current(active) && row.branch.generation === generation) row.upstream = { value, generation, state: row.monitoring === 'degraded' ? 'stale' : 'observed', observedAt: Date.now() };
    } catch (error) { if (this.current(active) && row.branch.generation === generation) row.upstream = { ...row.upstream, generation, state: 'error', error: message(error) }; }
    if (this.current(active)) this.publishRow(active, repository.id);
  }
  private publishRow(active: Active, id: string): void {
    if (!this.current(active)) return;
    active.dirtyRows.add(id);
    if (active.rowTimer) return;
    active.rowTimer = setTimeout(() => {
      active.rowTimer = undefined;
      if (!this.current(active)) return;
      const rows = [...active.dirtyRows].flatMap(id => active.rows.has(id) ? [structuredClone(active.rows.get(id)!)] : []); active.dirtyRows.clear();
      if (rows.length) this.context.emit('rows', { rows });
    }, 16);
  }
  private reconcileBounded(active: Active): void {
    const ids = [...active.repositories.values()].filter(repository => repository.available).map(repository => repository.id);
    const batch = new Set<string>(active.snapshot.selectedId ? [active.snapshot.selectedId] : []);
    for (let index = 0; index < Math.min(8, ids.length); index++) batch.add(ids[(active.fallbackOffset + index) % ids.length]!);
    active.fallbackOffset = ids.length ? (active.fallbackOffset + 8) % ids.length : 0;
    this.invalidate(active, [...batch]);
  }
  private async setTrust(trusted: boolean): Promise<WorkspaceSnapshot> {
    const active = this.requireActive();
    if (trusted && !active.snapshot.trusted && !await this.context.confirm('Trust this workspace?', `${active.snapshot.roots.join('\n')}\nTrusted operations can run Git hooks, signing tools and credential helpers. Only trust folders you recognize.`)) throw new RequestError('cancelled', 'Workspace trust was not changed.');
    if (!this.current(active)) throw new RequestError('unavailable', 'Workspace changed while deciding trust.');
    active.gitService.clearReviews();
    if (trusted) this.context.state.trust(active.snapshot.roots);
    else for (const root of active.snapshot.roots) this.context.state.revokeTrust(root);
    active.snapshot.trusted = trusted;
    if (active.snapshot.selectedId) this.invalidate(active, [active.snapshot.selectedId]);
    await this.context.state.flush(); this.context.emit('workspace', this.snapshot);
    return this.snapshot!;
  }
  private async recent(): Promise<RecentWorkspace[]> {
    return Promise.all(this.context.state.snapshot.recentWorkspaces.map(async roots => ({
      id: identity(JSON.stringify(roots)), roots, name: roots.map(root => path.basename(root) || root).join(' + '), openedAt: 0,
      available: (await Promise.all(roots.map(root => stat(root).then(info => info.isDirectory(), () => false)))).every(Boolean),
    })));
  }
  private persistWorkspace(active: Active): void {
    const previous = this.context.state.workspace;
    const same = JSON.stringify(previous.roots) === JSON.stringify(active.snapshot.roots);
    this.context.state.setWorkspace({ roots: active.snapshot.roots, selectedRepository: active.snapshot.selectedId,
      repositoryOrder: [...active.rows.keys()], pinnedRepositories: active.session?.pins ?? (same ? previous.pinnedRepositories : []),
      openDocuments: same ? previous.openDocuments : [], activeDocument: same ? previous.activeDocument : undefined });
    void this.context.state.flush().catch(error => this.notice(active, message(error)));
  }
  private checkIdle(active: Active): void {
    if (active.discovering || active.queues.branch.size || active.queues.status.size || active.running.branch.size || active.running.status.size) return;
    for (const resolve of active.idle.splice(0)) resolve();
    this.scheduleSave(active);
  }
  private whenIdle(active: Active): Promise<void> {
    if (!active.discovering && !active.queues.branch.size && !active.queues.status.size && !active.running.branch.size && !active.running.status.size) return Promise.resolve();
    return new Promise(resolve => active.idle.push(resolve));
  }
  private scheduleSave(active: Active): void {
    if (!this.current(active) || active.cacheTimer) return;
    active.cacheTimer = setTimeout(() => { active.cacheTimer = undefined; void this.save(active).catch(error => this.notice(active, message(error))); }, 150);
    active.cacheTimer.unref();
  }
  private async save(active: Active): Promise<void> {
    const repositories = [...active.rows.values()].map(({ id, root, name, parentId, available, error }) => ({ ...active.repositories.get(id), id, root, name, parentId, available, error }));
    await saveCatalog(path.join(active.cache, 'catalog.json'), repositories);
    const branches = [...active.rows.values()].filter(row => row.branch.value).map(row => ({ id: row.id, value: row.branch.value, observedAt: row.branch.observedAt }));
    await mkdir(active.cache, { recursive: true, mode: 0o700 });
    const file = path.join(active.cache, 'branches.json'); const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ version: 1, branches }), { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }
  private async loadBranches(cache: string): Promise<Map<string, { value: Branch; observedAt?: number }>> {
    const result = new Map<string, { value: Branch; observedAt?: number }>();
    try {
      const file = path.join(cache, 'branches.json'); if ((await stat(file)).size > 4 * 1024 * 1024) return result;
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.branches) || parsed.branches.length > 4096) return result;
      for (const row of parsed.branches) {
        const branch = row?.value;
        if (typeof row?.id !== 'string' || !branch || !['branch', 'unborn', 'detached'].includes(branch.kind)) continue;
        if (branch.name !== undefined && (typeof branch.name !== 'string' || branch.name.length > 4096)) continue;
        if (branch.oid !== undefined && (typeof branch.oid !== 'string' || !/^[a-f0-9]{40,64}$/i.test(branch.oid))) continue;
        if (branch.operation !== undefined && typeof branch.operation !== 'string') continue;
        result.set(row.id, { value: { kind: branch.kind, name: branch.name, oid: branch.oid, operation: branch.operation }, observedAt: Number.isFinite(row.observedAt) ? row.observedAt : undefined });
      }
    } catch { /* Disposable metadata corruption does not touch recovery drafts. */ }
    return result;
  }
  private async closeNow(emit = true): Promise<void> {
    const active = this.active; if (!active) return;
    this.persistWorkspace(active); this.active = undefined;
    active.controller.abort(); active.gitService.clearReviews(); active.fileService.dispose(); active.watcher.dispose();
    if (active.cacheTimer) clearTimeout(active.cacheTimer); if (active.rowTimer) clearTimeout(active.rowTimer); if (active.fallbackTimer) clearInterval(active.fallbackTimer);
    active.queues.branch.clear(); active.queues.status.clear();
    for (const resolve of active.idle.splice(0)) resolve();
    await Promise.all([this.save(active), this.context.state.flush(), this.sessions.flush()]);
    if (emit) this.context.emit('workspace', null);
  }
  private notice(active: Active, detail: string): void { if (this.current(active)) this.context.emit('notice', { level: 'warning', message: detail }); }
}
