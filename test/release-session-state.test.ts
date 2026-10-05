import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStateStore, validateRendererSession } from '../desktop/main/session-state';
import type { RendererSession } from '../desktop/shared/session';

const workspace = 'a'.repeat(24); const repository = 'b'.repeat(24);
function sample(id = workspace): RendererSession {
  return { version: 1, workspaceId: id, selectedId: repository, order: [repository], pins: [repository], layout: 'flat', collapsed: [], tab: 'files',
    sheets: [{ id: 's1', kind: 'file', repositoryId: repository, path: 'src/main.ts', view: { line: 42, column: 5, scrollTop: 321.5, scrollLeft: 4 } }, { id: 's2', kind: 'settings' }],
    activeSheet: 's1', splitSheet: 's2', focusedPane: 'split', plane: 'sheet', focus: false, indexScrollTop: 7.5,
    expandedDirectories: [{ repositoryId: repository, paths: ['', 'src'], scrollTop: 12 }], commitDrafts: [{ repositoryId: repository, text: 'Work in progress\n\nCommit message draft.' }] };
}

test('durable sessions preserve panes, view positions and drafts independently per workspace', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'minv-session-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStateStore(directory); const first = sample(); const second = sample('c'.repeat(24)); second.layout = 'tree'; second.commitDrafts = [];
  await Promise.all([store.save(first), store.save(second)]);
  first.commitDrafts[0]!.text = 'mutated caller';
  const reloaded = await new SessionStateStore(directory).load(workspace);
  assert.equal(reloaded?.commitDrafts[0]?.text, 'Work in progress\n\nCommit message draft.');
  assert.equal(reloaded?.sheets[0]?.view?.scrollTop, 321.5);
  assert.equal(reloaded?.splitSheet, 's2');
  assert.equal((await store.load(second.workspaceId))?.layout, 'tree');
  assert.equal((await stat(path.join(directory, 'sessions', workspace + '.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(directory, 'sessions'))).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(path.join(directory, 'sessions'))).sort(), [workspace + '.json', second.workspaceId + '.json'].sort());
});

test('session schemas cannot carry source contents, capabilities, traversal or another workspace', () => {
  const original = sample();
  assert.throws(() => validateRendererSession({ ...original, text: 'source contents' }), /Unknown or invalid session field/);
  assert.throws(() => validateRendererSession({ ...original, sheets: [{ ...original.sheets[0], text: 'source contents' }] }), /Unknown or invalid session field/);
  assert.throws(() => validateRendererSession({ ...original, sheets: [{ ...original.sheets[0], waits: ['capability'] }] }), /Unknown or invalid session field/);
  for (const escape of ['../secret', '/etc/passwd', 'C:/outside', '.git/config', 'safe/../../outside', 'safe\\..\\outside']) {
    assert.throws(() => validateRendererSession({ ...original, sheets: [{ ...original.sheets[0], path: escape }], splitSheet: undefined, focusedPane: 'main' }), /inside a repository/);
  }
  assert.throws(() => validateRendererSession(original, 'c'.repeat(24)), /different workspace/);
  assert.throws(() => validateRendererSession({ ...original, sheets: Array.from({ length: 101 }, (_, i) => ({ ...original.sheets[0], id: `s${i}` })) }), /limit/);
  assert.throws(() => validateRendererSession({ ...original, splitSheet: 's1' }), /active pane/);
  assert.throws(() => validateRendererSession({ ...original, activeSheet: 'missing' }), /active pane/);
  assert.throws(() => validateRendererSession({ ...original, commitDrafts: [{ repositoryId: repository, text: 'x'.repeat(65537) }] }), /Invalid session text/);
});

test('malformed session state is ignored without touching recovery and later saves recover', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'minv-session-corrupt-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStateStore(directory); await store.save(sample());
  const recovery = path.join(directory, 'dirty-buffer'); await writeFile(recovery, 'unsaved source');
  const file = path.join(directory, 'sessions', workspace + '.json');
  await writeFile(file, '{truncated'); assert.equal(await store.load(workspace), null);
  assert.equal(await readFile(recovery, 'utf8'), 'unsaved source');
  await store.save(sample()); assert.equal((await store.load(workspace))?.selectedId, repository);
});
