import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { WatchCoordinator } from '../desktop/main/watcher';
import type { Repository } from '../src/core/types';

const execute = promisify(execFile);
async function until(condition: () => boolean, milliseconds = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) { assert.ok(Date.now() - startedAt < milliseconds, 'Watcher condition timed out'); await delay(20); }
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-watch-test-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull });
  const git = (...args: string[]) => execute('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`, ...args], { cwd: root, env });
  await git('init', '--quiet', '--template=', '--initial-branch=main');
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'ignored', 'deep'), { recursive: true });
  await mkdir(path.join(root, 'empty', 'nested'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '/ignored/\n');
  await writeFile(path.join(root, 'src', 'tracked.txt'), 'tracked');
  await writeFile(path.join(root, 'ignored', 'tracked.txt'), 'tracked despite ignore');
  await Promise.all(Array.from({ length: 128 }, (_, index) => writeFile(path.join(root, 'ignored', 'deep', `${index}.txt`), 'ignored')));
  await git('add', '--', '.gitignore', 'src');
  await git('add', '-f', '--', 'ignored/tracked.txt');
  const repository: Repository = { id: 'repository', name: 'fixture', root, gitDir: path.join(root, '.git'), commonDir: path.join(root, '.git'), available: true };
  return { root, repository };
}

test('directory watches preserve tracked ignored files and existing/new empty directories without watching ignored trees', { timeout: 15_000 }, async t => {
  const { root, repository } = await fixture();
  const watcher = new WatchCoordinator();
  t.after(async () => { watcher.dispose(); await rm(root, { recursive: true, force: true }); });
  const invalidations: string[][] = [];
  watcher.on('invalidation', (event: { ids: string[] }) => invalidations.push(event.ids));
  watcher.setRepositories([repository]);
  watcher.watchRoots([root]);
  await until(() => !watcher.snapshot().initializing);
  await delay(100);
  assert.equal(watcher.snapshot().degraded, false);
  assert.ok(watcher.snapshot().watches < 15, 'Registration should scale with directories, not file count');
  invalidations.length = 0;
  await writeFile(path.join(root, 'ignored', 'deep', '0.txt'), 'ignored external edit');
  await delay(150);
  assert.equal(invalidations.length, 0, 'Excluded directory must not produce repository work');
  await writeFile(path.join(root, 'ignored', 'tracked.txt'), 'tracked external edit');
  await until(() => invalidations.some(ids => ids.includes(repository.id)));
  invalidations.length = 0;
  await writeFile(path.join(root, 'empty', 'nested', 'new.txt'), 'new file in existing empty directory');
  await until(() => invalidations.length > 0);
  await mkdir(path.join(root, 'new-directory', 'nested'), { recursive: true });
  await until(() => !watcher.snapshot().initializing);
  await delay(200);
  invalidations.length = 0;
  await writeFile(path.join(root, 'new-directory', 'nested', 'new.txt'), 'newly registered directory');
  await until(() => invalidations.length > 0);
});

test('explicit opened ignored files are monitored and registration failure projects onto later repositories', { timeout: 15_000 }, async t => {
  const { root, repository } = await fixture();
  const watcher = new WatchCoordinator();
  t.after(async () => { watcher.dispose(); await rm(root, { recursive: true, force: true }); });
  watcher.setRepositories([repository]);
  watcher.watchRoots([root]);
  await until(() => !watcher.snapshot().initializing);
  const opened = path.join(root, 'ignored', 'deep', '0.txt');
  watcher.trackFile('opened', opened);
  await until(() => !watcher.snapshot().initializing);
  const changes: string[] = [];
  watcher.on('fileChanged', (event: { key: string }) => changes.push(event.key));
  await writeFile(opened, 'external edit to an explicitly opened ignored file');
  await until(() => changes.includes('opened'));

  const broken = new WatchCoordinator();
  t.after(() => broken.dispose());
  const unavailable = path.join(root, 'unavailable');
  const degraded: { ids: string[]; error: string }[] = [];
  broken.on('degraded', event => degraded.push(event));
  broken.watchRoots([unavailable]);
  await until(() => broken.snapshot().degraded);
  broken.setRepositories([{ ...repository, id: 'late', root: unavailable, available: false }]);
  assert.ok(degraded.some(event => event.ids.includes('late')));
  assert.ok(broken.snapshot().failures.every(message => !message.includes(root)), 'Public snapshot must not expose filesystem paths');
});

test('deferred discovery avoids a source crawl and ordinary changes do not invalidate branch metadata', { timeout: 15_000 }, async t => {
  const { root, repository } = await fixture();
  const watcher = new WatchCoordinator();
  t.after(async () => { watcher.dispose(); await rm(root, { recursive: true, force: true }); });
  const events: { ids: string[]; metadataIds: string[]; branchMetadata: { id: string; deliveredAt: number }[] }[] = [];
  watcher.on('invalidation', event => events.push(event));
  watcher.watchRoots([root], { deferPlain: true });
  await delay(60);
  assert.equal(watcher.snapshot().watches, 0);
  assert.equal(watcher.snapshot().initializing, true);
  watcher.setRepositories([repository]);
  watcher.watchRoots([root]);
  await until(() => !watcher.snapshot().initializing);
  await delay(100);
  events.length = 0;
  await writeFile(path.join(root, 'src', 'tracked.txt'), 'external content update');
  await until(() => events.length > 0);
  assert.ok(events.every(event => !event.metadataIds.includes(repository.id)));
  events.length = 0;
  await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/other\n');
  await until(() => events.some(event => event.metadataIds.includes(repository.id)));
  assert.ok(events.some(event => event.branchMetadata.some(item => item.id === repository.id && item.deliveredAt > 0)));
});
