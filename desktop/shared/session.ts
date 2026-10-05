/** Durable layout only. Source text lives exclusively in dirty-buffer recovery. */
export interface SavedEditorView {
  line: number;
  column: number;
  scrollTop: number;
  scrollLeft: number;
}
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
