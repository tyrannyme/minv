// Tour tabs.
const tabs = [...document.querySelectorAll('[role="tab"]')];
tabs.forEach(tab => tab.addEventListener('click', () => select(tab)));
document.querySelector('.tabs')?.addEventListener('keydown', event => {
  const at = tabs.indexOf(document.activeElement);
  if (at < 0 || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const next = tabs[(at + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  select(next); next.focus();
});
function select(tab) {
  for (const other of tabs) {
    const on = other === tab;
    other.setAttribute('aria-selected', String(on));
    other.tabIndex = on ? 0 : -1;
    document.getElementById(other.getAttribute('aria-controls')).hidden = !on;
  }
}

// Dark and light comparison.
const compare = document.querySelector('.compare');
compare?.querySelector('input').addEventListener('input', event => compare.style.setProperty('--split', `${event.target.value}%`));

// Everyone who isn't on Linux is told it's Linux-only for now.
if (!/Linux/.test(navigator.userAgent) || /Android/.test(navigator.userAgent)) {
  document.querySelector('[data-platform-note]').innerHTML = 'Linux x64 only for now. <a href="https://github.com/tyrannyme/minv">Watch the repo</a> for macOS and Windows.';
}
