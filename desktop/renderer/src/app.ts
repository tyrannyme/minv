/**
 * The Minv controller. Every user intent goes through here: it talks to the host,
 * keeps per-sheet runtime (buffers, reviews) and turns host errors into sentences.
 */
import type {
  BranchTarget, CursorPosition, DiffResult, DiffSide, EditorAdapter, EditorHandle, FileContent, FileRef, HistoryEntry, HostError, HostMethods,
  HunkReview, MinvHost, PathMatch, Preferences, RemoteTarget, RepositoryRow, SearchMatch, SearchProgress, StashEntry, TextFile, WriteAction, WriteBasis,
} from './contract.js';
import { normalizeAppearance, type RendererSession, type SavedSheet } from './contract.js';
import { parseDiff, type FileDiff } from './diff.js';
import { branchText, groupChanges, languageOf, splitPath } from './format.js';
import { Store, selectedRow, type FolioTab, type Plane, type Sheet } from './state.js';

export interface FileRuntime {
  content?: FileContent;
  handle?: EditorHandle;
  dirty: boolean;
  cursor?: CursorPosition;
  saving?: boolean;
  error?: string;
  /** EDIT-02: disk moved under a dirty buffer. */
  diskChanged?: { version?: string; deleted?: boolean };
  recoverTimer?: ReturnType<typeof setTimeout>;
  loading: boolean;
}
export interface ReviewRuntime {
  loading: boolean;
  error?: string;
  review?: HunkReview;
  diff?: DiffResult;
  files: FileDiff[];
  /** hunk index → id, only for hunk reviews */
  ids: string[];
  mode: 'inline' | 'split';
  wrap: boolean;
  current: number;
  busy?: boolean;
}
export interface CommitRuntime { loading: boolean; error?: string; message?: string; files: FileDiff[]; entry?: HistoryEntry; parents?: string[] }
export interface CompareRuntime { loading: boolean; error?: string; texts?: [string, string]; language?: string; inline?: boolean; mounted?: { layout(): void; dispose(): void } }
export interface SearchRuntime {
  query: string; regex: boolean; caseSensitive: boolean; includeIgnored: boolean; workspace: boolean;
  searchId?: string; matches: SearchMatch[]; done: boolean; complete: boolean; searched: number; note?: string; errors: string[]; startedAt?: number;
}
export interface HistoryRuntime { repositoryId: string; entries: HistoryEntry[]; nextOffset?: number; loading: boolean; error?: string; stashes: StashEntry[]; current?: string }
export interface FilesRuntime { repositoryId: string; expanded: Set<string>; listings: Map<string, { entries: import('./contract.js').DirectoryEntry[]; complete: boolean; note?: string } | 'loading' | { error: string }> }

type Confirm = (options: ConfirmOptions) => Promise<boolean>;
export interface ChooseOptions { title: string; body: string; paths?: string[]; options: { id: string; label: string; primary?: boolean; danger?: boolean }[] }
type Prompt = (options: PromptOptions) => Promise<string | undefined>;
export interface ConfirmOptions { title: string; body: string; paths?: string[]; confirm: string; danger?: boolean; check?: string; checked?: (value: boolean) => void }
export interface PromptOptions { title: string; body?: string; label: string; value?: string; confirm: string; validate?: (value: string) => string | undefined; select?: [number, number] }
export interface PickItem { id: string; primary: string; secondary?: string; hint?: string; group?: string; run: () => void | Promise<void> }
export interface PickOptions { placeholder: string; context?: string; items: (query: string) => PickItem[] | Promise<PickItem[]> }

let serial = 0;
const sheetId = () => `s${++serial}`;

export class App {
  readonly files = new Map<string, FileRuntime>();
  readonly reviews = new Map<string, ReviewRuntime>();
  readonly commits = new Map<string, CommitRuntime>();
  readonly compares = new Map<string, CompareRuntime>();
  search: SearchRuntime = { query: '', regex: false, caseSensitive: false, includeIgnored: false, workspace: false, matches: [], done: true, complete: true, searched: 0, errors: [] };
  history?: HistoryRuntime;
  /** Running network operation per repository (fetch/pull/push), shown with a Stop control. */
  readonly network = new Map<string, { kind: 'fetch' | 'pull' | 'push'; remote: string; since: number }>();
  tree?: FilesRuntime;
  /** Filled by the overlay layer at boot. */
  confirm!: Confirm;
  /** Multi-way decision; resolves undefined on Escape. Headless default: a confirm keeps drafts. */
  choose: (options: ChooseOptions) => Promise<string | undefined> = async o =>
    (await this.confirm({ title: o.title, body: o.body, paths: o.paths, confirm: o.options.find(x => x.id === 'keep')?.label ?? 'Continue' })) ? 'keep' : 'cancel';
  prompt!: Prompt;
  pick!: (options: PickOptions) => void;
  menu!: (anchor: HTMLElement | { x: number; y: number }, items: ({ label: string; hint?: string; danger?: boolean; run: () => void } | 'sep')[]) => void;
  focusPlane!: (plane: Plane) => void;

  constructor(readonly host: MinvHost, readonly editor: EditorAdapter | undefined, readonly store: Store) {}

  get state() { return this.store.state; }

  // ── Host plumbing ───────────────────────────────────────────────────────────

  async call<M extends keyof HostMethods>(method: M, params: HostMethods[M][0], quiet = false): Promise<HostMethods[M][1] | undefined> {
    try { return await this.host.invoke(method, params); }
    catch (error) {
      if (!quiet) this.explain(error);
      return undefined;
    }
  }

  /** For void methods: true on success, false on failure (already explained unless quiet). */
  async run<M extends keyof HostMethods>(method: M, params: HostMethods[M][0], quiet = false): Promise<boolean> {
    try { await this.host.invoke(method, params); return true; }
    catch (error) { if (!quiet) this.explain(error); return false; }
  }

  error(error: unknown): HostError {
    if (error && typeof error === 'object' && 'code' in error && 'message' in error) return error as HostError;
    const message = error instanceof Error ? error.message : String(error);
    // Electron prefixes rejected invoke errors; keep only the host's sentence.
    const clean = message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    const code = /^\[(\w[\w-]*)\]/.exec(clean)?.[1] as HostError['code'] | undefined;
    return { code: code ?? 'internal', message: code ? clean.replace(/^\[[\w-]+\]\s*/, '') : clean };
  }

  explain(error: unknown, prefix?: string): void {
    const e = this.error(error);
    const lead = prefix ? `${prefix}. ` : '';
    if (e.code === 'stale-review') { this.store.notify('warning', `${lead}${e.message}`); void this.refreshSelected(); return; }
    if (e.code === 'cancelled') return;
    this.store.notify(e.code === 'uncertain' || e.code === 'conflict' ? 'warning' : 'error', `${lead}${e.message}`, e.detail);
    if (e.code === 'uncertain') void this.refreshSelected();
  }

  // ── Workspace ───────────────────────────────────────────────────────────────

  async boot(): Promise<void> {
    this.host.on('workspace', w => { if (w?.id !== this.state.workspace?.id) { this.epoch++; this.restoring = false; this.deferred = []; } this.store.replaceWorkspace(w); if (!w) void this.loadRecent(); else this.afterWorkspace(); });
    this.host.on('rows', ({ rows, discovery }) => {
      this.store.applyRows(rows);
      if (discovery && this.state.workspace) this.store.update(s => { s.workspace!.discovery = discovery; });
    });
    this.host.on('notice', n => this.store.notify(n.level, n.message, n.detail));
    this.host.on('prefs', p => this.store.update(s => { s.prefs = { ...p, appearance: normalizeAppearance(p.appearance) }; }));
    this.host.on('search.progress', p => this.onSearch(p));
    this.host.on('file.changed', e => this.onFileChanged(e.repositoryId, e.path, e.version, e.deleted));
    this.host.on('open', e => void this.onOpen(e));
    this.host.on('compare', e => this.openCompare(e.left, e.right, e.wait));
    this.host.on('workspace.willClose', e => void this.answerClose(e.requestId, e.reason));
    addEventListener('beforeunload', event => { if (!this.closeApproved && this.dirtySheets().length) event.preventDefault(); });
    const [workspace, prefs] = await Promise.all([this.call('workspace.get', undefined), this.call('prefs.get', undefined, true)]);
    if (prefs) this.store.update(s => { s.prefs = { ...s.prefs, ...prefs, appearance: normalizeAppearance(prefs.appearance) }; });
    this.store.replaceWorkspace(workspace ?? null);
    if (workspace) this.afterWorkspace(); else void this.loadRecent();
    await this.call('window.ready', undefined, true);
  }

  /** Last selection hint sent; avoids re-sending on every workspace snapshot. */
  private hinted?: string;
  private hint(id: string | undefined): void {
    if (!id || id === this.hinted) return;
    this.hinted = id;
    void this.call('repo.select', { id }, true);
  }

  // ── Session (restore once per workspace; debounced save; flushed before close) ──

  private restoredFor?: string;
  private restoring = false;
  /** Bumped whenever the workspace is replaced; async restores from an older epoch abort. */
  private epoch = 0;
  private lastSaved = '';
  private saveTimer?: ReturnType<typeof setTimeout>;
  /** Saved tree state per repository, applied when its Files view first lists. */
  private savedTrees = new Map<string, string[]>();
  /** Restored documents whose repository is not yet verified; hydrated when it is. */
  private deferred: SavedSheet[] = [];
  indexScrollTop = 0;

  private ready(id: string): boolean {
    const row = this.state.rows.get(id);
    return !!row && row.available && row.branch.state === 'observed';
  }

  private async restoreSession(): Promise<void> {
    const w = this.state.workspace;
    if (!w || this.restoredFor === w.id) return;
    const epoch = ++this.epoch;
    this.restoredFor = w.id;
    this.restoring = true;
    try {
      const s = await this.call('session.get', undefined, true);
      if (epoch !== this.epoch) return;
      if (!s || s.workspaceId !== w.id || this.state.workspace?.id !== w.id) { this.lastSaved = JSON.stringify(this.session()); return; }
      this.store.update(st => {
        // Saved order first (user order survives), then anything discovered since.
        const known = new Set(st.order);
        st.order = [...s.order.filter(id => known.has(id)), ...st.order.filter(id => !s.order.includes(id))];
        st.pins = s.pins.filter(id => known.has(id));
        st.layout = s.layout; st.collapsed = new Set(s.collapsed); st.tab = s.tab; st.focus = s.focus;
        if (s.selectedId && known.has(s.selectedId)) st.selectedId = s.selectedId;
        for (const d of s.commitDrafts) if (d.text) st.drafts.set(d.repositoryId, d.text);
      });
      for (const t of s.expandedDirectories) this.savedTrees.set(t.repositoryId, t.paths);
      this.indexScrollTop = s.indexScrollTop;
      this.hint(this.state.selectedId);
      const ids = new Map<string, string>();
      for (const saved of s.sheets) {
        if (epoch !== this.epoch) return;
        if (saved.kind !== 'settings' && !this.ready(saved.repositoryId)) {
          if (this.state.rows.has(saved.repositoryId)) this.deferred.push(saved);
          continue;
        }
        const created = await this.hydrate(saved);
        if (created) ids.set(saved.id, created);
      }
      if (epoch !== this.epoch) return;
      this.store.update(st => {
        st.activeSheet = (s.activeSheet && ids.get(s.activeSheet)) ?? st.activeSheet;
        st.splitSheet = s.splitSheet ? ids.get(s.splitSheet) : undefined;
        st.focusedPane = st.splitSheet ? s.focusedPane : 'main';
      });
      // Nothing to diff against yet: the next real change is saved, the restore itself is not.
      this.lastSaved = JSON.stringify(this.session());
    } finally {
      if (epoch === this.epoch) this.restoring = false;
    }
  }

  private async hydrate(saved: SavedSheet): Promise<string | undefined> {
    const before = this.state.focusedPane;
    this.store.update(st => { st.focusedPane = 'main'; });
    if (saved.kind === 'file') {
      await this.openFile(saved.repositoryId, saved.path, saved.view?.line, saved.view?.column);
      const sheet = this.state.sheets.find(x => x.kind === 'file' && x.repositoryId === saved.repositoryId && x.path === saved.path);
      if (sheet && saved.view) sheet.view = saved.view;
    } else if (saved.kind === 'diff') await this.openReview(saved.repositoryId, saved.path, saved.side);
    else if (saved.kind === 'commit') await this.openCommit(saved.repositoryId, { oid: saved.oid, subject: '', author: '', date: new Date().toISOString() });
    else this.openSettings();
    this.store.update(st => { st.focusedPane = before; });
    return this.state.activeSheet;
  }

  /** Called on row updates: restore documents whose repository has just been verified. */
  private hydrateDeferred(): void {
    if (!this.deferred.length || this.restoring) return;
    const epoch = this.epoch;
    const now = this.deferred.filter(x => x.kind === 'settings' || this.ready(x.repositoryId));
    if (!now.length) return;
    this.deferred = this.deferred.filter(x => !now.includes(x));
    void (async () => { for (const saved of now) { if (epoch !== this.epoch) return; await this.hydrate(saved); } })();
  }

  session(): RendererSession {
    const st = this.state;
    const sheets: SavedSheet[] = st.sheets.flatMap((sh): SavedSheet[] => {
      const f = this.files.get(sh.id);
      const view = f?.handle ? f.handle.getView() : sh.view;
      if (sh.kind === 'file' && sh.path) return [{ id: sh.id, kind: 'file', repositoryId: sh.repositoryId, path: sh.path, ...(view ? { view } : {}) }];
      if (sh.kind === 'diff' && sh.path && sh.side) return [{ id: sh.id, kind: 'diff', repositoryId: sh.repositoryId, path: sh.path, side: sh.side }];
      if (sh.kind === 'commit' && sh.oid) return [{ id: sh.id, kind: 'commit', repositoryId: sh.repositoryId, oid: sh.oid }];
      if (sh.kind === 'settings') return [{ id: sh.id, kind: 'settings' }];
      return []; // compare documents hold one-time capabilities and are not restored
    });
    // Documents still waiting for their repository stay in the session untouched.
    sheets.push(...this.deferred);
    const trees = new Map(this.savedTrees);
    if (this.tree) trees.set(this.tree.repositoryId, [...this.tree.expanded].filter(Boolean));
    return {
      version: 1, workspaceId: st.workspace?.id ?? '', ...(st.selectedId ? { selectedId: st.selectedId } : {}),
      order: [...st.order], pins: [...st.pins], layout: st.layout, collapsed: [...st.collapsed], tab: st.tab, sheets,
      ...(st.activeSheet && sheets.some(x => x.id === st.activeSheet) ? { activeSheet: st.activeSheet } : {}),
      ...(st.splitSheet && sheets.some(x => x.id === st.splitSheet) ? { splitSheet: st.splitSheet } : {}),
      focusedPane: st.focusedPane, plane: st.plane, focus: st.focus, indexScrollTop: Math.round(this.indexScrollTop),
      expandedDirectories: [...trees].map(([repositoryId, paths]) => ({ repositoryId, paths, scrollTop: 0 })),
      commitDrafts: [...st.drafts].filter(([, text]) => text.trim()).map(([repositoryId, text]) => ({ repositoryId, text })),
    };
  }

  /** Called on every store change; saves at most every 700 ms and only when something changed. */
  scheduleSave(): void {
    this.hydrateDeferred();
    if (!this.state.workspace || this.restoredFor !== this.state.workspace.id || this.restoring) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flushSession().catch(error => this.explain(error, 'Layout could not be saved')), 700);
  }

  /** Throws when the host refuses; lastSaved only advances after a confirmed save. */
  async flushSession(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (!this.state.workspace || this.restoredFor !== this.state.workspace.id || this.restoring) return;
    const session = this.session();
    const json = JSON.stringify(session);
    if (json === this.lastSaved) return;
    await this.host.invoke('session.save', session);
    this.lastSaved = json;
  }

  togglePin(id: string): void {
    this.store.update(s => { s.pins = s.pins.includes(id) ? s.pins.filter(x => x !== id) : [...s.pins, id]; });
  }

  savedTree(repositoryId: string): string[] { return this.savedTrees.get(repositoryId) ?? []; }

  private afterWorkspace(): void {
    void this.restoreSession();
    this.hint(this.state.selectedId);
    void this.call('fs.recoveries', undefined, true).then(r => r && this.store.update(s => { s.recoveries = r; }));
  }

  async loadRecent(): Promise<void> {
    const [recent, recoveries] = await Promise.all([this.call('workspace.recent', undefined, true), this.call('fs.recoveries', undefined, true)]);
    this.store.update(s => { s.recent = recent ?? []; s.recoveries = recoveries ?? []; });
  }

  private closeApproved = false;
  dirtySheets(): Sheet[] { return this.state.sheets.filter(s => this.files.get(s.id)?.dirty); }

  /** Persist every dirty draft, then ask once. Nothing is lost on any branch of this function. */
  async answerClose(requestId: string, reason: 'open' | 'close' | 'cli' | 'window'): Promise<void> {
    let allow = true;
    try {
      const dirty = this.dirtySheets();
      await Promise.all(dirty.map(sheet => this.persistDraft(sheet)));
      if (dirty.length) {
        const choice = await this.choose({
          title: dirty.length === 1 ? `Save changes to ${dirty[0]!.title}?` : `Save changes to ${dirty.length} files?`,
          body: `${reason === 'window' ? 'Minv is closing.' : 'This workspace is closing.'} Unsaved edits are already kept as recovery drafts; you can save them now or reopen the drafts later.`,
          paths: dirty.map(s => `${this.state.rows.get(s.repositoryId)?.name ?? ''}/${s.path}`),
          options: [{ id: 'save', label: 'Save all', primary: true }, { id: 'keep', label: 'Keep as drafts' }, { id: 'cancel', label: 'Cancel' }],
        });
        if (choice === 'cancel' || choice === undefined) allow = false;
        else if (choice === 'save') {
          for (const sheet of dirty) await this.save(sheet);
          if (this.dirtySheets().length) { allow = false; this.store.notify('warning', 'Some files could not be saved. Nothing was closed.'); }
        }
      }
    } catch (error) { allow = false; this.explain(error, 'Could not prepare to close'); }
    if (allow) {
      // Commit drafts and layout live only in the session: refuse to close if they cannot be saved.
      try { await this.flushSession(); }
      catch (error) { allow = false; this.explain(error, 'Nothing was closed because the layout and commit drafts could not be saved'); }
    }
    this.closeApproved = allow;
    if (allow) { this.epoch++; this.restoredFor = undefined; this.restoring = false; this.deferred = []; this.savedTrees.clear(); this.disposeSheets(); }
    await this.call('workspace.closeReady', { requestId, allow }, true);
    if (allow && reason !== 'window') this.closeApproved = false;
  }

  private async persistDraft(sheet: Sheet): Promise<void> {
    const f = this.files.get(sheet.id); if (!f?.handle || f.content?.kind !== 'text') return;
    if (f.recoverTimer) clearTimeout(f.recoverTimer);
    await this.host.invoke('fs.recover', { documentId: `${sheet.repositoryId}:${sheet.path}`, repositoryId: sheet.repositoryId, path: sheet.path!, text: f.handle.getText(), encoding: f.content.encoding, bom: f.content.bom, baseVersion: f.content.version });
  }

  /** Workspace replaced after approval: drop sheets without prompting (drafts already persisted). */
  disposeSheets(): void {
    for (const sheet of this.state.sheets) {
      const f = this.files.get(sheet.id); f?.handle?.dispose(); if (f?.recoverTimer) clearTimeout(f.recoverTimer);
      this.compares.get(sheet.id)?.mounted?.dispose();
      for (const wait of sheet.waits ?? []) void this.call('cli.released', { wait }, true);
    }
    this.files.clear(); this.reviews.clear(); this.commits.clear(); this.compares.clear();
    this.history = undefined; this.tree = undefined;
    this.store.update(s => { s.sheets = []; s.activeSheet = undefined; s.splitSheet = undefined; s.focusedPane = 'main'; s.drafts.clear(); });
  }

  async openWorkspace(recentId?: string): Promise<void> {
    // The host sends workspace.willClose first when a workspace is open; that is the only dirty-buffer path.
    const workspace = await this.call('workspace.open', recentId ? { recentId } : {});
    if (workspace) { this.store.replaceWorkspace(workspace); this.afterWorkspace(); }
  }

  async closeWorkspace(): Promise<void> {
    if (!(await this.run('workspace.close', undefined))) return;
    this.store.replaceWorkspace(null);
    void this.loadRecent();
  }

  async setTrust(trusted: boolean): Promise<void> {
    if (trusted) {
      const ok = await this.confirm({
        title: 'Trust this workspace?',
        body: 'Trusted workspaces can stage, commit and switch branches. Git may then run this workspace\'s configured hooks, filters and signing programs when you ask for a write. Reading stays passive either way.',
        paths: this.state.workspace?.roots, confirm: 'Trust workspace',
      });
      if (!ok) return;
    }
    const workspace = await this.call('workspace.trust', { trusted });
    if (workspace) this.store.update(s => { s.workspace = { ...s.workspace!, trusted: workspace.trusted }; });
  }

  // ── Repositories ────────────────────────────────────────────────────────────

  select(id: string): void {
    if (!this.state.rows.has(id)) return;
    if (this.state.selectedId !== id) {
      this.store.update(s => { s.selectedId = id; });
      this.history = undefined;
      this.tree = undefined;
      if (!this.search.workspace) this.search = { ...this.search, matches: [], done: true, searched: 0, note: undefined, errors: [] };
    }
    this.hint(id);
    if (this.state.tab === 'history') void this.loadHistory();
  }

  async refreshSelected(): Promise<void> { const id = this.state.selectedId; if (id) await this.call('repo.refresh', { id }); }
  async refreshAll(): Promise<void> { await this.call('repo.refresh', { all: true }); }

  setTab(tab: FolioTab): void {
    this.store.update(s => { s.tab = tab; });
    if (tab === 'history' && (!this.history || this.history.repositoryId !== this.state.selectedId)) void this.loadHistory();
  }

  writable(row: RepositoryRow | undefined): string | undefined {
    if (!row) return 'Choose a repository';
    if (!this.state.workspace?.trusted) return 'Restricted mode: trust this workspace to make changes';
    if (!this.state.workspace.gitAvailable) return this.state.workspace.gitError ?? 'Git is not available';
    if (!row.available) return row.error ?? 'Checkout is unavailable';
    return undefined;
  }

  /** A ticket for exactly what is on screen. Fails (and explains) rather than acting on newer state. */
  async ticket(repositoryId: string, action: WriteAction, basis: WriteBasis, paths?: string[]): Promise<string | undefined> {
    const row = this.state.rows.get(repositoryId);
    const blocked = this.writable(row);
    if (blocked) { this.store.notify('warning', blocked); return undefined; }
    const token = await this.call('git.prepare', { repositoryId, action, basis, ...(paths ? { paths } : {}) });
    return token?.token;
  }

  /** Status basis for list actions: only an observed, current status can authorize a write. */
  statusBasis(row: RepositoryRow): WriteBasis | undefined {
    if (row.status.state !== 'observed') { this.store.notify('warning', 'Changes are being rechecked. Try again once they are verified.'); return undefined; }
    return { kind: 'status', generation: row.status.generation };
  }

  async stage(repositoryId: string, paths: string[], unstage = false): Promise<void> {
    const row = this.state.rows.get(repositoryId); if (!row) return;
    const basis = this.statusBasis(row); if (!basis) return;
    const action = unstage ? 'unstage' : 'stage';
    const token = await this.ticket(repositoryId, action, basis, paths); if (!token) return;
    await this.run(unstage ? 'git.unstage' : 'git.stage', { repositoryId, paths, token });
    this.reloadReviews(repositoryId);
  }

  async discard(repositoryId: string, paths: string[]): Promise<void> {
    const row = this.state.rows.get(repositoryId); if (!row) return;
    const basis = this.statusBasis(row); if (!basis) return;
    // The ticket is taken before the confirmation is shown, so the dialog describes exactly what it authorizes.
    const token = await this.ticket(repositoryId, 'discard', basis, paths); if (!token) return;
    const untracked = groupChanges(row.status.value).untracked.some(e => paths.includes(e.change.path));
    const ok = await this.confirm({
      title: paths.length === 1 ? `Discard changes to ${splitPath(paths[0]!).base}?` : `Discard changes to ${paths.length} files?`,
      body: `Working-tree changes in ${row.name} will be replaced with the staged version${untracked ? '; untracked files will be removed' : ''}. Minv keeps a backup you can restore from the command palette.`,
      paths, confirm: 'Discard', danger: true,
    });
    if (!ok) return;
    const result = await this.call('git.discard', { repositoryId, paths, token, confirmed: true });
    if (result) this.store.notify('info', `Discarded ${paths.length === 1 ? paths[0] : `${paths.length} files`}. Backup kept.`);
    this.reloadReviews(repositoryId);
    for (const path of paths) this.onFileChanged(repositoryId, path);
  }

  async commit(repositoryId: string): Promise<void> {
    const row = this.state.rows.get(repositoryId); if (!row) return;
    const message = this.state.drafts.get(repositoryId) ?? '';
    if (!message.trim()) { this.store.notify('warning', 'Write a commit message first.'); return; }
    const staged = groupChanges(row.status.value).staged.map(e => e.change.path);
    if (!staged.length) { this.store.notify('warning', 'Nothing is staged in this repository.'); return; }
    const basis = this.statusBasis(row); if (!basis) return;
    const token = await this.ticket(repositoryId, 'commit', basis); if (!token) return;
    const result = await this.call('git.commit', { repositoryId, message, token });
    if (!result) return; // draft is kept on failure (WRITE-02)
    this.store.update(s => { s.drafts.delete(repositoryId); });
    this.store.notify('info', `Committed ${result.oid.slice(0, 7)} to ${row.name} on ${branchText(row.branch) ?? 'HEAD'}.`);
    if (this.history?.repositoryId === repositoryId) void this.loadHistory();
    this.reloadReviews(repositoryId);
  }

  // ── Branches, stashes, remotes ─────────────────────────────────────────────

  async branchPicker(): Promise<void> {
    const row = selectedRow(this.state); if (!row) return;
    const branches = await this.call('git.branches', { repositoryId: row.id });
    if (!branches) return;
    const current = branches.find(b => b.current);
    const valid = (name: string) => /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[^\s~^:?*[\\\x00-\x1f]+(?<![./]|\.lock)$/.test(name);
    this.pick({
      placeholder: 'Switch branch or type a new branch name',
      context: `${row.name} · ${current ? `on ${current.name}` : branchText(row.branch) ?? 'no branch'}`,
      items: (query) => {
        const q = query.trim().toLowerCase();
        const list: PickItem[] = branches.filter(b => !q || b.name.toLowerCase().includes(q)).map(b => ({
          id: b.ref, primary: b.name, secondary: b.oid.slice(0, 7), group: b.remote ? 'Remote branches' : 'Local branches',
          hint: b.current ? 'current' : b.remote ? 'create local' : '',
          run: () => b.current ? undefined : b.remote ? this.createBranch(b.name.replace(/^[^/]+\//, ''), b, true) : this.switchBranch(b),
        }));
        if (q && valid(query.trim()) && !branches.some(b => !b.remote && b.name === query.trim()) && current) {
          list.unshift({ id: 'new', primary: `Create branch ${query.trim()}`, secondary: `from ${current.name}`, group: 'New', hint: 'switch to it', run: () => this.createBranch(query.trim(), current, true) });
        }
        return list;
      },
    });
  }

  async switchBranch(target: BranchTarget): Promise<void> {
    const row = selectedRow(this.state); if (!row) return;
    const token = await this.ticket(row.id, 'switchBranch', { kind: 'none' }); if (!token) return;
    if (await this.run('git.switchBranch', { repositoryId: row.id, target, token })) this.store.notify('info', `${row.name} is now on ${target.name}.`);
  }

  async createBranch(name: string, start: BranchTarget, switchTo: boolean): Promise<void> {
    const row = selectedRow(this.state); if (!row) return;
    const token = await this.ticket(row.id, 'createBranch', { kind: 'none' }); if (!token) return;
    if (await this.run('git.createBranch', { repositoryId: row.id, name, start, switchTo, token })) this.store.notify('info', `Created ${name} from ${start.name}${switchTo ? ' and switched to it' : ''}.`);
  }

  async stash(repositoryId: string): Promise<void> {
    const row = this.state.rows.get(repositoryId); if (!row) return;
    const groups = groupChanges(row.status.value);
    const tracked = [...new Set([...groups.staged, ...groups.unstaged].map(e => e.change.path))];
    const untracked = groups.untracked.map(e => e.change.path);
    if (!tracked.length && !untracked.length) { this.store.notify('info', 'There is nothing to stash.'); return; }
    const basis = this.statusBasis(row); if (!basis) return;
    let includeUntracked = false;
    const message = await this.prompt({ title: 'Stash changes', body: `Set aside these changes in ${row.name}. Applying a stash later keeps it until you drop it.`, label: 'Description', value: '', confirm: 'Stash' });
    if (message === undefined) return;
    if (untracked.length) includeUntracked = await this.confirm({ title: 'Include untracked files?', body: `${untracked.length} untracked file${untracked.length === 1 ? '' : 's'} can be stashed too.`, paths: untracked, confirm: 'Include them' });
    const paths = includeUntracked ? [...tracked, ...untracked] : tracked;
    if (!paths.length) return;
    const token = await this.ticket(repositoryId, 'stash', basis, paths); if (!token) return;
    if (await this.run('git.stash', { repositoryId, message, paths, includeUntracked, token })) { this.store.notify('info', `Stashed ${paths.length} file${paths.length === 1 ? '' : 's'}.`); void this.loadStashes(); }
  }

  async applyStash(entry: StashEntry): Promise<void> {
    const row = selectedRow(this.state); if (!row) return;
    const token = await this.ticket(row.id, 'applyStash', { kind: 'none' }); if (!token) return;
    if (await this.run('git.applyStash', { repositoryId: row.id, entry, restoreIndex: true, token })) this.store.notify('info', `Applied ${entry.selector}. It stays in the list until you drop it.`);
  }

  async dropStash(entry: StashEntry): Promise<void> {
    const row = selectedRow(this.state); if (!row) return;
    const token = await this.ticket(row.id, 'dropStash', { kind: 'none' }); if (!token) return;
    const ok = await this.confirm({ title: `Drop ${entry.selector}?`, body: `“${entry.subject}” will be deleted from ${row.name}. This cannot be undone from Minv.`, confirm: 'Drop stash', danger: true });
    if (!ok) return;
    if (await this.run('git.dropStash', { repositoryId: row.id, entry, token, confirmed: true })) void this.loadStashes();
  }

  private async remoteFor(row: RepositoryRow): Promise<RemoteTarget | undefined> {
    const remotes = await this.call('git.remotes', { repositoryId: row.id });
    if (!remotes?.length) { if (remotes) this.store.notify('warning', `${row.name} has no configured remotes.`); return undefined; }
    const upstream = row.upstream?.value?.name;
    const named = upstream ? remotes.find(r => upstream.startsWith(`${r.name}/`)) : undefined;
    if (named || remotes.length === 1) return named ?? remotes[0];
    return new Promise(resolve => this.pick({ placeholder: 'Choose a remote', context: row.name, items: () => remotes.map(r => ({ id: r.name, primary: r.name, secondary: r.fetchUrl, run: () => resolve(r) })) }));
  }

  async remote(kind: 'fetch' | 'pull' | 'push'): Promise<void> {
    const row = selectedRow(this.state); if (!row) return;
    const branch = row.branch.value?.kind === 'branch' ? row.branch.value.name : undefined;
    if (kind !== 'fetch' && !branch) { this.store.notify('warning', 'Check out a branch first; detached HEAD has no branch to sync.'); return; }
    const remote = await this.remoteFor(row); if (!remote) return;
    const target = row.upstream?.value?.name?.slice(remote.name.length + 1) ?? branch;
    if (kind === 'push') {
      const ok = await this.confirm({ title: `Push ${branch} to ${remote.name}?`, body: `Sends commits from ${row.name} to ${remote.name}/${target}. Minv never force-pushes; a rejected push changes nothing.`, paths: [remote.pushUrl], confirm: 'Push' });
      if (!ok) return;
    }
    const token = await this.ticket(row.id, kind, { kind: 'none' }); if (!token) return;
    this.network.set(row.id, { kind, remote: `${remote.name}${kind === 'fetch' ? '' : `/${target}`}`, since: Date.now() });
    this.store.update(() => {});
    const ok = kind === 'fetch' ? await this.run('git.fetch', { repositoryId: row.id, remote, token })
      : await this.run(kind === 'pull' ? 'git.pull' : 'git.push', { repositoryId: row.id, remote, branch: target!, token });
    this.network.delete(row.id); this.store.update(() => {});
    if (ok) this.store.notify('info', `${kind === 'fetch' ? 'Fetched' : kind === 'pull' ? 'Pulled' : 'Pushed'} ${row.name}.`);
  }

  async cancelNetwork(repositoryId: string): Promise<void> { await this.call('git.cancel', { repositoryId }); }

  // ── History ─────────────────────────────────────────────────────────────────

  async loadHistory(more = false): Promise<void> {
    const row = selectedRow(this.state); if (!row) return;
    if (!more || !this.history || this.history.repositoryId !== row.id) this.history = { repositoryId: row.id, entries: [], loading: true, stashes: [] };
    const h = this.history;
    h.loading = true; this.store.update(() => {});
    if (!more) void this.loadStashes();
    try {
      const page = await this.host.invoke('git.history', { repositoryId: row.id, offset: h.nextOffset ?? 0, ...(h.entries.length && h.entries[0] ? { revision: h.entries[0].oid } : {}) });
      if (this.history !== h) return;
      h.entries.push(...page.entries); h.nextOffset = page.nextOffset; h.error = undefined;
    } catch (error) { h.error = this.error(error).message; }
    h.loading = false; this.store.update(() => {});
  }

  async loadStashes(): Promise<void> {
    const h = this.history; if (!h) return;
    const stashes = await this.call('git.stashes', { repositoryId: h.repositoryId }, true);
    if (this.history === h) { h.stashes = stashes ?? []; this.store.update(() => {}); }
  }

  // ── Files ───────────────────────────────────────────────────────────────────

  async listDir(dir: string): Promise<void> {
    const row = selectedRow(this.state); if (!row) return;
    if (!this.tree || this.tree.repositoryId !== row.id) {
      if (this.tree) this.savedTrees.set(this.tree.repositoryId, [...this.tree.expanded].filter(Boolean));
      const saved = this.savedTree(row.id);
      this.tree = { repositoryId: row.id, expanded: new Set(['', ...saved]), listings: new Map() };
      for (const path of saved) void this.listDir(path);
    }
    const tree = this.tree;
    tree.listings.set(dir, 'loading'); this.store.update(() => {});
    try { tree.listings.set(dir, await this.host.invoke('fs.list', { repositoryId: row.id, dir })); }
    catch (error) { tree.listings.set(dir, { error: this.error(error).message }); }
    this.store.update(() => {});
  }

  toggleDir(dir: string): void {
    const tree = this.tree; if (!tree) return;
    if (tree.expanded.has(dir)) tree.expanded.delete(dir); else { tree.expanded.add(dir); if (!tree.listings.has(dir)) void this.listDir(dir); }
    this.store.update(() => {});
  }

  async createEntry(directory: string, kind: 'file' | 'folder'): Promise<void> {
    const row = selectedRow(this.state); if (!row) return;
    const name = await this.prompt({ title: kind === 'file' ? 'New file' : 'New folder', body: `In ${row.name}/${directory || ''}`, label: 'Name', confirm: 'Create', validate: v => !v.trim() ? 'Enter a name' : /(^|\/)\.\.?(\/|$)|^\//.test(v) ? 'Use a relative name without . or ..' : undefined });
    if (!name) return;
    const path = directory ? `${directory}/${name.trim()}` : name.trim();
    if (!(await this.run(kind === 'file' ? 'fs.createFile' : 'fs.createDirectory', { repositoryId: row.id, path }))) return;
    void this.listDir(directory);
    if (kind === 'file') void this.openFile(row.id, path);
  }

  async renameEntry(path: string): Promise<void> {
    const row = selectedRow(this.state); if (!row) return;
    const { base } = splitPath(path);
    const target = await this.prompt({ title: `Rename ${base}`, label: 'New path', value: path, confirm: 'Rename', select: [path.length - base.length, path.length - (base.includes('.') ? base.length - base.lastIndexOf('.') : 0)], validate: v => !v.trim() || v === path ? 'Enter a different path' : undefined });
    if (!target) return;
    await this.transfer('move', row.id, path, row.id, target.trim());
  }

  async transfer(mode: 'copy' | 'move', repositoryId: string, path: string, targetRepositoryId: string, targetPath: string): Promise<void> {
    const plan = await this.call('fs.prepareTransfer', { mode, repositoryId, path, targetRepositoryId, targetPath }); if (!plan) return;
    let confirmed = false;
    if (plan.requiresConfirmation) {
      confirmed = await this.confirm({ title: `${mode === 'move' ? 'Move' : 'Copy'} across repositories?`, body: `This ${mode === 'move' ? 'moves' : 'copies'} a file from one Git repository into another. Both repositories will show the change.`, paths: [`from ${plan.sourceScope}`, `to   ${plan.targetScope}`], confirm: mode === 'move' ? 'Move file' : 'Copy file' });
      if (!confirmed) return;
    }
    if (!(await this.run('fs.transfer', { token: plan.token, confirmed }))) return;
    const dir = (p: string) => splitPath(p).dir.replace(/\/$/, '');
    void this.listDir(dir(path)); if (dir(targetPath) !== dir(path)) void this.listDir(dir(targetPath));
    if (mode === 'move') this.store.update(s => { for (const sheet of s.sheets) if (sheet.repositoryId === repositoryId && sheet.path === path && sheet.kind === 'file') { sheet.path = targetPath; sheet.title = splitPath(targetPath).base; } });
  }

  async deleteEntry(path: string): Promise<void> {
    const row = selectedRow(this.state); if (!row) return;
    const content = await this.call('fs.read', { repositoryId: row.id, path }); if (!content) return;
    const ok = await this.confirm({ title: `Delete ${splitPath(path).base}?`, body: `The file is removed from ${row.name}. Minv keeps a backup you can restore from the command palette.`, paths: [path], confirm: 'Delete', danger: true });
    if (!ok) return;
    const result = await this.call('fs.delete', { repositoryId: row.id, path, version: content.version });
    if (!result) return;
    void this.listDir(splitPath(path).dir.replace(/\/$/, ''));
    for (const sheet of this.state.sheets.filter(s => s.repositoryId === row.id && s.path === path && s.kind === 'file')) this.onFileChanged(row.id, path, undefined, true, sheet);
  }

  async restoreBackups(): Promise<void> {
    const backups = await this.call('fs.backups', undefined); if (!backups) return;
    this.pick({ placeholder: 'Restore a backup', context: backups.length ? 'Restores only when the original path is free.' : 'No backups yet.', items: q => backups.filter(b => b.path.includes(q)).map(b => ({ id: b.id, primary: b.path, secondary: new Date(b.createdAt).toLocaleString(), group: this.state.rows.get(b.repositoryId ?? '')?.name ?? 'Backups', hint: 'Enter restores', run: () => this.backupAction(b) })) });
  }

  private async backupAction(b: import('./contract.js').BackupRecord): Promise<void> {
    const choice = await this.choose({ title: b.path, body: `Backup from ${new Date(b.createdAt).toLocaleString()}. Restoring never overwrites an existing file.`, options: [{ id: 'restore', label: 'Restore', primary: true }, { id: 'remove', label: 'Remove backup', danger: true }, { id: 'cancel', label: 'Cancel' }] });
    if (choice === 'restore') { if (await this.run('fs.restore', { backupId: b.id })) this.store.notify('info', `Restored ${b.path}.`); }
    else if (choice === 'remove' && await this.confirm({ title: 'Remove this backup?', body: 'It cannot be restored afterwards.', paths: [b.path], confirm: 'Remove', danger: true })) {
      if (await this.run('fs.removeBackup', { backupId: b.id })) this.store.notify('info', `Removed the backup of ${b.path}.`);
    }
  }

  // ── Sheets ──────────────────────────────────────────────────────────────────

  private addSheet(sheet: Omit<Sheet, 'id'>, match: (s: Sheet) => boolean): Sheet {
    const existing = this.state.sheets.find(match);
    if (existing) { this.activate(existing.id); return existing; }
    const created = { ...sheet, id: sheetId() };
    this.store.update(s => {
      const at = s.sheets.findIndex(x => x.id === s.activeSheet);
      s.sheets.splice(at < 0 ? s.sheets.length : at + 1, 0, created);
      if (s.focusedPane === 'split' && s.splitSheet) s.splitSheet = created.id; else s.activeSheet = created.id;
    });
    return created;
  }

  activate(id: string): void {
    this.store.update(s => { if (s.focusedPane === 'split' && s.splitSheet) s.splitSheet = id; else s.activeSheet = id; });
  }

  async openFile(repositoryId: string, path: string, line?: number, column?: number, wait?: string): Promise<void> {
    const sheet = this.addSheet({ kind: 'file', repositoryId, path, title: splitPath(path).base, line, column, ...(wait ? { waits: [wait] } : {}) }, s => s.kind === 'file' && s.repositoryId === repositoryId && s.path === path);
    if (wait && !sheet.waits?.includes(wait)) this.store.update(() => { (sheet.waits ??= []).push(wait); });
    const runtime = this.files.get(sheet.id);
    if (runtime?.handle && line) runtime.handle.revealLine(line, column);
    if (runtime) return;
    const fresh: FileRuntime = { dirty: false, loading: true };
    this.files.set(sheet.id, fresh);
    this.store.update(() => {});
    try { fresh.content = await this.host.invoke('fs.read', { repositoryId, path }); }
    catch (error) { fresh.error = this.error(error).message; }
    fresh.loading = false;
    this.store.update(() => {});
  }

  async openReview(repositoryId: string, path: string, side: DiffSide): Promise<void> {
    const title = splitPath(path).base;
    const sheet = this.addSheet({ kind: 'diff', repositoryId, path, side, title }, s => s.kind === 'diff' && s.repositoryId === repositoryId && s.path === path && s.side === side);
    if (!this.reviews.has(sheet.id)) await this.loadReview(sheet);
  }

  async loadReview(sheet: Sheet): Promise<void> {
    const previous = this.reviews.get(sheet.id);
    const r: ReviewRuntime = { loading: true, files: [], ids: [], mode: previous?.mode ?? 'inline', wrap: previous?.wrap ?? false, current: Math.min(previous?.current ?? 0, 999) };
    this.reviews.set(sheet.id, r);
    this.store.update(() => {});
    const params = { repositoryId: sheet.repositoryId, path: sheet.path!, side: sheet.side! };
    try {
      const review = await this.host.invoke('git.hunks', params);
      r.review = review;
      r.ids = review.hunks.map(h => h.id);
      const header = `diff --git a/${sheet.path} b/${sheet.path}\n--- a/${sheet.path}\n+++ b/${sheet.path}\n`;
      r.files = parseDiff(header + review.hunks.map(h => h.patch.endsWith('\n') ? h.patch : `${h.patch}\n`).join(''));
    } catch {
      // No selectable hunks (binary, rename, gitlink, conflict, mode): show the read-only presentation.
      try { r.diff = await this.host.invoke('git.diff', params); r.files = parseDiff(r.diff.patch); }
      catch (error) { r.error = this.error(error).message; }
    }
    r.current = Math.min(r.current, Math.max(0, (r.files[0]?.hunks.length ?? 1) - 1));
    r.loading = false;
    this.store.update(() => {});
  }

  reloadReviews(repositoryId: string): void {
    for (const sheet of this.state.sheets) if (sheet.kind === 'diff' && sheet.repositoryId === repositoryId) void this.loadReview(sheet);
  }

  async applyHunk(sheet: Sheet, index: number): Promise<void> {
    const r = this.reviews.get(sheet.id); const id = r?.ids[index];
    if (!r?.review || !id || r.busy) return;
    if (this.writable(this.state.rows.get(sheet.repositoryId))) { this.store.notify('warning', this.writable(this.state.rows.get(sheet.repositoryId))!); return; }
    r.busy = true; this.store.update(() => {});
    const ok = await this.run('git.applyHunks', { repositoryId: sheet.repositoryId, reviewId: r.review.reviewId, ids: [id] });
    r.busy = false;
    if (ok) this.store.notify('info', `${sheet.side === 'staged' ? 'Unstaged' : 'Staged'} hunk ${index + 1} of ${sheet.title}.`);
    // The review is consumed either way; read the file again so the next action uses fresh ids.
    await this.loadReview(sheet);
  }

  /** Whole-file action from a review: bound to the review the user is looking at. */
  async applyFile(sheet: Sheet): Promise<void> {
    const r = this.reviews.get(sheet.id);
    const reviewId = r?.review?.reviewId ?? r?.diff?.reviewId;
    if (!reviewId || !sheet.path) return;
    const unstage = sheet.side === 'staged';
    const token = await this.ticket(sheet.repositoryId, unstage ? 'unstage' : 'stage', { kind: 'review', reviewId }, [sheet.path]); if (!token) return;
    if (await this.run(unstage ? 'git.unstage' : 'git.stage', { repositoryId: sheet.repositoryId, paths: [sheet.path], token })) {
      this.store.notify('info', `${unstage ? 'Unstaged' : 'Staged'} ${sheet.title}.`);
    }
    this.reloadReviews(sheet.repositoryId);
  }

  async openCommit(repositoryId: string, entry: HistoryEntry): Promise<void> {
    if (this.history) this.history.current = entry.oid;
    const sheet = this.addSheet({ kind: 'commit', repositoryId, oid: entry.oid, title: entry.oid.slice(0, 7) }, s => s.kind === 'commit' && s.oid === entry.oid && s.repositoryId === repositoryId);
    if (this.commits.has(sheet.id)) return;
    const c: CommitRuntime = { loading: true, files: [], entry };
    this.commits.set(sheet.id, c); this.store.update(() => {});
    try {
      const detail = await this.host.invoke('git.show', { repositoryId, oid: entry.oid });
      c.message = detail.message; c.parents = detail.parents; c.entry = { oid: detail.oid, subject: detail.subject, author: detail.author, date: detail.date };
      const from = detail.parents[0];
      const patch = from ? await this.host.invoke('git.revisionDiff', { repositoryId, from, to: detail.oid }) : '';
      c.files = parseDiff(patch);
      if (!from) c.error = 'This is a root commit. Its files are listed without a diff.';
      if (!from) c.files = detail.changes.map(ch => ({ header: [], newPath: ch.path, binary: false, hunks: [] }));
    } catch (error) { c.error = this.error(error).message; }
    c.loading = false; this.store.update(() => {});
  }

  openCompare(left: FileRef, right: FileRef, wait?: string): void {
    this.addSheet({ kind: 'compare', repositoryId: left.repositoryId ?? right.repositoryId ?? '', left, right, ...(wait ? { waits: [wait] } : {}), title: `${splitPath(left.label).base} ↔ ${splitPath(right.label).base}` }, () => false);
  }

  openSettings(): void { this.addSheet({ kind: 'settings', repositoryId: '', title: 'Settings' }, s => s.kind === 'settings'); }

  async closeSheet(id: string): Promise<boolean> {
    const sheet = this.state.sheets.find(s => s.id === id); if (!sheet) return true;
    const file = this.files.get(id);
    if (file?.dirty) {
      // The draft must be durable before the buffer may go away.
      try { await this.persistDraft(sheet); }
      catch (error) { this.explain(error, `${sheet.title} was not closed because its draft could not be saved`); return false; }
      const choice = await this.choose({ title: `Save changes to ${sheet.title}?`, body: 'If you close without saving, your edits stay in a recovery draft you can reopen from the front page.', options: [{ id: 'save', label: 'Save', primary: true }, { id: 'keep', label: 'Close, keep draft' }, { id: 'cancel', label: 'Cancel' }] });
      if (choice === 'save') { await this.save(sheet); if (file.dirty) return false; }
      else if (choice !== 'keep') return false;
    }
    file?.handle?.dispose(); if (file?.recoverTimer) clearTimeout(file.recoverTimer);
    this.compares.get(id)?.mounted?.dispose();
    this.files.delete(id); this.reviews.delete(id); this.commits.delete(id); this.compares.delete(id);
    for (const wait of sheet.waits ?? []) void this.call('cli.released', { wait }, true);
    this.store.update(s => {
      const index = s.sheets.findIndex(x => x.id === id);
      s.sheets.splice(index, 1);
      const neighbour = s.sheets[Math.min(index, s.sheets.length - 1)]?.id;
      if (s.splitSheet === id) { s.splitSheet = undefined; s.focusedPane = 'main'; }
      if (s.activeSheet === id) s.activeSheet = neighbour !== s.splitSheet ? neighbour : s.sheets.find(x => x.id !== s.splitSheet)?.id;
    });
    return true;
  }

  async closeAllSheets(): Promise<boolean> {
    for (const sheet of [...this.state.sheets]) if (!(await this.closeSheet(sheet.id))) return false;
    return true;
  }

  toggleSplit(): void {
    this.store.update(s => {
      if (s.splitSheet) { s.splitSheet = undefined; s.focusedPane = 'main'; return; }
      const other = s.sheets.find(x => x.id !== s.activeSheet);
      if (other) { s.splitSheet = other.id; s.focusedPane = 'split'; }
      else this.store.notify('info', 'Open a second sheet to split the desk.');
    });
  }

  cycleSheet(delta: number): void {
    const { sheets } = this.state; if (!sheets.length) return;
    const current = this.state.focusedPane === 'split' ? this.state.splitSheet : this.state.activeSheet;
    const index = sheets.findIndex(s => s.id === current);
    this.activate(sheets[(index + delta + sheets.length) % sheets.length]!.id);
  }

  focusedSheet(): Sheet | undefined {
    const id = this.state.focusedPane === 'split' && this.state.splitSheet ? this.state.splitSheet : this.state.activeSheet;
    return this.state.sheets.find(s => s.id === id);
  }

  // ── Buffers ─────────────────────────────────────────────────────────────────

  markDirty(sheet: Sheet): void {
    const f = this.files.get(sheet.id); if (!f || f.content?.kind !== 'text') return;
    const text = f.handle?.getText();
    const dirty = text !== f.content.text;
    if (dirty !== f.dirty) { f.dirty = dirty; this.store.update(s => { const x = s.sheets.find(y => y.id === sheet.id); if (x) x.dirty = dirty; }); }
    if (f.recoverTimer) clearTimeout(f.recoverTimer);
    if (dirty && text !== undefined) {
      const content = f.content;
      f.recoverTimer = setTimeout(() => void this.call('fs.recover', { documentId: `${sheet.repositoryId}:${sheet.path}`, repositoryId: sheet.repositoryId, path: sheet.path!, text, encoding: content.encoding, bom: content.bom, baseVersion: content.version }, true), 900);
    }
  }

  async save(sheet: Sheet | undefined = this.focusedSheet()): Promise<void> {
    if (!sheet || sheet.kind !== 'file') return;
    const f = this.files.get(sheet.id); if (!f?.handle || f.content?.kind !== 'text' || f.saving) return;
    if (!this.state.workspace?.trusted) { /* Saving text is a file write, not a Git write: allowed but stated. */ }
    const text = f.handle.getText();
    f.saving = true; this.store.update(() => {});
    try {
      const result = await this.host.invoke('fs.write', { repositoryId: sheet.repositoryId, path: sheet.path!, text, encoding: f.content.encoding, bom: f.content.bom, baseVersion: f.content.version });
      f.content = { ...f.content, text, version: result.version };
      f.diskChanged = undefined;
      void this.call('fs.removeRecovery', { documentId: `${sheet.repositoryId}:${sheet.path}` }, true);
    } catch (error) {
      const e = this.error(error);
      if (e.code === 'conflict') f.diskChanged = { };
      else this.explain(error, `Could not save ${sheet.title}`);
    }
    f.saving = false;
    this.markDirty(sheet);
    this.store.update(() => {});
  }

  /** EDIT-02: clean buffers follow disk; dirty buffers keep their text and show the reconciliation bar. */
  onFileChanged(repositoryId: string, path: string, version?: string, deleted?: boolean, only?: Sheet): void {
    for (const sheet of only ? [only] : this.state.sheets.filter(s => s.kind === 'file' && s.repositoryId === repositoryId && s.path === path)) {
      const f = this.files.get(sheet.id); if (!f || f.content?.kind !== 'text') continue;
      if (version && version === f.content.version) continue;
      if (f.dirty || deleted) { f.diskChanged = { version, deleted }; this.store.update(() => {}); continue; }
      void this.host.invoke('fs.read', { repositoryId, path }).then(content => {
        if (content.kind !== 'text') { f.content = content; f.handle?.dispose(); f.handle = undefined; this.store.update(() => {}); return; }
        if (f.dirty) { f.diskChanged = { version: content.version }; this.store.update(() => {}); return; }
        f.content = content; f.handle?.setText(content.text); this.store.update(() => {});
      }).catch(() => { f.diskChanged = { deleted: true }; this.store.update(() => {}); });
    }
    if (this.state.sheets.some(s => s.kind === 'diff' && s.repositoryId === repositoryId && s.path === path)) this.reloadReviews(repositoryId);
  }

  async takeDisk(sheet: Sheet): Promise<void> {
    const f = this.files.get(sheet.id); if (!f) return;
    if (f.dirty) {
      try { await this.persistDraft(sheet); }
      catch (error) { this.explain(error, 'Your edits were kept in the editor because their draft could not be saved'); return; }
      if (!(await this.confirm({ title: 'Replace your edits with the disk version?', body: 'Your edits are saved as a recovery draft and can be reopened from the front page.', confirm: 'Use disk version', danger: true }))) return;
    }
    const content = await this.call('fs.read', { repositoryId: sheet.repositoryId, path: sheet.path! }); if (!content) return;
    f.content = content; f.diskChanged = undefined;
    if (content.kind === 'text') f.handle?.setText(content.text);
    this.markDirty(sheet); this.store.update(() => {});
  }

  /** Keep mine: adopt the disk version as the new base after the user has compared. */
  async keepMine(sheet: Sheet): Promise<void> {
    const f = this.files.get(sheet.id); if (!f || f.content?.kind !== 'text') return;
    const content = await this.call('fs.read', { repositoryId: sheet.repositoryId, path: sheet.path! }); if (!content || content.kind !== 'text') return;
    const ok = await this.confirm({ title: `Overwrite the disk version of ${sheet.title}?`, body: 'Another program changed this file. Saving now replaces its version with yours. A backup of the disk version is kept.', paths: [sheet.path!], confirm: 'Save my version', danger: true });
    if (!ok) return;
    f.content = { ...f.content, version: content.version };
    f.diskChanged = undefined;
    await this.save(sheet);
  }

  async compareWithDisk(sheet: Sheet): Promise<void> {
    const f = this.files.get(sheet.id); if (!f?.handle) return;
    const content = await this.call('fs.read', { repositoryId: sheet.repositoryId, path: sheet.path! });
    if (!content) return;
    if (content.kind !== 'text') { this.store.notify('warning', 'The disk version is no longer text; it cannot be compared.'); return; }
    const created = this.addSheet({ kind: 'compare', repositoryId: sheet.repositoryId, title: `${sheet.title} · disk ↔ yours`, left: { ref: '', label: `${sheet.path} · on disk` }, right: { ref: '', label: `${sheet.path} · your edits` } }, () => false);
    this.compares.set(created.id, { loading: false, texts: [content.text, f.handle.getText()], language: languageOf(sheet.path!) });
    this.store.update(() => {});
  }

  // ── Search and quick open ───────────────────────────────────────────────────

  async runSearch(): Promise<void> {
    const q = this.search;
    if (q.searchId) void this.call('search.cancel', { searchId: q.searchId }, true);
    if (!q.query) { this.search = { ...q, searchId: undefined, matches: [], done: true, complete: true, searched: 0, note: undefined, errors: [] }; this.store.update(() => {}); return; }
    const scope = q.workspace ? [] : this.state.selectedId ? [this.state.selectedId] : [];
    this.search = { ...q, matches: [], done: false, complete: true, searched: 0, note: undefined, errors: [], startedAt: performance.now() };
    this.store.update(() => {});
    const started = await this.call('search.start', { query: q.query, regex: q.regex, caseSensitive: q.caseSensitive, includeIgnored: q.includeIgnored, scope });
    if (started) this.search.searchId = started.searchId; else { this.search.done = true; this.search.complete = false; }
    this.store.update(() => {});
  }

  private onSearch(p: SearchProgress): void {
    if (p.searchId !== this.search.searchId) return;
    const s = this.search;
    s.matches.push(...p.matches); s.searched = p.searchedRepositories;
    if (p.errors?.length) s.errors.push(...p.errors);
    if (p.done) { s.done = true; s.complete = p.complete; s.note = p.note; }
    this.store.update(() => {});
  }

  async findPaths(query: string, scope: string[]): Promise<{ matches: PathMatch[]; complete: boolean; note?: string }> {
    if (!this.state.workspace) return { matches: [], complete: true };
    return (await this.call('fs.findPaths', { query, scope, limit: 40 }, true)) ?? { matches: [], complete: false, note: 'File search is unavailable' };
  }

  // ── Preferences, shell, CLI ─────────────────────────────────────────────────

  async setPrefs(patch: Partial<Preferences>): Promise<void> {
    this.store.update(s => { s.prefs = { ...s.prefs, ...patch }; });
    const saved = await this.call('prefs.set', patch);
    if (saved) this.store.update(s => { s.prefs = saved; });
  }

  async terminal(): Promise<void> { const row = selectedRow(this.state); if (row) await this.call('shell.openTerminal', { repositoryId: row.id }); }
  async reveal(path?: string): Promise<void> { const row = selectedRow(this.state); if (row) await this.call('shell.reveal', { repositoryId: row.id, ...(path ? { path } : {}) }); }

  private async onOpen(e: { repositoryId: string; path?: string; line?: number; column?: number; diff?: DiffSide; wait?: string }): Promise<void> {
    if (!this.state.rows.has(e.repositoryId)) return;
    this.select(e.repositoryId);
    if (e.path && e.diff) await this.openReview(e.repositoryId, e.path, e.diff);
    else if (e.path) await this.openFile(e.repositoryId, e.path, e.line, e.column, e.wait);
    else this.focusPlane('folio');
  }

  languageFor(path: string): string { return languageOf(path); }
  isText(content: FileContent | undefined): content is TextFile { return content?.kind === 'text'; }
}
