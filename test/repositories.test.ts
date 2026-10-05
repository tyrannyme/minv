import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import type * as vscode from 'vscode';
import type { RepositoryActions, RepositoryRow } from '../src/ui/repositories';

// The provider needs only workspace trust from the editor host. Keep this mock
// local to its import so core tests do not require a running extension host.
const workspace = { isTrusted: true, onDidGrantWorkspaceTrust: () => ({ dispose() {} }) };
const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
let RepositoriesView: typeof import('../src/ui/repositories').RepositoriesView;
try {
  loader._load = function (name: string, ...args: unknown[]): unknown {
    return name === 'vscode' ? { workspace } : originalLoad.call(this, name, ...args);
  };
  RepositoriesView = (require('../src/ui/repositories') as typeof import('../src/ui/repositories')).RepositoriesView;
} finally {
  loader._load = originalLoad;
}

function row(id = 'repo'): RepositoryRow {
  return {
    repository: { id, root: '/workspace/' + id, name: id, available: true },
    branch: { state: 'observed', value: { kind: 'branch', name: 'main' }, generation: 1 },
    status: { state: 'observed', generation: 1, value: { complete: true, changes: [
      { path: 'working.ts', index: '.', workingTree: 'M' },
      { path: 'staged.ts', index: 'A', workingTree: '.' },
      { path: 'new.ts', index: '?', workingTree: '?' },
    ] } },
  };
}

function fixture(rows = [row()]) {
  workspace.isTrusted = true;
  const calls: unknown[][] = [];
  const published: { rows: RepositoryRow[]; selectedId?: string }[] = [];
  let receive: (message: unknown) => void = () => assert.fail('provider not initialized');
  const actions: RepositoryActions = {
    select: (...args) => { calls.push(['select', ...args]); },
    refresh: (...args) => { calls.push(['refresh', ...args]); },
    openChange: (...args) => { calls.push(['openChange', ...args]); },
    stage: (...args) => { calls.push(['stage', ...args]); },
    unstage: (...args) => { calls.push(['unstage', ...args]); },
    commit: (...args) => { calls.push(['commit', ...args]); },
  };
  const webview = {
    html: '', options: {},
    onDidReceiveMessage(handler: typeof receive) { receive = handler; return { dispose() {} }; },
    postMessage(message: typeof published[number]) { published.push(message); return Promise.resolve(true); },
  };
  const view = { webview, onDidDispose: () => ({ dispose() {} }) };
  const provider = new RepositoriesView({ subscriptions: [] } as unknown as vscode.ExtensionContext, actions);
  provider.update(rows, rows[0]?.repository.id);
  provider.resolveWebviewView(view as unknown as vscode.WebviewView);
  return { provider, calls, published, rows, webview, send: (message: unknown) => receive(message) };
}

test('webview actions reject malformed messages and invented repositories or paths', () => {
  const f = fixture();
  for (const message of [null, [], 'stage', {}, { type: 'stage', id: 1, path: 'working.ts' },
    { type: 'stage', id: 'outside', path: 'working.ts' },
    { type: 'stage', id: 'repo', path: '../outside.ts' },
    { type: 'openChange', id: 'repo', path: 'working.ts', staged: 'false' },
    { type: 'openChange', id: 'repo', path: 'working.ts', staged: true },
    { type: 'unstage', id: 'repo', path: 'working.ts' },
    { type: 'stage', id: 'repo', path: 'staged.ts' },
  ]) f.send(message);
  assert.deepEqual(f.calls, []);
});

test('valid changes retain explicit repository, path and diff side', () => {
  const f = fixture();
  f.send({ type: 'stage', id: 'repo', path: 'working.ts' });
  f.send({ type: 'stage', id: 'repo', path: 'new.ts' });
  f.send({ type: 'unstage', id: 'repo', path: 'staged.ts' });
  f.send({ type: 'openChange', id: 'repo', path: 'staged.ts', staged: true });
  f.send({ type: 'commit', id: 'repo' });
  assert.deepEqual(f.calls, [
    ['stage', 'repo', 'working.ts'], ['stage', 'repo', 'new.ts'],
    ['unstage', 'repo', 'staged.ts'], ['openChange', 'repo', 'staged.ts', true], ['commit', 'repo'],
  ]);
});

test('stale, partial, unavailable and untrusted repositories cannot receive writes', () => {
  for (const mode of ['untrusted', 'stale-status', 'stale-branch', 'partial', 'unavailable']) {
    const r = row();
    const f = fixture([r]);
    if (mode === 'untrusted') workspace.isTrusted = false;
    if (mode === 'stale-status') r.status.state = 'stale';
    if (mode === 'stale-branch') r.branch.state = 'cached';
    if (mode === 'partial') r.status.value!.complete = false;
    if (mode === 'unavailable') r.repository.available = false;
    f.send({ type: 'stage', id: 'repo', path: 'working.ts' });
    f.send({ type: 'unstage', id: 'repo', path: 'staged.ts' });
    f.send({ type: 'commit', id: 'repo' });
    assert.deepEqual(f.calls, [], mode);
  }
});

test('commit requires staged changes and messages use the latest snapshot', () => {
  const f = fixture();
  const changed = row();
  changed.status.value!.changes = [];
  f.provider.update([changed], 'repo');
  f.send({ type: 'commit', id: 'repo' });
  f.send({ type: 'stage', id: 'repo', path: 'working.ts' });
  f.send({ type: 'openChange', id: 'repo', path: 'staged.ts', staged: true });
  assert.deepEqual(f.calls, []);
});

test('read navigation remains available in an untrusted workspace', () => {
  const f = fixture();
  workspace.isTrusted = false;
  f.send({ type: 'select', id: 'repo' });
  f.send({ type: 'openChange', id: 'repo', path: 'working.ts', staged: false });
  f.send({ type: 'refresh' });
  assert.deepEqual(f.calls, [['select', 'repo'], ['openChange', 'repo', 'working.ts', false], ['refresh']]);
});

test('updates preserve established row order and wait for webview readiness', () => {
  const f = fixture([row('a'), row('b')]);
  assert.equal(f.published.length, 0);
  f.send({ type: 'ready' });
  f.provider.update([row('b'), row('c'), row('a')], 'b');
  assert.deepEqual(f.published.at(-1)!.rows.map(item => item.repository.id), ['a', 'b', 'c']);
  assert.equal(f.published.at(-1)!.selectedId, 'b');
});

test('webview uses a nonce CSP and never embeds repository strings in HTML', () => {
  const r = row();
  r.repository.name = '</script><script>alert("unexpected")</script>';
  const f = fixture([r]);
  assert.match(f.webview.html, /default-src 'none'/);
  assert.match(f.webview.html, /script-src 'nonce-[^']+'/);
  assert.ok(!f.webview.html.includes(r.repository.name));
  assert.deepEqual(f.webview.options, { enableScripts: true, localResourceRoots: [] });
});
