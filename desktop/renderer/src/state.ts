import type { DiffSide, FileRef, Preferences, RecentWorkspace, RecoveryDraft, RepositoryRow, WorkspaceSnapshot } from './contract.js';

export type FolioTab = 'changes' | 'files' | 'history' | 'search';
export type Plane = 'index' | 'folio' | 'sheet';

export type SheetKind = 'file' | 'diff' | 'commit' | 'compare' | 'settings';
export interface Sheet {
  id: string;
  kind: SheetKind;
  repositoryId: string;
  path?: string;
  side?: DiffSide;
  oid?: string;
  left?: FileRef;
  right?: FileRef;
  line?: number;
  column?: number;
  /** Restored session view, applied once when the editor mounts. */
  view?: import('./contract.js').SavedEditorView;
  /** EXT-01 --wait handles, all released when this sheet closes. */
  waits?: string[];
  title: string;
  dirty?: boolean;
}

export interface Notice { id: number; level: 'info' | 'warning' | 'error'; message: string; detail?: string; at: number }

export interface State {
  workspace?: WorkspaceSnapshot;
  /** True once workspace.get resolved (null workspace shows the welcome page). */
  booted: boolean;
  recent: RecentWorkspace[];
  recoveries: RecoveryDraft[];
  /** Stable first-seen order (REPO-01/05). Never re-sorted by status. */
  order: string[];
  rows: Map<string, RepositoryRow>;
  selectedId?: string;
  filter: string;
  layout: 'tree' | 'flat';
  collapsed: Set<string>;
  tab: FolioTab;
  sheets: Sheet[];
  activeSheet?: string;
  splitSheet?: string;
  focusedPane: 'main' | 'split';
  focus: boolean;
  plane: Plane;
  prefs: Preferences;
  notices: Notice[];
  drafts: Map<string, string>;
  /** REPO-01: user pins, shown first in the map. */
  pins: string[];
}

export function initialState(): State {
  return {
    booted: false, recent: [], recoveries: [], order: [], rows: new Map(), filter: '', layout: 'tree', collapsed: new Set(), tab: 'changes',
    sheets: [], focusedPane: 'main', focus: false, plane: 'index',
    prefs: { appearance: 'system', motion: 'system', density: 'compact', editorFontSize: 13, tabSize: 2, wordWrap: false, renderWhitespace: false, gitPath: 'git', terminal: '', browseExclude: [], searchExclude: [] }, notices: [], drafts: new Map(), pins: [],
  };
}

type Listener = (state: State) => void;

/** One mutable state object; views re-read it on the next animation frame. */
export class Store {
  readonly state = initialState();
  private listeners = new Set<Listener>();
  private scheduled = false;

  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  update(mutate: (state: State) => void): void {
    mutate(this.state);
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const listener of this.listeners) listener(this.state);
    });
  }

  /** Applies host rows without moving established rows; ignores older generations per field. */
  applyRows(rows: RepositoryRow[]): void {
    this.update(state => {
      for (const incoming of rows) {
        const current = state.rows.get(incoming.id);
        if (!current) { state.rows.set(incoming.id, incoming); state.order.push(incoming.id); continue; }
        const next = { ...incoming };
        if (incoming.branch.generation < current.branch.generation) next.branch = current.branch;
        if (incoming.status.generation < current.status.generation) next.status = current.status;
        state.rows.set(incoming.id, next);
      }
    });
  }

  replaceWorkspace(workspace: WorkspaceSnapshot | null): void {
    this.update(state => {
      state.booted = true;
      state.workspace = workspace ?? undefined;
      if (!workspace) { state.rows = new Map(); state.order = []; state.selectedId = undefined; return; }
      state.rows = new Map();
      state.order = [];
      for (const row of workspace.rows) { state.rows.set(row.id, row); state.order.push(row.id); }
      if (!state.selectedId || !state.rows.has(state.selectedId)) state.selectedId = workspace.selectedId ?? workspace.rows[0]?.id;
    });
  }

  notify(level: Notice['level'], message: string, detail?: string): void {
    this.update(state => {
      const notice = { id: Date.now() + Math.random(), level, message, detail, at: Date.now() };
      state.notices = [...state.notices.slice(-3), notice];
      if (level !== 'error') setTimeout(() => this.update(s => { s.notices = s.notices.filter(n => n !== notice); }), 5000);
    });
  }
}

export function depthOf(state: State, id: string): number {
  let depth = 0;
  let row = state.rows.get(id);
  while (row?.parentId && depth < 32) { depth++; row = state.rows.get(row.parentId); }
  return depth;
}

export function childrenOf(state: State): Map<string | undefined, string[]> {
  const map = new Map<string | undefined, string[]>();
  for (const id of state.order) {
    const row = state.rows.get(id)!;
    const parent = row.parentId && state.rows.has(row.parentId) ? row.parentId : undefined;
    const list = map.get(parent) ?? [];
    list.push(id);
    map.set(parent, list);
  }
  return map;
}

/** Visible index rows: tree order (parents before children, first-seen order among siblings) or filtered flat. */
export function visibleRows(state: State): string[] {
  const query = state.filter.trim().toLowerCase();
  if (query) {
    const terms = query.split(/\s+/);
    return state.order.filter(id => {
      const row = state.rows.get(id)!;
      const hay = `${row.name} ${row.relativePath} ${row.branch.value?.name ?? ''}`.toLowerCase();
      return terms.every(term => hay.includes(term));
    });
  }
  const pinned = state.pins.filter(id => state.rows.has(id));
  if (state.layout === 'flat') return [...pinned, ...state.order.filter(id => !pinned.includes(id))];
  const children = childrenOf(state);
  const out: string[] = [...pinned];
  const walk = (parent: string | undefined) => {
    for (const id of children.get(parent) ?? []) {
      if (!pinned.includes(id)) out.push(id);
      if (!state.collapsed.has(id)) walk(id);
    }
  };
  walk(undefined);
  return out;
}

export function selectedRow(state: State): RepositoryRow | undefined {
  return state.selectedId ? state.rows.get(state.selectedId) : undefined;
}
