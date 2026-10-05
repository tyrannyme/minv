import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { GitService } from '../desktop/main/git-service';
import { prepareWrite } from '../src/core/status';
import type { HostMethods } from '../desktop/renderer/src/contract';
import { Git } from '../src/core/git';
import type { Repository } from '../src/core/types';

function command(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull } });
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-git-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  command(root, 'init', '--quiet', '--initial-branch=main');
  command(root, 'config', 'user.name', 'Minv Test'); command(root, 'config', 'user.email', 'test@example.invalid'); command(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(root, 'file.txt'), 'original\n'); command(root, 'add', 'file.txt'); command(root, 'commit', '--quiet', '-m', 'initial');
  const repo: Repository = { id: root, root, name: 'fixture', available: true, gitDir: path.join(root, '.git'), commonDir: path.join(root, '.git') };
  const git = new Git(); t.after(() => git.dispose());
  const state = { trusted: true, confirmations: [] as { title: string; detail: string }[], invalidations: [] as string[], confirm: async () => true };
  const service = new GitService({ git, getRepository: id => { if (id !== repo.id) throw new Error('Repository unavailable'); return repo; }, isTrusted: () => state.trusted,
    confirm: async (title, detail) => { state.confirmations.push({ title, detail }); return state.confirm(); }, choose: async () => undefined, invalidate: id => { state.invalidations.push(id); } });
  const call = async <M extends keyof HostMethods>(method: M, input: HostMethods[M][0]): Promise<HostMethods[M][1]> => {
    const handler = service.handlers[method] as ((input: HostMethods[M][0]) => Promise<HostMethods[M][1]>) | undefined;
    if (!handler) throw new Error(`Missing handler ${method}`); return handler(input);
  };
  let generation = 0;
  const observed = async () => {
    service.recordStatusBasis(repo.id, ++generation, await prepareWrite(repo, git));
    return { kind: 'status' as const, generation };
  };
  return { root, repo, git, service, state, call, observed };
}
const code = (expected: string) => (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;

test('Git service tickets bind action, selected paths and single-use state', async t => {
  const { repo, root, call, observed } = await fixture(t);
  await writeFile(path.join(root, 'file.txt'), 'edited\n'); await writeFile(path.join(root, 'other.txt'), 'other\n');
  const prepared = await call('git.prepare', { repositoryId: repo.id, action: 'stage', basis: await observed(), paths: ['file.txt'] });
  await assert.rejects(call('git.unstage', { repositoryId: repo.id, paths: ['file.txt'], token: prepared.token }), code('stale-review'));
  await call('git.stage', { repositoryId: repo.id, paths: ['file.txt'], token: prepared.token });
  await assert.rejects(call('git.stage', { repositoryId: repo.id, paths: ['file.txt'], token: prepared.token }), code('stale-review'));
  const wrongScope = await call('git.prepare', { repositoryId: repo.id, action: 'stage', basis: await observed(), paths: ['other.txt'] });
  wrongScope.paths!.push('file.txt');
  await assert.rejects(call('git.stage', { repositoryId: repo.id, paths: ['other.txt', 'file.txt'], token: wrongScope.token }), code('stale-review'));
  assert.equal(command(root, 'show', ':file.txt'), 'edited\n');
  assert.throws(() => command(root, 'show', ':other.txt'));
});

test('Git service refuses stale review content and invalidates observations on failure', async t => {
  const { root, repo, call, state, observed } = await fixture(t);
  await writeFile(path.join(root, 'file.txt'), 'reviewed\n');
  const prepared = await call('git.prepare', { repositoryId: repo.id, action: 'stage', basis: await observed(), paths: ['file.txt'] });
  await writeFile(path.join(root, 'file.txt'), 'external\n');
  await assert.rejects(call('git.stage', { repositoryId: repo.id, paths: ['file.txt'], token: prepared.token }), code('stale-review'));
  assert.equal(command(root, 'diff', '--cached'), '');
  assert.deepEqual(state.invalidations, [repo.id]);
});

test('untrusted inspection remains available and trust is checked again after confirmation', async t => {
  const { root, repo, call, state, observed } = await fixture(t);
  await writeFile(path.join(root, 'file.txt'), 'staged change\n'); command(root, 'add', 'file.txt');
  state.trusted = false;
  assert.match((await call('git.diff', { repositoryId: repo.id, path: 'file.txt', side: 'staged' })).patch, /staged change/);
  await assert.rejects(call('git.prepare', { repositoryId: repo.id, action: 'commit', basis: await observed() }), code('untrusted'));
  state.trusted = true;
  const prepared = await call('git.prepare', { repositoryId: repo.id, action: 'commit', basis: await observed() });
  state.confirm = async () => { state.trusted = false; return true; };
  await assert.rejects(call('git.commit', { repositoryId: repo.id, message: 'must not run', token: prepared.token }), code('untrusted'));
  assert.match(state.confirmations[0]!.detail, /Exact staged changes/);
  assert.match(state.confirmations[0]!.detail, /staged change/);
  assert.equal(command(root, 'log', '-1', '--format=%s').trim(), 'initial');
});

test('whitespace-filtered diff cannot authorize hidden content and hunk IDs are consumed', async t => {
  const { root, repo, call } = await fixture(t);
  await writeFile(path.join(root, 'file.txt'), '  original\n');
  const diff = await call('git.diff', { repositoryId: repo.id, path: 'file.txt', side: 'unstaged', ignoreWhitespace: true });
  assert.equal(diff.patch, ''); assert.equal('token' in diff, false);
  await assert.rejects(call('git.prepare', { repositoryId: repo.id, action: 'stage', paths: ['file.txt'], basis: { kind: 'review', reviewId: diff.reviewId } }), code('stale-review'));
  const review = await call('git.hunks', { repositoryId: repo.id, path: 'file.txt', side: 'unstaged' });
  assert.match(review.hunks[0]!.patch, /\+  original/);
  await call('git.applyHunks', { repositoryId: repo.id, reviewId: review.reviewId, ids: review.hunks.map(hunk => hunk.id) });
  await assert.rejects(call('git.applyHunks', { repositoryId: repo.id, reviewId: review.reviewId, ids: review.hunks.map(hunk => hunk.id) }), code('stale-review'));
  assert.equal(command(root, 'show', ':file.txt'), '  original\n');
});

test('commit detects external change during review and never retries', async t => {
  const { root, repo, call, state, observed } = await fixture(t);
  await writeFile(path.join(root, 'file.txt'), 'staged\n'); command(root, 'add', 'file.txt');
  const prepared = await call('git.prepare', { repositoryId: repo.id, action: 'commit', basis: await observed() });
  state.confirm = async () => { await writeFile(path.join(root, 'file.txt'), 'external while dialog open\n'); return true; };
  await assert.rejects(call('git.commit', { repositoryId: repo.id, message: 'draft remains caller-owned', token: prepared.token }), code('stale-review'));
  assert.equal(command(root, 'log', '-1', '--format=%s').trim(), 'initial');
  await assert.rejects(call('git.commit', { repositoryId: repo.id, message: 'retry', token: prepared.token }), code('stale-review'));
});

test('network confirmation uses backend destination and revalidates changes during dialog', async t => {
  const { root, repo, call, state, observed } = await fixture(t);
  command(root, 'remote', 'add', 'origin', '/explicit/local/destination');
  const remote = (await call('git.remotes', { repositoryId: repo.id }))[0]!;
  const prepared = await call('git.prepare', { repositoryId: repo.id, action: 'fetch', basis: { kind: 'none' } });
  state.confirm = async () => { command(root, 'remote', 'set-url', 'origin', '/different/destination'); return true; };
  await assert.rejects(call('git.fetch', { repositoryId: repo.id, remote: { ...remote, fetchUrl: 'forged display' }, token: prepared.token }), code('stale-review'));
  assert.match(state.confirmations[0]!.detail, /explicit\/local\/destination/);
  assert.doesNotMatch(state.confirmations[0]!.detail, /forged display/);
});

test('create-and-switch uses one reviewed operation and keeps working content', async t => {
  const { root, repo, call, service, observed } = await fixture(t);
  const main = (await call('git.branches', { repositoryId: repo.id }))[0]!;
  await writeFile(path.join(root, 'file.txt'), 'local work\n');
  const prepared = await call('git.prepare', { repositoryId: repo.id, action: 'createBranch', basis: { kind: 'none' } });
  await call('git.createBranch', { repositoryId: repo.id, name: 'topic', start: main, switchTo: true, token: prepared.token });
  assert.equal(command(root, 'branch', '--show-current').trim(), 'topic');
  assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'local work\n');
  const cleared = await call('git.prepare', { repositoryId: repo.id, action: 'stage', basis: await observed(), paths: ['file.txt'] });
  service.clearReviews();
  await assert.rejects(call('git.stage', { repositoryId: repo.id, paths: ['file.txt'], token: cleared.token }), code('stale-review'));
});


test('fresh prepare cannot authorize changes after the displayed status or diff', async t => {
  const { root, repo, call, observed } = await fixture(t);
  await writeFile(path.join(root, 'file.txt'), 'content seen by user\n');
  const basis = await observed();
  const diff = await call('git.diff', { repositoryId: repo.id, path: 'file.txt', side: 'unstaged' });
  assert.match(diff.patch, /content seen by user/);
  await writeFile(path.join(root, 'file.txt'), 'unseen external content\n');
  await assert.rejects(call('git.prepare', { repositoryId: repo.id, action: 'stage', paths: ['file.txt'], basis }), code('stale-review'));
  await assert.rejects(call('git.prepare', { repositoryId: repo.id, action: 'stage', paths: ['file.txt'], basis: { kind: 'review', reviewId: diff.reviewId } }), code('stale-review'));
  await assert.rejects(call('git.prepare', { repositoryId: repo.id, action: 'stage', paths: ['file.txt'], basis: { kind: 'none' } }), code('stale-review'));
  assert.equal(command(root, 'diff', '--cached'), '');
});

test('diff review is bound to its displayed path and stage direction', async t => {
  const { root, repo, call } = await fixture(t);
  await writeFile(path.join(root, 'file.txt'), 'file edit\n');
  await writeFile(path.join(root, 'other.txt'), 'other edit\n');
  const diff = await call('git.diff', { repositoryId: repo.id, path: 'file.txt', side: 'unstaged' });
  const basis = { kind: 'review' as const, reviewId: diff.reviewId };
  await assert.rejects(call('git.prepare', { repositoryId: repo.id, action: 'stage', paths: ['other.txt'], basis }), code('stale-review'));
  await assert.rejects(call('git.prepare', { repositoryId: repo.id, action: 'unstage', paths: ['file.txt'], basis }), code('stale-review'));
  const prepared = await call('git.prepare', { repositoryId: repo.id, action: 'stage', paths: ['file.txt'], basis });
  await call('git.stage', { repositoryId: repo.id, paths: ['file.txt'], token: prepared.token });
  assert.equal(command(root, 'show', ':file.txt'), 'file edit\n');
});

test('explicit network cancellation aborts its signal, refuses duplicates and reports uncertain outcome', async t => {
  const { root, repo, git } = await fixture(t);
  command(root, 'remote', 'add', 'origin', '/local/reviewed/remote');
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  const service = new GitService({
    git: { run: (cwd, args, options) => {
      if (args[0] !== 'fetch') return git.run(cwd, args, options);
      assert.equal(options?.cancelActiveWrite, true);
      assert.ok(options?.signal);
      started();
      return new Promise((_, reject) => options.signal!.addEventListener('abort', () => reject(new Error('Git request canceled. Write outcome may be uncertain; inspect repository state before retrying.')), { once: true }));
    } },
    getRepository: () => repo, isTrusted: () => true, confirm: async () => true, choose: async () => undefined, invalidate: () => undefined,
  });
  const remote = (await service.handlers['git.remotes']!({ repositoryId: repo.id }))[0]!;
  const prepared = await service.handlers['git.prepare']!({ repositoryId: repo.id, action: 'fetch', basis: { kind: 'none' } });
  const pending = Promise.resolve(service.handlers['git.fetch']!({ repositoryId: repo.id, remote, token: prepared.token }));
  const rejected = assert.rejects(pending, code('uncertain'));
  await dispatched;
  await assert.rejects(Promise.resolve(service.handlers['git.fetch']!({ repositoryId: repo.id, remote, token: prepared.token })), code('unavailable'));
  await service.handlers['git.cancel']!({ repositoryId: repo.id });
  await rejected;
  await service.handlers['git.cancel']!({ repositoryId: repo.id }); // Already completed: harmless.
});

test('trust revoked during final Git freshness reads prevents the write command', async t => {
  const { root, repo, git } = await fixture(t);
  await writeFile(path.join(root, 'file.txt'), 'reviewed edit\n');
  let trusted = true; let revoke = false;
  const service = new GitService({
    git: { run: async (cwd, args, options) => {
      const result = await git.run(cwd, args, options);
      if (revoke && args.includes('status')) trusted = false;
      return result;
    } },
    getRepository: () => repo, isTrusted: () => trusted, confirm: async () => true, choose: async () => undefined, invalidate: () => undefined,
  });
  service.recordStatusBasis(repo.id, 1, await prepareWrite(repo, git));
  const prepared = await service.handlers['git.prepare']!({ repositoryId: repo.id, action: 'stage', paths: ['file.txt'], basis: { kind: 'status', generation: 1 } });
  revoke = true;
  await assert.rejects(Promise.resolve(service.handlers['git.stage']!({ repositoryId: repo.id, paths: ['file.txt'], token: prepared.token })), code('untrusted'));
  assert.equal(command(root, 'diff', '--cached'), '');
});
