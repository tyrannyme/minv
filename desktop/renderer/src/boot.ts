/** Shared renderer boot. Entry points supply the host and editor; nothing here knows about fixtures. */
import { App } from './app.js';
import { normalizeAppearance, type EditorAdapter, type MinvHost } from './contract.js';
import { h } from './dom.js';
import { Store, type Plane } from './state.js';
import { themeFromTokens } from './editor/codeoss.js';
import { createFolio } from './ui/folio.js';
import { createIndex, createMasthead, openPalette } from './ui/index.js';
import { installOverlays, renderNotices } from './ui/overlays.js';
import { createDesk, createWelcome } from './ui/sheets.js';

export async function start(host: MinvHost, editor: EditorAdapter | undefined): Promise<App> {
  const store = new Store();
  const app = new App(host, editor, store);
  installOverlays(app);

  const masthead = createMasthead(app);
  const index = createIndex(app);
  const folio = createFolio(app);
  const desk = createDesk(app);
  const welcome = createWelcome(app);
  const notices = h('div', { class: 'notices', 'aria-live': 'polite' });
  const live = h('div', { class: 'visually-hidden', 'aria-live': 'polite', role: 'status' });
  const sash = (variable: '--index-w' | '--folio-w', min: number, max: number, column: number) => {
    const grip = h('div', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': variable === '--index-w' ? 'Resize index' : 'Resize folio' });
    const el = h('div', { class: 'sash', style: `grid-column:${column};` }, grip);
    grip.addEventListener('pointerdown', e => {
      grip.setPointerCapture(e.pointerId); grip.classList.add('dragging');
      const start = e.clientX, initial = parseFloat(getComputedStyle(frame).getPropertyValue(variable)) || min;
      const move = (ev: PointerEvent) => frame.style.setProperty(variable, `${Math.max(min, Math.min(max, initial + ev.clientX - start))}px`);
      const up = () => { grip.classList.remove('dragging'); grip.removeEventListener('pointermove', move); localStorage.setItem(`minv${variable}`, frame.style.getPropertyValue(variable)); desk.layout(); };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up, { once: true });
    });
    grip.addEventListener('dblclick', () => { frame.style.removeProperty(variable); localStorage.removeItem(`minv${variable}`); desk.layout(); });
    return el;
  };
  const frame = h('div', { class: 'app' }, masthead.element, index.element, sash('--index-w', 220, 520, 2), folio.element, sash('--folio-w', 280, 620, 3), desk.element);
  for (const v of ['--index-w', '--folio-w'] as const) { const saved = localStorage.getItem(`minv${v}`); if (saved) frame.style.setProperty(v, saved); }
  document.body.replaceChildren(frame, welcome.element, notices, live);

  app.focusPlane = (plane: Plane) => {
    store.update(s => { s.plane = plane; if (s.focus && plane !== 'sheet') s.focus = false; });
    requestAnimationFrame(() => plane === 'index' ? index.focus() : plane === 'folio' ? folio.focus() : desk.focus());
  };

  // Appearance → root attributes → editor theme, all from the same tokens.
  const root = document.documentElement;
  const media = [matchMedia('(prefers-color-scheme: light)'), matchMedia('(prefers-contrast: more)')];
  let lastTheme = '';
  const applyTheme = () => {
    const p = store.state.prefs;
    const appearance = normalizeAppearance(p.appearance);
    root.dataset.theme = appearance; root.dataset.motion = p.motion; root.dataset.density = p.density;
    const signature = `${appearance}|${media.map(m => m.matches).join()}`;
    if (signature !== lastTheme && editor) {
      lastTheme = signature;
      const contrast = appearance.endsWith('contrast') || (appearance === 'system' && media[1]!.matches);
      editor.setTheme(themeFromTokens(getComputedStyle(root), contrast));
    }
  };
  for (const m of media) m.addEventListener('change', () => { lastTheme = ''; applyTheme(); });
  let lastOptions = '';

  store.subscribe(state => {
    applyTheme();
    const o = { fontSize: state.prefs.editorFontSize, tabSize: state.prefs.tabSize, wordWrap: state.prefs.wordWrap, renderWhitespace: state.prefs.renderWhitespace };
    if (editor && JSON.stringify(o) !== lastOptions) { lastOptions = JSON.stringify(o); editor.setOptions(o); }
    document.body.classList.toggle('platform-darwin', state.workspace?.platform === 'darwin');
    frame.classList.toggle('focus', state.focus);
    frame.classList.toggle('empty', !state.workspace);
    document.title = state.workspace ? `${state.workspace.name} · Minv` : 'Minv';
    masthead.render(state);
    if (state.workspace) { index.render(state); folio.render(state); desk.render(state); }
    welcome.render(state);
    renderNotices(app, notices, live);
    app.scheduleSave();
  });
  // Relative times ("checked 12 s ago") stay honest without host traffic.
  setInterval(() => store.update(() => {}), 10_000);
  addEventListener('resize', () => desk.layout());

  installKeys(app, index);
  applyTheme();
  await app.boot();
  return app;
}

function installKeys(app: App, index: { focusFind(): void }): void {
  addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = e.target instanceof HTMLElement && (e.target.matches('input, textarea, [contenteditable]') || !!e.target.closest('.monaco-editor'));
    const key = e.key.toLowerCase();
    const run = (fn: () => void) => { e.preventDefault(); e.stopPropagation(); fn(); };
    if (document.querySelector('.scrim')) return;
    if (mod && !e.shiftKey && (key === 'k' || key === 'p')) return run(() => openPalette(app));
    if (mod && e.shiftKey && key === 'p') return run(() => openPalette(app, '>'));
    if (mod && key === 'o' && !e.shiftKey) return run(() => void app.openWorkspace());
    if (!app.state.workspace) return;
    if (mod && !e.shiftKey && key === 's') return run(() => void app.save());
    if (mod && !e.shiftKey && key === 'w') return run(() => { const s = app.focusedSheet(); if (s) void app.closeSheet(s.id); });
    if (mod && key === '\\') return run(() => app.toggleSplit());
    if (mod && !e.shiftKey && key === 'b') return run(() => app.store.update(s => { s.focus = !s.focus; }));
    if (mod && e.shiftKey && key === 'b') return run(() => void app.branchPicker());
    if (mod && key === ',') return run(() => app.openSettings());
    if (mod && e.key === 'Tab') return run(() => app.cycleSheet(e.shiftKey ? -1 : 1));
    if (mod && !e.shiftKey && key === 'r') return run(() => void app.refreshSelected());
    if (mod && e.shiftKey && key === 'r') return run(() => void app.refreshAll());
    if (mod && e.shiftKey && key === 'f') return run(() => { app.search.workspace = true; app.setTab('search'); app.focusPlane('folio'); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.search-form input')?.focus()); });
    if (mod && ['1', '2', '3'].includes(e.key)) return run(() => app.focusPlane(e.key === '1' ? 'index' : e.key === '2' ? 'folio' : 'sheet'));
    if (e.altKey && ['1', '2', '3', '4'].includes(e.key)) return run(() => { app.setTab((['changes', 'files', 'history', 'search'] as const)[Number(e.key) - 1]!); app.focusPlane('folio'); });
    if (e.key === 'F6') return run(() => { const order = ['index', 'folio', 'sheet'] as const; const at = order.indexOf(app.state.plane); app.focusPlane(order[(at + (e.shiftKey ? 2 : 1)) % 3]!); });
    if (!typing && e.key === '/' && !mod) return run(() => index.focusFind());
    if (!typing && e.key === 'Escape' && document.activeElement?.closest('.desk')) return run(() => app.focusPlane('folio'));
  }, true);
}
