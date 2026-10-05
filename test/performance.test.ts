import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const project = path.resolve(__dirname, '../..');
const fixtureScript = path.join(project, 'scripts/fixture.mjs');
const benchmarkScript = path.join(project, 'scripts/bench.mjs');
interface Manifest {
  counts: { availableWorkspaceCheckouts: number; workspaceCatalogEntries: number };
  repositories: { path: string }[];
  stagedGitlink: { parent: string; child: string };
}

test('smoke fixture matches its counts and branch measurements finish while sibling status is held', { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'minv-performance-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, 'fixture');
  await execute(process.execPath, [fixtureScript, '--output', output], { cwd: project, timeout: 30_000 });
  const manifest = JSON.parse(await readFile(path.join(output, 'fixture.json'), 'utf8')) as Manifest;
  assert.equal(manifest.counts.availableWorkspaceCheckouts, 8);
  assert.equal(manifest.counts.workspaceCatalogEntries, 10);
  let tracked = 0;
  let untracked = 0;
  let ignored = 0;
  let modified = 0;
  const count = (value: string) => value.split('\0').filter(Boolean).length;
  for (const repository of manifest.repositories) {
    const cwd = path.join(output, repository.path);
    const run = async (...args: string[]) => (await execute('git', args, { cwd })).stdout;
    const entries = (await run('ls-files', '--stage', '-z')).split('\0').filter(Boolean);
    tracked += entries.filter(entry => !entry.startsWith('160000 ')).length;
    untracked += count(await run('ls-files', '--others', '--exclude-standard', '-z'));
    ignored += count(await run('ls-files', '--others', '--ignored', '--exclude-standard', '-z'));
    modified += count(await run('diff', '--name-only', '--ignore-submodules=all', '-z'));
  }
  assert.equal(tracked, 256);
  assert.equal(untracked, 24);
  assert.equal(ignored, 128);
  assert.equal(modified, 16);
  const pointerParent = path.join(output, manifest.stagedGitlink.parent);
  const pointerDiff = (await execute('git', ['diff', '--cached', '--raw'], { cwd: pointerParent })).stdout;
  assert.match(pointerDiff, /^:160000 160000 /);
  const detached = path.join(output, manifest.stagedGitlink.child);
  await assert.rejects(execute('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: detached }));
  const unborn = path.join(output, 'unborn-companion');
  assert.equal((await execute('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: unborn })).stdout.trim(), 'unborn');
  await assert.rejects(execute('git', ['rev-parse', '--verify', 'HEAD'], { cwd: unborn }));
  const repeated = path.join(temporary, 'repeated');
  await execute(process.execPath, [fixtureScript, '--output', repeated], { cwd: project, timeout: 30_000 });
  for (const repository of manifest.repositories) {
    const first = await execute('git', ['rev-parse', 'HEAD'], { cwd: path.join(output, repository.path) });
    const second = await execute('git', ['rev-parse', 'HEAD'], { cwd: path.join(repeated, repository.path) });
    assert.equal(first.stdout, second.stdout, `Reproducible history for ${repository.path}`);
  }
  const { stdout } = await execute(process.execPath, [benchmarkScript, '--fixture', output, '--iterations', '1'], { cwd: project, timeout: 30_000 });
  const result = JSON.parse(stdout);
  assert.equal(result.releaseEvidence, false);
  assert.equal(result.independence.statusHeldIterations, 1);
  assert.equal(result.metrics.allAvailableBranches.count, 1);
  assert.ok(Number.isFinite(result.metrics.selectedBranchWhileStatusHeld.p95));
  // A rerun must preserve an existing directory, even if it contains unrelated data.
  await writeFile(path.join(output, 'keep.txt'), 'preserve this');
  await assert.rejects(execute(process.execPath, [fixtureScript, '--output', output], { cwd: project }));
  assert.equal(await readFile(path.join(output, 'keep.txt'), 'utf8'), 'preserve this');
});

test('fixture profile validation rejects unexpected scales before creating an output directory', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'minv-invalid-fixture-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await assert.rejects(execute(process.execPath, [fixtureScript, '--profile', 'R999999', '--output', path.join(temporary, 'invalid')], { cwd: project }), /Unknown profile/);
});
