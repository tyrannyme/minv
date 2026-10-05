import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Git } from '../src/core/git';
import type { GitRunner } from '../src/core/types';
import { StateStore } from '../desktop/main/state';
import { WorkspaceSession } from '../desktop/main/workspace';

const exec = promisify(execFile);
async function fixture(t: test.TestContext, options: { git?: GitRunner; confirm?: () => Promise<boolean> } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'minv-workspace-'));
  const root = path.join(directory, 'project'); const data = path.join(directory, 'state');
  await mkdir(root); await mkdir(data);
  const git = new Git(); const state = new StateStore(data); await state.load();
  const events: {event: string; payload: any}[] = [];
  const session = new WorkspaceSession({ state, git: options.git ?? git, dataDirectory: data,
    emit: (event, payload) => events.push({ event, payload }), confirm: options.confirm ?? (async () => true), choose: async () => undefined });
  t.after(async () => { await session.close(); git.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { root, data, directory, session, state, events };
}
async function init(root: string) {
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await exec('git', ['-C', root, 'config', 'user.email', 'workspace@example.invalid']);
  await exec('git', ['-C', root, 'config', 'user.name', 'Workspace test']);
  await writeFile(path.join(root, 'hello.txt'), 'hello\n');
  await exec('git', ['-C', root, 'add', 'hello.txt']);
  await exec('git', ['-C', root, 'commit', '-qm', 'initial']);
}

test('workspace restores cached branch as unverified and isolates browsing from trust', async t => {
  const { root, session } = await fixture(t); await init(root);
  const initial = await session.open([root]); assert.equal(initial.trusted, false);
  assert.equal(initial.rows[0]?.branch.state, 'unknown');
  await session.ready; await session.settled();
  const verified = session.snapshot!; const id = verified.rows[0]!.id;
  assert.equal(verified.discovery, 'complete'); assert.equal(verified.rows[0]!.branch.value?.name, 'main');
  assert.equal(verified.rows[0]!.status.state, 'observed');
  const document = await session.handlers['fs.read']!({ repositoryId: id, path: 'hello.txt' });
  assert.equal(document.kind, 'text');
  await assert.rejects(async () => session.handlers['fs.createFile']!({ repositoryId: id, path: 'untrusted.txt' }), /Trust this workspace/);
  await session.close();
  const reopened = await session.open([root]);
  assert.equal(reopened.discovery, 'cached'); assert.equal(reopened.rows[0]!.branch.state, 'cached');
  assert.equal(reopened.rows[0]!.branch.value?.name, 'main');
  assert.equal(session.repository(id).available, false, 'cached metadata must not authorize Git');
  await session.ready; await session.settled();
});

test('missing Git leaves plain-folder reading usable and rejects writes without trust', async t => {
  const missingGit: GitRunner = { run: async () => { throw new Error('Git executable unavailable'); } };
  const { root, session } = await fixture(t, { git: missingGit });
  await writeFile(path.join(root, 'plain.txt'), 'works without Git');
  const opened = await session.open([root]); await session.ready; await session.settled();
  assert.equal(session.snapshot?.gitAvailable, false);
  const id = opened.rows[0]!.id;
  const listing = await session.handlers['fs.list']!({ repositoryId: id, dir: '' });
  assert(listing.entries.some(entry => entry.name === 'plain.txt'));
  const document = await session.handlers['fs.read']!({ repositoryId: id, path: 'plain.txt' });
  assert.equal(document.kind === 'text' ? document.text : '', 'works without Git');
  await session.handlers['workspace.trust']!({ trusted: true });
  await session.handlers['fs.createFile']!({ repositoryId: id, path: 'new.txt' });
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), '');
});

test('opening a repository subfolder never authorizes its ancestor', async t => {
  const { root, session } = await fixture(t); await init(root);
  const child = path.join(root, 'approved'); await mkdir(child); await writeFile(path.join(child, 'inside.txt'), 'inside');
  await session.open([child]); await session.ready; await session.settled();
  assert(session.repositories().every(repository => repository.root === child));
  const repository = session.repositories()[0]!; assert.equal(repository.available, false);
  const result = await session.handlers['fs.read']!({ repositoryId: repository.id, path: 'inside.txt' });
  assert.equal(result.kind, 'text');
  await assert.rejects(async () => session.handlers['fs.read']!({ repositoryId: repository.id, path: '../hello.txt' }), /escapes|relative|outside|Invalid/i);
});

test('a rejected replacement preserves the current workspace and late trust cannot authorize another one', async t => {
  let confirm!: (value: boolean) => void;
  const { root, directory, session } = await fixture(t, { confirm: () => new Promise(resolve => { confirm = resolve; }) });
  await session.open([root]); await session.ready; await session.settled();
  const old = session.snapshot!.id;
  await assert.rejects(session.open([path.join(directory, 'missing')]));
  assert.equal(session.snapshot?.id, old);
  const pending = Promise.resolve(session.handlers['workspace.trust']!({ trusted: true }));
  const replacement = path.join(directory, 'replacement'); await mkdir(replacement);
  await session.open([replacement]); confirm(true);
  await assert.rejects(pending, /Workspace changed/);
  assert.equal(session.snapshot?.trusted, false); await session.ready; await session.settled();
});

test('status tickets bind to the displayed generation and revoked trust invalidates them', async t => {
  const { root, session } = await fixture(t); await init(root);
  await writeFile(path.join(root, 'hello.txt'), 'changed\n');
  await session.open([root]); await session.ready; await session.settled();
  await session.handlers['workspace.trust']!({ trusted: true });
  // Selection refreshes the status with a fingerprint captured around its display.
  await session.handlers['repo.select']!({ id: session.snapshot!.rows[0]!.id });
  for (let attempt = 0; attempt < 200 && session.snapshot!.rows[0]!.status.state !== 'observed'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const row = session.snapshot!.rows[0]!; assert.equal(row.status.state, 'observed');
  const token = await session.handlers['git.prepare']!({ repositoryId: row.id, action: 'stage', paths: ['hello.txt'], basis: { kind: 'status', generation: row.status.generation } });
  await session.handlers['workspace.trust']!({ trusted: false });
  await assert.rejects(async () => session.handlers['git.stage']!({ repositoryId: row.id, paths: ['hello.txt'], token: token.token }), /Trust this workspace/);
  const staged = await exec('git', ['-C', root, 'diff', '--cached', '--name-only']); assert.equal(staged.stdout, '');
});


test('cached rows paint before Git resumes and close suppresses late discovery', async t => {
  let release!: () => void; let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  let block = false;
  const real = new Git(); t.after(() => real.dispose());
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow: GitRunner = { run: async (cwd, args, options) => { if (block && args[0] === '--version') { started(); await gate; } return real.run(cwd, args, options); } };
  const { root, session, events } = await fixture(t, { git: slow }); await init(root);
  await session.open([root]); await session.ready; await session.settled(); await session.close();
  block = true;
  const reopened = await session.open([root]);
  assert.equal(reopened.rows[0]!.branch.state, 'cached');
  assert.equal(reopened.rows[0]!.branch.value?.name, 'main');
  await start; await session.close(); const count = events.length;
  release(); await session.ready;
  assert.equal(session.snapshot, null); assert.equal(events.length, count, 'old discovery must not publish into a closed workspace');
});

test('an invalidated in-flight branch cannot replace a newer observation', async t => {
  let release!: () => void; let started!: () => void; let first = true;
  const start = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const real = new Git(); t.after(() => real.dispose());
  const slow: GitRunner = { run: async (cwd, args, options) => {
    if (first && args.join(' ') === 'symbolic-ref --quiet --short HEAD') { first = false; started(); await gate; return { stdout: 'obsolete\n', stderr: '', exitCode: 0 }; }
    return real.run(cwd, args, options);
  } };
  const { root, session, events } = await fixture(t, { git: slow }); await init(root);
  const opened = await session.open([root]); await start;
  await session.handlers['repo.refresh']!({ id: opened.rows[0]!.id }); release();
  await session.ready; await session.settled();
  assert.equal(session.snapshot!.rows[0]!.branch.value?.name, 'main');
  const published = events.flatMap(event => event.payload?.rows ?? []);
  assert(!published.some(row => row.branch?.state === 'observed' && row.branch?.value?.name === 'obsolete'));
});


test('selecting the already selected row emits no workspace loop', async t => {
  const { root, session, events } = await fixture(t); await session.open([root]); await session.ready; await session.settled();
  const count = events.filter(event => event.event === 'workspace').length;
  await session.handlers['repo.select']!({ id: session.snapshot!.selectedId! });
  assert.equal(events.filter(event => event.event === 'workspace').length, count);
});

test('renderer session survives workspace switches and rejects delayed saves from another workspace', async t => {
  const { root, directory, session } = await fixture(t);
  const first = await session.open([root]); await session.ready; await session.settled();
  const id = first.rows[0]!.id;
  const saved: import('../desktop/shared/session').RendererSession = {
    version: 1, workspaceId: first.id, selectedId: id, order: [id], pins: [id], layout: 'flat', collapsed: [], tab: 'files',
    sheets: [{ id: 's1', kind: 'file', repositoryId: id, path: 'remember.txt', view: { line: 2, column: 3, scrollTop: 55, scrollLeft: 0 } }],
    activeSheet: 's1', focusedPane: 'main', plane: 'sheet', focus: false, indexScrollTop: 4,
    expandedDirectories: [{ repositoryId: id, paths: ['', 'src'], scrollTop: 12 }], commitDrafts: [{ repositoryId: id, text: 'remember my commit' }],
  };
  await session.saveSession(saved);
  const other = path.join(directory, 'other'); await mkdir(other); await session.open([other]); await session.ready; await session.settled();
  assert.equal(session.sessionState(), null);
  await assert.rejects(session.saveSession(saved), /different workspace/);
  await session.open([root]); await session.ready; await session.settled();
  assert.deepEqual(session.sessionState(), saved);
  await assert.rejects(async () => session.handlers['fs.read']!({ repositoryId: 'a'.repeat(24), path: 'remember.txt' }), /Unknown repository/);
});

test('changing status still publishes a stale sample without authorizing a write', async t => {
  const real = new Git(); t.after(() => real.dispose()); let revision = 0;
  const changing: GitRunner = { run: async (cwd, args, options) => {
    if (args.join(' ') === 'rev-parse --verify --quiet HEAD') return { stdout: (++revision).toString(16).padStart(40, '0') + '\n', stderr: '', exitCode: 0 };
    return real.run(cwd, args, options);
  } };
  const { root, session } = await fixture(t, { git: changing }); await init(root); await writeFile(path.join(root, 'hello.txt'), 'changing content\n');
  await session.open([root]); await session.ready; await session.settled();
  await session.handlers['workspace.trust']!({ trusted: true }); await session.settled();
  const row = session.snapshot!.rows[0]!;
  assert.equal(row.status.state, 'stale'); assert(row.status.observedAt);
  assert(row.status.value?.changes.some(change => change.path === 'hello.txt'));
  await assert.rejects(async () => session.handlers['git.prepare']!({ repositoryId: row.id, action: 'stage', paths: ['hello.txt'], basis: { kind: 'status', generation: row.status.generation } }), /displayed status is out of date/);
});
