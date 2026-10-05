import type { App } from '../app.js';
import type { DirectoryEntry, RepositoryRow } from '../contract.js';
import { attr, h, kbd, mod, syncList, text } from '../dom.js';
import { branchSentence, branchText, changeCount, groupChanges, plural, pointerSentence, relativeTime, shortOid, splitPath, statusSentence, type ChangeEntry } from '../format.js';
import { selectedRow, type FolioTab, type State } from '../state.js';
import { chevron } from './icons.js';

const tabs: { id: FolioTab; label: string }[] = [{ id: 'changes', label: 'Changes' }, { id: 'files', label: 'Files' }, { id: 'history', label: 'History' }, { id: 'search', label: 'Search' }];

export function createFolio(app: App): { element: HTMLElement; render(state: State): void; focus(): void } {
  const head = h('div', { class: 'folio-head' });
  const tabBar = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Repository views' });
  const tabButtons = tabs.map((t, i) => {
    const b = h('button', { class: 'tab', role: 'tab', id: `tab-${t.id}`, 'aria-controls': 'folio-body', title: `${t.label} (Alt ${i + 1})`, onclick: () => app.setTab(t.id) }, t.label, h('span', { class: 'n' }));
    tabBar.append(b);
    return b;
  });
  tabBar.addEventListener('keydown', e => {
    const i = tabs.findIndex(t => t.id === app.state.tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]!; app.setTab(next.id); tabButtons[tabs.indexOf(next)]?.focus(); e.preventDefault(); }
  });
  const body = h('div', { class: 'folio-body', id: 'folio-body', role: 'tabpanel' });
  const slip = h('div', { class: 'slip', hidden: true });
  const element = h('section', { class: 'folio', 'aria-label': 'Selected repository' }, head, tabBar, body, slip);

  const changes = createChanges(app);
  const files = createFiles(app);
  const history = createHistory(app);
  const search = createSearch(app);
  const commit = createSlip(app, slip);
  let shownTab: FolioTab | undefined;
  let shownRepo: string | undefined;

  return {
    element,
    focus: () => { (body.querySelector<HTMLElement>('[tabindex="0"], button, input') ?? tabButtons[0])?.focus(); },
    render(state) {
      const row = selectedRow(state);
      renderHead(app, head, row, state);
      tabButtons.forEach((b, i) => {
        const t = tabs[i]!;
        attr(b, 'aria-selected', String(state.tab === t.id)); attr(b, 'tabindex', state.tab === t.id ? '0' : '-1');
        const n = t.id === 'changes' && row?.status.value ? changeCount(row.status.value) : undefined;
        text(b.querySelector('.n')!, n ? String(n) : '');
      });
      attr(body, 'aria-labelledby', `tab-${state.tab}`);
      const view = state.tab === 'changes' ? changes : state.tab === 'files' ? files : state.tab === 'history' ? history : search;
      if (shownTab !== state.tab || shownRepo !== row?.id) { body.replaceChildren(view.element); body.scrollTop = 0; shownTab = state.tab; shownRepo = row?.id; }
      view.render(state, row);
      attr(slip, 'hidden', state.tab !== 'changes' || !row);
      if (row && state.tab === 'changes') commit.render(state, row);
    },
  };
}

function renderHead(app: App, head: HTMLElement, row: RepositoryRow | undefined, state: State): void {
  const key = row ? JSON.stringify([state.pins.includes(row.id), row.id, row.name, row.branch, row.upstream, row.status.state, row.status.observedAt, row.available, row.monitoring, state.workspace?.trusted, Math.floor(Date.now() / 10000), app.network.get(row.id)]) : 'none';
  if (head.dataset.key === key) return;
  head.dataset.key = key;
  if (!row) { head.replaceChildren(h('h1', { class: 'title' }, 'No repository'), h('p', { class: 'facts' }, 'Choose a repository in the index.')); return; }
  const crumbs: (HTMLElement | string)[] = [];
  let parent = row.parentId ? state.rows.get(row.parentId) : undefined;
  const chain: RepositoryRow[] = [];
  while (parent && chain.length < 8) { chain.unshift(parent); parent = parent.parentId ? state.rows.get(parent.parentId) : undefined; }
  for (const p of chain) crumbs.push(h('button', { onclick: () => app.select(p.id), title: `Select ${p.name}` }, p.name), '/');
  crumbs.push(h('span', null, row.relativePath ? row.relativePath.slice(chain.at(-1)?.relativePath ? chain.at(-1)!.relativePath.length + 1 : 0) : row.root.replace(/^\/home\/[^/]+/, '~')));

  const b = row.branch;
  const name = branchText(b);
  const unverified = b.state !== 'observed';
  const writable = !app.writable(row);
  const branchButton = h('button', { class: 'branch-name', disabled: !row.available, title: writable ? `Switch branch (${mod} ⇧ B)` : 'Branches', onclick: () => void app.branchPicker() },
    h('span', { class: unverified ? 'unverified' : '' }, name ?? (b.state === 'error' ? 'unreadable' : 'checking…')), h('span', { class: 'chev', 'aria-hidden': 'true' }, '⌄'));
  const up = row.upstream?.value;
  const upstream = up ? h('span', { class: `upstream ${row.upstream!.state === 'observed' ? '' : 'unverified'}`, title: up.lastFetchAt ? `Last fetched ${relativeTime(up.lastFetchAt)}` : 'Not fetched in this session; counts use local refs only' },
    up.ahead || up.behind ? [h('b', null, `↑${up.ahead}`), ' ', h('b', null, `↓${up.behind}`), ' '] : 'in sync with ', up.name) : null;

  const glyph = (f: string) => h('span', { class: 'glyph', 'data-f': f, 'aria-hidden': 'true' });
  const facts = h('div', { class: 'facts' },
    h('div', { class: 'fact' }, glyph(!row.available ? 'offline' : b.state), branchSentence(row)),
    row.available ? h('div', { class: 'fact' }, glyph(row.status.state), statusSentence(row)) : null);

  const notes: HTMLElement[] = [];
  const op = b.value?.operation;
  if (op) notes.push(h('div', { class: 'note conflict' }, h('b', null, `${op[0]!.toUpperCase()}${op.slice(1)} in progress.`), 'Resolve conflicts and stage them here; continue or abort the sequence in your terminal.', h('br'), h('button', { class: 'button', onclick: () => void app.terminal() }, 'Open terminal')));
  if (!row.available) notes.push(h('div', { class: 'note error' }, h('b', null, 'Unavailable.'), row.error ?? 'This checkout cannot be read.', ' Minv never initializes, clones or repairs checkouts on its own.'));
  if (row.monitoring === 'degraded') notes.push(h('div', { class: 'note warn' }, h('b', null, 'Watching paused.'), row.monitoringError ?? 'Changes may not appear automatically.', h('br'), h('button', { class: 'button', onclick: () => void app.refreshSelected() }, 'Check now')));
  if (state.workspace && !state.workspace.trusted) notes.push(h('div', { class: 'note' }, h('b', null, 'Restricted mode.'), 'You can read branches, changes and diffs. Staging, commits and branch changes need trust.', h('br'), h('button', { class: 'button', onclick: () => void app.setTrust(true) }, 'Trust workspace…')));
  const net = app.network.get(row.id);
  if (net) notes.push(h('div', { class: 'note', role: 'status' }, h('b', null, `${net.kind === 'fetch' ? 'Fetching' : net.kind === 'pull' ? 'Pulling' : 'Pushing'} ${net.remote}.`), `Started ${relativeTime(net.since)}.`, h('br'), h('button', { class: 'button', onclick: () => void app.cancelNetwork(row.id) }, 'Stop')));

  const actions = h('div', { class: 'repo-actions' },
    h('button', { class: 'button', disabled: !writable || !!net, onclick: () => void app.remote('fetch') }, 'Fetch'),
    h('button', { class: 'button', disabled: !writable || !!net, onclick: () => void app.remote('pull') }, 'Pull'),
    h('button', { class: 'button', disabled: !writable || !!net, onclick: () => void app.remote('push') }, 'Push'),
    h('button', { class: 'button', disabled: !row.available, onclick: () => void app.terminal() }, 'Terminal'),
    h('button', { class: 'button', 'aria-label': 'More repository actions', onclick: (e: Event) => app.menu(e.currentTarget as HTMLElement, [
      { label: state.pins.includes(row.id) ? 'Unpin from top' : 'Pin to top', run: () => app.togglePin(row.id) },
      { label: 'Refresh', hint: `${mod} R`, run: () => void app.refreshSelected() },
      { label: 'Stash changes…', run: () => void app.stash(row.id) },
      { label: 'Reveal in file manager', run: () => void app.reveal() },
      { label: 'Copy path', run: () => void navigator.clipboard?.writeText(row.root) },
      'sep',
      { label: 'Show diagnostics', run: () => void app.call('diagnostics.open', undefined) },
    ]) }, '⋯'));

  head.replaceChildren(h('div', { class: 'crumbs' }, ...crumbs), h('h1', { class: 'title' }, row.name),
    h('div', { class: 'branch-line' }, h('span', { class: 'on' }, b.value?.kind === 'detached' ? 'at' : 'on'), branchButton, upstream),
    facts, ...notes, actions);
}

// ── Changes ──────────────────────────────────────────────────────────────────

function createChanges(app: App) {
  const element = h('div', { class: 'changes' });
  const fileRow = (e: ChangeEntry, row: RepositoryRow, writable: boolean) => {
    const { dir, base } = splitPath(e.change.path);
    const staged = e.side === 'staged';
    const open = () => e.kind === 'conflict' ? void app.openFile(row.id, e.change.path) : void app.openReview(row.id, e.change.path, e.side);
    const primary = e.kind === 'conflict'
      ? h('button', { class: 'button quiet', disabled: !writable, title: 'Stage the resolved file', onclick: (ev: Event) => { ev.stopPropagation(); void app.stage(row.id, [e.change.path]); } }, 'Mark resolved')
      : h('button', { class: 'button quiet', disabled: !writable, onclick: (ev: Event) => { ev.stopPropagation(); void app.stage(row.id, [e.change.path], staged); } }, staged ? 'Unstage' : e.kind === 'submodule' ? 'Stage pointer' : 'Stage');
    const more = h('button', { class: 'button quiet', 'aria-label': `More actions for ${base}`, onclick: (ev: Event) => { ev.stopPropagation(); app.menu(ev.currentTarget as HTMLElement, [
      { label: 'Review changes', hint: 'Enter', run: open },
      { label: 'Open file', hint: 'E', run: () => void app.openFile(row.id, e.change.path) },
      ...(!staged && e.kind !== 'submodule' ? ['sep' as const, { label: 'Discard changes…', hint: 'Del', danger: true, run: () => void app.discard(row.id, [e.change.path]) }] : []),
    ]); } }, '⋯');
    const sub = e.kind === 'submodule' ? h('span', { class: 'sub' }, pointerSentence(e)) : e.change.originalPath ? h('span', { class: 'sub' }, `from ${e.change.originalPath}`) : null;
    const el = h('div', { class: `file${sub ? ' tall' : ''}`, tabindex: '0', role: 'listitem', 'data-kind': e.kind,
      'aria-label': `${base}, ${dir || 'repository root'}, ${e.kind}${staged ? ', staged' : ''}`,
      onclick: open,
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') open();
        else if (ev.key === ' ') { if (writable) void app.stage(row.id, [e.change.path], staged); }
        else if (ev.key === 'e') void app.openFile(row.id, e.change.path);
        else if (ev.key === 'Delete' && !staged && e.kind !== 'submodule') void app.discard(row.id, [e.change.path]);
        else if (ev.key === 'ArrowDown') (nextFocusable(el, 1))?.focus();
        else if (ev.key === 'ArrowUp') (nextFocusable(el, -1))?.focus();
        else return;
        ev.preventDefault();
      } },
      h('span', { class: 'letter', 'aria-hidden': 'true' }, e.letter), h('span', { class: 'base' }, base), h('span', { class: 'dir' }, h('bdi', null, dir)), h('span', { class: 'acts' }, primary, more), sub);
    return el;
  };
  return {
    element,
    render(state: State, row: RepositoryRow | undefined) {
      if (!row) { element.replaceChildren(); return; }
      const current = app.focusedSheet();
      const key = JSON.stringify([row.id, row.status.generation, row.status.state, state.workspace?.trusted, current?.path, current?.side]);
      if (element.dataset.key === key) return;
      element.dataset.key = key;
      const focusedKey = (document.activeElement as HTMLElement | null)?.closest('.file')?.getAttribute('aria-label');
      const s = row.status;
      if (!row.available) { element.replaceChildren(h('div', { class: 'empty-note' }, 'This checkout is not available, so it has no changes to show.')); return; }
      if (!s.value) {
        element.replaceChildren(h('div', { class: 'empty-note', role: 'status' }, s.state === 'error' ? `Changes could not be read: ${s.error}` : s.state === 'refreshing' ? 'Checking changes in this repository…' : 'Changes have not been checked yet.',
          s.state === 'error' ? h('div', null, h('button', { class: 'button', onclick: () => void app.refreshSelected() }, 'Try again')) : null));
        return;
      }
      const g = groupChanges(s.value);
      const writable = !app.writable(row) && s.state === 'observed';
      const section = (title: string, list: ChangeEntry[], action?: HTMLElement) => list.length ? [h('div', { class: 'section-head' }, title, h('span', { class: 'n' }, String(list.length)), h('span', { class: 'grow' }), action ?? null), h('div', { role: 'list', 'aria-label': title }, ...list.map(e => {
        const el = fileRow(e, row, writable);
        if (current?.repositoryId === row.id && current.path === e.change.path && (current.side === e.side || current.kind === 'file')) el.classList.add('current');
        return el;
      }))] : [];
      const all = (list: ChangeEntry[], unstage: boolean, label: string) => h('button', { class: 'button quiet', disabled: !writable, onclick: () => void app.stage(row.id, [...new Set(list.map(e => e.change.path))], unstage) }, label);
      const unstagedAll = [...g.unstaged, ...g.untracked];
      const nodes = [
        ...section('Conflicts', g.conflicts),
        ...section('Staged', g.staged, all(g.staged, true, 'Unstage all')),
        ...section('Changes', g.unstaged, all(g.unstaged, false, 'Stage all')),
        ...section('Untracked', g.untracked, all(g.untracked, false, 'Stage all')),
        ...section('Submodule pointers', g.pointers),
      ];
      if (!nodes.length) nodes.push(h('div', { class: 'empty-note', role: 'status' }, s.state === 'observed' ? `No changes. Working tree matches HEAD as of ${relativeTime(s.observedAt)}.` : 'No changes were found in the last check, which is not yet verified.'));
      if (s.state !== 'observed') nodes.unshift(h('div', { class: 'empty-note', role: 'status' }, s.state === 'refreshing' ? 'Rechecking. Actions resume once changes are verified.' : s.state === 'stale' ? 'This list may be out of date. Actions resume after the next check.' : `Last check failed: ${s.error ?? ''}`));
      if (!s.value.complete) nodes.push(h('div', { class: 'empty-note' }, 'Untracked files are still being listed; this view is partial.'));
      void unstagedAll;
      element.replaceChildren(...nodes);
      if (focusedKey) element.querySelector<HTMLElement>(`.file[aria-label="${CSS.escape(focusedKey)}"]`)?.focus();
    },
  };
}

function nextFocusable(from: HTMLElement, dir: 1 | -1): HTMLElement | undefined {
  const all = [...from.closest('.folio-body')!.querySelectorAll<HTMLElement>('.file, .tree-row, .commit, .hit')];
  return all[all.indexOf(from) + dir];
}

// ── Commit slip ──────────────────────────────────────────────────────────────

function createSlip(app: App, slip: HTMLElement) {
  const target = h('div', { class: 'slip-target' });
  const message = h('textarea', { class: 'field', rows: '3', placeholder: 'Message: what changed and why', 'aria-label': 'Commit message', spellcheck: 'true' });
  const meter = h('span', { class: 'meter', 'aria-hidden': 'true' });
  const why = h('span', { class: 'slip-why grow' });
  const commit = h('button', { class: 'button primary', onclick: () => void submit() }, 'Commit', h('span', { class: 'keys' }, h('kbd', null, mod), h('kbd', null, '⏎')));
  slip.append(target, message, h('div', { class: 'slip-foot' }, why, meter, commit));
  let repo: string | undefined;
  const submit = async () => { if (!repo || commit.disabled) return; commit.disabled = true; await app.commit(repo); };
  message.addEventListener('input', () => {
    if (repo) app.state.drafts.set(repo, message.value);
    grow(); meterText(); app.store.update(() => {});
  });
  message.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } });
  const grow = () => { message.style.height = 'auto'; message.style.height = `${Math.min(180, message.scrollHeight + 2)}px`; };
  const meterText = () => {
    const first = message.value.split('\n')[0] ?? '';
    text(meter, first.length ? `${first.length}/72` : '');
    meter.classList.toggle('over', first.length > 72);
  };
  return {
    render(state: State, row: RepositoryRow) {
      if (repo !== row.id) { repo = row.id; message.value = state.drafts.get(row.id) ?? ''; grow(); meterText(); }
      else if (!state.drafts.has(row.id) && message.value && document.activeElement !== message) { message.value = ''; grow(); meterText(); }
      const g = groupChanges(row.status.value);
      const branch = branchText(row.branch);
      target.replaceChildren('Commit to ', h('b', null, row.name), ' on ', h('code', { class: row.branch.state === 'observed' ? '' : 'unverified' }, branch ?? '—'));
      const staged = `${plural(g.staged.length, 'file')} staged${row.branch.value?.kind === 'detached' ? ' · detached HEAD' : ''}`;
      const blocked = app.writable(row)
        ?? (row.status.state !== 'observed' ? 'Waiting for changes to be verified' : undefined)
        ?? (!g.staged.length ? 'Stage changes to commit' : undefined);
      commit.disabled = !!blocked || !message.value.trim();
      text(why, blocked ?? staged);
      message.disabled = !!app.writable(row);
    },
  };
}

// ── Files ────────────────────────────────────────────────────────────────────

function createFiles(app: App) {
  const list = h('div', { role: 'tree', 'aria-label': 'Files' });
  const element = h('div', null,
    h('div', { class: 'toolbar' },
      h('button', { class: 'button quiet', onclick: () => void app.createEntry('', 'file') }, 'New file'),
      h('button', { class: 'button quiet', onclick: () => void app.createEntry('', 'folder') }, 'New folder'),
      h('button', { class: 'button quiet', onclick: () => void app.listDir('') }, 'Reload')),
    list);
  const statusOf = (row: RepositoryRow) => new Map((row.status.value?.changes ?? []).map(c => [c.path, groupChanges({ changes: [c], complete: true })]));
  return {
    element,
    render(state: State, row: RepositoryRow | undefined) {
      if (!row) return;
      if (!app.tree || app.tree.repositoryId !== row.id) { void app.listDir(''); return; }
      const tree = app.tree;
      const changes = statusOf(row);
      const rows: HTMLElement[] = [];
      const walk = (dir: string, depth: number) => {
        const listing = tree.listings.get(dir);
        if (!listing || listing === 'loading') { rows.push(h('div', { class: 'tree-row', style: `--depth:${depth}` }, h('span', { class: 'tw' }), h('span', { class: 'nm', style: 'color:var(--ink3)' }, 'Loading…'))); return; }
        if ('error' in listing) { rows.push(h('div', { class: 'tree-row', style: `--depth:${depth}` }, h('span', { class: 'tw' }), h('span', { class: 'nm', style: 'color:var(--deleted)' }, listing.error))); return; }
        for (const entry of listing.entries) {
          const path = dir ? `${dir}/${entry.name}` : entry.name;
          rows.push(entryRow(entry, path, depth, changes));
          if (entry.kind === 'directory' && tree.expanded.has(path)) walk(path, depth + 1);
        }
        if (!listing.complete) rows.push(h('div', { class: 'tree-row', style: `--depth:${depth}`, role: 'note' }, h('span', { class: 'tw' }), h('span', { class: 'nm', style: 'color:var(--modified)' }, listing.note ?? `Showing the first ${listing.entries.length} entries. This folder has more.`)));
        if (!listing.entries.length) rows.push(h('div', { class: 'tree-row', style: `--depth:${depth}` }, h('span', { class: 'tw' }), h('span', { class: 'nm', style: 'color:var(--ink3)' }, 'Empty folder')));
      };
      const entryRow = (entry: DirectoryEntry, path: string, depth: number, map: Map<string, ReturnType<typeof groupChanges>>) => {
        const isDir = entry.kind === 'directory';
        const g = map.get(path);
        const first = g && [...g.conflicts, ...g.unstaged, ...g.untracked, ...g.staged][0];
        const activate = () => {
          if (isDir) app.toggleDir(path);
          else if (entry.kind === 'submodule') { const child = [...app.state.rows.values()].find(r => r.parentId === row.id && r.relativePath.endsWith(path)); if (child) app.select(child.id); }
          else void app.openFile(row.id, path);
        };
        const el = h('div', { class: 'tree-row', role: 'treeitem', tabindex: '0', 'data-kind': entry.kind, 'aria-expanded': isDir ? String(tree.expanded.has(path)) : undefined, style: `--depth:${depth}`,
          onclick: activate,
          oncontextmenu: (e: MouseEvent) => { e.preventDefault(); menuFor(e); },
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter') activate();
            else if (e.key === 'ArrowRight' && isDir && !tree.expanded.has(path)) app.toggleDir(path);
            else if (e.key === 'ArrowLeft' && isDir && tree.expanded.has(path)) app.toggleDir(path);
            else if (e.key === 'F2' && entry.kind === 'file') void app.renameEntry(path);
            else if (e.key === 'Delete' && entry.kind === 'file') void app.deleteEntry(path);
            else if (e.key === 'ArrowDown') nextFocusable(el, 1)?.focus();
            else if (e.key === 'ArrowUp') nextFocusable(el, -1)?.focus();
            else return;
            e.preventDefault();
          } },
          h('span', { class: 'tw' }, isDir ? chevron() : ''), h('span', { class: 'nm' }, entry.name),
          first ? h('span', { class: 'letter', 'data-kind': first.kind, title: first.kind }, first.letter) : entry.size !== undefined && !isDir ? h('span', { class: 'sz' }, size(entry.size)) : null);
        if (first) el.dataset.kind = first.kind;
        const menuFor = (e: MouseEvent | { x: number; y: number }) => app.menu({ x: (e as MouseEvent).clientX ?? 0, y: (e as MouseEvent).clientY ?? 0 }, isDir ? [
          { label: 'New file here…', run: () => void app.createEntry(path, 'file') },
          { label: 'New folder here…', run: () => void app.createEntry(path, 'folder') },
          { label: 'Reveal in file manager', run: () => void app.reveal(path) },
          { label: 'Copy path', run: () => void navigator.clipboard?.writeText(path) },
        ] : [
          { label: 'Open', hint: 'Enter', run: activate },
          { label: 'Rename or move…', hint: 'F2', run: () => void app.renameEntry(path) },
          { label: 'Duplicate…', run: async () => { const t = await app.prompt({ title: `Duplicate ${entry.name}`, label: 'New path', value: path, confirm: 'Duplicate' }); if (t && t !== path) await app.transfer('copy', row.id, path, row.id, t); } },
          { label: 'Reveal in file manager', run: () => void app.reveal(path) },
          { label: 'Copy path', run: () => void navigator.clipboard?.writeText(path) },
          'sep',
          { label: 'Delete…', hint: 'Del', danger: true, run: () => void app.deleteEntry(path) },
        ]);
        return el;
      };
      walk('', 0);
      const focused = (document.activeElement as HTMLElement | null)?.closest('.tree-row')?.textContent;
      list.replaceChildren(...rows);
      if (focused) [...list.querySelectorAll<HTMLElement>('.tree-row')].find(r => r.textContent === focused)?.focus();
    },
  };
}

function size(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }

// ── History ──────────────────────────────────────────────────────────────────

function createHistory(app: App) {
  const element = h('div');
  return {
    element,
    render(state: State, row: RepositoryRow | undefined) {
      const hst = app.history;
      if (!row) return;
      if (!hst || hst.repositoryId !== row.id) { element.replaceChildren(h('div', { class: 'empty-note' }, 'Loading history…')); return; }
      const key = JSON.stringify([hst.entries.length, hst.loading, hst.error, hst.stashes.length, hst.current, state.workspace?.trusted]);
      if (element.dataset.key === key) return;
      element.dataset.key = key;
      const writable = !app.writable(row);
      const nodes: HTMLElement[] = [];
      if (hst.stashes.length) {
        nodes.push(h('div', { class: 'section-head' }, 'Stashes', h('span', { class: 'n' }, String(hst.stashes.length))));
        for (const st of hst.stashes) nodes.push(h('div', { class: 'commit' },
          h('div', { class: 'subject' }, st.subject),
          h('div', { class: 'meta' }, h('span', { class: 'oid' }, st.selector), relativeTime(Date.parse(st.date)), h('span', { style: 'flex:1' }),
            h('button', { class: 'button quiet', disabled: !writable, onclick: () => void app.applyStash(st) }, 'Apply'),
            h('button', { class: 'button quiet danger', disabled: !writable, onclick: () => void app.dropStash(st) }, 'Drop'))));
      }
      nodes.push(h('div', { class: 'section-head' }, 'Commits', h('span', { class: 'n' }, hst.entries.length ? `${hst.entries.length}${hst.nextOffset !== undefined ? '+' : ''}` : '')));
      if (hst.error) nodes.push(h('div', { class: 'empty-note' }, `History could not be read: ${hst.error}`));
      else if (!hst.entries.length && !hst.loading) nodes.push(h('div', { class: 'empty-note' }, row.branch.value?.kind === 'unborn' ? 'No commits yet on this branch.' : 'No commits found.'));
      for (const entry of hst.entries) {
        const el = h('div', { class: `commit${hst.current === entry.oid ? ' current' : ''}`, tabindex: '0', role: 'button', 'aria-label': `${entry.subject}, ${shortOid(entry.oid)} by ${entry.author}`,
          onclick: () => void app.openCommit(row.id, entry),
          onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void app.openCommit(row.id, entry); else if (e.key === 'ArrowDown') nextFocusable(el, 1)?.focus(); else if (e.key === 'ArrowUp') nextFocusable(el, -1)?.focus(); else return; e.preventDefault(); } },
          h('div', { class: 'subject' }, entry.subject), h('div', { class: 'meta' }, h('span', { class: 'oid' }, shortOid(entry.oid)), h('span', null, entry.author), h('span', null, relativeTime(Date.parse(entry.date)))));
        nodes.push(el);
      }
      if (hst.loading) nodes.push(h('div', { class: 'empty-note', role: 'status' }, 'Loading commits…'));
      else if (hst.nextOffset !== undefined) nodes.push(h('button', { class: 'button more', onclick: () => void app.loadHistory(true) }, 'Load 50 more'));
      const focusedLabel = (document.activeElement as HTMLElement | null)?.getAttribute('aria-label');
      element.replaceChildren(...nodes);
      if (focusedLabel) element.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focusedLabel)}"]`)?.focus();
    },
  };
}

// ── Search ───────────────────────────────────────────────────────────────────

function createSearch(app: App) {
  const input = h('input', { class: 'field', type: 'search', placeholder: 'Search text', 'aria-label': 'Search text', spellcheck: 'false' });
  const toggle = (label: string, title: string, key: 'regex' | 'caseSensitive' | 'includeIgnored') => {
    const b = h('button', { class: 'button quiet toggle', title, 'aria-pressed': 'false', onclick: () => { app.search[key] = !app.search[key]; void app.runSearch(); } }, label);
    return [b, key] as const;
  };
  const toggles = [toggle('Aa', 'Match case', 'caseSensitive'), toggle('.*', 'Regular expression', 'regex'), toggle('Ignored', 'Include ignored files', 'includeIgnored')];
  const here = h('button', { class: 'button quiet toggle', onclick: () => { app.search.workspace = false; void app.runSearch(); } }, 'This repository');
  const everywhere = h('button', { class: 'button quiet toggle', onclick: () => { app.search.workspace = true; void app.runSearch(); } }, 'Workspace');
  const status = h('div', { class: 'search-status', role: 'status' });
  const results = h('div');
  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener('input', () => { app.search.query = input.value; clearTimeout(timer); timer = setTimeout(() => void app.runSearch(), 180); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(timer); void app.runSearch(); } if (e.key === 'ArrowDown') { results.querySelector<HTMLElement>('.hit')?.focus(); e.preventDefault(); } });
  const element = h('div', null, h('div', { class: 'search-form' }, input, h('div', { class: 'opts' }, ...toggles.map(t => t[0]), h('span', { class: 'grow' }), here, everywhere)), status, results);
  let shown = -1;
  return {
    element,
    render(state: State, row: RepositoryRow | undefined) {
      const s = app.search;
      if (input.value !== s.query && document.activeElement !== input) input.value = s.query;
      for (const [b, key] of toggles) attr(b, 'aria-pressed', String(s[key]));
      attr(here, 'aria-pressed', String(!s.workspace)); attr(everywhere, 'aria-pressed', String(s.workspace));
      const scope = s.workspace ? 'the workspace' : row?.name ?? 'this repository';
      const glyph = h('span', { class: 'glyph', 'data-f': !s.query ? 'unknown' : !s.done ? 'refreshing' : s.complete ? 'observed' : 'stale', 'aria-hidden': 'true' });
      const files = new Set(s.matches.map(m => `${m.repositoryId}\0${m.path}`)).size;
      status.replaceChildren(glyph, !s.query ? `Searches ${scope}. Respects ignore files unless “Ignored” is on.`
        : `${plural(s.matches.length, 'match', 'matches')} in ${plural(files, 'file')} · ${!s.done ? `searching ${scope}…` : s.complete ? `searched all of ${scope}` : `incomplete${s.note ? `: ${s.note}` : ''}`}${s.errors.length ? ` · ${plural(s.errors.length, 'error')}` : ''}`);
      if (shown === s.matches.length && results.childElementCount) return;
      shown = s.matches.length;
      const groups = new Map<string, typeof s.matches>();
      for (const m of s.matches.slice(0, 1500)) { const k = `${m.repositoryId}\0${m.path}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(m); }
      const nodes: HTMLElement[] = [];
      for (const [k, matches] of groups) {
        const [repoId, path] = k.split('\0') as [string, string];
        const { dir, base } = splitPath(path);
        nodes.push(h('div', { class: 'hit-file' }, base, h('span', { class: 'where' }, `${s.workspace ? `${state.rows.get(repoId)?.name ?? ''} · ` : ''}${dir}`), h('span', { class: 'where' }, String(matches.length))));
        for (const m of matches.slice(0, 50)) {
          const before = m.preview.slice(0, m.column - 1), hit = m.preview.slice(m.column - 1, m.column - 1 + m.length), after = m.preview.slice(m.column - 1 + m.length);
          const trimmed = before.length > 40 ? `…${before.slice(-36).trimStart()}` : before.trimStart();
          const el = h('div', { class: 'hit', tabindex: '0', role: 'button', 'aria-label': `${base} line ${m.line}: ${m.preview.trim()}`,
            onclick: () => void app.openFile(repoId, path, m.line, m.column),
            onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void app.openFile(repoId, path, m.line, m.column); else if (e.key === 'ArrowDown') nextFocusable(el, 1)?.focus(); else if (e.key === 'ArrowUp') (nextFocusable(el, -1) ?? input).focus(); else return; e.preventDefault(); } },
            h('span', { class: 'ln' }, String(m.line)), h('span', { class: 'tx' }, trimmed, h('mark', null, hit), after));
          nodes.push(el);
        }
      }
      if (s.matches.length > 1500) nodes.push(h('div', { class: 'empty-note' }, `Showing the first 1,500 of ${s.matches.length} matches. Narrow the search to see the rest.`));
      results.replaceChildren(...nodes);
    },
  };
}

export { kbd, syncList, statusSentence };
