/**
 * Minv renderer ⇄ host contract (version 2). See docs/DESIGN_CONTRACT.md.
 *
 * The renderer owns every pixel of the window. The host (Electron main + preload,
 * repository/file/search/operation services in src/core) owns all state that touches
 * disk or Git. The renderer never infers repository state; it renders host
 * observations and their freshness exactly as published.
 *
 * Transport: preload exposes `window.minvHost` via contextBridge. Payloads are
 * structured-clone safe. Repository-relative paths use '/' on every platform.
 */

export const CONTRACT_VERSION = 4 as const;

// ── Observation model (mirrors src/core/types.ts) ─────────────────────────────

export type Freshness = 'unknown' | 'cached' | 'refreshing' | 'observed' | 'stale' | 'error';
export interface Observation<T> { state: Freshness; value?: T; observedAt?: number; error?: string; generation: number }

export interface Branch { kind: 'branch' | 'detached' | 'unborn'; name?: string; oid?: string; operation?: string }
export interface Change { path: string; originalPath?: string; index: string; workingTree: string; submodule?: string }
export interface RepositoryStatus { changes: Change[]; complete: boolean }

/** Upstream tracking for the checked-out branch, from local refs only. Never fetched implicitly. */
export interface Upstream { name: string; ahead: number; behind: number; lastFetchAt?: number }

export interface RepositoryRow {
  id: string;
  root: string;
  name: string;
  /** Path relative to the workspace root that contains it; '' for a root. Display only. */
  relativePath: string;
  parentId?: string;
  available: boolean;
  error?: string;
  branch: Observation<Branch>;
  status: Observation<RepositoryStatus>;
  upstream?: Observation<Upstream>;
  /** 'degraded' when the watcher failed or overflowed; freshness must already be downgraded. */
  monitoring?: 'live' | 'degraded';
  monitoringError?: string;
}

export interface WorkspaceSnapshot {
  contract: typeof CONTRACT_VERSION;
  id: string;
  name: string;
  roots: string[];
  /** 'cached' = rows come from the saved catalog only; discovery has not reported yet. */
  discovery: 'cached' | 'discovering' | 'complete' | 'error';
  discoveryError?: string;
  /** false = restricted mode: passive inspection (branches, status, diffs, files) works; every write and hook is refused. */
  trusted: boolean;
  gitAvailable: boolean;
  gitError?: string;
  /** Host order. The renderer keeps first-seen positions; new ids are appended. */
  rows: RepositoryRow[];
  selectedId?: string;
  platform: 'linux' | 'darwin' | 'win32';
  /** Set by the standalone preview host only. Shown in the masthead; never set in a real build. */
  fixture?: string;
}

export interface RecentWorkspace { id: string; name: string; roots: string[]; openedAt: number; available: boolean }

// ── Files (repository-relative; host maps to FILES_API root ids) ──────────────

export interface DirectoryEntry { name: string; kind: 'file' | 'directory' | 'symlink' | 'submodule' | 'other'; size?: number; ignored?: boolean }

export type TextEncoding = 'utf8' | 'utf16le' | 'utf16be';
export type LineEnding = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';
export interface TextFile {
  kind: 'text';
  text: string;
  /** FILES_API fingerprint. Opaque; echoed back as the save base (EDIT-02). */
  version: string;
  encoding: TextEncoding;
  bom: boolean;
  eol: LineEnding;
  size: number;
  /** EDIT-03: over the reduced-tokenization threshold; renderer enables bounded mode. */
  large: boolean;
}
/** Binary or over the hard text limit: metadata only, never truncated text. */
export interface OpaqueFile { kind: 'binary' | 'large'; size: number; version: string }
export type FileContent = TextFile | OpaqueFile;

export interface SaveResult { version: string }
export interface TransferPlan { token: string; sourceScope: string; targetScope: string; requiresConfirmation: boolean }
export interface BackupRecord { id: string; repositoryId?: string; path: string; createdAt: number }
export interface RecoveryDraft { documentId: string; repositoryId: string; path: string; updatedAt?: number }

// ── Git ───────────────────────────────────────────────────────────────────────

export type DiffSide = 'unstaged' | 'staged';
/** Read-only presentation of a change; used for kinds without selectable hunks. */
export interface DiffResult {
  /** Review id binding whole-file actions taken from this presentation to exactly what was shown. */
  reviewId: string;
  patch: string;
  /** Non-text presentations must never disappear (GIT-04). */
  kind: 'text' | 'binary' | 'gitlink' | 'mode' | 'symlink' | 'rename' | 'conflict' | 'empty';
}
/** OPERATIONS_API readHunks: the backend owns patch text; the renderer returns ids only. */
export interface ReviewHunk { id: string; header: string; patch: string }
export interface HunkReview { reviewId: string; path: string; side: DiffSide; hunks: ReviewHunk[] }

export interface HistoryEntry { oid: string; subject: string; author: string; date: string }
export interface HistoryPage { entries: HistoryEntry[]; revision?: string; nextOffset?: number }
export interface CommitChange { status: string; path: string; originalPath?: string }
export interface CommitDetail extends HistoryEntry { parents: string[]; message: string; changes: CommitChange[] }

/** Every mutation a ticket can authorize. A ticket is bound to one action and one exact path set. */
export type WriteAction = 'stage' | 'unstage' | 'discard' | 'commit' | 'createBranch' | 'switchBranch' | 'stash' | 'applyStash' | 'dropStash' | 'fetch' | 'pull' | 'push';
/**
 * What the user saw when they chose the action. The host refuses to issue a ticket unless the
 * repository still matches it, so a ticket can never authorize content the user did not see.
 * - review: a `git.hunks` or `git.diff` reviewId (the exact diff on screen).
 * - status: the status observation generation currently displayed (change list, commit slip).
 * - none:   actions not derived from viewed content (fetch, branch switch/create, stash apply/drop).
 */
export type WriteBasis = { kind: 'review'; reviewId: string } | { kind: 'status'; generation: number } | { kind: 'none' };
/** Write precondition ticket (WRITE-03). Host keeps the fingerprint; renderer echoes the token once. */
export interface WriteToken { token: string; action: WriteAction; paths?: string[]; head?: string; branch?: string }

export interface BranchTarget { name: string; ref: string; oid: string; remote: boolean; current: boolean; upstream?: string }
export interface StashEntry { selector: string; oid: string; subject: string; date: string }
/** URLs are already redacted by the host. */
export interface RemoteTarget { name: string; fetchUrl: string; pushUrl: string; fingerprint: string; lastFetchedAt?: number }
export interface OperationState { kinds: ('merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect')[]; conflicts: Change[]; mergeHeads: string[]; indexLocked: boolean }

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchQuery {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  /** Repository ids; empty = whole workspace. */
  scope: string[];
  includeIgnored: boolean;
}
/** line and column are one-based; length counts UTF-16 units of `preview` (host converts from rg bytes). */
export interface SearchMatch { repositoryId: string; path: string; line: number; column: number; preview: string; length: number }
export interface SearchProgress {
  searchId: string;
  matches: SearchMatch[];
  done: boolean;
  /** False when cancelled, capped or a repository could not be searched. */
  complete: boolean;
  searchedRepositories: number;
  note?: string;
  errors?: string[];
}
export interface PathMatch { repositoryId: string; path: string }
/** Opaque, host-authorized file reference. `label` is display text (path as the user typed it). */
export interface FileRef { ref: string; label: string; repositoryId?: string; path?: string }

// ── Settings (SET-01: this is the entire settings surface) ────────────────────

export type Appearance = 'system' | 'light' | 'dark' | 'light-contrast' | 'dark-contrast';
/** Pre-Signal values hosts may still hold; renderer and host map them with `normalizeAppearance`. */
export type LegacyAppearance = 'paper' | 'ink' | 'paper-contrast' | 'ink-contrast';
export function normalizeAppearance(value: string | undefined): Appearance {
  const legacy: Record<LegacyAppearance, Appearance> = { paper: 'light', ink: 'dark', 'paper-contrast': 'light-contrast', 'ink-contrast': 'dark-contrast' };
  if (typeof value === 'string' && Object.hasOwn(legacy, value)) return legacy[value as LegacyAppearance];
  return value === 'light' || value === 'dark' || value === 'light-contrast' || value === 'dark-contrast' ? value : 'system';
}
export interface Preferences {
  appearance: Appearance;
  motion: 'system' | 'reduce';
  density: 'compact' | 'comfortable';
  editorFontSize: number;
  tabSize: number;
  wordWrap: boolean;
  renderWhitespace: boolean;
  /** Machine scope; host announces that it applies after restart. */
  gitPath: string;
  /** External terminal command; empty = platform default. */
  terminal: string;
  /** Browse-only globs. Never hide Git changes (FILE-01). */
  browseExclude: string[];
  /** Search-only globs. */
  searchExclude: string[];
}

// ── Session (structurally identical to desktop/shared/session.ts RendererSession) ──

/** Durable layout only. Source text lives exclusively in dirty-buffer recovery. */
export interface SavedEditorView { line: number; column: number; scrollTop: number; scrollLeft: number }
export type SavedSheet =
  | { id: string; kind: 'file'; repositoryId: string; path: string; view?: SavedEditorView }
  | { id: string; kind: 'diff'; repositoryId: string; path: string; side: 'staged' | 'unstaged'; view?: SavedEditorView }
  | { id: string; kind: 'commit'; repositoryId: string; oid: string; view?: SavedEditorView }
  | { id: string; kind: 'settings'; view?: SavedEditorView };
export interface RendererSession {
  version: 1;
  workspaceId: string;
  selectedId?: string;
  order: string[];
  pins: string[];
  layout: 'tree' | 'flat';
  collapsed: string[];
  tab: 'changes' | 'files' | 'history' | 'search';
  sheets: SavedSheet[];
  activeSheet?: string;
  splitSheet?: string;
  focusedPane: 'main' | 'split';
  plane: 'index' | 'folio' | 'sheet';
  focus: boolean;
  indexScrollTop: number;
  expandedDirectories: { repositoryId: string; paths: string[]; scrollTop: number }[];
  commitDrafts: { repositoryId: string; text: string }[];
}

// ── Requests (renderer → host) ────────────────────────────────────────────────

export interface HostMethods {
  /** null = no workspace open; renderer shows the front page with recents. */
  'workspace.get': [void, WorkspaceSnapshot | null];
  /** Without recentId the host shows the native folder picker. Resolves null when cancelled. */
  'workspace.open': [{ recentId?: string }, WorkspaceSnapshot | null];
  'workspace.recent': [void, RecentWorkspace[]];
  'workspace.close': [void, void];
  /**
   * Answer to a `workspace.willClose` event. Sent only after every dirty buffer's draft is
   * durably persisted and the user chose to save, keep drafts, or cancel (allow: false).
   */
  'workspace.closeReady': [{ requestId: string; allow: boolean }, void];
  /** Called only from an explicit decision in the trust sheet. */
  /** Layout for the open workspace; null when none was saved. Read once per workspace. */
  'session.get': [void, RendererSession | null];
  /** Debounced by the renderer and flushed before `workspace.closeReady`. Host validates and stores. */
  'session.save': [RendererSession, void];
  'workspace.trust': [{ trusted: boolean }, WorkspaceSnapshot];
  /** Interactive-priority hint (REPO-03). Never mutates a repository. */
  'repo.select': [{ id: string }, void];
  'repo.refresh': [{ id?: string; all?: boolean }, void];

  /** complete=false when a cap was hit; the renderer says so in the list itself. */
  'fs.list': [{ repositoryId: string; dir: string }, { entries: DirectoryEntry[]; complete: boolean; note?: string }];
  'fs.read': [{ repositoryId: string; path: string }, FileContent];
  /** Rejects with code 'conflict' when disk no longer matches baseVersion. No force flag exists. */
  'fs.write': [{ repositoryId: string; path: string; text: string; encoding: TextEncoding; bom: boolean; baseVersion: string }, SaveResult];
  'fs.findPaths': [{ query: string; scope: string[]; limit: number }, { matches: PathMatch[]; complete: boolean; note?: string }];
  /** Exclusive create; never overwrites. */
  'fs.createFile': [{ repositoryId: string; path: string }, void];
  'fs.createDirectory': [{ repositoryId: string; path: string }, void];
  /** Files only. Rename = move within one repository. */
  'fs.prepareTransfer': [{ mode: 'copy' | 'move'; repositoryId: string; path: string; targetRepositoryId: string; targetPath: string }, TransferPlan];
  'fs.transfer': [{ token: string; confirmed: boolean }, void];
  /** Recoverable deletion of one file. */
  'fs.delete': [{ repositoryId: string; path: string; version: string }, { backupId: string }];
  'fs.backups': [void, BackupRecord[]];
  'fs.restore': [{ backupId: string }, void];
  /** Explicit, confirmed removal of one backup. Recovery drafts are never evicted automatically. */
  'fs.removeBackup': [{ backupId: string }, void];
  /** Persist a dirty-buffer draft (renderer debounces). */
  'fs.recover': [{ documentId: string; repositoryId: string; path: string; text: string; encoding: TextEncoding; bom: boolean; baseVersion: string }, void];
  'fs.recoveries': [void, RecoveryDraft[]];
  /** Reads a host-authorized reference from a `compare` event (may lie outside the workspace). */
  'fs.readRef': [{ ref: string }, FileContent];
  'fs.readRecovery': [{ documentId: string }, { text: string; baseVersion: string; encoding: TextEncoding; bom: boolean }];
  'fs.removeRecovery': [{ documentId: string }, void];

  /** Read-only presentation for any change kind. */
  'git.diff': [{ repositoryId: string; path: string; side: DiffSide; ignoreWhitespace?: boolean }, DiffResult];
  /** Selectable hunks for text changes; rejects (code 'git') for kinds that need whole-file actions. */
  'git.hunks': [{ repositoryId: string; path: string; side: DiffSide }, HunkReview];
  /** Stages (unstaged review) or unstages (staged review) the chosen hunks. Consumes the review. */
  'git.applyHunks': [{ repositoryId: string; reviewId: string; ids: string[] }, void];
  /**
   * Single-use ticket bound to action + exact paths + the basis the user saw. Rejects with
   * 'stale-review' when the repository moved past that basis; the renderer then re-reads and
   * shows the new state instead of acting.
   */
  'git.prepare': [{ repositoryId: string; action: WriteAction; paths?: string[]; basis: WriteBasis }, WriteToken];
  'git.stage': [{ repositoryId: string; paths: string[]; token: string }, void];
  'git.unstage': [{ repositoryId: string; paths: string[]; token: string }, void];
  /** WRITE-04: host backs up each file, then restores it from the index. */
  'git.discard': [{ repositoryId: string; paths: string[]; token: string; confirmed: true }, { backupIds: string[] }];
  'git.commit': [{ repositoryId: string; message: string; token: string }, { oid: string }];
  'git.history': [{ repositoryId: string; offset: number; revision?: string; path?: string }, HistoryPage];
  'git.show': [{ repositoryId: string; oid: string }, CommitDetail];
  'git.revisionDiff': [{ repositoryId: string; from: string; to: string; path?: string }, string];
  'git.operation': [{ repositoryId: string }, OperationState];
  'git.branches': [{ repositoryId: string }, BranchTarget[]];
  'git.createBranch': [{ repositoryId: string; name: string; start: BranchTarget; switchTo: boolean; token: string }, void];
  'git.switchBranch': [{ repositoryId: string; target: BranchTarget; token: string }, void];
  'git.stashes': [{ repositoryId: string }, StashEntry[]];
  'git.stash': [{ repositoryId: string; message: string; paths: string[]; includeUntracked: boolean; token: string }, void];
  'git.applyStash': [{ repositoryId: string; entry: StashEntry; restoreIndex: boolean; token: string }, void];
  'git.dropStash': [{ repositoryId: string; entry: StashEntry; token: string; confirmed: true }, void];
  'git.remotes': [{ repositoryId: string }, RemoteTarget[]];
  'git.fetch': [{ repositoryId: string; remote: RemoteTarget; token: string }, void];
  /** Fast-forward only. */
  'git.pull': [{ repositoryId: string; remote: RemoteTarget; branch: string; token: string }, void];
  /** Never forced. */
  'git.push': [{ repositoryId: string; remote: RemoteTarget; branch: string; token: string }, void];

  /**
   * Stops the repository's running network operation (fetch/pull/push). The original call then
   * rejects with 'cancelled' (nothing changed) or 'uncertain' (outcome unknown; renderer refreshes).
   */
  'git.cancel': [{ repositoryId: string }, void];

  'search.start': [SearchQuery, { searchId: string }];
  'search.cancel': [{ searchId: string }, void];

  'shell.openTerminal': [{ repositoryId: string }, void];
  'shell.reveal': [{ repositoryId: string; path?: string }, void];
  'diagnostics.open': [void, void];

  'prefs.get': [void, Preferences];
  'prefs.set': [Partial<Preferences>, Preferences];

  /** Sent once after listeners are attached and the first workspace/prefs are applied. Host holds open/compare events until then. */
  'window.ready': [void, void];
  'window.minimize': [void, void];
  'window.toggleMaximize': [void, void];
  'window.close': [void, void];
  /** EXT-01 --wait: the buffer opened for a waiting CLI call was closed. */
  'cli.released': [{ wait: string }, void];
}

// ── Events (host → renderer) ─────────────────────────────────────────────────

export interface HostEvents {
  'workspace': WorkspaceSnapshot | null;
  /**
   * The host is about to replace or close the workspace (renderer request, CLI reuse-window,
   * or native window close). It waits for `workspace.closeReady` and does nothing until then.
   */
  'workspace.willClose': { requestId: string; reason: 'open' | 'close' | 'cli' | 'window' };
  /** Whole rows for changed ids. The renderer ignores a field whose generation is older than what it holds. */
  'rows': { rows: RepositoryRow[]; discovery?: WorkspaceSnapshot['discovery'] };
  /** EDIT-02: a file the renderer has open changed on disk. */
  'file.changed': { repositoryId: string; path: string; version?: string; deleted?: boolean };
  'search.progress': SearchProgress;
  'notice': { level: 'info' | 'warning' | 'error'; message: string; repositoryId?: string; detail?: string };
  'window.state': { maximized: boolean; focused: boolean };
  /** CLI handoff: `minv --goto file:42:5`, `--repo path`, `--diff`, `--wait`. */
  'open': { repositoryId: string; path?: string; line?: number; column?: number; diff?: DiffSide; wait?: string };
  /**
   * CLI `minv --diff before after [--wait]`. Each side is an opaque host-authorized ref
   * (paths may lie outside the workspace); the renderer reads them with `fs.readRef`.
   * left = before/original, right = after/modified. Both are shown read-only.
   */
  'compare': { left: FileRef; right: FileRef; wait?: string };
  'prefs': Preferences;
}

/** Host errors carry a stable code so the renderer can explain, never guess. */
export interface HostError { code: 'conflict' | 'stale-review' | 'untrusted' | 'unavailable' | 'cancelled' | 'boundary' | 'git' | 'uncertain' | 'internal'; message: string; detail?: string }

export interface MinvHost {
  invoke<M extends keyof HostMethods>(method: M, params: HostMethods[M][0]): Promise<HostMethods[M][1]>;
  on<E extends keyof HostEvents>(event: E, listener: (payload: HostEvents[E]) => void): () => void;
}

// ── Editor adapter (renderer-side; installed by the trusted renderer bootstrap) ──

export interface EditorDocument { uri: string; text: string; languageId: string; readOnly: boolean; large?: boolean }
export interface CursorPosition { line: number; column: number; selections: number }
export interface EditorHandle {
  getText(): string;
  /** Replace contents preserving view state where possible (clean reload). */
  setText(text: string): void;
  setReadOnly(readOnly: boolean): void;
  revealLine(line: number, column?: number): void;
  focus(): void;
  layout(): void;
  onDidChangeContent(listener: () => void): () => void;
  onDidChangeCursor(listener: (position: CursorPosition) => void): () => void;
  /** Editor-native actions: find/replace/go to line/undo/redo live inside the editor. */
  run(action: 'find' | 'replace' | 'gotoLine' | 'undo' | 'redo'): void;
  /** Cursor and scroll position for session persistence. */
  getView(): SavedEditorView;
  setView(view: SavedEditorView): void;
  dispose(): void;
}
export interface EditorOptions { fontSize: number; tabSize: number; wordWrap: boolean; renderWhitespace: boolean }
export interface EditorTheme { base: 'light' | 'dark'; highContrast: boolean; colors: Record<string, string>; tokens: Array<{ token: string; foreground?: string; fontStyle?: string }>; fontFamily: string; lineHeight: number }
export interface EditorAdapter {
  readonly name: string;
  create(container: HTMLElement, document: EditorDocument): EditorHandle;
  /** Read-only side-by-side or inline text comparison (dirty buffer vs disk, revision vs revision). */
  createComparison(container: HTMLElement, original: EditorDocument, modified: EditorDocument, inline: boolean): { layout(): void; dispose(): void };
  setTheme(theme: EditorTheme): void;
  setOptions(options: EditorOptions): void;
}

declare global {
  interface Window { minvHost?: MinvHost; minvEditor?: EditorAdapter }
}
