import type { App, ChooseOptions, ConfirmOptions, PickItem, PickOptions, PromptOptions } from '../app.js';
import { h, kbd } from '../dom.js';

/** One overlay at a time; focus returns to where it was. */
function open(content: HTMLElement, onClose: () => void, label: string): () => void {
  const previous = document.activeElement as HTMLElement | null;
  const scrim = h('div', { class: 'scrim', role: 'presentation' }, content);
  content.setAttribute('role', 'dialog'); content.setAttribute('aria-modal', 'true'); content.setAttribute('aria-label', label);
  scrim.addEventListener('mousedown', e => { if (e.target === scrim) { close(); onClose(); } });
  document.body.append(scrim);
  let closed = false;
  function close() { if (closed) return; closed = true; scrim.remove(); previous?.focus?.(); }
  return close;
}

function highlight(text: string, query: string): (Node | string)[] {
  const q = query.trim().toLowerCase();
  if (!q) return [text];
  const at = text.toLowerCase().indexOf(q);
  if (at >= 0) return [text.slice(0, at), h('mark', null, text.slice(at, at + q.length)), text.slice(at + q.length)];
  return [text];
}

export function installOverlays(app: App): void {
  app.pick = (options: PickOptions) => {
    const input = h('input', { type: 'text', placeholder: options.placeholder, 'aria-label': options.placeholder, spellcheck: 'false', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pick-results' });
    const results = h('div', { class: 'results', id: 'pick-results', role: 'listbox' });
    const card = h('div', { class: 'palette' }, input, options.context ? h('div', { class: 'context' }, options.context) : null, results);
    let items: PickItem[] = [];
    let active = 0;
    let generation = 0;
    const close = open(card, () => {}, options.placeholder);
    const render = () => {
      results.replaceChildren();
      if (!items.length) { results.append(h('div', { class: 'none' }, input.value ? 'Nothing matches.' : 'Start typing.')); return; }
      let group: string | undefined;
      items.forEach((item, i) => {
        if (item.group && item.group !== group) { group = item.group; results.append(h('div', { class: 'group', role: 'presentation' }, group)); }
        const el = h('div', { class: 'item', role: 'option', id: `pick-${i}`, 'aria-selected': String(i === active), onmousemove: () => { if (active !== i) { active = i; render(); } }, onmousedown: (e: Event) => { e.preventDefault(); choose(i); } },
          h('span', { class: 'p' }, ...highlight(item.primary, input.value)), h('span', { class: 's' }, item.secondary ?? ''), h('span', { class: 'h' }, item.hint ?? ''));
        results.append(el);
      });
      input.setAttribute('aria-activedescendant', `pick-${active}`);
      results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    };
    const update = async () => {
      const mine = ++generation;
      const next = await options.items(input.value);
      if (mine !== generation) return;
      items = next; active = 0; render();
    };
    const choose = (i: number) => { const item = items[i]; if (!item) return; close(); void item.run(); };
    input.addEventListener('input', () => void update());
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { choose(active); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); }
    });
    input.focus();
    void update();
  };

  app.confirm = (o: ConfirmOptions) => new Promise<boolean>(resolve => {
    let done = false;
    const finish = (value: boolean) => { if (done) return; done = true; close(); resolve(value); };
    const cancel = h('button', { class: 'button', onclick: () => finish(false) }, 'Cancel');
    const ok = h('button', { class: `button ${o.danger ? 'solid-danger' : 'primary'}`, onclick: () => finish(true) }, o.confirm);
    const card = h('div', { class: 'dialog', onkeydown: (e: KeyboardEvent) => { if (e.key === 'Escape') { finish(false); e.stopPropagation(); } } },
      h('h2', null, o.title), h('p', null, o.body),
      o.paths?.length ? h('ul', { class: 'paths', 'aria-label': 'Affected' }, ...o.paths.map(p => h('li', null, p))) : null,
      h('div', { class: 'row-actions' }, cancel, ok));
    const close = open(card, () => finish(false), o.title);
    // Destructive choices default to Cancel.
    (o.danger ? cancel : ok).focus();
  });

  app.choose = (o: ChooseOptions) => new Promise<string | undefined>(resolve => {
    let done = false;
    const finish = (value: string | undefined) => { if (done) return; done = true; close(); resolve(value); };
    const buttons = o.options.map(opt => h('button', { class: `button ${opt.primary ? 'primary' : opt.danger ? 'solid-danger' : ''}`, onclick: () => finish(opt.id) }, opt.label));
    const card = h('div', { class: 'dialog', onkeydown: (e: KeyboardEvent) => { if (e.key === 'Escape') { finish(undefined); e.stopPropagation(); } } },
      h('h2', null, o.title), h('p', null, o.body),
      o.paths?.length ? h('ul', { class: 'paths', 'aria-label': 'Files' }, ...o.paths.map(p => h('li', null, p))) : null,
      h('div', { class: 'row-actions' }, ...[...buttons].reverse()));
    const close = open(card, () => finish(undefined), o.title);
    buttons[o.options.findIndex(x => x.primary)]?.focus();
  });

  app.prompt = (o: PromptOptions) => new Promise<string | undefined>(resolve => {
    let done = false;
    const finish = (value: string | undefined) => { if (done) return; done = true; close(); resolve(value); };
    const input = h('input', { class: 'field', type: 'text', value: o.value ?? '', spellcheck: 'false' });
    const error = h('div', { class: 'error-text', role: 'alert' });
    const submit = () => { const message = o.validate?.(input.value); if (message) { error.textContent = message; return; } finish(input.value); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { submit(); e.preventDefault(); } });
    const card = h('div', { class: 'dialog', onkeydown: (e: KeyboardEvent) => { if (e.key === 'Escape') { finish(undefined); e.stopPropagation(); } } },
      h('h2', null, o.title), o.body ? h('p', null, o.body) : null,
      h('label', null, o.label, input), error,
      h('div', { class: 'row-actions' }, h('button', { class: 'button', onclick: () => finish(undefined) }, 'Cancel'), h('button', { class: 'button primary', onclick: submit }, o.confirm)));
    const close = open(card, () => finish(undefined), o.title);
    input.focus();
    if (o.select) input.setSelectionRange(o.select[0], o.select[1]); else input.select();
  });

  app.menu = (anchor, entries) => {
    document.querySelector('.menu')?.remove();
    const previous = document.activeElement as HTMLElement | null;
    const menu = h('div', { class: 'menu', role: 'menu' });
    const close = () => { menu.remove(); document.removeEventListener('mousedown', outside, true); previous?.focus?.(); };
    const outside = (e: Event) => { if (!menu.contains(e.target as Node)) close(); };
    for (const entry of entries) {
      if (entry === 'sep') { menu.append(h('hr')); continue; }
      menu.append(h('button', { role: 'menuitem', class: entry.danger ? 'danger' : '', onclick: () => { close(); entry.run(); } }, entry.label, entry.hint ? h('span', { class: 'h' }, entry.hint) : null));
    }
    menu.addEventListener('keydown', e => {
      const buttons = [...menu.querySelectorAll('button')];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') { buttons[(i + 1) % buttons.length]?.focus(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); e.stopPropagation(); }
    });
    document.body.append(menu);
    const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, right: anchor.x };
    const w = menu.offsetWidth, hgt = menu.offsetHeight;
    menu.style.left = `${Math.min(rect.left, innerWidth - w - 8)}px`;
    menu.style.top = `${Math.min(rect.bottom + 4, innerHeight - hgt - 8)}px`;
    setTimeout(() => document.addEventListener('mousedown', outside, true));
    menu.querySelector('button')?.focus();
  };
}

export function renderNotices(app: App, container: HTMLElement, live: HTMLElement): void {
  const notices = app.state.notices;
  const ids = notices.map(n => String(n.id)).join();
  if (container.dataset.ids === ids) return;
  container.dataset.ids = ids;
  container.replaceChildren(...notices.map(n => h('div', { class: `notice ${n.level}`, role: n.level === 'error' ? 'alert' : 'status' },
    h('div', { class: 'msg' }, h('b', null, n.level === 'error' ? 'Failed. ' : n.level === 'warning' ? 'Note. ' : ''), n.message, n.detail ? h('span', { class: 'detail' }, n.detail) : null),
    h('button', { class: 'button quiet', 'aria-label': 'Dismiss', onclick: () => app.store.update(s => { s.notices = s.notices.filter(x => x !== n); }) }, 'Dismiss'))));
  const last = notices.at(-1);
  if (last) live.textContent = last.message;
}

export { kbd };
