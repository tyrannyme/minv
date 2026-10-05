import type { App, ReviewRuntime } from '../app.js';
import { normalizeAppearance, type Appearance, type EditorHandle } from '../contract.js';
import { changedRange, inlinePairs, splitRows, stats, type DiffLine, type FileDiff, type Hunk } from '../diff.js';
import { attr, h, kbd, mod, text } from '../dom.js';
import { branchText, changeCount, groupChanges, languageName, languageOf, plural, relativeTime, shortOid, splitPath } from '../format.js';
import { selectedRow, type Sheet, type State } from '../state.js';
import { close as closeIcon, mark } from './icons.js';
import { ledger } from './index.js';

interface SheetView { element: HTMLElement; render(state: State): void; layout?(): void; focus(): void; dispose?(): void }

export function createDesk(app: App): { element: HTMLElement; render(state: State): void; focus(): void; layout(): void } {
  const tabs = h('div', { class: 'sheet-tabs', role: 'tablist', 'aria-label': 'Open sheets' });
  const split = h('button', { class: 'button quiet', title: `Split desk (${mod} \\)`, onclick: () => app.toggleSplit() }, 'Split');
  const focusBtn = h('button', { class: 'button quiet', title: `Focus mode (${mod} B)`, onclick: () => app.store.update(s => { s.focus = !s.focus; }) }, 'Focus');
  const strip = h('div', { class: 'strip' }, tabs, h('div', { class: 'strip-tools' }, split, focusBtn));
  const panes = h('div', { class: 'panes' });
  const element = h('main', { class: 'desk', 'aria-label': 'Sheets' }, strip, panes);
  const views = new Map<string, SheetView>();
  const front = createFront(app);
  const frontSheet = h('section', { class: 'sheet first', 'aria-label': 'Front page' }, h('div', { class: 'sheet-body' }, front.element));
  let mainPane: HTMLElement = frontSheet, splitPane: HTMLElement | undefined;

  const viewFor = (sheet: Sheet): SheetView => {
    let v = views.get(sheet.id);
    if (!v) {
      v = sheet.kind === 'file' ? fileView(app, sheet) : sheet.kind === 'diff' ? reviewView(app, sheet) : sheet.kind === 'commit' ? commitView(app, sheet) : sheet.kind === 'compare' ? compareView(app, sheet) : settingsView(app);
      v.element.addEventListener('focusin', () => { const pane = app.state.splitSheet === sheet.id ? 'split' : 'main'; if (app.state.focusedPane !== pane) app.store.update(s => { s.focusedPane = pane; }); });
      views.set(sheet.id, v);
    }
    return v;
  };

  return {
    element,
    focus: () => { const s = app.focusedSheet(); if (s) views.get(s.id)?.focus(); else front.element.querySelector<HTMLElement>('button')?.focus(); },
    layout: () => { for (const v of views.values()) v.layout?.(); },
    render(state) {
      // Strip
      const counts = new Map<string, number>();
      for (const s of state.sheets) counts.set(s.title, (counts.get(s.title) ?? 0) + 1);
      tabs.replaceChildren(...state.sheets.map(sheet => {
        const selected = sheet.id === state.activeSheet || sheet.id === state.splitSheet;
        const owner = state.rows.get(sheet.repositoryId)?.name;
        const kind = sheet.kind === 'diff' ? (sheet.side === 'staged' ? 'staged' : 'review') : sheet.kind === 'commit' ? 'commit' : sheet.kind === 'compare' ? 'compare' : '';
        const tab = h('div', { class: 'sheet-tab', role: 'tab', tabindex: selected ? '0' : '-1', 'aria-selected': String(selected), title: [owner, sheet.path ?? sheet.title].filter(Boolean).join(' / '),
          onmousedown: (e: MouseEvent) => { if (e.button === 1) { e.preventDefault(); void app.closeSheet(sheet.id); } else if (!(e.target as Element).closest('.x')) app.activate(sheet.id); },
          onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { app.activate(sheet.id); app.focusPlane('sheet'); } } },
          sheet.dirty ? h('span', { class: 'dirty', 'aria-label': 'unsaved' }) : null,
          kind ? h('span', { class: 'kind' }, kind === 'review' ? 'Diff' : kind) : null,
          h('span', { class: 'tt' }, sheet.title), owner && sheet.kind !== 'settings' ? h('span', { class: 'owner' }, owner) : null,
          h('button', { class: 'x', 'aria-label': `Close ${sheet.title}`, onclick: () => void app.closeSheet(sheet.id) }, closeIcon()));
        void counts;
        return tab;
      }));
      attr(split, 'aria-pressed', String(!!state.splitSheet));
      // Panes
      const active = state.sheets.find(s => s.id === state.activeSheet);
      const splitSheet = state.sheets.find(s => s.id === state.splitSheet);
      const nextMain = active ? viewFor(active).element : frontSheet;
      const nextSplit = splitSheet ? viewFor(splitSheet).element : undefined;
      if (nextMain !== mainPane || nextSplit !== splitPane || panes.childElementCount !== (nextSplit ? 2 : 1)) {
        panes.replaceChildren(...[nextMain, nextSplit].filter((x): x is HTMLElement => !!x));
        mainPane = nextMain; splitPane = nextSplit;
        requestAnimationFrame(() => { for (const v of views.values()) v.layout?.(); });
      }
      panes.classList.toggle('split', !!nextSplit);
      nextMain.classList.add('first');
      nextMain.classList.toggle('focused', state.focusedPane === 'main' && !!nextSplit);
      nextSplit?.classList.toggle('focused', state.focusedPane === 'split');
      if (!active) front.render(state);
      for (const sheet of [active, splitSheet]) if (sheet) viewFor(sheet).render(state);
      // Dispose views of closed sheets
      for (const [id, v] of views) if (!state.sheets.some(s => s.id === id)) { v.dispose?.(); v.element.remove(); views.delete(id); }
    },
  };
}

function sheetFrame(label: string) {
  const where = h('div', { class: 'where' });
  const tools = h('div', { class: 'tools' });
  const bars = h('div');
  const body = h('div', { class: 'sheet-body' });
  const foot = h('div', { class: 'sheet-foot' });
  const element = h('section', { class: 'sheet', 'aria-label': label }, h('header', { class: 'sheet-head' }, where, tools), bars, body, foot);
  return { element, where, tools, bars, body, foot };
}

function heading(app: App, sheet: Sheet, title: string, aside?: string) {
  const owner = app.state.rows.get(sheet.repositoryId);
  const { dir } = splitPath(sheet.path ?? '');
  return [h('div', { class: 'path' }, owner ? h('b', null, owner.name) : '', owner ? ' / ' : '', dir), h('div', { class: 'file-title' }, title, aside ? h('span', { class: 'aside' }, aside) : null)];
}

const eolName = { lf: 'LF', crlf: 'CRLF', cr: 'CR', mixed: 'Mixed line endings', none: 'No line endings' } as const;
const encName = { utf8: 'UTF-8', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE' } as const;

// ── File ─────────────────────────────────────────────────────────────────────

function fileView(app: App, sheet: Sheet): SheetView {
  const f = sheetFrame(sheet.title);
  f.body.classList.add('editor-host');
  let handle: EditorHandle | undefined;
  let mountedVersion: unknown;
  const pos = h('span'), enc = h('span'), eol = h('span'), lang = h('span'), state = h('span');
  f.foot.append(pos, h('span', { class: 'grow' }), enc, eol, lang, state);
  f.tools.append(
    h('button', { class: 'button quiet', title: `Find (${mod} F)`, onclick: () => handle?.run('find') }, 'Find'),
    h('button', { class: 'button quiet', title: `Go to line (${mod} G)`, onclick: () => handle?.run('gotoLine') }, 'Line'),
    h('button', { class: 'button quiet', onclick: (e: Event) => app.menu(e.currentTarget as HTMLElement, [
      { label: 'Save', hint: `${mod} S`, run: () => void app.save(sheet) },
      { label: 'Review changes', run: () => void app.openReview(sheet.repositoryId, sheet.path!, 'unstaged') },
      { label: 'Reveal in file manager', run: () => void app.reveal(sheet.path) },
      { label: 'Copy path', run: () => void navigator.clipboard?.writeText(sheet.path ?? '') },
    ]) }, '⋯'));
  return {
    element: f.element,
    focus: () => handle?.focus(),
    layout: () => handle?.layout(),
    dispose: () => { /* handle is owned by the App runtime and disposed on close */ },
    render(st) {
      const rt = app.files.get(sheet.id);
      const key = JSON.stringify([sheet.path, sheet.title]);
      if (f.where.dataset.key !== key) { f.where.dataset.key = key; f.where.replaceChildren(...heading(app, sheet, sheet.title)); }
      if (!rt) return;
      // Bars: EDIT-02 reconciliation and large/unsaved states. Each states the consequence.
      const bars: HTMLElement[] = [];
      if (rt.diskChanged) bars.push(h('div', { class: 'bar warn', role: 'alert' },
        h('b', null, rt.diskChanged.deleted ? 'Deleted on disk.' : 'Changed on disk.'), rt.diskChanged.deleted ? 'Your text is still here. Saving creates the file again.' : 'Another program changed this file while you were editing. Your text is kept.',
        h('span', { class: 'grow' }),
        h('button', { class: 'button', onclick: () => void app.compareWithDisk(sheet) }, 'Compare'),
        !rt.diskChanged.deleted ? h('button', { class: 'button', onclick: () => void app.takeDisk(sheet) }, 'Use disk version') : null,
        h('button', { class: 'button', onclick: () => void app.keepMine(sheet) }, 'Keep mine')));
      if (rt.content?.kind === 'text' && rt.content.large) bars.push(h('div', { class: 'bar' }, h('b', null, 'Large file.'), 'Folding and syntax colouring are reduced to keep editing responsive. Nothing is truncated.'));
      const barKey = JSON.stringify([rt.diskChanged, rt.content?.kind === 'text' && rt.content.large]);
      if (f.bars.dataset.key !== barKey) { f.bars.dataset.key = barKey; f.bars.replaceChildren(...bars); }

      if (rt.loading) { if (!f.body.firstChild) f.body.append(h('div', { class: 'opaque' }, 'Opening…')); return; }
      if (rt.error) { f.body.replaceChildren(h('div', { class: 'opaque' }, h('h2', null, 'This file could not be opened'), h('p', null, rt.error))); return; }
      const c = rt.content;
      if (c && c.kind !== 'text') {
        if (mountedVersion !== c.version) {
          mountedVersion = c.version;
          f.body.replaceChildren(h('div', { class: 'opaque' }, h('h2', null, c.kind === 'binary' ? 'Binary file' : 'Too large to edit here'),
            h('p', null, `${(c.size / 1048576).toFixed(c.size > 1048576 ? 1 : 3)} MB. ${c.kind === 'binary' ? 'Minv does not render binary content.' : 'It is over the text limit, so Minv will not load a partial copy you could save by accident.'}`),
            h('button', { class: 'button', onclick: () => void app.reveal(sheet.path) }, 'Reveal in file manager')));
        }
        return;
      }
      if (c && !rt.handle) {
        if (!app.editor) { f.body.replaceChildren(h('div', { class: 'opaque' }, h('h2', null, 'Editor unavailable'), h('p', null, 'The Code-OSS editor build could not be loaded. Files can still be reviewed in the Changes view.'))); return; }
        f.body.replaceChildren();
        rt.handle = handle = app.editor.create(f.body, { uri: `minv://${encodeURIComponent(sheet.repositoryId)}/${sheet.path}`, text: c.text, languageId: languageOf(sheet.path!), readOnly: false, large: c.large });
        handle.onDidChangeContent(() => app.markDirty(sheet));
        handle.onDidChangeCursor(p => { rt.cursor = p; app.scheduleSave(); text(pos, `Ln ${p.line}, Col ${p.column}${p.selections > 1 ? ` · ${p.selections} cursors` : ''}`); });
        text(pos, 'Ln 1, Col 1');
        requestAnimationFrame(() => { handle?.layout(); if (sheet.view) { handle?.setView(sheet.view); sheet.view = undefined; } else if (sheet.line) handle?.revealLine(sheet.line, sheet.column); handle?.focus(); });
      }
      handle = rt.handle;
      if (c) { text(enc, `${encName[c.encoding]}${c.bom ? ' with BOM' : ''}`); text(eol, eolName[c.eol]); text(lang, languageName[languageOf(sheet.path!)] ?? 'Plain text'); }
      text(state, rt.saving ? 'Saving…' : rt.dirty ? 'Unsaved' : 'Saved');
      state.className = rt.dirty ? 'state-dirty' : '';
      void st;
    },
  };
}

// ── Review (the redline) ─────────────────────────────────────────────────────

function lineEl(line: DiffLine, pair: DiffLine | undefined, cols: 'inline' | 'left' | 'right'): HTMLElement {
  const cls = line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : line.kind === '\\' ? 'meta' : '';
  const code = h('span', { class: 'code' });
  const range = pair && line.kind !== ' ' ? changedRange(line.kind === '-' ? line.text : pair.text, line.kind === '-' ? pair.text : line.text) : undefined;
  if (range) {
    const [a, b] = line.kind === '-' ? range.before : range.after;
    code.append(line.text.slice(0, a), h(line.kind === '-' ? 'del' : 'ins', null, line.text.slice(a, b)), line.text.slice(b));
  } else code.textContent = line.text || '​';
  const sign = h('span', { class: 'sign', 'aria-hidden': 'true' }, line.kind === ' ' ? '' : line.kind === '\\' ? '' : line.kind === '+' ? '+' : '−');
  if (cols === 'inline') return h('div', { class: `line ${cls}` }, h('span', { class: 'no' }, line.oldNo?.toString() ?? ''), h('span', { class: 'no' }, line.newNo?.toString() ?? ''), sign, code);
  return h('div', { class: `line ${cls}` }, h('span', { class: 'no' }, (cols === 'left' ? line.oldNo : line.newNo)?.toString() ?? ''), sign, code);
}

export function renderHunkLines(hunk: Hunk, mode: 'inline' | 'split'): HTMLElement {
  if (mode === 'inline') {
    const pairs = inlinePairs(hunk);
    return h('div', { role: 'presentation' }, ...hunk.lines.map(l => lineEl(l, pairs.get(l), 'inline')));
  }
  const grid = h('div', { class: 'split-lines' });
  for (const row of splitRows(hunk)) {
    grid.append(row.left ? lineEl(row.left, row.left.kind === '-' ? row.right : undefined, 'left') : h('div', { class: 'line blank' }));
    grid.append(row.right ? lineEl(row.right, row.right.kind === '+' ? row.left : undefined, 'right') : h('div', { class: 'line blank' }));
  }
  return grid;
}

function describeKind(kind: string | undefined, file: FileDiff | undefined): string | undefined {
  switch (kind) {
    case 'binary': return 'Binary content changed. Minv does not render binary diffs; stage or discard the whole file.';
    case 'gitlink': return 'Submodule pointer. The parent records a different commit for this submodule; staging records the child’s current commit.';
    case 'mode': return 'Only the file mode changed (for example the executable bit).';
    case 'symlink': return 'Symbolic link target changed.';
    case 'rename': return `Renamed${file?.oldPath ? ` from ${file.oldPath}` : ''}.`;
    case 'conflict': return 'Unresolved conflict. Open the file, resolve the markers, save, then mark it resolved.';
    case 'empty': return 'No differences on this side any more. The change may have been staged, unstaged or reverted elsewhere.';
    default: return undefined;
  }
}

function reviewView(app: App, sheet: Sheet): SheetView {
  const f = sheetFrame(`Review ${sheet.title}`);
  const review = h('div', { class: 'review', tabindex: '0', 'aria-label': `Changes in ${sheet.title}. J and K move between hunks, S stages, U unstages.` });
  f.body.append(review);
  const inline = h('button', { class: 'button quiet toggle', onclick: () => setMode('inline') }, 'Inline');
  const split = h('button', { class: 'button quiet toggle', onclick: () => setMode('split') }, 'Side by side');
  const wrap = h('button', { class: 'button quiet toggle', onclick: () => { const r = app.reviews.get(sheet.id); if (r) { r.wrap = !r.wrap; app.store.update(() => {}); } } }, 'Wrap');
  const whole = h('button', { class: 'button quiet', onclick: () => void app.applyFile(sheet) });
  const edit = h('button', { class: 'button quiet', onclick: () => void app.openFile(sheet.repositoryId, sheet.path!) }, 'Edit file');
  f.tools.append(inline, split, wrap, h('span', { style: 'width:8px' }), edit, whole);
  const setMode = (mode: 'inline' | 'split') => { const r = app.reviews.get(sheet.id); if (r) { r.mode = mode; app.store.update(() => {}); } };
  const move = (r: ReviewRuntime, d: number) => { const n = r.files[0]?.hunks.length ?? 0; if (!n) return; r.current = Math.max(0, Math.min(n - 1, r.current + d)); app.store.update(() => {}); requestAnimationFrame(() => review.querySelector('.hunk.current')?.scrollIntoView({ block: 'nearest' })); };
  review.addEventListener('keydown', e => {
    const r = app.reviews.get(sheet.id); if (!r || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'j' || e.key === 'n') move(r, 1);
    else if (e.key === 'k' || e.key === 'p') move(r, -1);
    else if ((e.key === 's' && sheet.side === 'unstaged') || (e.key === 'u' && sheet.side === 'staged')) void app.applyHunk(sheet, r.current);
    else if (e.key === 'e') void app.openFile(sheet.repositoryId, sheet.path!);
    else return;
    e.preventDefault();
  });
  const foot = h('span');
  f.foot.append(foot);
  return {
    element: f.element,
    focus: () => review.focus(),
    render(state) {
      const r = app.reviews.get(sheet.id);
      const row = state.rows.get(sheet.repositoryId);
      const side = sheet.side === 'staged' ? 'Staged · index compared with HEAD' : 'Unstaged · working tree compared with index';
      const headKey = JSON.stringify([side, row?.name]);
      if (f.where.dataset.key !== headKey) { f.where.dataset.key = headKey; f.where.replaceChildren(...heading(app, sheet, sheet.title, side)); }
      if (!r) return;
      attr(inline, 'aria-pressed', String(r.mode === 'inline')); attr(split, 'aria-pressed', String(r.mode === 'split')); attr(wrap, 'aria-pressed', String(r.wrap));
      const blocked = app.writable(row);
      text(whole, sheet.side === 'staged' ? 'Unstage file' : 'Stage file');
      whole.disabled = !!blocked || r.loading || !(r.review || r.diff) || r.diff?.kind === 'empty' || r.diff?.kind === 'conflict';
      whole.title = blocked ?? '';
      const key = JSON.stringify([r.loading, r.error, r.review?.reviewId, r.diff?.reviewId, r.mode, r.wrap, r.current, r.busy, !!blocked]);
      if (review.dataset.key === key) return;
      review.dataset.key = key;
      review.classList.toggle('wrap', r.wrap);
      if (r.loading && !r.files.length) { review.replaceChildren(h('div', { class: 'opaque' }, 'Reading the diff…')); return; }
      if (r.error) { review.replaceChildren(h('div', { class: 'opaque' }, h('h2', null, 'This change could not be read'), h('p', null, r.error), h('button', { class: 'button', onclick: () => void app.loadReview(sheet) }, 'Try again'))); return; }
      const file = r.files[0];
      const nodes: HTMLElement[] = [];
      const special = describeKind(r.diff?.kind && r.diff.kind !== 'text' ? r.diff.kind : undefined, file);
      if (special) nodes.push(h('div', { class: 'special' }, h('b', null, (r.diff?.kind ?? '').replace(/^./, c => c.toUpperCase())), special));
      const hunks = file?.hunks ?? [];
      const selectable = !!r.review;
      hunks.forEach((hunk, i) => {
        const apply = selectable ? h('button', { class: 'button quiet', disabled: !!blocked || r.busy, title: blocked ?? `${sheet.side === 'staged' ? 'U' : 'S'}`, onclick: () => void app.applyHunk(sheet, i) }, sheet.side === 'staged' ? 'Unstage hunk' : 'Stage hunk', kbd(sheet.side === 'staged' ? 'U' : 'S')) : null;
        nodes.push(h('div', { class: `hunk${i === r.current ? ' current' : ''}`, onclick: () => { if (r.current !== i) { r.current = i; app.store.update(() => {}); } } },
          h('div', { class: 'hunk-head' }, h('span', null, `Hunk ${i + 1} of ${hunks.length}`), h('span', { class: 'range' }, `−${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`), h('span', { class: 'section' }, hunk.section), apply),
          renderHunkLines(hunk, r.mode)));
      });
      if (!hunks.length && !special) nodes.push(h('div', { class: 'special' }, h('b', null, 'No text changes'), 'Nothing to review on this side.'));
      review.replaceChildren(...nodes);
      const st = file ? stats(file) : { added: 0, removed: 0 };
      text(foot, `+${st.added} −${st.removed} · ${plural(hunks.length, 'hunk')} · ${selectable ? 'hunks selectable' : 'whole-file actions only'} · ${row ? `${row.name} on ${branchText(row.branch) ?? '—'}` : ''}`);
    },
  };
}

// ── Commit ───────────────────────────────────────────────────────────────────

function commitView(app: App, sheet: Sheet): SheetView {
  const f = sheetFrame(`Commit ${sheet.title}`);
  const body = h('div', { class: 'review', tabindex: '0' });
  f.body.append(body);
  const foot = h('span'); f.foot.append(foot);
  return {
    element: f.element,
    focus: () => body.focus(),
    render(state) {
      const c = app.commits.get(sheet.id); if (!c) return;
      const key = JSON.stringify([c.loading, c.error, c.message, c.files.length]);
      if (body.dataset.key === key) return;
      body.dataset.key = key;
      const e = c.entry!;
      f.where.replaceChildren(h('div', { class: 'path' }, h('b', null, state.rows.get(sheet.repositoryId)?.name ?? ''), ` · ${shortOid(e.oid)} · ${e.author} · ${new Date(e.date).toLocaleString()}`), h('div', { class: 'file-title' }, e.subject));
      if (c.loading) { body.replaceChildren(h('div', { class: 'opaque' }, 'Reading commit…')); return; }
      const nodes: HTMLElement[] = [];
      const rest = (c.message ?? '').split('\n').slice(1).join('\n').trim();
      if (rest) nodes.push(h('div', { class: 'special', style: 'white-space:pre-wrap;font-family:var(--font-mono);font-size:12.5px;line-height:1.6;border-style:solid' }, rest));
      if (c.error) nodes.push(h('div', { class: 'special' }, c.error));
      for (const file of c.files) {
        const st = stats(file);
        nodes.push(h('div', { class: 'review-file' }, h('h3', null, file.newPath ?? file.oldPath ?? ''), h('span', { class: 'st' }, h('span', { class: 'a' }, `+${st.added}`), ' ', h('span', { class: 'd' }, `−${st.removed}`))));
        if (file.binary) nodes.push(h('div', { class: 'special' }, 'Binary content changed.'));
        for (const hunk of file.hunks) nodes.push(h('div', { class: 'hunk' }, h('div', { class: 'hunk-head' }, h('span', { class: 'range' }, `−${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`), h('span', { class: 'section' }, hunk.section)), renderHunkLines(hunk, 'inline')));
      }
      body.replaceChildren(...nodes);
      text(foot, `${plural(c.files.length, 'file')} · parents ${(c.parents ?? []).map(shortOid).join(', ') || 'none'} · read-only`);
    },
  };
}

// ── Compare ──────────────────────────────────────────────────────────────────

function compareView(app: App, sheet: Sheet): SheetView {
  const f = sheetFrame(sheet.title);
  f.body.classList.add('editor-host');
  const inline = h('button', { class: 'button quiet toggle', 'aria-pressed': 'false', onclick: () => { const c = app.compares.get(sheet.id); if (c) { c.inline = !c.inline; c.mounted?.dispose(); c.mounted = undefined; app.store.update(() => {}); } } }, 'Inline');
  f.tools.append(inline);
  f.where.append(h('div', { class: 'path' }, 'Read-only comparison'), h('div', { class: 'file-title' }, sheet.left?.label ?? '', h('span', { class: 'aside' }, '↔'), h('span', { class: 'aside' }, sheet.right?.label ?? '')));
  f.foot.append(h('span', null, `left: ${sheet.left?.label ?? ''}`), h('span', { class: 'grow' }), h('span', null, `right: ${sheet.right?.label ?? ''}`));
  let loading = false;
  const load = async () => {
    loading = true;
    let c = app.compares.get(sheet.id);
    if (!c) { c = { loading: true }; app.compares.set(sheet.id, c); }
    if (!c.texts && sheet.left?.ref && sheet.right?.ref) {
      try {
        const [a, b] = await Promise.all([app.host.invoke('fs.readRef', { ref: sheet.left.ref }), app.host.invoke('fs.readRef', { ref: sheet.right.ref })]);
        if (a.kind !== 'text' || b.kind !== 'text') c.error = 'One side is binary or too large to compare as text.';
        else { c.texts = [a.text, b.text]; c.language = languageOf(sheet.right.label); }
      } catch (error) { c.error = app.error(error).message; }
    }
    c.loading = false; loading = false;
    app.store.update(() => {});
  };
  return {
    element: f.element,
    focus: () => f.body.focus(),
    layout: () => app.compares.get(sheet.id)?.mounted?.layout(),
    dispose: () => app.compares.get(sheet.id)?.mounted?.dispose(),
    render() {
      const c = app.compares.get(sheet.id);
      if ((!c || (!c.texts && !c.error && !c.loading)) && !loading) { void load(); return; }
      if (!c) return;
      attr(inline, 'aria-pressed', String(!!c.inline));
      if (c.error) { f.body.replaceChildren(h('div', { class: 'opaque' }, h('h2', null, 'Cannot compare'), h('p', null, c.error))); return; }
      if (c.texts && !c.mounted) {
        if (!app.editor) { f.body.replaceChildren(h('div', { class: 'opaque' }, h('h2', null, 'Editor unavailable'), h('p', null, 'Comparisons need the Code-OSS editor build.'))); return; }
        f.body.replaceChildren();
        const lang = c.language ?? 'plaintext';
        c.mounted = app.editor.createComparison(f.body, { uri: `minv-compare://${sheet.id}/left/${sheet.left?.label ?? ''}`, text: c.texts[0], languageId: lang, readOnly: true }, { uri: `minv-compare://${sheet.id}/right/${sheet.right?.label ?? ''}`, text: c.texts[1], languageId: lang, readOnly: true }, !!c.inline);
        requestAnimationFrame(() => c.mounted?.layout());
      }
    },
  };
}

// ── Settings (SET-01: the whole surface) ─────────────────────────────────────

const appearances: { id: Appearance; label: string; canvas: string; surface: string; fg: string; border: string }[] = [
  { id: 'system', label: 'System', canvas: 'linear-gradient(90deg,#0a0b0d 50%,#eceef2 50%)', surface: 'linear-gradient(90deg,#181a1f 50%,#ffffff 50%)', fg: '#888', border: '#888' },
  { id: 'dark', label: 'Dark', canvas: '#0a0b0d', surface: '#111216', fg: '#eceef2', border: '#24272e' },
  { id: 'light', label: 'Light', canvas: '#eceef2', surface: '#ffffff', fg: '#0d0f12', border: '#dcdfe6' },
  { id: 'dark-contrast', label: 'Dark, high contrast', canvas: '#000000', surface: '#000000', fg: '#ffffff', border: '#ffffff' },
  { id: 'light-contrast', label: 'Light, high contrast', canvas: '#ffffff', surface: '#ffffff', fg: '#000000', border: '#000000' },
];

function settingsView(app: App): SheetView {
  const f = sheetFrame('Settings');
  f.where.append(h('div', { class: 'path' }, 'MINV · MINIMAL VS CODE'), h('div', { class: 'file-title' }, 'Settings', h('span', { class: 'aside' }, 'This is every setting Minv has.')));
  const form = h('div', { class: 'settings' });
  f.body.append(form);
  f.foot.append(h('span', null, 'Changes apply immediately and are stored on this machine.'));
  const num = (key: 'editorFontSize' | 'tabSize', min: number, max: number) => {
    const input = h('input', { class: 'field', type: 'number', min: String(min), max: String(max), value: String(app.state.prefs[key]), style: 'width:90px' });
    input.addEventListener('change', () => { const v = Math.max(min, Math.min(max, Number(input.value) || min)); void app.setPrefs({ [key]: v }); });
    return input;
  };
  const check = (key: 'wordWrap' | 'renderWhitespace', label: string) => {
    const input = h('input', { type: 'checkbox', checked: app.state.prefs[key] });
    input.addEventListener('change', () => void app.setPrefs({ [key]: input.checked }));
    return h('label', { class: 'inline' }, input, label);
  };
  const textField = (key: 'gitPath' | 'terminal', placeholder: string) => {
    const input = h('input', { class: 'field', type: 'text', value: app.state.prefs[key], placeholder, spellcheck: 'false' });
    input.addEventListener('change', () => void app.setPrefs({ [key]: input.value.trim() }));
    return input;
  };
  const globs = (key: 'browseExclude' | 'searchExclude') => {
    const input = h('textarea', { class: 'field', rows: '3', spellcheck: 'false', style: 'font-family:var(--font-mono);font-size:12px' });
    input.value = app.state.prefs[key].join('\n');
    input.addEventListener('change', () => void app.setPrefs({ [key]: input.value.split('\n').map(x => x.trim()).filter(Boolean) }));
    return input;
  };
  let built = false;
  const swatchButtons: HTMLElement[] = [];
  return {
    element: f.element,
    focus: () => form.querySelector<HTMLElement>('button, input')?.focus(),
    render(state) {
      if (!built) {
        built = true;
        const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Appearance' }, ...appearances.map(a => {
          const b = h('button', { class: 'swatch', role: 'radio', 'aria-checked': 'false', onclick: () => void app.setPrefs({ appearance: a.id }) },
            h('span', { class: 'mini', style: `background:${a.canvas}` }, h('i', { style: `background:${a.surface};border:1px solid ${a.border}` }), h('i', { style: `background:${a.surface};border:1px solid ${a.border}` })), a.label);
          b.dataset.id = a.id; swatchButtons.push(b); return b;
        }));
        const motion = h('input', { type: 'checkbox' }); motion.addEventListener('change', () => void app.setPrefs({ motion: motion.checked ? 'reduce' : 'system' }));
        const density = h('input', { type: 'checkbox' }); density.addEventListener('change', () => void app.setPrefs({ density: density.checked ? 'comfortable' : 'compact' }));
        form.replaceChildren(
          h('fieldset', null, h('legend', { class: 'label' }, 'Appearance'), swatches,
            h('label', { class: 'inline' }, motion, 'Reduce motion (otherwise follows the system setting)'),
            h('label', { class: 'inline' }, density, 'Comfortable rows')),
          h('fieldset', null, h('legend', { class: 'label' }, 'Editor'), h('div', { class: 'two' }, h('span', null, 'Font size'), num('editorFontSize', 10, 24), h('span', null, 'Tab width'), num('tabSize', 1, 8)),
            check('wordWrap', 'Wrap long lines'), check('renderWhitespace', 'Show whitespace'),
            h('p', { class: 'hint' }, 'Minv never formats, autosaves or changes line endings on its own.')),
          h('fieldset', null, h('legend', { class: 'label' }, 'Files and search'),
            h('div', { class: 'two' }, h('span', null, 'Hide in file browser'), globs('browseExclude'), h('span', null, 'Skip in text search'), globs('searchExclude')),
            h('p', { class: 'hint' }, 'One glob per line. Hidden files still show up in Changes; Git state is never hidden.')),
          h('fieldset', null, h('legend', { class: 'label' }, 'Tools'),
            h('div', { class: 'two' }, h('span', null, 'Git executable'), textField('gitPath', 'git'), h('span', null, 'External terminal'), textField('terminal', 'Platform default')),
            h('p', { class: 'hint' }, 'The Git path applies after restarting Minv.')),
          h('fieldset', null, h('legend', { class: 'label' }, 'Workspace trust'),
            h('p', { class: 'hint' }, state.workspace ? (state.workspace.trusted ? 'This workspace is trusted. Git writes may run its hooks and filters.' : 'Restricted mode. Reading works; writes and hooks are off.') : 'No workspace is open.'),
            state.workspace ? h('div', null, h('button', { class: 'button', onclick: () => void app.setTrust(!state.workspace?.trusted) }, state.workspace.trusted ? 'Return to restricted mode' : 'Trust this workspace…')) : ''),
          h('fieldset', null, h('legend', { class: 'label' }, 'Recovery'), h('div', null, h('button', { class: 'button', onclick: () => void app.restoreBackups() }, 'Manage backups…'))),
        );
        (motion as HTMLInputElement).checked = state.prefs.motion === 'reduce';
        (density as HTMLInputElement).checked = state.prefs.density === 'comfortable';
      }
      for (const b of swatchButtons) attr(b, 'aria-checked', String(b.dataset.id === normalizeAppearance(state.prefs.appearance)));
    },
  };
}

// ── Front page ───────────────────────────────────────────────────────────────

function createFront(app: App) {
  const element = h('div', { class: 'front' });
  return {
    element,
    render(state: State) {
      const w = state.workspace;
      if (!w) return;
      const l = ledger(state);
      const sel = selectedRow(state);
      const withChanges = state.order.map(id => state.rows.get(id)!).filter(r => r.status.state === 'observed' && changeCount(r.status.value) > 0).slice(0, 7);
      const key = JSON.stringify([w.name, l, sel?.id, withChanges.map(r => [r.id, changeCount(r.status.value)]), state.recoveries.length, w.trusted]);
      if (element.dataset.key === key) return;
      element.dataset.key = key;
      const known = l.total - l.offline;
      const readout = (num: string | HTMLElement, what: string, signal = false) => h('div', null, h('div', { class: `num${signal ? ' signal' : ''}` }, num), h('div', { class: 'what' }, what));
      const primer: [string[], string][] = [[[mod, 'K'], 'Go to a repository, file or command'], [['/'], 'Find a repository'], [[mod, '1 2 3'], 'Repositories, inspector, editor'], [['Space'], 'Stage or unstage the focused file'], [['S'], 'Stage the current hunk in a review'], [[mod, '⏎'], 'Commit']];
      element.replaceChildren(
        h('div', { class: 'kicker' }, w.fixture ? 'Preview fixture · ' : '', w.roots[0]?.replace(/^\/home\/[^/]+/, '~') ?? ''),
        h('h1', null, w.name),
        h('div', { class: 'readouts', role: 'status' },
          readout(h('span', null, String(l.verified), h('small', null, `/${known}`)), l.checking ? `branches verified · ${l.checking} checking` : l.unverified ? `branches verified · ${l.unverified} from last session` : 'branches verified', l.verified === known && known > 0),
          readout(l.statusKnown ? String(l.withChanges) : '—', l.statusKnown < known ? `with changes · ${known - l.statusKnown} not scanned yet` : 'with changes'),
          readout(String(l.offline + l.failed), l.offline + l.failed === 1 ? 'checkout unavailable' : 'checkouts unavailable'),
          readout(w.discovery === 'complete' ? 'Done' : w.discovery === 'error' ? 'Error' : '…', w.discovery === 'complete' ? 'discovery complete' : w.discovery === 'cached' ? 'saved catalog, discovering' : 'discovering checkouts')),
        h('div', { class: 'front-grid' },
          h('div', null, h('h2', { class: 'label' }, withChanges.length ? 'Work in progress' : 'Repositories'),
            ...(withChanges.length ? withChanges : state.order.slice(0, 6).map(id => state.rows.get(id)!)).map(r => h('button', { class: 'pick', onclick: () => { app.select(r.id); app.focusPlane('folio'); } },
              h('span', null, r.name), h('span', { class: 'b' }, `${branchText(r.branch) ?? '—'}${r.status.value && changeCount(r.status.value) ? ` · ${changeCount(r.status.value)}` : ''}`)))),
          h('div', null, h('h2', { class: 'label' }, 'Keys'), h('div', { class: 'primer' }, ...primer.flatMap(([keys, label]) => [kbd(...keys), h('span', null, label)]))),
          state.recoveries.length ? h('div', null, h('h2', { class: 'label' }, 'Unsaved drafts'), ...state.recoveries.map(d => h('button', { class: 'pick', onclick: () => void openDraft(app, d.documentId, d.repositoryId, d.path) }, h('span', null, splitPath(d.path).base), h('span', { class: 'b' }, `${state.rows.get(d.repositoryId)?.name ?? ''}${d.updatedAt ? ` · ${relativeTime(d.updatedAt)}` : ''}`)))) : null),
        h('p', { class: 'colophon' }, h('b', null, 'minv'), ' — Minimal VS Code. The Code-OSS editor and a repository map. Nothing else competes for your attention.'));
    },
  };
}

/** Recovery: open the file, then put the draft text into the buffer (still unsaved). */
async function openDraft(app: App, documentId: string, repositoryId: string, path: string): Promise<void> {
  const draft = await app.call('fs.readRecovery', { documentId }); if (!draft) return;
  await app.openFile(repositoryId, path);
  const sheet = app.state.sheets.find(s => s.kind === 'file' && s.repositoryId === repositoryId && s.path === path);
  const rt = sheet && app.files.get(sheet.id);
  const apply = () => { if (rt?.handle && sheet) { rt.handle.setText(draft.text); if (rt.content?.kind === 'text' && rt.content.version !== draft.baseVersion) rt.diskChanged = {}; app.markDirty(sheet); app.store.update(() => {}); return true; } return false; };
  if (!apply()) { let tries = 0; const t = setInterval(() => { if (apply() || ++tries > 40) clearInterval(t); }, 50); }
  app.store.notify('info', `Restored your draft of ${splitPath(path).base}. It is not saved yet.`);
}

// ── Welcome (no workspace) ───────────────────────────────────────────────────

export function createWelcome(app: App): { element: HTMLElement; render(state: State): void } {
  const element = h('div', { class: 'welcome', hidden: true });
  return {
    element,
    render(state) {
      const show = state.booted && !state.workspace;
      attr(element, 'hidden', !show);
      if (!show) return;
      const key = JSON.stringify([state.recent, state.recoveries.length]);
      if (element.dataset.key === key) return;
      element.dataset.key = key;
      const hero = mark();
      element.replaceChildren(h('div', { class: 'front' },
        h('div', { class: 'hero-mark' }, hero, h('span', { class: 'wm' }, 'minv')),
        h('div', { class: 'expansion' }, h('u', null, 'Min'), 'imal ', h('u', null, 'V'), 'S Code.'),
        h('div', { class: 'tagline' }, 'Browse · Review · Commit'),
        h('div', { style: 'margin-top:32px;display:flex;gap:8px' }, h('button', { class: 'button primary', onclick: () => void app.openWorkspace() }, 'Open folder…', kbd(mod, 'O'))),
        h('div', { class: 'front-grid' },
          h('div', null, h('h2', { class: 'label' }, 'Recent'), ...(state.recent.length ? state.recent.map(r => h('button', { class: 'pick', disabled: !r.available, onclick: () => void app.openWorkspace(r.id) }, h('span', null, r.name), h('span', { class: 'b' }, r.available ? relativeTime(r.openedAt) : 'missing'))) : [h('p', { style: 'color:var(--fg3);margin:0' }, 'Nothing opened yet.')])),
          state.recoveries.length ? h('div', null, h('h2', { class: 'label' }, 'Unsaved drafts'), h('p', { style: 'color:var(--fg3);margin:0' }, `${plural(state.recoveries.length, 'draft')} kept from earlier sessions. Open their workspace to restore them.`)) : null),
        h('p', { class: 'colophon' }, 'No accounts, no assistants, no telemetry. Opening a folder never touches the network.')));
    },
  };
}

export { groupChanges };
