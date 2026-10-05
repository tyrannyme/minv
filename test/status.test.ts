import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Git } from '../src/core/git';
import { commit, parseStatus, prepareWrite, readDiff, readHistory, readStatus, stagePaths, unstagePaths } from '../src/core/status';
import type { Repository } from '../src/core/types';

function command(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull } });
}

async function fixture(t: TestContext): Promise<{ repo: Repository; git: Git }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  command(root, 'init', '--quiet', '--initial-branch=main');
  command(root, 'config', 'user.name', 'Minv Test');
  command(root, 'config', 'user.email', 'minv@example.invalid');
  command(root, 'config', 'commit.gpgsign', 'false');
  return { repo: { id: root, root, name: 'fixture', available: true, gitDir: path.join(root, '.git'), commonDir: path.join(root, '.git') }, git: new Git() };
}

async function initial(repo: Repository): Promise<void> {
  await writeFile(path.join(repo.root, 'file.txt'), 'initial\n');
  command(repo.root, 'add', '--', 'file.txt');
  command(repo.root, 'commit', '--quiet', '-m', 'initial');
}

test('porcelain parser preserves renamed paths, conflicts and all submodule bits', () => {
  const output = '2 RM N... 100644 100644 100644 abc def R100 new name\n.txt\0old\tname.txt\0' +
    'u UU N... 100644 100644 100644 100644 a b c conflict.txt\0' +
    '1 MM SCMU 160000 160000 160000 a b child\0? :[odd]*\0';
  const status = parseStatus(output);
  assert.equal(status.complete, true);
  assert.deepEqual(status.changes[0], { path: 'new name\n.txt', originalPath: 'old\tname.txt', index: 'R', workingTree: 'M' });
  assert.equal(status.changes[1]?.index, 'U');
  assert.equal(status.changes[2]?.submodule, 'SCMU');
  assert.equal(status.changes[3]?.path, ':[odd]*');
  assert.throws(() => parseStatus('? truncated'), /Incomplete/);
  assert.throws(() => parseStatus('? invalid\uFFFDname\0'), /UTF-8/);
  assert.throws(() => parseStatus('2 R. N... 100644 100644 100644 a b R100 new\0'), /original rename/);
});

test('unborn repository stages literal filenames, unstages without deleting content, and commits only selected paths', async t => {
  const { repo, git } = await fixture(t);
  const names = [':(glob)*', '-leading', 'line\nname', '日本語 file.txt'];
  for (const name of names) await writeFile(path.join(repo.root, name), name);
  assert.deepEqual(await readHistory(repo, git), []);
  assert.match(await readDiff(repo, git, names[0]!, false), /\+\:\(glob\)\*/);
  await stagePaths(repo, git, [names[0]!], await prepareWrite(repo, git));
  let status = await readStatus(repo, git);
  assert.equal(status.changes.filter(change => change.index === 'A').length, 1);
  await unstagePaths(repo, git, [names[0]!], await prepareWrite(repo, git));
  assert.equal(await readFile(path.join(repo.root, names[0]!), 'utf8'), names[0]);
  assert.equal((await readStatus(repo, git)).changes.every(change => change.index === '?'), true);
  await stagePaths(repo, git, names.slice(1), await prepareWrite(repo, git));
  await commit(repo, git, 'first selected files\n\nBody', await prepareWrite(repo, git));
  status = await readStatus(repo, git);
  assert.deepEqual(status.changes.map(change => change.path), [names[0]]);
  assert.equal((await readHistory(repo, git))[0]?.subject, 'first selected files');
  assert.deepEqual(await readHistory(repo, git, 50), []);
});

test('staged and unstaged diffs distinguish index from working content', async t => {
  const { repo, git } = await fixture(t);
  await initial(repo);
  await writeFile(path.join(repo.root, 'file.txt'), 'staged\n');
  await stagePaths(repo, git, ['file.txt'], await prepareWrite(repo, git));
  await writeFile(path.join(repo.root, 'file.txt'), 'working\n');
  assert.deepEqual((await readStatus(repo, git)).changes[0], { path: 'file.txt', index: 'M', workingTree: 'M' });
  assert.match(await readDiff(repo, git, 'file.txt', true), /\+staged/);
  assert.match(await readDiff(repo, git, 'file.txt', false), /\+working/);
  await unstagePaths(repo, git, ['file.txt'], await prepareWrite(repo, git));
  assert.equal(await readFile(path.join(repo.root, 'file.txt'), 'utf8'), 'working\n');
  assert.equal((await readStatus(repo, git)).changes[0]?.index, '.');
});

test('writes reject stale working content, index and branch identity', async t => {
  const { repo, git } = await fixture(t);
  await initial(repo);
  await writeFile(path.join(repo.root, 'file.txt'), 'one\n');
  const contentSnapshot = await prepareWrite(repo, git);
  await writeFile(path.join(repo.root, 'file.txt'), 'two\n');
  await assert.rejects(stagePaths(repo, git, ['file.txt'], contentSnapshot), /Repository changed/);
  const indexSnapshot = await prepareWrite(repo, git);
  command(repo.root, 'add', 'file.txt');
  await assert.rejects(commit(repo, git, 'stale', indexSnapshot), /Repository changed/);
  const branchSnapshot = await prepareWrite(repo, git);
  command(repo.root, 'branch', 'other');
  command(repo.root, 'symbolic-ref', 'HEAD', 'refs/heads/other');
  await assert.rejects(commit(repo, git, 'wrong branch', branchSnapshot), /Repository changed/);
  assert.equal(command(repo.root, 'log', '-1', '--format=%s').trim(), 'initial');
});

test('concurrent writes from the same review serialize and reject the superseded action', async t => {
  const { repo, git } = await fixture(t);
  await initial(repo);
  await writeFile(path.join(repo.root, 'file.txt'), 'updated\n');
  const precondition = await prepareWrite(repo, git);
  const outcomes = await Promise.allSettled([stagePaths(repo, git, ['file.txt'], precondition), stagePaths(repo, git, ['file.txt'], precondition)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
});

test('staging a symlink checks its target text without following it', async t => {
  const { repo, git } = await fixture(t);
  await initial(repo);
  const link = path.join(repo.root, 'link');
  await symlink('file.txt', link);
  const reviewed = await prepareWrite(repo, git);
  await rm(link);
  await symlink('../outside', link);
  await assert.rejects(stagePaths(repo, git, ['link'], reviewed), /Repository changed/);
  await stagePaths(repo, git, ['link'], await prepareWrite(repo, git));
  assert.equal(command(repo.root, 'show', ':link'), '../outside');
});

test('real rename and merge conflict records parse without collapsing state', async t => {
  const { repo, git } = await fixture(t);
  await initial(repo);
  await rename(path.join(repo.root, 'file.txt'), path.join(repo.root, 'new name.txt'));
  command(repo.root, 'add', '-A');
  const renamed = (await readStatus(repo, git)).changes[0]!;
  assert.equal(renamed.originalPath, 'file.txt');
  assert.equal(renamed.path, 'new name.txt');
  await unstagePaths(repo, git, ['new name.txt'], await prepareWrite(repo, git));
  assert.equal(command(repo.root, 'diff', '--cached'), '');
  command(repo.root, 'reset', '--hard', '--quiet');
  await rm(path.join(repo.root, 'new name.txt'));
  command(repo.root, 'checkout', '--quiet', '-b', 'other');
  await writeFile(path.join(repo.root, 'file.txt'), 'other\n');
  command(repo.root, 'commit', '-am', 'other', '--quiet');
  command(repo.root, 'checkout', '--quiet', 'main');
  await writeFile(path.join(repo.root, 'file.txt'), 'main\n');
  command(repo.root, 'commit', '-am', 'main', '--quiet');
  assert.throws(() => command(repo.root, 'merge', 'other'));
  const conflict = (await readStatus(repo, git)).changes[0]!;
  assert.equal(conflict.index, 'U');
  assert.equal(conflict.workingTree, 'U');
});

test('trusted commit runs hooks and preserves staged state on hook failure', async t => {
  const { repo, git } = await fixture(t);
  await initial(repo);
  await writeFile(path.join(repo.root, 'file.txt'), 'hook test\n');
  await stagePaths(repo, git, ['file.txt'], await prepareWrite(repo, git));
  const hook = path.join(repo.gitDir!, 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\necho "review hook refusal" >&2\nexit 1\n');
  await chmod(hook, 0o700);
  await assert.rejects(commit(repo, git, 'blocked', await prepareWrite(repo, git)), /review hook refusal/);
  assert.equal((await readStatus(repo, git)).changes[0]?.index, 'M');
  assert.equal(command(repo.root, 'log', '-1', '--format=%s').trim(), 'initial');
});

test('unsafe path scopes and parent writes through symlink or nested checkout are refused', async t => {
  const { repo, git } = await fixture(t);
  await initial(repo);
  await writeFile(path.join(repo.root, 'file.txt'), 'new\n');
  const reviewed = await prepareWrite(repo, git);
  for (const file of ['.', '../escape', '/absolute', '.git/config']) await assert.rejects(stagePaths(repo, git, [file], reviewed));
  await mkdir(path.join(repo.root, 'child'));
  command(path.join(repo.root, 'child'), 'init', '--quiet');
  await writeFile(path.join(repo.root, 'child', 'file'), 'child\n');
  await assert.rejects(stagePaths(repo, git, ['child/file'], await prepareWrite(repo, git)), /nested repository/);
  await symlink('child', path.join(repo.root, 'link'));
  await assert.rejects(stagePaths(repo, git, ['link/file'], await prepareWrite(repo, git)), /symlink/);
});

test('parent reports gitlink pointer while child dirtiness stays separately scoped; changed child HEAD invalidates staging', async t => {
  const { repo, git } = await fixture(t);
  const { repo: source } = await fixture(t);
  await initial(source);
  await initial(repo);
  command(repo.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', source.root, 'child');
  command(repo.root, 'commit', '--quiet', '-am', 'add child');
  const child = path.join(repo.root, 'child');
  command(child, 'config', 'user.name', 'Minv Test');
  command(child, 'config', 'user.email', 'minv@example.invalid');
  command(child, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(child, 'file.txt'), 'changed child\n');
  command(child, 'commit', '--quiet', '-am', 'child second');
  await writeFile(path.join(child, 'file.txt'), 'dirty child\n');
  let change = (await readStatus(repo, git)).changes.find(item => item.path === 'child')!;
  assert.equal(change.workingTree, 'M');
  assert.equal(change.submodule, 'SC..');
  assert.equal((await readStatus({ ...source, root: child }, git)).changes[0]?.workingTree, 'M');
  const reviewed = await prepareWrite(repo, git);
  command(child, 'commit', '--quiet', '-am', 'child third');
  await writeFile(path.join(child, 'file.txt'), 'still dirty\n');
  await assert.rejects(stagePaths(repo, git, ['child'], reviewed), /Repository changed/);
  await stagePaths(repo, git, ['child'], await prepareWrite(repo, git));
  change = (await readStatus(repo, git)).changes.find(item => item.path === 'child')!;
  assert.equal(change.index, 'M');
  assert.equal(change.workingTree, '.');
  assert.equal(change.submodule, 'S...');
});
