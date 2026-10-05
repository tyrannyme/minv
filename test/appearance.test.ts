import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(__dirname, '..', '..');
const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
let welcomeHtml: typeof import('../src/ui/welcome').welcomeHtml;
try {
  loader._load = function (name: string, ...args: unknown[]): unknown { return name === 'vscode' ? {} : originalLoad.call(this, name, ...args); };
  welcomeHtml = (require('../src/ui/welcome') as typeof import('../src/ui/welcome')).welcomeHtml;
} finally {
  loader._load = originalLoad;
}

test('extension icon and state colors remain declared', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(existsSync(path.join(root, manifest.contributes.viewsContainers.activitybar[0].icon)));
  const colors: Array<{ id: string; defaults: Record<string, string> }> = manifest.contributes.colors;
  const ids = colors.map(color => color.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['modified', 'added', 'deleted', 'untracked', 'conflict', 'pending']) {
    assert.ok(ids.includes(`minv.${id}`), `Missing ${id} state color`);
  }
  for (const color of colors) {
    for (const variant of ['dark', 'light', 'highContrast', 'highContrastLight']) {
      assert.ok(color.defaults[variant], `${color.id} missing ${variant} default`);
    }
  }
});

test('home page uses a nonce CSP and offers only fixed commands', () => {
  const html = welcomeHtml('<svg viewBox="0 0 24 24"></svg>', 'Ctrl');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-[^']+'/);
  const commands = [...html.matchAll(/data-command="([^"]+)"/g)].map(match => match[1]);
  assert.ok(commands.length > 0);
  for (const command of commands) assert.match(command!, /^(minv\.|workbench\.(action|view)\.)/);
});
