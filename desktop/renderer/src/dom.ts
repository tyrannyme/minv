type Child = Node | string | false | null | undefined;
type Listener = (event: never) => void;
type Props = Record<string, string | number | boolean | Listener | undefined | null>;

/** Tiny element factory. `on*` props bind listeners; booleans toggle attributes. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props) for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === 'class') element.className = String(value);
    else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === false || child === null || child === undefined) continue;
    element.append(child);
  }
  return element;
}

export function text(element: Element, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

export function attr(element: Element, name: string, value: string | null | undefined | boolean): void {
  if (value === null || value === undefined || value === false) { if (element.hasAttribute(name)) element.removeAttribute(name); return; }
  const next = value === true ? '' : value;
  if (element.getAttribute(name) !== next) element.setAttribute(name, next);
}

/** Keyed list reconciliation that keeps existing nodes (and their focus) in place. */
export function syncList<T>(container: Element, items: readonly T[], key: (item: T) => string, create: (item: T) => HTMLElement, update: (element: HTMLElement, item: T) => void): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children) as HTMLElement[]) {
    const id = child.dataset.key;
    if (id !== undefined) existing.set(id, child);
  }
  let cursor: ChildNode | null = container.firstChild;
  for (const item of items) {
    const id = key(item);
    let element = existing.get(id);
    if (element) existing.delete(id);
    else { element = create(item); element.dataset.key = id; }
    update(element, item);
    if (element !== cursor) container.insertBefore(element, cursor);
    else cursor = cursor.nextSibling;
  }
  for (const stale of existing.values()) stale.remove();
}

export function kbd(...keys: string[]): HTMLElement {
  return h('span', { class: 'keys', 'aria-hidden': 'true' }, ...keys.map(key => h('kbd', null, key)));
}

export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
export const mod = isMac ? '⌘' : 'Ctrl';
