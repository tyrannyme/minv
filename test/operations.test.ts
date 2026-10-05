import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Git } from '../src/core/git';
import { prepareWrite, readStatus } from '../src/core/status';
import { applyHunks, applyStash, createBranch, createStash, dropStash, fetchRemote, listBranches, listRemotes, listStashes, pullFastForward, pushBranch, readCommitDetail, readHistoryPage, readHunks, readOperationState, readRevisionDiff, switchBranch } from '../src/core/operations';
import type { Repository } from '../src/core/types';

function command(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull }, stdio: ['pipe', 'pipe', 'pipe'] });
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-operations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  command(root, 'init', '--quiet', '--initial-branch=main');
  command(root, 'config', 'user.name', 'Minv Test');
  command(root, 'config', 'user.email', 'minv@example.invalid');
  command(root, 'config', 'commit.gpgsign', 'false');
  const repo: Repository = { id: root, root, name: 'fixture', available: true, gitDir: path.join(root, '.git'), commonDir: path.join(root, '.git') };
  const git = new Git(); t.after(() => git.dispose());
  return { repo, git };
}
async function initial(repo: Repository) {
  await writeFile(path.join(repo.root, 'file.txt'), Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join(''));
  command(repo.root, 'add', '--', 'file.txt'); command(repo.root, 'commit', '--quiet', '-m', 'initial');
}
async function modify(repo: Repository, first: string, second: string) {
  const file = path.join(repo.root, 'file.txt');
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('line 2\n', `${first}\n`).replace('line 28\n', `${second}\n`));
}

test('stage and unstage one selected hunk without unrelated edits', async t => {
  const { repo, git } = await fixture(t); await initial(repo); await modify(repo, 'first edit', 'second edit');
  const review = await readHunks(repo, git, 'file.txt', false);
  assert.equal(review.hunks.length, 2);
  await applyHunks(repo, git, review, [review.hunks[0]!.id]);
  assert.match(command(repo.root, 'diff', '--cached'), /first edit/);
  assert.doesNotMatch(command(repo.root, 'diff', '--cached'), /second edit/);
  assert.match(command(repo.root, 'diff'), /second edit/);
  const staged = await readHunks(repo, git, 'file.txt', true);
  await applyHunks(repo, git, staged.id, staged.hunks.map(hunk => hunk.id));
  assert.equal(command(repo.root, 'diff', '--cached'), '');
  assert.match(await readFile(path.join(repo.root, 'file.txt'), 'utf8'), /first edit/);
});

test('hunk review refuses changed content, forged IDs, cross-repository use, and replay', async t => {
  const { repo, git } = await fixture(t); await initial(repo); await modify(repo, 'first edit', 'second edit');
  const review = await readHunks(repo, git, 'file.txt', false);
  await assert.rejects(applyHunks(repo, git, review, ['invented']), /reviewed hunks/);
  const other = await fixture(t); await initial(other.repo);
  await assert.rejects(applyHunks(other.repo, git, review, [review.hunks[0]!.id]), /another repository/);
  await writeFile(path.join(repo.root, 'file.txt'), 'external replacement\n');
  await assert.rejects(applyHunks(repo, git, review, [review.hunks[0]!.id]), /Repository changed/);
  const current = await readHunks(repo, git, 'file.txt', false);
  await applyHunks(repo, git, { ...current, hunks: [{ id: 'fake', header: '', patch: 'arbitrary malicious patch' }] }, current.hunks.map(hunk => hunk.id));
  await assert.rejects(applyHunks(repo, git, current, current.hunks.map(hunk => hunk.id)), /expired/);
});

test('new text file and literal newline/pathspec filenames support hunk staging', async t => {
  const { repo, git } = await fixture(t); await initial(repo);
  const name = ':(glob)odd\nfile.txt';
  await writeFile(path.join(repo.root, name), 'new content\n');
  const review = await readHunks(repo, git, name, false);
  await applyHunks(repo, git, review, review.hunks.map(hunk => hunk.id));
  assert.equal(command(repo.root, 'show', `:${name}`), 'new content\n');
});

test('branch create/switch preserve dirty files, reject moved target and bad names', async t => {
  const { repo, git } = await fixture(t); await initial(repo);
  const main = (await listBranches(repo, git)).find(branch => branch.current)!;
  await createBranch(repo, git, 'topic', main, await prepareWrite(repo, git));
  const topic = (await listBranches(repo, git)).find(branch => branch.name === 'topic')!;
  await modify(repo, 'working edit', 'other edit');
  await switchBranch(repo, git, topic, await prepareWrite(repo, git));
  assert.match(await readFile(path.join(repo.root, 'file.txt'), 'utf8'), /working edit/);
  command(repo.root, 'commit', '--quiet', '-am', 'topic change');
  command(repo.root, 'branch', '-f', 'main', 'topic');
  await assert.rejects(switchBranch(repo, git, main, await prepareWrite(repo, git)), /branch moved/);
  await assert.rejects(createBranch(repo, git, '--force', topic, await prepareWrite(repo, git)), /valid branch/);
});

test('branch switch refuses to overwrite an ignored local file', async t => {
  const { repo, git } = await fixture(t); await initial(repo);
  command(repo.root, 'checkout', '--quiet', '-b', 'topic');
  await writeFile(path.join(repo.root, 'private.txt'), 'tracked on topic\n'); command(repo.root, 'add', 'private.txt'); command(repo.root, 'commit', '--quiet', '-m', 'topic file');
  command(repo.root, 'checkout', '--quiet', 'main');
  await writeFile(path.join(repo.root, '.git', 'info', 'exclude'), 'private.txt\n');
  await writeFile(path.join(repo.root, 'private.txt'), 'precious ignored content\n');
  const target = (await listBranches(repo, git)).find(branch => branch.name === 'topic')!;
  await assert.rejects(switchBranch(repo, git, target, await prepareWrite(repo, git)), /overwritten|untracked/i);
  assert.equal(await readFile(path.join(repo.root, 'private.txt'), 'utf8'), 'precious ignored content\n');
  assert.equal(command(repo.root, 'branch', '--show-current').trim(), 'main');
});

test('scoped stash creation leaves unrelated work and apply never drops its recovery entry', async t => {
  const { repo, git } = await fixture(t); await initial(repo); await modify(repo, 'stashed edit', 'last edit');
  await writeFile(path.join(repo.root, 'unrelated.txt'), 'keep this\n');
  await assert.rejects(createStash(repo, git, 'untracked omitted', ['unrelated.txt'], false, await prepareWrite(repo, git)), /Include untracked/);
  await createStash(repo, git, 'selected file only', ['file.txt'], false, await prepareWrite(repo, git));
  assert.match(await readFile(path.join(repo.root, 'file.txt'), 'utf8'), /line 2\n/);
  assert.equal(await readFile(path.join(repo.root, 'unrelated.txt'), 'utf8'), 'keep this\n');
  const entry = (await listStashes(repo, git))[0]!;
  assert.match(entry.subject, /selected file only/);
  await applyStash(repo, git, entry, false, await prepareWrite(repo, git));
  assert.match(await readFile(path.join(repo.root, 'file.txt'), 'utf8'), /stashed edit/);
  assert.equal((await listStashes(repo, git))[0]?.oid, entry.oid);
  await dropStash(repo, git, entry, await prepareWrite(repo, git), true);
  assert.deepEqual(await listStashes(repo, git), []);
});

test('scoped stash never silently captures unrelated staged files', async t => {
  const { repo, git } = await fixture(t); await initial(repo);
  await modify(repo, 'selected edit', 'other selected edit');
  await writeFile(path.join(repo.root, 'unrelated.txt'), 'staged elsewhere\n'); command(repo.root, 'add', 'unrelated.txt');
  await assert.rejects(createStash(repo, git, 'selected only', ['file.txt'], false, await prepareWrite(repo, git)), /unrelated staged files/);
  assert.deepEqual(await listStashes(repo, git), []);
  assert.equal(command(repo.root, 'show', ':unrelated.txt'), 'staged elsewhere\n');
  assert.match(await readFile(path.join(repo.root, 'file.txt'), 'utf8'), /selected edit/);
  await createStash(repo, git, 'both selected', ['file.txt', 'unrelated.txt'], false, await prepareWrite(repo, git));
  assert.deepEqual(command(repo.root, 'stash', 'show', '--name-only').trim().split('\n').sort(), ['file.txt', 'unrelated.txt']);
});

test('stash identity movement and destructive confirmation are enforced', async t => {
  const { repo, git } = await fixture(t); await initial(repo); await modify(repo, 'first stash', 'last edit');
  await createStash(repo, git, 'first', ['file.txt'], false, await prepareWrite(repo, git));
  const first = (await listStashes(repo, git))[0]!;
  await modify(repo, 'second stash', 'other edit');
  await createStash(repo, git, 'second', ['file.txt'], false, await prepareWrite(repo, git));
  await assert.rejects(dropStash(repo, git, first, await prepareWrite(repo, git), true), /Stash list changed/);
  const current = (await listStashes(repo, git))[0]!;
  await assert.rejects(dropStash(repo, git, current, await prepareWrite(repo, git), false as true), /confirmation/);
  assert.equal((await listStashes(repo, git)).length, 2);
});

test('stash apply conflict preserves both conflict content and the stash recovery entry', async t => {
  const { repo, git } = await fixture(t); await initial(repo);
  await writeFile(path.join(repo.root, 'file.txt'), 'stashed version\n');
  await createStash(repo, git, 'recoverable conflict', ['file.txt'], false, await prepareWrite(repo, git));
  const stash = (await listStashes(repo, git))[0]!;
  await writeFile(path.join(repo.root, 'file.txt'), 'committed version\n'); command(repo.root, 'commit', '--quiet', '-am', 'diverged');
  await assert.rejects(applyStash(repo, git, stash, false, await prepareWrite(repo, git)));
  assert.equal((await listStashes(repo, git))[0]?.oid, stash.oid);
  const content = await readFile(path.join(repo.root, 'file.txt'), 'utf8');
  assert.match(content, /stashed version/); assert.match(content, /committed version/); assert.match(content, /<<<<<<</);
  assert.equal((await readOperationState(repo, git)).conflicts[0]?.path, 'file.txt');
});

test('history has stable pagination, commit detail and scoped revision diffs', async t => {
  const { repo, git } = await fixture(t);
  assert.deepEqual((await readHistoryPage(repo, git)).entries, []);
  await initial(repo); await modify(repo, 'second commit', 'other edit'); command(repo.root, 'commit', '--quiet', '-am', 'second');
  const page = await readHistoryPage(repo, git, { limit: 1 });
  assert.equal(page.entries[0]?.subject, 'second'); assert.equal(page.nextOffset, 1);
  const next = await readHistoryPage(repo, git, { revision: page.revision, offset: page.nextOffset, limit: 1 });
  assert.equal(next.entries[0]?.subject, 'initial'); assert.equal(next.nextOffset, undefined);
  const detail = await readCommitDetail(repo, git, page.entries[0]!.oid);
  assert.deepEqual(detail.changes, [{ status: 'M', path: 'file.txt' }]); assert.equal(detail.parents.length, 1);
  const root = await readCommitDetail(repo, git, detail.parents[0]!);
  assert.equal(root.changes[0]?.status, 'A');
  assert.match(await readRevisionDiff(repo, git, detail.parents[0]!, detail.oid, 'file.txt'), /second commit/);
  await assert.rejects(readHistoryPage(repo, git, { limit: 100000 }), /Invalid history page/);
});

test('operation state identifies merge conflicts without changing them', async t => {
  const { repo, git } = await fixture(t); await initial(repo);
  command(repo.root, 'checkout', '--quiet', '-b', 'topic'); await writeFile(path.join(repo.root, 'file.txt'), 'topic\n'); command(repo.root, 'commit', '--quiet', '-am', 'topic');
  command(repo.root, 'checkout', '--quiet', 'main'); await writeFile(path.join(repo.root, 'file.txt'), 'main\n'); command(repo.root, 'commit', '--quiet', '-am', 'main');
  assert.throws(() => command(repo.root, 'merge', 'topic'));
  const state = await readOperationState(repo, git);
  assert.deepEqual(state.kinds, ['merge']); assert.equal(state.conflicts[0]?.path, 'file.txt'); assert.equal(state.mergeHeads.length, 1);
  assert.equal((await readStatus(repo, git)).changes[0]?.index, 'U');
  await writeFile(path.join(repo.root, 'merge-target'), state.mergeHeads.join('\n') + '\n');
  await rm(path.join(repo.gitDir!, 'MERGE_HEAD'));
  await symlink('../merge-target', path.join(repo.gitDir!, 'MERGE_HEAD'));
  await assert.rejects(readOperationState(repo, git), /ELOOP|symbolic link/i);
});

test('explicit local bare remote push, fetch and ff-only pull work without force or recursive mutation', async t => {
  const { repo, git } = await fixture(t); await initial(repo);
  const remoteRoot = await mkdtemp(path.join(os.tmpdir(), 'minv-bare-')); t.after(() => rm(remoteRoot, { recursive: true, force: true }));
  command(remoteRoot, 'init', '--bare', '--quiet', '--initial-branch=main');
  command(repo.root, 'remote', 'add', 'origin', remoteRoot);
  command(repo.root, 'tag', '-a', 'private-tag', '-m', 'must remain local');
  command(repo.root, 'config', 'push.followTags', 'true');
  const remote = (await listRemotes(repo, git))[0]!;
  await pushBranch(repo, git, remote, 'main', await prepareWrite(repo, git));
  assert.equal(command(remoteRoot, 'rev-parse', 'refs/heads/main').trim(), command(repo.root, 'rev-parse', 'HEAD').trim());
  assert.equal(command(remoteRoot, 'tag', '--list'), '');
  const other = await fixture(t); command(other.repo.root, 'remote', 'add', 'origin', remoteRoot);
  const otherRemote = (await listRemotes(other.repo, git))[0]!;
  await pullFastForward(other.repo, git, otherRemote, 'main', await prepareWrite(other.repo, git));
  await writeFile(path.join(other.repo.root, 'remote.txt'), 'remote work\n'); command(other.repo.root, 'add', 'remote.txt'); command(other.repo.root, 'commit', '--quiet', '-m', 'remote work');
  await pushBranch(other.repo, git, otherRemote, 'main', await prepareWrite(other.repo, git));
  command(repo.root, 'update-ref', 'refs/remotes/origin/keep-local-tracking', 'HEAD');
  command(repo.root, 'config', 'fetch.prune', 'true'); command(repo.root, 'config', 'remote.origin.prune', 'true');
  await fetchRemote(repo, git, remote, await prepareWrite(repo, git));
  assert.ok(command(repo.root, 'rev-parse', 'refs/remotes/origin/keep-local-tracking').trim());
  assert.ok((await listRemotes(repo, git))[0]?.lastFetchedAt);
  await pullFastForward(repo, git, remote, 'main', await prepareWrite(repo, git));
  assert.equal(await readFile(path.join(repo.root, 'remote.txt'), 'utf8'), 'remote work\n');
  await writeFile(path.join(repo.root, 'local.txt'), 'local\n'); command(repo.root, 'add', 'local.txt'); command(repo.root, 'commit', '--quiet', '-m', 'local diverged');
  await writeFile(path.join(other.repo.root, 'further.txt'), 'remote\n'); command(other.repo.root, 'add', 'further.txt'); command(other.repo.root, 'commit', '--quiet', '-m', 'remote diverged');
  await pushBranch(other.repo, git, otherRemote, 'main', await prepareWrite(other.repo, git));
  await assert.rejects(pullFastForward(repo, git, remote, 'main', await prepareWrite(repo, git)), /fast-forward|diverg/i);
  await assert.rejects(pushBranch(repo, git, remote, 'main', await prepareWrite(repo, git)), /rejected|failed|fetch first/i);
  command(repo.root, 'remote', 'set-url', 'origin', '/a/different/path');
  await assert.rejects(fetchRemote(repo, git, remote, await prepareWrite(repo, git)), /Remote configuration changed/);
});

test('remote display redacts credentials and observes effective URL rewrites', async t => {
  const { repo, git } = await fixture(t); await initial(repo);
  command(repo.root, 'remote', 'add', 'origin', 'https://user:secret@example.invalid/repo?token=secret');
  let remote = (await listRemotes(repo, git))[0]!;
  assert.doesNotMatch(remote.fetchUrl, /secret/);
  command(repo.root, 'config', 'url.https://elsewhere.invalid/.insteadOf', 'https://user:secret@example.invalid/');
  const changed = (await listRemotes(repo, git))[0]!;
  assert.notEqual(changed.fingerprint, remote.fingerprint);
  await assert.rejects(fetchRemote(repo, git, remote, await prepareWrite(repo, git)), /Remote configuration changed/);
});

test('explicitly cancelled network action never dispatches its fetch', async t => {
  const { repo, git } = await fixture(t); await initial(repo);
  const other = await fixture(t); await initial(other.repo);
  command(repo.root, 'remote', 'add', 'origin', other.repo.root);
  const remote = (await listRemotes(repo, git))[0]!;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchRemote(repo, git, remote, await prepareWrite(repo, git), { signal: controller.signal }), /cancel/i);
  assert.equal(command(repo.root, 'for-each-ref', '--format=%(refname)', 'refs/remotes/'), '');
});
