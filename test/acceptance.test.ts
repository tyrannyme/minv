import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RepositoryController, type Row } from '../src/controller';
import { saveCatalog } from '../src/core/catalog';
import type { GitResult, GitRunner, Repository } from '../src/core/types';

const success = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('Expected controller state did not arrive');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function repository(root: string, available = true): Repository {
  return { id: createHash('sha256').update(root).digest('hex').slice(0, 24), root, name: 'fixture', gitDir: root, commonDir: root, available };
}
function row(repo: Repository): Row {
  return { repository: repo, branch: { state: 'unknown', generation: 0 }, status: { state: 'unknown', generation: 0 } };
}
function result(root: string, args: readonly string[]): GitResult {
  if (args[0] === 'symbolic-ref') return success('main\n');
  if (args[0] === 'rev-parse') return success(args.includes('HEAD') ? `${'a'.repeat(40)}\n` : `${root}\n`);
  return success();
}

test('unavailable checkout can recover without leaving a resolved refresh stuck in flight', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-controller-recovery-'));
  const controller = new RepositoryController({ run: async (_cwd, args) => result(root, args) }, path.join(root, 'cache.json'));
  const entry = row(repository(root, false));
  controller.rows = [entry];
  try {
    controller.select(entry.repository.id);
    await until(() => entry.branch.state === 'error' && entry.status.state === 'error');
    entry.repository.available = true;
    await controller.refresh();
    assert.equal(entry.branch.state, 'observed');
    assert.equal(entry.branch.value?.name, 'main');
    assert.equal(entry.status.state, 'observed');
  } finally { controller.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('cached selected checkout metadata starts while workspace discovery is blocked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-controller-metadata-'));
  const cache = path.join(root, 'cache.json');
  const repo = repository(root);
  const sibling = repository(path.join(root, 'earlier-cached-row'));
  await saveCatalog(cache, [sibling, repo]);
  const discovery = deferred<GitResult>();
  let discoveryStarted = false;
  let branchStarted = false;
  const branchRequests: string[] = [];
  const git: GitRunner = { run: async (cwd, args) => {
    if (args.includes('--show-toplevel')) { discoveryStarted = true; return discovery.promise; }
    if (args[0] === 'symbolic-ref') { branchStarted = true; branchRequests.push(cwd); }
    return result(root, args);
  } };
  const controller = new RepositoryController(git, cache);
  const opening = controller.open([root], repo.id);
  try {
    await until(() => discoveryStarted);
    // The metadata path must make progress before the discovery barrier is released.
    await until(() => branchStarted);
    assert.equal(branchRequests[0], root, 'restored selection must precede unrelated cached branch requests');
  } finally {
    discovery.resolve(success(`${root}\n`));
    await opening;
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('invalidated in-flight status never publishes its old clean result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-controller-generation-'));
  const old = deferred<GitResult>();
  const current = deferred<GitResult>();
  let calls = 0;
  const controller = new RepositoryController({ run: async (_cwd, args) => {
    if (args[0] === 'status') return ++calls === 1 ? old.promise : current.promise;
    return result(root, args);
  } }, path.join(root, 'cache.json'));
  const entry = row(repository(root));
  controller.rows = [entry];
  const observedCounts: number[] = [];
  controller.on('change', () => { if (entry.status.state === 'observed') observedCounts.push(entry.status.value!.changes.length); });
  try {
    controller.select(entry.repository.id);
    await until(() => calls === 1);
    controller.invalidate(entry.repository.id);
    old.resolve(success());
    await until(() => calls >= 2);
    assert.equal(entry.status.state, 'refreshing');
    current.resolve(success('? external.txt\0'));
    await until(() => entry.status.state === 'observed');
    assert.equal(entry.status.value?.changes[0]?.path, 'external.txt');
    assert.ok(observedCounts.every(count => count === 1), 'old empty status was published as observed');
  } finally {
    old.resolve(success()); current.resolve(success());
    controller.dispose(); await rm(root, { recursive: true, force: true });
  }
});

test('rediscovery preserves the position of a cached checkout that is now missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-controller-order-'));
  const cache = path.join(root, 'cache.json');
  const parent = repository(root);
  const missing = { ...repository(path.join(root, 'missing')), parentId: parent.id };
  await saveCatalog(cache, [missing, parent]);
  const controller = new RepositoryController({ run: async (_cwd, args) => result(root, args) }, cache);
  try {
    await controller.open([root], parent.id);
    assert.deepEqual(controller.rows.map(item => item.repository.id), [missing.id, parent.id]);
    assert.equal(controller.rows[0]?.repository.available, false);
    assert.match(controller.rows[0]!.repository.error!, /not found/);
    assert.equal(controller.selectedId, parent.id);
  } finally { controller.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('restricted content policy permits branch metadata without spawning status', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-controller-restricted-'));
  const commands: string[] = [];
  let allowContent = false;
  const controller = new RepositoryController({ run: async (_cwd, args) => {
    commands.push(args[0]!);
    return result(root, args);
  } }, path.join(root, 'cache.json'), () => allowContent);
  const entry = row(repository(root));
  controller.rows = [entry];
  try {
    controller.select(entry.repository.id);
    await until(() => entry.branch.state === 'observed');
    await controller.refresh(true);
    assert.equal(entry.branch.value?.name, 'main');
    assert.equal(commands.includes('status'), false, 'restricted workspace launched passive content inspection');
    assert.notEqual(entry.status.state, 'observed');
    allowContent = true;
    await controller.refresh();
    assert.equal(entry.status.state, 'observed');
    assert.equal(commands.includes('status'), true);
  } finally { controller.dispose(); await rm(root, { recursive: true, force: true }); }
});
