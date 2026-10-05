import type { App } from '../app.js';
import type { Freshness, RepositoryRow } from '../contract.js';
import { attr, h, kbd, mod, text } from '../dom.js';
import { branchText, changeCount, freshnessWord, plural, shortOid } from '../format.js';
import { childrenOf, depthOf, visibleRows, type State } from '../state.js';
import { chevron, close, mark, maximize, minimize, search } from './icons.js';

export function glyphState(row: RepositoryRow): Freshness | 'offline' {
  if (!row.available) return 'offline';
  return row.branch.state;
}

/** Workspace-wide honesty: counts only what has been established. */
export function ledger(state: State) {
  let verified = 0, checking = 0, unverified = 0, failed = 0, statusKnown = 0, withChanges = 0, offline = 0;
  for (const row of state.rows.values()) {
    if (!row.available) { offline++; continue; }
    if (row.branch.state === 'observed') verified++;
    else if (row.branch.state === 'refreshing' || row.branch.state === 'unknown') checking++;
    else if (row.branch.state === 'error') failed++;
    else unverified++;
    if (row.status.state === 'observed') { statusKnown++; if (changeCount(row.status.value)) withChanges++; }
  }
  return { total: state.rows.size, verified, checking, unverified, failed, statusKnown, withChanges, offline };
}

export function createMasthead(app: App): { element: HTMLElement; render(state: State): void } {
  const name = h('span', { class: 'workspace-name' });
  const root = h('span', { class: 'workspace-root' });
  const fixture = h('span', { class: 'fixture-label', hidden: true, title: 'No desktop host is attached. Data comes from the bundled preview fixture.' });
  const ledgerEl = h('div', { class: 'ledger', role: 'status', 'aria-live': 'off' });
  const goto = h('button', { class: 'goto', onclick: () => openPalette(app), 'aria-label': 'Go to a repository, file or command' }, search(), h('span', { class: 'q' }, 'Go to anything'), kbd(mod, 'K'));
  const controls = h('div', { class: 'window-controls' },
    h('button', { 'aria-label': 'Minimize', onclick: () => void app.call('window.minimize', undefined, true) }, minimize()),
    h('button', { 'aria-label': 'Maximize', onclick: () => void app.call('window.toggleMaximize', undefined, true) }, maximize()),
    h('button', { class: 'close', 'aria-label': 'Close window', onclick: () => void app.call('window.close', undefined, true) }, close()));
  const brandMark = mark(); brandMark.classList.add('mark');
  const element = h('header', { class: 'masthead', ondblclick: (e: MouseEvent) => { if (e.target === element) void app.call('window.toggleMaximize', undefined, true); } },
    h('div', { class: 'brand', title: 'Minv · Browse. Review. Commit.' }, brandMark, h('span', { class: 'wordmark' }, 'minv'), h('span', { class: 'sep' }), name, root, fixture),
    goto, h('div', { class: 'bar-right' }, ledgerEl, controls));
  return {
    element,
    render(state) {
      const w = state.workspace;
      text(name, w?.name ?? 'Browse. Review. Commit.');
      text(root, w ? w.roots.join(' · ').replace(/^\/home\/[^/]+/, '~') : '');
      attr(fixture, 'hidden', !w?.fixture); text(fixture, w?.fixture ?? '');
      if (!w) { ledgerEl.replaceChildren(); return; }
      const l = ledger(state);
      const parts: [string, string | number, string, Freshness | 'offline' | ''][] = [];
      parts.push(['', `${l.verified}/${l.total - l.offline}`, 'verified', l.checking ? 'refreshing' : l.unverified ? 'cached' : 'observed']);
      if (l.failed + l.offline) parts.push(['opt', l.failed + l.offline, 'offline', 'error']);
      parts.push(['opt', l.statusKnown ? l.withChanges : '—', 'changed', '']);
      ledgerEl.replaceChildren(...parts.map(([cls, n, label, f]) => h('span', { class: `item ${cls}` }, f ? h('span', { class: 'glyph', 'data-f': f, 'aria-hidden': 'true' }) : null, h('b', null, String(n)), label)));
      if (!w.trusted) ledgerEl.append(h('span', { class: 'item' }, h('b', null, 'Restricted')));
    },
  };
}

export function openPalette(app: App, initial = ''): void {
  const state = app.state;
  const commands = paletteCommands(app);
  app.pick({
    placeholder: 'Repositories, files and commands',
    context: state.workspace ? `Type > for commands · searching ${state.selectedId ? `files in ${state.rows.get(state.selectedId)?.name}` : 'the workspace'}` : undefined,
    items: async (query) => {
      if (query.startsWith('>') || initial === '>' && !query) {
        const q = query.replace(/^>\s*/, '').toLowerCase();
        return commands.filter(c => !q || c.primary.toLowerCase().includes(q)).map(c => ({ ...c, group: 'Commands' }));
      }
      const q = query.trim().toLowerCase();
      const repos = state.order.map(id => state.rows.get(id)!).filter(r => !q || r.name.toLowerCase().includes(q) || r.relativePath.toLowerCase().includes(q)).slice(0, q ? 8 : 6)
        .map(r => ({ id: r.id, primary: r.name, secondary: `${r.relativePath || '.'} · ${branchText(r.branch) ?? '—'}`, hint: freshnessWord[r.branch.state], group: 'Repositories', run: () => { app.select(r.id); app.focusPlane('folio'); } }));
      const files = q && state.selectedId ? await app.findPaths(q, [state.selectedId]) : { matches: [], complete: true };
      const fileItems = files.matches.slice(0, 12).map(m => ({ id: `${m.repositoryId}:${m.path}`, primary: m.path.split('/').at(-1)!, secondary: m.path, hint: state.rows.get(m.repositoryId)?.name ?? '', group: `Files${files.complete ? '' : ' · partial results'}`, run: () => void app.openFile(m.repositoryId, m.path) }));
      const cmd = q ? commands.filter(c => c.primary.toLowerCase().includes(q)).slice(0, 5).map(c => ({ ...c, group: 'Commands' })) : [];
      return [...repos, ...fileItems, ...cmd];
    },
  });
  if (initial) { const input = document.querySelector<HTMLInputElement>('.palette input'); if (input) { input.value = initial; input.dispatchEvent(new Event('input')); } }
}

function paletteCommands(app: App) {
  const c = (id: string, primary: string, run: () => void, hint = '') => ({ id, primary, hint, run });
  const ws = !!app.state.workspace;
  return [
    c('open', 'Open folder…', () => void app.openWorkspace()),
    ...(ws ? [
      c('switch', 'Switch branch…', () => void app.branchPicker(), `${mod} ⇧ B`),
      c('refresh', 'Refresh selected repository', () => void app.refreshSelected(), `${mod} R`),
      c('refreshAll', 'Refresh all repositories', () => void app.refreshAll(), `${mod} ⇧ R`),
      c('fetch', 'Fetch selected repository', () => void app.remote('fetch')),
      c('pull', 'Pull (fast-forward only)', () => void app.remote('pull')),
      c('push', 'Push…', () => void app.remote('push')),
      c('stash', 'Stash changes…', () => { if (app.state.selectedId) void app.stash(app.state.selectedId); }),
      c('newFile', 'New file…', () => void app.createEntry('', 'file')),
      c('search', 'Search in workspace', () => { app.search.workspace = true; app.setTab('search'); app.focusPlane('folio'); }, `${mod} ⇧ F`),
      c('terminal', 'Open external terminal here', () => void app.terminal()),
      c('reveal', 'Reveal repository in file manager', () => void app.reveal()),
      c('backups', 'Restore a backup…', () => void app.restoreBackups()),
      c('focus', 'Toggle focus mode', () => app.store.update(s => { s.focus = !s.focus; }), `${mod} B`),
      c('split', 'Toggle split desk', () => app.toggleSplit(), `${mod} \\`),
      c('trust', app.state.workspace?.trusted ? 'Return to restricted mode' : 'Trust this workspace…', () => void app.setTrust(!app.state.workspace?.trusted)),
      c('close', 'Close workspace', () => void app.closeWorkspace()),
    ] : []),
    c('settings', 'Settings', () => app.openSettings(), `${mod} ,`),
    c('dark', 'Appearance: Dark', () => void app.setPrefs({ appearance: 'dark' })),
    c('light', 'Appearance: Light', () => void app.setPrefs({ appearance: 'light' })),
    c('darkHc', 'Appearance: Dark, high contrast', () => void app.setPrefs({ appearance: 'dark-contrast' })),
    c('lightHc', 'Appearance: Light, high contrast', () => void app.setPrefs({ appearance: 'light-contrast' })),
    c('system', 'Appearance: follow system', () => void app.setPrefs({ appearance: 'system' })),
    c('diagnostics', 'Show diagnostics', () => void app.call('diagnostics.open', undefined)),
  ];
}

// ── The index ────────────────────────────────────────────────────────────────

export function createIndex(app: App): { element: HTMLElement; render(state: State): void; focus(): void; focusFind(): void } {
  const find = h('input', { class: 'field', type: 'search', placeholder: 'Find repository', 'aria-label': 'Find repository by name, path or branch', spellcheck: 'false' });
  const tree = h('button', { class: 'button quiet toggle', 'aria-pressed': 'true', onclick: () => app.store.update(s => { s.layout = 'tree'; }) }, 'Tree');
  const flat = h('button', { class: 'button quiet toggle', 'aria-pressed': 'false', onclick: () => app.store.update(s => { s.layout = 'flat'; }) }, 'Flat');
  const count = h('span');
  const spacer = h('div', { class: 'spacer' });
  const list = h('div', { class: 'list', role: 'tree', tabindex: '0', 'aria-label': 'Repositories', 'aria-multiselectable': 'false' }, spacer);
  const foot = h('div', { class: 'index-foot', role: 'status' });
  const note = h('div', { class: 'empty-note', hidden: true });
  const element = h('nav', { class: 'index', 'aria-label': 'Repository index' },
    h('div', { class: 'index-head' }, h('div', { class: 'find' }, find, kbd('/')), h('div', { class: 'index-meta' }, count, h('div', { class: 'seg', role: 'group', 'aria-label': 'Layout' }, tree, flat))),
    list, note, foot);

  let rows: string[] = [];
  let active: string | undefined;
  const rendered = new Map<string, HTMLElement>();
  const rowHeight = () => app.state.prefs.density === 'comfortable' ? 34 : 30;
  let lastState: State | undefined;

  find.addEventListener('input', () => app.store.update(s => { s.filter = find.value; }));
  find.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') { const first = rows[0]; if (first) { app.select(first); active = first; } list.focus(); e.preventDefault(); }
    if (e.key === 'Escape') { if (find.value) { find.value = ''; app.store.update(s => { s.filter = ''; }); } else list.focus(); e.stopPropagation(); }
  });
  let restoredScroll = false;
  list.addEventListener('scroll', () => { app.indexScrollTop = list.scrollTop; if (lastState) paint(lastState); }, { passive: true });
  list.addEventListener('focus', () => { active ??= app.state.selectedId; if (lastState) paint(lastState); });
  list.addEventListener('keydown', e => {
    const i = Math.max(0, rows.indexOf(active ?? app.state.selectedId ?? ''));
    const move = (to: number) => { const id = rows[Math.max(0, Math.min(rows.length - 1, to))]; if (id) { active = id; app.select(id); reveal(id); } };
    const id = rows[i];
    const kids = id ? (childrenOf(app.state).get(id)?.length ?? 0) : 0;
    switch (e.key) {
      case 'ArrowDown': move(i + 1); break;
      case 'ArrowUp': move(i - 1); break;
      case 'PageDown': move(i + Math.floor(list.clientHeight / rowHeight())); break;
      case 'PageUp': move(i - Math.floor(list.clientHeight / rowHeight())); break;
      case 'Home': move(0); break;
      case 'End': move(rows.length - 1); break;
      case 'ArrowRight':
        if (id && kids && app.state.collapsed.has(id) && !app.state.filter) app.store.update(s => { s.collapsed.delete(id); });
        else app.focusPlane('folio');
        break;
      case 'ArrowLeft': {
        if (id && kids && !app.state.collapsed.has(id) && !app.state.filter && app.state.layout === 'tree') app.store.update(s => { s.collapsed.add(id); });
        else { const parent = id ? app.state.rows.get(id)?.parentId : undefined; if (parent && rows.includes(parent)) move(rows.indexOf(parent)); }
        break;
      }
      case 'Enter': app.focusPlane('folio'); break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== '/' && e.key !== ' ') { find.focus(); find.value += e.key; app.store.update(s => { s.filter = find.value; }); }
        return;
    }
    e.preventDefault();
  });

  const reveal = (id: string) => {
    const top = rows.indexOf(id) * rowHeight();
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + rowHeight() > list.scrollTop + list.clientHeight) list.scrollTop = top + rowHeight() - list.clientHeight;
  };

  const createRow = (id: string) => {
    const el = h('div', { class: 'row', role: 'treeitem', id: `repo-${cssId(id)}` },
      h('span', { class: 'glyph', 'aria-hidden': 'true' }), h('span', { class: 'name' }), h('span', { class: 'branch' }), h('span', { class: 'count' }));
    el.addEventListener('mousedown', e => {
      const twisty = (e.target as Element).closest('.twisty');
      if (twisty) { app.store.update(s => { if (s.collapsed.has(id)) s.collapsed.delete(id); else s.collapsed.add(id); }); e.preventDefault(); return; }
      active = id; app.select(id);
    });
    el.addEventListener('dblclick', () => app.focusPlane('folio'));
    return el;
  };

  const updateRow = (el: HTMLElement, row: RepositoryRow, state: State, index: number, hasKids: boolean) => {
    const depth = state.filter || state.layout === 'flat' ? 0 : depthOf(state, row.id);
    el.style.transform = `translateY(${index * rowHeight()}px)`;
    el.style.setProperty('--depth', String(depth));
    attr(el, 'aria-selected', String(state.selectedId === row.id));
    attr(el, 'aria-level', String(depth + 1));
    attr(el, 'aria-posinset', String(index + 1)); attr(el, 'aria-setsize', String(rows.length));
    attr(el, 'aria-expanded', hasKids && !state.filter && state.layout === 'tree' ? String(!state.collapsed.has(row.id)) : null);
    attr(el, 'data-available', String(row.available));
    el.classList.toggle('active', active === row.id);
    el.classList.toggle('pinned', state.pins.includes(row.id));
    const [glyph, name, branch, count] = Array.from(el.children).filter(c => !c.classList.contains('twisty')) as HTMLElement[];
    let twisty = el.querySelector('.twisty');
    if (hasKids && !state.filter && state.layout === 'tree') { if (!twisty) { twisty = h('span', { class: 'twisty', 'aria-hidden': 'true' }, chevron()); el.prepend(twisty); } }
    else twisty?.remove();
    const g = glyphState(row);
    attr(glyph!, 'data-f', g);
    const showPath = (state.filter || state.layout === 'flat') && row.relativePath.includes('/');
    const nameText = row.name;
    if (name!.dataset.v !== `${nameText}|${showPath}`) {
      name!.dataset.v = `${nameText}|${showPath}`;
      name!.replaceChildren(showPath ? h('span', { class: 'path' }, row.relativePath.slice(0, row.relativePath.length - row.name.length)) : '', nameText);
    }
    // Branch cell: italic = not verified this session. Never blank for a known value.
    const b = branchText(row.branch);
    const op = row.branch.value?.operation;
    const branchLabel = !row.available ? 'not checked out' : b ?? (row.branch.state === 'error' ? 'unreadable' : '—');
    if (branch!.dataset.v !== `${branchLabel}|${op}|${row.branch.state}`) {
      branch!.dataset.v = `${branchLabel}|${op}|${row.branch.state}`;
      branch!.replaceChildren(branchLabel, op ? h('span', { class: 'op' }, op) : '');
      branch!.className = `branch${row.branch.state === 'cached' || row.branch.state === 'stale' || !row.available || !b ? ' unverified' : ''}`;
    }
    branch!.title = row.branch.value?.kind === 'detached' ? `Detached at ${row.branch.value.oid}` : b ?? '';
    // Change cell: zero only once zero is established.
    const s = row.status;
    const n = changeCount(s.value);
    let label = '—', cls = 'count none';
    if (!row.available) { label = ''; }
    else if (s.state === 'error') { label = '!'; cls = 'count error'; }
    else if (s.value && (s.state === 'observed' || s.state === 'refreshing' || s.state === 'stale' || s.state === 'cached')) {
      label = n ? `${n}${s.value.complete ? '' : '+'}` : 'clean';
      cls = `count${n ? '' : ' clean'}${s.state === 'observed' ? '' : ' unverified'}`;
    } else if (s.state === 'refreshing') label = '…';
    text(count!, label); count!.className = cls;
    el.setAttribute('aria-label', [row.name, row.relativePath && row.relativePath !== row.name ? `in ${row.relativePath}` : '',
      !row.available ? `unavailable: ${row.error ?? ''}` : `branch ${b ?? 'unknown'}, ${freshnessWord[row.branch.state].toLowerCase()}`,
      op ? `${op} in progress` : '', s.state === 'observed' ? (n ? plural(n, 'changed file') : 'no changes') : s.state === 'error' ? 'changes could not be read' : 'changes not verified',
      row.monitoring === 'degraded' ? 'monitoring degraded' : ''].filter(Boolean).join(', '));
  };

  const paint = (state: State) => {
    const rh = rowHeight();
    const first = Math.max(0, Math.floor(list.scrollTop / rh) - 8);
    const last = Math.min(rows.length, Math.ceil((list.scrollTop + list.clientHeight) / rh) + 8);
    const kids = childrenOf(state);
    const keep = new Set<string>();
    for (let i = first; i < last; i++) {
      const id = rows[i]!; keep.add(id);
      let el = rendered.get(id);
      if (!el) { el = createRow(id); rendered.set(id, el); list.append(el); }
      updateRow(el, state.rows.get(id)!, state, i, (kids.get(id)?.length ?? 0) > 0);
    }
    for (const [id, el] of rendered) if (!keep.has(id)) { el.remove(); rendered.delete(id); }
    const a = active && document.activeElement === list ? rendered.get(active) : undefined;
    attr(list, 'aria-activedescendant', a?.id ?? null);
  };

  return {
    element,
    focus: () => list.focus(),
    focusFind: () => { find.focus(); find.select(); },
    render(state) {
      lastState = state;
      const next = visibleRows(state);
      const changed = next.length !== rows.length || next.some((id, i) => rows[i] !== id);
      rows = next;
      if (changed) spacer.style.height = `${rows.length * rowHeight() + 8}px`;
      if (!restoredScroll && app.indexScrollTop && rows.length) { restoredScroll = true; list.scrollTop = app.indexScrollTop; }
      if (find.value !== state.filter && document.activeElement !== find) find.value = state.filter;
      attr(tree, 'aria-pressed', String(state.layout === 'tree')); attr(flat, 'aria-pressed', String(state.layout === 'flat'));
      const w = state.workspace;
      text(count, state.filter ? `${rows.length} of ${plural(state.rows.size, 'repository', 'repositories')}` : plural(state.rows.size, 'repository', 'repositories'));
      const discovering = w && w.discovery !== 'complete';
      attr(note, 'hidden', rows.length > 0 || !w);
      text(note, state.filter ? `No repository matches “${state.filter}”.${discovering ? ' Discovery is still running; more repositories may appear.' : ''}` : 'No repositories found in this workspace yet.');
      foot.replaceChildren(
        h('span', { class: 'glyph', 'data-f': !w ? 'unknown' : w.discovery === 'complete' ? 'observed' : w.discovery === 'error' ? 'error' : w.discovery === 'cached' ? 'cached' : 'refreshing', 'aria-hidden': 'true' }),
        h('span', { class: 'grow' }, !w ? '' : w.discovery === 'complete' ? 'Discovery complete' : w.discovery === 'cached' ? 'Showing the saved catalog' : w.discovery === 'error' ? (w.discoveryError ?? 'Discovery failed') : `Discovering · ${plural(state.rows.size, 'checkout')} so far`),
        h('button', { class: 'button quiet', title: `Refresh all (${mod} ⇧ R)`, onclick: () => void app.refreshAll() }, 'Refresh all'));
      paint(state);
      if (state.selectedId && changed && state.selectedId !== active) { /* keep the anchor where it is: never scroll on background updates */ }
    },
  };
}

function cssId(id: string): string { return id.replace(/[^\w-]/g, '_'); }
export { shortOid };
