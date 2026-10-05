import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RendererSession, SavedEditorView, SavedSheet } from '../shared/session';
export class SessionStateError extends Error { constructor(public readonly code: string, message: string) { super(message); } }

const MAX_BYTES = 2 * 1024 * 1024;
const invalid = (message: string): never => { throw new SessionStateError('invalid-request', message); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Expected a session object.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid('Invalid session object prototype.');
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) return invalid('Unknown or invalid session field.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return invalid('Invalid session text.');
  return value;
}
function id(value: unknown): string { const result = text(value, 24); if (!/^[a-f0-9]{24}$/.test(result)) return invalid('Invalid workspace or repository identity.'); return result; }
function sheetId(value: unknown): string { const result = text(value, 128); if (!/^[a-zA-Z0-9_-]+$/.test(result)) return invalid('Invalid sheet identity.'); return result; }
function relative(value: unknown, allowEmpty = false): string {
  const result = text(value, 4096);
  if ((!allowEmpty && !result) || result.startsWith('/') || /^[a-z]:/i.test(result) || result.includes('\\') || result.split('/').some(part => part === '..' || part === '.git' || part === '.')) return invalid('Session paths must stay inside a repository.');
  return result;
}
function integer(value: unknown, minimum = 0, maximum = 1_000_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) return invalid('Invalid session position.');
  return value as number;
}
function scroll(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) return invalid('Invalid scroll position.'); return value; }
function enumeration<T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== 'string' || !values.includes(value as T)) return invalid('Invalid session choice.'); return value as T; }
function array<T>(value: unknown, maximum: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid('Session list exceeds its limit.');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return invalid('Invalid session list item.');
  }
  if (Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return invalid('Invalid session list field.');
  return value.map(parse);
}
const ids = (value: unknown) => [...new Set(array(value, 4096, id))];
function view(value: unknown): SavedEditorView {
  const input = object(value, ['line', 'column', 'scrollTop', 'scrollLeft']);
  return { line: integer(input.line, 1), column: integer(input.column, 1), scrollTop: scroll(input.scrollTop), scrollLeft: scroll(input.scrollLeft) };
}
function sheet(value: unknown): SavedSheet {
  const input = object(value, ['id', 'kind', 'repositoryId', 'path', 'side', 'oid', 'view']);
  const shared = { id: sheetId(input.id), ...(input.view === undefined ? {} : { view: view(input.view) }) };
  if (input.kind === 'settings') {
    if (input.repositoryId !== undefined || input.path !== undefined || input.side !== undefined || input.oid !== undefined) return invalid('Settings have no repository target.');
    return { ...shared, kind: 'settings' };
  }
  const repositoryId = id(input.repositoryId);
  if (input.kind === 'file') {
    if (input.side !== undefined || input.oid !== undefined) return invalid('Invalid file sheet target.');
    return { ...shared, kind: 'file', repositoryId, path: relative(input.path) };
  }
  if (input.kind === 'diff') {
    if (input.oid !== undefined) return invalid('Invalid diff sheet target.');
    return { ...shared, kind: 'diff', repositoryId, path: relative(input.path), side: enumeration(input.side, ['staged', 'unstaged']) };
  }
  if (input.kind === 'commit') {
    if (input.path !== undefined || input.side !== undefined) return invalid('Invalid commit sheet target.');
    const oid = text(input.oid, 64); if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(oid)) return invalid('Invalid commit identity.');
    return { ...shared, kind: 'commit', repositoryId, oid };
  }
  return invalid('Unknown restorable sheet.');
}

/** Strictly copy approved fields; persisted identifiers are display hints, never capabilities. */
export function validateRendererSession(value: unknown, workspaceId?: string): RendererSession {
  const input = object(value, ['version', 'workspaceId', 'selectedId', 'order', 'pins', 'layout', 'collapsed', 'tab', 'sheets', 'activeSheet', 'splitSheet', 'focusedPane', 'plane', 'focus', 'indexScrollTop', 'expandedDirectories', 'commitDrafts']);
  if (input.version !== 1) return invalid('Unsupported session version.');
  const workspace = id(input.workspaceId);
  if (workspaceId !== undefined && workspace !== workspaceId) throw new SessionStateError('unavailable', 'The session belongs to a different workspace.');
  const sheets = array(input.sheets, 100, sheet);
  const sheetIds = new Set(sheets.map(sheet => sheet.id));
  if (sheetIds.size !== sheets.length) return invalid('Duplicate saved sheet identity.');
  const activeSheet = input.activeSheet === undefined ? undefined : sheetId(input.activeSheet);
  const splitSheet = input.splitSheet === undefined ? undefined : sheetId(input.splitSheet);
  if ((activeSheet && !sheetIds.has(activeSheet)) || (splitSheet && !sheetIds.has(splitSheet)) || (activeSheet && activeSheet === splitSheet)) return invalid('The active pane must reference a saved sheet.');
  const focusedPane = enumeration(input.focusedPane, ['main', 'split']);
  if (focusedPane === 'split' && !splitSheet) return invalid('The split pane is not open.');
  if (typeof input.focus !== 'boolean') return invalid('Invalid focus mode.');
  let directoryCount = 0;
  const expandedDirectories = array(input.expandedDirectories, 4096, value => {
    const item = object(value, ['repositoryId', 'paths', 'scrollTop']);
    const paths = [...new Set(array(item.paths, 4096, value => relative(value, true)))];
    directoryCount += paths.length; if (directoryCount > 4096) return invalid('Too many expanded directories.');
    return { repositoryId: id(item.repositoryId), paths, scrollTop: scroll(item.scrollTop) };
  });
  const seenDirectories = new Set(expandedDirectories.map(item => item.repositoryId));
  if (seenDirectories.size !== expandedDirectories.length) return invalid('Duplicate directory layout.');
  let draftBytes = 0;
  const commitDrafts = array(input.commitDrafts, 64, value => {
    const item = object(value, ['repositoryId', 'text']); const draft = text(item.text, 64 * 1024);
    draftBytes += Buffer.byteLength(draft); if (draftBytes > 512 * 1024) return invalid('Commit drafts exceed their limit.');
    return { repositoryId: id(item.repositoryId), text: draft };
  });
  if (new Set(commitDrafts.map(item => item.repositoryId)).size !== commitDrafts.length) return invalid('Duplicate commit draft.');
  const result: RendererSession = {
    version: 1, workspaceId: workspace, ...(input.selectedId === undefined ? {} : { selectedId: id(input.selectedId) }),
    order: ids(input.order), pins: ids(input.pins), layout: enumeration(input.layout, ['tree', 'flat']), collapsed: ids(input.collapsed),
    tab: enumeration(input.tab, ['changes', 'files', 'history', 'search']), sheets,
    ...(activeSheet ? { activeSheet } : {}), ...(splitSheet ? { splitSheet } : {}), focusedPane,
    plane: enumeration(input.plane, ['index', 'folio', 'sheet']), focus: input.focus, indexScrollTop: scroll(input.indexScrollTop), expandedDirectories, commitDrafts,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) return invalid('Workspace session exceeds its storage limit.');
  return result;
}

/** Durable UI state, separate from both disposable caches and unsaved source recovery. */
export class SessionStateStore {
  private readonly directory: string;
  private writes: Promise<void> = Promise.resolve();
  constructor(dataDirectory: string) { this.directory = path.join(dataDirectory, 'sessions'); }
  async load(workspaceId: string): Promise<RendererSession | null> {
    const file = path.join(this.directory, `${id(workspaceId)}.json`);
    try {
      if ((await lstat(this.directory)).isSymbolicLink() || (await lstat(file)).isSymbolicLink() || (await stat(file)).size > MAX_BYTES) return null;
      const contents = await readFile(file, 'utf8'); if (Buffer.byteLength(contents) > MAX_BYTES) return null;
      return validateRendererSession(JSON.parse(contents), workspaceId);
    } catch { return null; }
  }
  save(value: RendererSession): Promise<void> {
    const session = validateRendererSession(value); const contents = JSON.stringify(session);
    const next = this.writes.catch(() => undefined).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await lstat(this.directory)).isSymbolicLink()) throw new SessionStateError('boundary', 'Session storage cannot be a symlink.');
      await chmod(this.directory, 0o700);
      const file = path.join(this.directory, `${session.workspaceId}.json`); const temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
    });
    this.writes = next; return next;
  }
  flush(): Promise<void> { return this.writes; }
}
