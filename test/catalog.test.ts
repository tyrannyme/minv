import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { discoverRepositories, loadCatalog, readBranch, saveCatalog } from '../src/core/catalog';
import type { GitRunner, GitResult, Repository } from '../src/core/types';

const calls: string[][] = [];
const git: GitRunner = {
  run(cwd, args) {
    calls.push([...args]);
    return new Promise((resolve, reject) => {
      execFile('git', [...args], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') reject(error);
        else resolve({ stdout, stderr, exitCode: typeof error?.code === 'number' ? error.code : 0 });
      });
    });
  },
};

async function command(cwd: string, ...args: string[]): Promise<string> {
  const result = await git.run(cwd, args);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function initialize(root: string, committed = true): Promise<void> {
  await mkdir(root, { recursive: true });
  await command(root, 'init', '-b', 'main');
  await command(root, 'config', 'user.name', 'Minv tests');
  await command(root, 'config', 'user.email', 'minv@example.invalid');
  if (committed) await command(root, 'commit', '--allow-empty', '-m', 'initial');
}
function only(repositories: Repository[]): Repository {
  assert.equal(repositories.length, 1);
  return repositories[0]!;
}

test('named, detached, and unborn branches never request working-tree status', async t => {
  const root = await fixture(t);
  await initialize(root, false);
  const repository = only(await discoverRepositories([root], git));
  const start = calls.length;
  assert.deepEqual(await readBranch(repository, git), { kind: 'unborn', name: 'main' });
  await command(root, 'commit', '--allow-empty', '-m', 'initial');
  const branch = await readBranch(repository, git);
  assert.equal(branch.kind, 'branch');
  assert.equal(branch.name, 'main');
  assert.match(branch.oid!, /^[0-9a-f]{40,64}$/);
  await command(root, 'checkout', '--detach');
  assert.deepEqual(await readBranch(repository, git), { kind: 'detached', oid: branch.oid });
  assert.ok(calls.slice(start).every(args => !['status', 'diff', 'log', 'ls-files'].includes(args[0]!)));
});

test('discovery includes nested declarations, missing checkouts, and index-only gitlinks', async t => {
  const root = await fixture(t);
  await initialize(root);
  const child = path.join(root, 'modules', 'child with space');
  await initialize(child);
  await mkdir(path.join(child, 'empty'), { recursive: true });
  await writeFile(path.join(root, '.gitmodules'), '[submodule "child"]\n path = modules/child with space\n[submodule "missing"]\n path = absent\n');
  await writeFile(path.join(child, '.gitmodules'), '[submodule "empty"]\n path = empty\n');
  const oid = await command(root, 'rev-parse', 'HEAD');
  await command(root, 'update-index', '--add', '--cacheinfo', `160000,${oid},recorded-only`);
  const repositories = await discoverRepositories([root], git);
  assert.deepEqual(repositories.map(repository => path.relative(root, repository.root)), ['', 'absent', 'modules/child with space', 'recorded-only', 'modules/child with space/empty']);
  assert.equal(repositories[0]!.available, true);
  assert.equal(repositories[1]!.available, false);
  assert.equal(repositories[2]!.available, true);
  assert.equal(repositories[3]!.available, false);
  assert.equal(repositories[4]!.available, false);
  assert.equal(repositories[4]!.parentId, repositories[2]!.id);
  assert.match(repositories[4]!.error!, /not initialized/);
});

test('checkout identity is stable across branch changes and distinct for linked worktrees', async t => {
  const directory = await fixture(t);
  const root = path.join(directory, 'main');
  const linked = path.join(directory, 'linked');
  await initialize(root);
  await command(root, 'worktree', 'add', '-b', 'other', linked);
  const repositories = await discoverRepositories([root, linked, root], git);
  assert.equal(repositories.length, 2);
  const [first, second] = repositories as [Repository, Repository];
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.gitDir, second.gitDir);
  assert.equal(first.commonDir, second.commonDir);
  assert.equal((await readBranch(second, git)).name, 'other');
  await command(root, 'checkout', '-b', 'renamed');
  assert.equal(only(await discoverRepositories([root], git)).id, first.id);
  await mkdir(path.join(second.gitDir!, 'rebase-merge'));
  assert.equal((await readBranch(second, git)).operation, 'rebase');
  assert.equal((await readBranch(first, git)).operation, undefined);
});

test('separate Git directories and workspace folders within a checkout are resolved through Git', async t => {
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  const gitDir = path.join(directory, 'metadata');
  await command(directory, 'init', '-b', 'main', '--separate-git-dir', gitDir, root);
  const inner = path.join(root, 'src');
  await mkdir(inner);
  const repository = only(await discoverRepositories([inner], git));
  assert.equal(repository.root, root);
  assert.equal(repository.gitDir, gitDir);
  assert.equal(repository.commonDir, gitDir);
  assert.equal((await readBranch(repository, git)).kind, 'unborn');
});

test('an explicitly opened submodule keeps its parent relationship without duplicate rows', async t => {
  const root = await fixture(t);
  await initialize(root);
  const child = path.join(root, 'child');
  await initialize(child);
  await writeFile(path.join(root, '.gitmodules'), '[submodule "child"]\n path = child\n');
  for (const roots of [[root, child], [child, root]]) {
    const repositories = await discoverRepositories(roots, git);
    assert.equal(repositories.length, 2);
    const parentRepository = repositories.find(repository => repository.root === root)!;
    const childRepository = repositories.find(repository => repository.root === child)!;
    assert.equal(childRepository.parentId, parentRepository.id);
  }
});

test('unsafe declarations and escaping symlinks do not inspect outside the checkout', async t => {
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  const outside = path.join(directory, 'outside');
  await initialize(root);
  await initialize(outside);
  await symlink(outside, path.join(root, 'escape'));
  await symlink(root, path.join(root, 'cycle'));
  await writeFile(path.join(root, '.gitmodules'), '[submodule "escape"]\n path = escape\n[submodule "cycle"]\n path = cycle\n[submodule "parent"]\n path = ../outside\n[submodule "metadata"]\n path = .git/modules/secret\n');
  const roots: string[] = [];
  const guarded: GitRunner = { run(cwd, args, options) { roots.push(cwd); return git.run(cwd, args, options); } };
  const repository = only(await discoverRepositories([root], guarded));
  assert.equal(repository.available, true);
  assert.match(repository.error!, /Ignored/);
  assert.ok(roots.every(cwd => cwd === root));
});

test('one broken repository and corrupt declarations do not prevent healthy siblings', async t => {
  const directory = await fixture(t);
  const root = path.join(directory, 'valid');
  await initialize(root);
  await writeFile(path.join(root, '.gitmodules'), '[bad syntax');
  const repositories = await discoverRepositories([path.join(directory, 'missing'), root], git);
  assert.equal(repositories.length, 2);
  assert.equal(repositories[0]!.available, false);
  assert.equal(repositories[1]!.available, true);
  assert.match(repositories[1]!.error!, /bad config|bad configuration/);
  assert.equal((await readBranch(repositories[1]!, git)).name, 'main');
  await assert.rejects(readBranch(repositories[0]!, git));
});

test('nonzero metadata errors are not confused with detached or unborn states', async () => {
  const repository: Repository = { id: 'test', root: '/checkout', name: 'checkout', available: true };
  const broken: GitRunner = { async run(): Promise<GitResult> { return { stdout: '', stderr: 'corrupt refs', exitCode: 128 }; } };
  await assert.rejects(readBranch(repository, broken), /corrupt refs/);
});

test('repository metadata is published before index discovery finishes', async t => {
  const root = await fixture(t);
  await initialize(root);
  let release!: () => void;
  const indexGate = new Promise<void>(resolve => { release = resolve; });
  let published!: (repository: Repository) => void;
  const publication = new Promise<Repository>(resolve => { published = resolve; });
  const delayed: GitRunner = {
    async run(cwd, args, options) {
      if (args[0] === 'ls-files') await indexGate;
      return git.run(cwd, args, options);
    },
  };
  const discovery = discoverRepositories([root], delayed, published);
  try {
    const repository = await publication;
    assert.equal(repository.available, true);
    assert.equal((await readBranch(repository, delayed)).name, 'main');
  } finally { release(); }
  assert.equal((await discovery).length, 1);
});

test('catalog writes atomically with private permissions and recovers from corrupt or unknown caches', async t => {
  const root = await fixture(t);
  await initialize(root);
  const repositories = await discoverRepositories([root], git);
  const file = path.join(root, 'cache', 'catalog.json');
  await saveCatalog(file, repositories);
  assert.deepEqual(await loadCatalog(file), repositories);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(path.dirname(file)), ['catalog.json']);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1);
  await writeFile(file, '{truncated');
  assert.deepEqual(await loadCatalog(file), []);
  await writeFile(file, JSON.stringify({ version: 2, repositories }));
  assert.deepEqual(await loadCatalog(file), []);
  await writeFile(file, JSON.stringify({ version: 1, repositories: [{ ...repositories[0], root: 'relative' }] }));
  assert.deepEqual(await loadCatalog(file), []);
  assert.deepEqual(await loadCatalog(`${file}.missing`), []);
});
