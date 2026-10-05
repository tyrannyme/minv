import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Branch, Observation, Repository, RepositoryStatus } from '../core/types';

export interface RepositoryActions {
  select(id: string): void;
  refresh(): void;
  openChange(id: string, path: string, staged: boolean): void;
  stage(id: string, path: string): void;
  unstage(id: string, path: string): void;
  commit(id: string): void;
}

export interface RepositoryRow {
  repository: Repository;
  branch: Observation<Branch>;
  status: Observation<RepositoryStatus>;
  monitoringError?: string;
}

/** Only catalog identities and changes from the latest extension snapshot may be acted on. */
export class RepositoriesView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private rows: RepositoryRow[] = [];
  private selectedId?: string;
  private ready = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly actions: RepositoryActions) {}

  update(rows: RepositoryRow[], selectedId?: string): void {
    const incoming = new Map(rows.map(row => [row.repository.id, row]));
    // Preserve established positions even if scans finish in a different order.
    const previousIds = new Set(this.rows.map(row => row.repository.id));
    this.rows = this.rows.flatMap(row => incoming.has(row.repository.id) ? [incoming.get(row.repository.id)!] : []);
    this.rows.push(...rows.filter(row => !previousIds.has(row.repository.id)));
    this.selectedId = selectedId;
    this.publish();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = html();
    this.context.subscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => this.receive(message)),
      view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.ready = false; } }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.publish()),
    );
  }

  private publish(): void {
    if (this.ready) {
      void this.view?.webview.postMessage({ type: 'update', rows: this.rows, selectedId: this.selectedId, trusted: vscode.workspace.isTrusted });
    }
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const message = value as Record<string, unknown>;
    if (message.type === 'ready') { this.ready = true; this.publish(); return; }
    if (message.type === 'refresh') { this.actions.refresh(); return; }
    if (typeof message.id !== 'string') return;
    const row = this.rows.find(item => item.repository.id === message.id);
    if (!row) return;
    const id = row.repository.id;
    if (message.type === 'select') { this.actions.select(id); return; }
    if (!row.repository.available) return;
    if (message.type === 'openChange') {
      if (typeof message.path !== 'string' || typeof message.staged !== 'boolean') return;
      const change = row.status.value?.changes.find(item => item.path === message.path);
      if (!change || (message.staged ? !isStaged(change.index) : !isWorking(change.workingTree, change.index))) return;
      this.actions.openChange(id, change.path, message.staged);
      return;
    }
    if (!vscode.workspace.isTrusted || row.status.state !== 'observed' || !row.status.value?.complete || row.branch.state !== 'observed') return;
    if (message.type === 'commit') {
      if (row.status.value.changes.some(change => isStaged(change.index))) this.actions.commit(id);
      return;
    }
    if (typeof message.path !== 'string') return;
    const change = row.status.value.changes.find(item => item.path === message.path);
    if (!change) return;
    if (message.type === 'stage' && isWorking(change.workingTree, change.index)) this.actions.stage(id, change.path);
    if (message.type === 'unstage' && isStaged(change.index)) this.actions.unstage(id, change.path);
  }
}

function isStaged(index: string): boolean { return index !== '.' && index !== ' ' && index !== '?' && index !== '!'; }
function isWorking(workingTree: string, index: string): boolean { return index === '?' || (workingTree !== '.' && workingTree !== ' ' && workingTree !== '!'); }

interface WebviewState { query?: string; scroll?: number; selectedId?: string; activeId?: string; detailScroll?: number }
declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): WebviewState | undefined; setState(state: WebviewState): void };

/** Self-contained: emitted as a nonce-authorized script without interpolating repository data. */
function webviewMain(): void {
  const api = acquireVsCodeApi();
  const saved = api.getState() ?? {};
  const search = document.getElementById('search') as HTMLInputElement;
  const list = document.getElementById('repositories')!;
  const canvas = document.getElementById('rows')!;
  const empty = document.getElementById('empty')!;
  const count = document.getElementById('count')!;
  const detail = document.getElementById('detail')!;
  const title = document.getElementById('detail-title')!;
  const branchLabel = document.getElementById('detail-branch')!;
  const scope = document.getElementById('detail-scope')!;
  const stateLabel = document.getElementById('detail-state')!;
  const commitButton = document.getElementById('commit') as HTMLButtonElement;
  const stagedList = document.getElementById('staged-list')!;
  const workingList = document.getElementById('working-list')!;
  const stagedHeading = document.getElementById('staged-heading')!;
  const workingHeading = document.getElementById('working-heading')!;
  const notice = document.getElementById('notice')!;
  const rowHeight = 54;
  document.documentElement.style.setProperty('--row-height', rowHeight + 'px');
  let rows: RepositoryRow[] = [];
  let depths = new Map<string, number>();
  let filtered: RepositoryRow[] = [];
  let selectedId = saved.selectedId;
  let activeId = saved.activeId ?? selectedId;
  let trusted = false;
  let renderedDetailId: string | undefined;
  const mounted = new Map<string, HTMLElement>();
  const rowDomIds = new Map<string, string>();
  let nextDomId = 0;
  let frame = 0;
  let announcementTimer: ReturnType<typeof setTimeout> | undefined;
  let lastAnnouncement = '';
  search.value = saved.query ?? '';

  function persist(): void {
    api.setState({ query: search.value, scroll: list.scrollTop, selectedId, activeId, detailScroll: detail.scrollTop });
  }
  function send(type: string, extra: Record<string, unknown> = {}): void { api.postMessage({ type, ...extra }); }
  function text(element: Element, value: string): void { if (element.textContent !== value) element.textContent = value; }
  function staged(index: string): boolean { return index !== '.' && index !== ' ' && index !== '?' && index !== '!'; }
  function working(index: string, work: string): boolean { return index === '?' || (work !== '.' && work !== ' ' && work !== '!'); }
  function branch(row: RepositoryRow): string {
    if (!row.repository.available) return 'Offline checkout';
    const value = row.branch.value;
    if (!value) {
      if (row.branch.state === 'error') return 'Branch unavailable';
      if (row.branch.state === 'refreshing') return 'Checking branch';
      return row.branch.state === 'cached' ? 'Branch unverified' : 'Branch unknown';
    }
    if (value.kind === 'detached') return 'Detached · ' + (value.oid?.slice(0, 8) ?? 'unknown commit');
    return (value.name ?? 'Unknown branch') + (value.kind === 'unborn' ? ' · unborn' : '');
  }
  function freshness(observation: Observation<unknown>, scopeName: string): string {
    switch (observation.state) {
      case 'cached': return scopeName + ' unverified';
      case 'unknown': return scopeName + ' unknown';
      case 'refreshing': return 'Checking ' + scopeName.toLowerCase();
      case 'stale': return scopeName + ' stale';
      case 'error': return scopeName + ' failed';
      case 'observed': return scopeName + ' checked' + (observation.observedAt ? ' ' + new Date(observation.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
    }
  }
  function summary(row: RepositoryRow): string {
    if (!row.repository.available) return 'Unavailable';
    if (!row.status.value) return row.status.state === 'error' ? 'Status failed' : 'Changes unknown';
    const n = row.status.value.changes.length;
    const partial = !row.status.value.complete;
    if (n === 0) return row.status.state === 'observed' && !partial ? 'No changes' : 'Changes unverified';
    return n + (partial ? '+' : '') + (n === 1 && !partial ? ' change' : ' changes');
  }
  function rowState(row: RepositoryRow): string {
    if (!row.repository.available) return 'offline';
    if (row.branch.state === 'error' || row.status.state === 'error' || row.monitoringError) return 'error';
    const value = row.status.value;
    if (!value) return 'pending';
    const verified = row.status.state === 'observed' && value.complete;
    if (value.changes.length) return verified ? 'dirty' : 'dirty unverified';
    return verified ? 'clean' : 'pending';
  }
  function depth(row: RepositoryRow, byId: Map<string, RepositoryRow>): number {
    let level = 0;
    for (let parent = row.repository.parentId; parent && level < 6; level++) parent = byId.get(parent)?.repository.parentId;
    return level;
  }
  // Keep the tail of long paths visible; marks stop the leading slash from flipping sides.
  function tail(value: string): string { return '\u200e' + value + '\u200e'; }
  function cell(className: string): HTMLSpanElement {
    const element = document.createElement('span');
    element.className = className;
    return element;
  }
  function makeRow(id: string): HTMLElement {
    const element = document.createElement('div');
    element.className = 'repository';
    if (!rowDomIds.has(id)) rowDomIds.set(id, 'repository-' + nextDomId++);
    element.id = rowDomIds.get(id)!;
    element.setAttribute('role', 'option');
    const glyph = cell('glyph');
    glyph.setAttribute('aria-hidden', 'true');
    const first = document.createElement('div');
    first.className = 'row-line';
    first.append(cell('name'), cell('summary'));
    const second = document.createElement('div');
    second.className = 'row-line';
    second.append(cell('branch'), cell('freshness'));
    const body = document.createElement('div');
    body.className = 'row-body';
    body.append(first, second, cell('path'));
    element.append(glyph, body);
    element.addEventListener('click', () => { choose(id); list.focus(); });
    return element;
  }
  function renderRows(): void {
    frame = 0;
    const first = Math.max(0, Math.floor(list.scrollTop / rowHeight) - 3);
    const last = Math.min(filtered.length, Math.ceil((list.scrollTop + list.clientHeight) / rowHeight) + 3);
    const wanted = new Set(filtered.slice(first, last).map(row => row.repository.id));
    for (const [id, element] of mounted) {
      if (!wanted.has(id)) { element.remove(); mounted.delete(id); }
    }
    for (let index = first; index < last; index++) {
      const row = filtered[index]!;
      const id = row.repository.id;
      let element = mounted.get(id);
      if (!element) { element = makeRow(id); mounted.set(id, element); canvas.append(element); }
      if (canvas.children[index - first] !== element) canvas.insertBefore(element, canvas.children[index - first] ?? null);
      element.style.top = index * rowHeight + 'px';
      element.style.setProperty('--depth', String(depths.get(id) ?? 0));
      element.dataset.state = rowState(row);
      element.classList.toggle('active', id === activeId);
      element.setAttribute('aria-selected', String(id === selectedId));
      element.setAttribute('aria-posinset', String(index + 1));
      element.setAttribute('aria-setsize', String(filtered.length));
      text(element.querySelector('.name')!, row.repository.name);
      text(element.querySelector('.branch')!, branch(row));
      text(element.querySelector('.path')!, tail(row.repository.root));
      text(element.querySelector('.summary')!, summary(row));
      element.querySelector('.summary')!.classList.toggle('quiet', !row.status.value?.changes.length);
      const state = freshness(row.branch, 'Branch') + ' · ' + freshness(row.status, 'Changes');
      const fresh = row.monitoringError ? 'Monitoring degraded' : row.branch.state === 'observed' ? (row.status.state === 'observed' && row.status.value?.complete ? 'Checked' : freshness(row.status, 'Changes')) : freshness(row.branch, 'Branch');
      text(element.querySelector('.freshness')!, fresh === summary(row) ? '' : fresh);
      element.title = row.repository.root + '\n' + branch(row) + '\n' + state + (row.branch.error ? '\n' + row.branch.error : '') + (row.repository.error ? '\n' + row.repository.error : '');
      element.setAttribute('aria-label', row.repository.name + ', ' + row.repository.root + ', ' + branch(row) + ', ' + summary(row) + ', ' + state + (row.monitoringError ? ', Monitoring degraded: ' + row.monitoringError : ''));
    }
    const active = activeId && mounted.get(activeId);
    if (active) list.setAttribute('aria-activedescendant', active.id);
    else list.removeAttribute('aria-activedescendant');
  }
  function scheduleRender(): void { if (!frame) frame = requestAnimationFrame(renderRows); }
  function filter(userInput: boolean): void {
    const query = search.value.trim().toLocaleLowerCase();
    filtered = rows.filter(row => !query || (row.repository.name + '\n' + row.repository.root).toLocaleLowerCase().includes(query));
    canvas.style.height = filtered.length * rowHeight + 'px';
    text(count, query ? filtered.length + ' of ' + rows.length : rows.length + (rows.length === 1 ? ' repository' : ' repositories'));
    empty.hidden = filtered.length > 0;
    text(empty, rows.length ? 'No matching repositories' : 'No repositories in this workspace');
    if (userInput) list.scrollTop = 0;
    if (!filtered.some(row => row.repository.id === activeId)) activeId = filtered[0]?.repository.id;
    renderRows();
    persist();
  }
  function choose(id: string): void {
    selectedId = id;
    activeId = id;
    renderRows();
    renderDetail();
    persist();
    send('select', { id });
  }
  function changeDescription(index: string, work: string, isStaged: boolean): string {
    const code = isStaged ? index : work;
    if (index === '?' || code === '?') return 'Untracked';
    if (index === 'U' || work === 'U' || (index === 'A' && work === 'A') || (index === 'D' && work === 'D')) return 'Conflict';
    return ({ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' } as Record<string, string>)[code] ?? 'Changed';
  }
  function letter(description: string): string {
    return ({ Untracked: '?', Conflict: '!', 'Type changed': 'T', Changed: '•' } as Record<string, string>)[description] ?? description[0]!;
  }
  function renderChanges(container: HTMLElement, row: RepositoryRow, isStaged: boolean, canWrite: boolean): number {
    const changes = row.status.value?.changes.filter(change => isStaged ? staged(change.index) : working(change.index, change.workingTree)) ?? [];
    const existing = new Map(Array.from(container.children).map(element => [(element as HTMLElement).dataset.path!, element as HTMLElement]));
    const present = new Set(changes.map(change => change.path));
    for (const [path, element] of existing) if (!present.has(path)) element.remove();
    changes.forEach((change, index) => {
      let element = existing.get(change.path);
      if (!element) {
        element = document.createElement('div');
        element.className = 'change';
        element.dataset.path = change.path;
        const open = document.createElement('button');
        open.className = 'open-change';
        open.append(cell('code'), cell('file'), cell('directory'));
        open.firstElementChild!.setAttribute('aria-hidden', 'true');
        open.addEventListener('click', () => send('openChange', { id: row.repository.id, path: change.path, staged: isStaged }));
        const action = document.createElement('button');
        action.className = 'change-action';
        action.textContent = isStaged ? 'Unstage' : 'Stage';
        action.addEventListener('click', () => send(isStaged ? 'unstage' : 'stage', { id: row.repository.id, path: change.path }));
        element.append(open, action);
      }
      const open = element.children[0] as HTMLButtonElement;
      const action = element.children[1] as HTMLButtonElement;
      const description = changeDescription(change.index, change.workingTree, isStaged);
      const submodule = change.submodule && change.submodule !== 'N...' ? ' · submodule' : '';
      const slash = change.path.lastIndexOf('/');
      element.dataset.kind = description.toLowerCase().replace(' ', '-');
      text(open.children[0]!, letter(description));
      text(open.children[1]!, change.path.slice(slash + 1));
      text(open.children[2]!, [slash > 0 ? change.path.slice(0, slash) : '', submodule ? 'submodule' : ''].filter(Boolean).join(' · '));
      open.setAttribute('aria-label', change.path + ', ' + description + submodule);
      open.title = (change.originalPath ? change.originalPath + ' → ' : '') + change.path + ' · ' + description + submodule;
      action.disabled = !canWrite;
      action.setAttribute('aria-label', (isStaged ? 'Unstage ' : 'Stage ') + change.path);
      if (container.children[index] !== element) container.insertBefore(element, container.children[index] ?? null);
    });
    return changes.length;
  }
  function renderDetail(): void {
    const row = rows.find(item => item.repository.id === selectedId);
    const changed = renderedDetailId !== row?.repository.id;
    if (changed) { stagedList.replaceChildren(); workingList.replaceChildren(); detail.scrollTop = 0; }
    renderedDetailId = row?.repository.id;
    detail.classList.toggle('vacant', !row);
    if (!row) {
      text(title, 'Select a repository');
      text(scope, ''); text(branchLabel, ''); text(stateLabel, '');
      commitButton.disabled = true;
      stagedHeading.hidden = workingHeading.hidden = true;
      text(notice, 'Choose a repository to inspect its changes.');
      return;
    }
    text(title, row.repository.name);
    text(scope, row.repository.root);
    text(branchLabel, branch(row) + (row.branch.value?.operation ? ' · ' + row.branch.value.operation : ''));
    text(stateLabel, freshness(row.branch, 'Branch') + ' · ' + freshness(row.status, 'Changes'));
    const canWrite = trusted && row.repository.available && row.branch.state === 'observed' && row.status.state === 'observed' && row.status.value?.complete === true;
    const stagedCount = renderChanges(stagedList, row, true, canWrite);
    const workingCount = renderChanges(workingList, row, false, canWrite);
    stagedHeading.hidden = workingHeading.hidden = false;
    text(stagedHeading.firstElementChild!, 'Staged');
    text(stagedHeading.lastElementChild!, row.status.value ? String(stagedCount) : 'unknown');
    text(workingHeading.firstElementChild!, 'Working tree');
    text(workingHeading.lastElementChild!, row.status.value ? String(workingCount) : 'unknown');
    commitButton.disabled = !canWrite || stagedCount === 0;
    commitButton.title = 'Review and commit staged changes in ' + row.repository.name;
    let message = '';
    if (!row.repository.available) message = row.repository.error ?? 'Checkout unavailable. Refresh to retry.';
    else if (row.branch.error || row.status.error) message = [row.branch.error, row.status.error].filter(Boolean).join(' ');
    else if (!row.status.value) message = 'Changes have not been checked yet.';
    else if (!row.status.value.complete) message = 'Incomplete status. Additional changes may be pending.';
    else if (row.status.state !== 'observed') message = 'Changes are ' + row.status.state + '. Refresh before staging or committing.';
    else if (!stagedCount && !workingCount) message = 'No changes at the last check.';
    if (!trusted) message += (message ? ' ' : '') + 'Trust this workspace to stage or commit.';
    if (row.monitoringError) message += (message ? ' ' : '') + 'Monitoring degraded: ' + row.monitoringError + ' Refresh to verify current changes.';
    if (rows.some(child => child.repository.parentId === row.repository.id)) {
      message += (message ? ' ' : '') + 'Parent files and submodule pointers. Child file changes are shown in their own repositories.';
    }
    text(notice, message);
    // Announce only the selected repository, coalescing rapid background updates.
    const announcement = row.repository.name + ', ' + branch(row) + ', ' + summary(row) + ', ' + row.branch.state + ' branch, ' + row.status.state + ' changes' + (row.monitoringError ? ', monitoring degraded' : '');
    if (announcement !== lastAnnouncement) {
      lastAnnouncement = announcement;
      if (announcementTimer) clearTimeout(announcementTimer);
      announcementTimer = setTimeout(() => text(document.getElementById('announcement')!, announcement), 500);
    }
  }
  search.addEventListener('input', () => filter(true));
  search.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'Enter') { event.preventDefault(); list.focus(); if (activeId) choose(activeId); }
    if (event.key === 'Escape' && search.value) { search.value = ''; filter(true); }
  });
  list.addEventListener('scroll', () => { scheduleRender(); persist(); });
  detail.addEventListener('scroll', persist);
  list.addEventListener('keydown', event => {
    const index = filtered.findIndex(row => row.repository.id === activeId);
    let next = index;
    switch (event.key) {
      case 'ArrowDown': next = Math.min(filtered.length - 1, index + 1); break;
      case 'ArrowUp': next = Math.max(0, index - 1); break;
      case 'Home': next = 0; break;
      case 'End': next = filtered.length - 1; break;
      case 'Enter': case ' ': if (activeId) { event.preventDefault(); choose(activeId); } return;
      default: return;
    }
    event.preventDefault();
    const row = filtered[next];
    if (!row) return;
    activeId = row.repository.id;
    if (next * rowHeight < list.scrollTop) list.scrollTop = next * rowHeight;
    else if ((next + 1) * rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = (next + 1) * rowHeight - list.clientHeight;
    renderRows(); persist();
  });
  commitButton.addEventListener('click', () => { if (selectedId) send('commit', { id: selectedId }); });
  new ResizeObserver(scheduleRender).observe(list);
  let firstUpdate = true;
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type !== 'update' || !Array.isArray(message.rows)) return;
    rows = message.rows;
    trusted = message.trusted === true;
    const byId = new Map(rows.map(row => [row.repository.id, row]));
    depths = new Map(rows.map(row => [row.repository.id, depth(row, byId)]));
    if (firstUpdate && rows.length) { selectedId = saved.selectedId; activeId = saved.activeId ?? saved.selectedId; }
    if (typeof message.selectedId === 'string') selectedId = message.selectedId;
    if (!rows.some(row => row.repository.id === selectedId)) selectedId = undefined;
    filter(false);
    renderDetail();
    if (firstUpdate && rows.length) {
      firstUpdate = false;
      list.scrollTop = saved.scroll ?? 0;
      detail.scrollTop = saved.detailScroll ?? 0;
      renderRows();
      if (!message.selectedId && selectedId) send('select', { id: selectedId });
    }
    persist();
  });
  send('ready');
}

function html(): string {
  const nonce = randomBytes(18).toString('base64');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Minv repositories</title>
<style nonce="${nonce}">
:root {
  --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
  --line: var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, transparent));
  --muted: var(--vscode-descriptionForeground);
  --modified: var(--vscode-minv-modified, var(--vscode-editorWarning-foreground));
  --added: var(--vscode-minv-added, var(--vscode-terminal-ansiGreen));
  --deleted: var(--vscode-minv-deleted, var(--vscode-errorForeground));
  --untracked: var(--vscode-minv-untracked, var(--vscode-textLink-foreground));
  --conflict: var(--vscode-minv-conflict, var(--vscode-errorForeground));
  --pending: var(--vscode-minv-pending, var(--muted));
}
* { box-sizing: border-box; }
body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); height: 100vh; display: flex; flex-direction: column; }
button, input { font: inherit; color: inherit; }
button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; padding: 3px 8px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: .5; cursor: default; }
:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.sr-only { position: absolute; height: 1px; width: 1px; overflow: hidden; clip-path: inset(50%); }

/* Find (refresh is the native view-title action) */
.toolbar { display: flex; gap: 4px; padding: 8px 8px 6px; align-items: center; }
.find { position: relative; flex: 1; min-width: 0; }
.find svg { position: absolute; left: 8px; top: 50%; translate: 0 -50%; color: var(--muted); pointer-events: none; }
input { width: 100%; height: 26px; padding: 0 8px 0 27px; border: 1px solid var(--vscode-input-border, transparent); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border-radius: 4px; }
input::placeholder { color: var(--vscode-input-placeholderForeground); }
input::-webkit-search-cancel-button { display: none; }
.catalog-heading { display: flex; justify-content: space-between; align-items: baseline; padding: 2px 12px 6px; font-size: 11px; color: var(--muted); }

/* Catalog */
#repositories { overflow: auto; min-height: 96px; flex: 1 1 44%; position: relative; border-block: 1px solid var(--line); }
#rows { position: relative; }
.repository { height: var(--row-height); position: absolute; left: 0; right: 0; display: flex; gap: 8px; padding: 6px 12px 0 calc(12px + min(var(--depth, 0), 6) * 12px); cursor: pointer; overflow: hidden; }
.repository:hover { background: var(--vscode-list-hoverBackground); }
.repository[aria-selected="true"] { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground); }
#repositories:focus .repository[aria-selected="true"] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
#repositories[aria-activedescendant]:focus-visible { outline: none; }
#repositories:focus .repository.active { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.row-body { flex: 1; min-width: 0; }
.row-line { display: flex; align-items: baseline; gap: 8px; }
.name { flex: 1; min-width: 0; font-weight: 600; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }
.summary { flex-shrink: 0; font-size: 11px; font-variant-numeric: tabular-nums; }
.summary.quiet, .freshness, .path { color: var(--muted); }
.branch { flex: 1; min-width: 0; font-family: var(--mono); font-size: 11px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }
.freshness { flex-shrink: 0; font-size: 11px; }
.path { display: block; font-family: var(--mono); font-size: 10.5px; line-height: 14px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; direction: rtl; text-align: left; }
#empty { padding: 14px 12px; color: var(--muted); }

/* State glyphs: shape carries meaning, color reinforces it. */
.glyph { flex-shrink: 0; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; border: 1.5px solid var(--muted); }
[data-state="dirty"] .glyph { border-color: var(--modified); background: var(--modified); }
[data-state="dirty unverified"] .glyph { border-color: var(--modified); background: linear-gradient(90deg, var(--modified) 50%, transparent 50%); }
[data-state="pending"] .glyph { border: none; height: 1.5px; margin-top: 8.5px; border-radius: 1px; background: var(--pending); }
[data-state="error"] .glyph { border: none; border-radius: 1px; width: 7px; height: 7px; margin: 5.5px .5px 0; rotate: 45deg; background: var(--deleted); }
[data-state="offline"] .glyph { border-radius: 1px; border-style: dashed; }

/* Selected repository */
#detail { flex: 1 1 56%; overflow: auto; min-height: 160px; }
.detail-header { position: sticky; top: 0; z-index: 1; background: var(--vscode-sideBar-background); padding: 10px 12px 8px; border-bottom: 1px solid var(--line); }
.title-line { display: flex; align-items: center; gap: 8px; }
#detail-title { margin: 0; font-size: 13px; font-weight: 600; min-width: 0; flex: 1; overflow-wrap: anywhere; }
#commit { color: var(--vscode-button-foreground); background: var(--vscode-button-background); flex-shrink: 0; font-weight: 600; }
#commit:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
#commit:disabled { color: var(--vscode-disabledForeground, var(--muted)); background: transparent; border-color: var(--line); font-weight: normal; opacity: 1; }
.facts { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 6px 0 0; font-size: 11px; line-height: 16px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
#detail-branch, #detail-scope { font-family: var(--mono); }
#detail-scope { word-break: break-all; }
.vacant .facts { display: none; }
#notice { margin: 10px 12px 0; overflow-wrap: anywhere; color: var(--muted); line-height: 1.45; }
#notice:empty { display: none; }
h3 { display: flex; justify-content: space-between; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin: 14px 12px 4px; }
h3 span:last-child { font-variant-numeric: tabular-nums; letter-spacing: 0; }
.change { display: flex; gap: 2px; align-items: center; padding: 0 8px 0 6px; }
.open-change { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; text-align: left; background: transparent; padding: 3px 6px; border-radius: 4px; color: var(--vscode-foreground); }
.open-change:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
.code { flex-shrink: 0; width: 1ch; font-family: var(--mono); font-weight: 600; font-size: 11px; text-align: center; color: var(--modified); }
[data-kind="added"] .code { color: var(--added); }
[data-kind="deleted"] .code { color: var(--deleted); }
[data-kind="deleted"] .file { text-decoration: line-through; text-decoration-color: var(--muted); }
[data-kind="untracked"] .code { color: var(--untracked); }
[data-kind="conflict"] .code { color: var(--conflict); }
.file { flex-shrink: 0; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.directory { min-width: 0; flex: 1; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.change-action { font-size: 11px; padding: 1px 6px; background: transparent; color: var(--muted); border-color: transparent; }
.change:hover .change-action:not(:disabled), .change:focus-within .change-action:not(:disabled) { color: var(--vscode-foreground); border-color: var(--line); }
.change-action:hover:not(:disabled) { background: var(--vscode-button-secondaryBackground); }

@media (max-width: 260px) { .freshness { display: none; } .summary { max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .directory { display: none; } }
body.vscode-high-contrast .repository[aria-selected="true"], body.vscode-high-contrast-light .repository[aria-selected="true"] { outline: 1px solid var(--vscode-contrastActiveBorder, var(--vscode-focusBorder)); outline-offset: -1px; }
body.vscode-high-contrast .change-action, body.vscode-high-contrast-light .change-action { color: var(--vscode-foreground); border-color: var(--vscode-contrastBorder); }
@media (forced-colors: active) {
  .repository[aria-selected="true"] { outline: 1px solid Highlight; outline-offset: -1px; }
  button, input { border: 1px solid ButtonText; }
  .glyph { forced-color-adjust: none; border-color: CanvasText; }
  [data-state="dirty"] .glyph, [data-state="pending"] .glyph, [data-state="error"] .glyph { background: CanvasText; }
  [data-state="dirty unverified"] .glyph { background: linear-gradient(90deg, CanvasText 50%, transparent 50%); }
}
</style></head><body>
<div class="toolbar">
<div class="find"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3" stroke-linecap="round"/></svg><label class="sr-only" for="search">Find repository by name or path</label><input id="search" type="search" placeholder="Find repository or path" autocomplete="off" spellcheck="false"></div>
</div>
<div class="catalog-heading"><span id="count">0 repositories</span></div>
<div id="repositories" role="listbox" aria-label="Repositories" tabindex="0"><div id="rows"></div><div id="empty">Waiting for repository catalog</div></div>
<section id="detail" class="vacant" aria-label="Selected repository changes">
<div class="detail-header"><div class="title-line"><h2 id="detail-title">Select a repository</h2><button id="commit" disabled>Commit…</button></div>
<dl class="facts"><dt>Branch</dt><dd id="detail-branch"></dd><dt>Path</dt><dd id="detail-scope"></dd><dt>State</dt><dd id="detail-state"></dd></dl></div>
<p id="notice"></p><h3 id="staged-heading" hidden><span>Staged</span><span></span></h3><div id="staged-list" role="group" aria-labelledby="staged-heading"></div><h3 id="working-heading" hidden><span>Working tree</span><span></span></h3><div id="working-list" role="group" aria-labelledby="working-heading"></div></section>
<div id="announcement" class="sr-only" aria-live="polite" aria-atomic="true"></div>
<script nonce="${nonce}">(${webviewMain.toString()})();</script></body></html>`;
}
