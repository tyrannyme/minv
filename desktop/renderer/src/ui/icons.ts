/** The only pictograms Minv draws. Everything else is typography. */
const svg = (body: string, view = '0 0 10 10', stroke = 1.3) => {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="${view}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  return t.content.firstElementChild as SVGElement;
};
export const chevron = () => svg('<path d="M2 3.5 5 6.5 8 3.5"/>');
export const close = () => svg('<path d="M2 2l6 6M8 2 2 8"/>', '0 0 10 10', 1.4);
export const minimize = () => svg('<path d="M1 5h8"/>', '0 0 10 10', 1.1);
export const maximize = () => svg('<rect x="1.5" y="1.5" width="7" height="7" rx="1"/>', '0 0 10 10', 1.1);
/** The Minv mark: an m standing on three repositories; the last one carries the signal. */
export const mark = () => {
  const el = svg('<rect x="0.5" y="0.5" width="23" height="23" rx="7" fill="var(--fg)" stroke="none"/><path d="M6.5 15V10.6a2.75 2.75 0 0 1 5.5 0V15m0-4.4a2.75 2.75 0 0 1 5.5 0V15" stroke="var(--canvas)" stroke-width="1.9"/><circle cx="6.5" cy="18.2" r="1.35" fill="var(--canvas)" stroke="none"/><circle cx="12" cy="18.2" r="1.35" fill="var(--canvas)" stroke="none"/><circle cx="17.5" cy="18.2" r="1.35" fill="var(--accent)" stroke="none"/>', '0 0 24 24', 1.9);
  return el;
};
export const search = () => svg('<circle cx="4.4" cy="4.4" r="3.2"/><path d="M6.8 6.8 9 9"/>', '0 0 10 10', 1.3);
