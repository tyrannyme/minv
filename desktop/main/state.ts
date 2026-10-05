import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface SavedWorkspace {
  roots: string[];
  selectedRepository?: string;
  repositoryOrder: string[];
  pinnedRepositories: string[];
  openDocuments: { rootId: string; path: string; view?: { line: number; column: number; scrollTop: number } }[];
  activeDocument?: string;
}
export type { Preferences } from '../renderer/src/contract';
import { normalizeAppearance, type Preferences } from '../renderer/src/contract';

interface State {
  version: 1;
  trustedRoots: string[];
  recentWorkspaces: string[][];
  workspace: SavedWorkspace;
  preferences: Preferences;
  bounds?: { width: number; height: number; x?: number; y?: number; maximized: boolean };
}
const fresh = (): State => ({
  version: 1, trustedRoots: [], recentWorkspaces: [],
  workspace: { roots: [], repositoryOrder: [], pinnedRepositories: [], openDocuments: [] },
  preferences: { appearance: 'system', motion: 'system', density: 'comfortable', editorFontSize: 13, tabSize: 2, wordWrap: false, renderWhitespace: false, gitPath: 'git', terminal: '', browseExclude: [], searchExclude: [] }
});
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 4096 && value.every(item => typeof item === 'string' && !item.includes('\0'));

/** Minv-owned user preferences, kept separate from disposable catalog and dirty recovery. */
export class StateStore {
  readonly file: string;
  private value: State = fresh();
  private writes: Promise<void> = Promise.resolve();
  constructor(directory: string) { this.file = path.join(directory, 'state.json'); }

  async load(): Promise<void> {
    try {
      if ((await stat(this.file)).size > 4 * 1024 * 1024) return;
      const text = await readFile(this.file, 'utf8');
      if (text.length > 4 * 1024 * 1024) return;
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return;
      const state = parsed as Partial<State>;
      if (state.version !== 1) return;
      if (stringList(state.trustedRoots)) this.value.trustedRoots = state.trustedRoots.filter(root => path.isAbsolute(root));
      if (Array.isArray(state.recentWorkspaces)) this.value.recentWorkspaces = state.recentWorkspaces.filter(stringList).slice(0, 20);
      if (state.workspace && stringList(state.workspace.roots)) {
        this.value.workspace = {
          roots: state.workspace.roots.filter(root => path.isAbsolute(root)),
          selectedRepository: typeof state.workspace.selectedRepository === 'string' ? state.workspace.selectedRepository : undefined,
          repositoryOrder: stringList(state.workspace.repositoryOrder) ? state.workspace.repositoryOrder : [],
          pinnedRepositories: stringList(state.workspace.pinnedRepositories) ? state.workspace.pinnedRepositories : [],
          openDocuments: Array.isArray(state.workspace.openDocuments) ? state.workspace.openDocuments.filter(doc => typeof doc?.rootId === 'string' && typeof doc?.path === 'string').slice(0, 100) : [],
          activeDocument: typeof state.workspace.activeDocument === 'string' ? state.workspace.activeDocument : undefined,
        };
      }
      if (state.preferences) this.setPreferences(state.preferences);
      if (state.bounds && Number.isFinite(state.bounds.width) && Number.isFinite(state.bounds.height)) {
        this.value.bounds = { ...state.bounds, width: Math.min(7680, Math.max(760, state.bounds.width)), height: Math.min(4320, Math.max(500, state.bounds.height)) };
      }
    } catch { /* Corrupt disposable UI state must not touch dirty-buffer recovery. */ }
  }

  get snapshot(): State { return structuredClone(this.value); }
  get workspace(): SavedWorkspace { return structuredClone(this.value.workspace); }
  get preferences(): Preferences { return structuredClone(this.value.preferences); }
  isTrusted(roots: string[]): boolean { return roots.length > 0 && roots.every(root => this.value.trustedRoots.includes(root)); }
  trust(roots: string[]): void { this.value.trustedRoots = [...new Set([...this.value.trustedRoots, ...roots])]; }
  revokeTrust(root: string): void { this.value.trustedRoots = this.value.trustedRoots.filter(item => item !== root); }
  setWorkspace(workspace: SavedWorkspace): void {
    this.value.workspace = structuredClone(workspace);
    if (workspace.roots.length) {
      const key = JSON.stringify(workspace.roots);
      this.value.recentWorkspaces = [workspace.roots, ...this.value.recentWorkspaces.filter(roots => JSON.stringify(roots) !== key)].slice(0, 20);
    }
  }
  setPreferences(update: Partial<Preferences>): void {
    const next = { ...this.value.preferences };
    if (typeof update.appearance === 'string') next.appearance = normalizeAppearance(update.appearance);
    if (['system', 'reduce'].includes(update.motion!)) next.motion = update.motion!;
    if (['compact', 'comfortable'].includes(update.density!)) next.density = update.density!;
    if (typeof update.gitPath === 'string' && update.gitPath && !update.gitPath.includes('\0')) next.gitPath = update.gitPath;
    if (typeof update.terminal === 'string' && !update.terminal.includes('\0')) next.terminal = update.terminal;
    if (typeof update.editorFontSize === 'number' && Number.isFinite(update.editorFontSize)) next.editorFontSize = Math.max(10, Math.min(28, update.editorFontSize));
    if (Number.isInteger(update.tabSize)) next.tabSize = Math.max(1, Math.min(8, update.tabSize!));
    if (typeof update.wordWrap === 'boolean') next.wordWrap = update.wordWrap;
    if (typeof update.renderWhitespace === 'boolean') next.renderWhitespace = update.renderWhitespace;
    if (stringList(update.browseExclude)) next.browseExclude = [...update.browseExclude];
    if (stringList(update.searchExclude)) next.searchExclude = [...update.searchExclude];
    this.value.preferences = next;
  }
  setBounds(bounds: NonNullable<State['bounds']>): void { this.value.bounds = { ...bounds }; }
  flush(): Promise<void> {
    const content = JSON.stringify(this.value, null, 2);
    const save = this.writes.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, content, { mode: 0o600, flag: 'wx' }); await rename(temporary, this.file); }
      finally { await rm(temporary, { force: true }); }
    });
    this.writes = save;
    return save;
  }
}
