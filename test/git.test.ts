import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { Git } from '../src/core/git';

const exec = promisify(execFile);
async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function raw(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } })).stdout;
}
async function initialize(root: string): Promise<void> {
  await raw(root, 'init', '-b', 'main');
  await raw(root, 'config', 'user.name', 'Minv tests');
  await raw(root, 'config', 'user.email', 'minv@example.invalid');
  await writeFile(path.join(root, 'file.txt'), 'before\n');
  await raw(root, 'add', 'file.txt');
  await raw(root, 'commit', '-m', 'initial');
}
async function until(predicate: () => Promise<boolean>, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for test process.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fake(t: TestContext): Promise<{ root: string; git: Git }> {
  const root = await fixture(t);
  const executable = path.join(root, 'fake-git');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--list')) process.exit(0);
if (args.includes('--version')) { process.stdout.write('git version 2.55.0\\n'); process.exit(0); }
const id = args.find(value => value.startsWith('id='))?.slice(3) || 'default';
fs.appendFileSync('started', id + '\\n');
if (args.includes('emit')) { process.stdout.write('x'.repeat(8192)); }
else if (args.includes('env')) process.stdout.write(JSON.stringify(process.env));
else if (args.includes('hold')) {
  fs.writeFileSync('pid-' + id, String(process.pid));
  const timer = setInterval(() => { if (fs.existsSync('release-' + id)) { clearInterval(timer); process.stdout.write(id); } }, 10);
} else if (args.includes('fail')) { process.stderr.write('expected failure'); process.exitCode = 23; }
else process.stdout.write(id);
`);
  await chmod(executable, 0o700);
  // Scheduler fixtures deliberately replace the trusted app-owned launcher. Real
  // confinement is exercised separately against the compiled native launcher.
  const git = new Git({ executable, sandboxExecutable: executable });
  t.after(() => git.dispose());
  return { root, git };
}

test('real Git uses literal argument arrays and returns ordinary nonzero results', async t => {
  const root = await fixture(t);
  await initialize(root);
  const git = new Git(); t.after(() => git.dispose());
  const result = await git.run(root, ['rev-parse', '--verify', '--quiet', 'missing-ref']);
  assert.equal(result.exitCode, 1);
  await writeFile(path.join(root, '$(touch injected).txt'), 'data');
  const status = await git.run(root, ['status', '--porcelain=v2', '-z']);
  assert.match(status.stdout, /\$\(touch injected\)\.txt/);
  await assert.rejects(readFile(path.join(root, 'injected')));
  await assert.rejects(git.run(root, ['config', 'unsafe.key', 'value']), /configuration reads/);
  await assert.rejects(git.run(root, ['fetch']), /trusted write/);
});

test('passive reads reject required content filters without executing them', async t => {
  const root = await fixture(t);
  await initialize(root);
  const helper = path.join(root, 'helper');
  await writeFile(helper, '#!/bin/sh\nprintf ran >> "$PWD/executed"\ncat\n');
  await chmod(helper, 0o700);
  await writeFile(path.join(root, '.gitattributes'), '*.txt filter=strange.driver diff=strange\n');
  for (const [key, value] of [
    ['core.fsmonitor', helper], ['filter.strange.driver.clean', helper], ['filter.strange.driver.process', helper],
    ['filter.strange.driver.required', 'true'], ['diff.strange.textconv', helper], ['diff.external', helper],
  ]) await raw(root, 'config', key!, value!);
  await writeFile(path.join(root, 'file.txt'), 'after!\n');
  const git = new Git(); t.after(() => git.dispose());
  const status = await git.run(root, ['status', '--porcelain=v2', '-z', '--ignore-submodules=none']);
  assert.equal(status.exitCode, 125, status.stderr);
  assert.match(status.stderr, /blocked executable helper/);
  const diff = await git.run(root, ['diff']);
  assert.equal(diff.exitCode, 125, diff.stderr);
  await assert.rejects(readFile(path.join(root, 'executed')));
});

test('inherited Git environment cannot redirect a checkout or inject config', async t => {
  const { root, git } = await fake(t);
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_EXTERNAL_DIFF'];
  const previous = names.map(name => process.env[name]);
  try {
    names.forEach(name => { process.env[name] = 'malicious'; });
    const env = JSON.parse((await git.run(root, ['rev-parse', 'env'])).stdout) as Record<string, string>;
    for (const name of names) assert.equal(env[name], undefined);
    assert.equal(env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  } finally { names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }); }
});

test('metadata capacity stays available when all content slots are occupied', async t => {
  const { root, git } = await fake(t);
  const pending = Array.from({ length: 4 }, (_, index) => git.run(root, ['rev-parse', 'hold', `id=background${index}`], { lane: 'background' }));
  try {
    await until(async () => (await readFile(path.join(root, 'started'), 'utf8').catch(() => '')).trim().split('\n').length === 4);
    const result = await git.run(root, ['rev-parse', 'id=selected'], { lane: 'metadata', timeoutMs: 1000 });
    assert.equal(result.stdout, 'selected');
  } finally {
    await Promise.all(Array.from({ length: 4 }, (_, index) => writeFile(path.join(root, `release-background${index}`), '')));
    await Promise.all(pending);
  }
});

test('shared-directory writes serialize while unrelated writes can proceed', async t => {
  const { root, git } = await fake(t);
  const one = git.run(root, ['add', 'hold', 'id=one'], { write: true, lockKey: root });
  await until(async () => (await readFile(path.join(root, 'started'), 'utf8').catch(() => '')).includes('one'));
  const two = git.run(root, ['add', 'id=two'], { write: true, lockKey: root });
  const unrelated = await git.run(root, ['add', 'id=other'], { write: true, lockKey: path.join(root, 'other') });
  assert.equal(unrelated.stdout, 'other');
  assert.doesNotMatch(await readFile(path.join(root, 'started'), 'utf8'), /two/);
  await writeFile(path.join(root, 'release-one'), '');
  await one;
  assert.equal((await two).stdout, 'two');
});

test('foreground requests cannot indefinitely starve queued background work', async t => {
  const { root, git } = await fake(t);
  const blockers = Array.from({ length: 4 }, (_, index) => git.run(root, ['rev-parse', 'hold', `id=block${index}`], { lane: 'background' }));
  let queued: Promise<unknown>[] = [];
  try {
    await until(async () => (await readFile(path.join(root, 'started'), 'utf8').catch(() => '')).trim().split('\n').length === 4);
    queued = Array.from({ length: 4 }, (_, index) => git.run(root, ['rev-parse', `id=foreground${index}`], { lane: 'foreground' }));
    queued.push(git.run(root, ['rev-parse', 'id=waiting-background'], { lane: 'background' }));
    await writeFile(path.join(root, 'release-block0'), '');
    await Promise.all(queued);
    const order = (await readFile(path.join(root, 'started'), 'utf8')).trim().split('\n').slice(4);
    assert.deepEqual(order, ['foreground0', 'foreground1', 'foreground2', 'waiting-background', 'foreground3']);
  } finally {
    await Promise.all(Array.from({ length: 4 }, (_, index) => writeFile(path.join(root, `release-block${index}`), '')));
    await Promise.all([...blockers, ...queued]);
  }
});

test('running writes are not canceled by a UI abort signal', async t => {
  const { root, git } = await fake(t);
  const controller = new AbortController();
  const pending = git.run(root, ['add', 'hold', 'id=write'], { write: true, lockKey: root, signal: controller.signal });
  await until(async () => (await readFile(path.join(root, 'started'), 'utf8').catch(() => '')).includes('write'));
  controller.abort();
  await writeFile(path.join(root, 'release-write'), '');
  assert.equal((await pending).stdout, 'write');
});

test('only explicit network-write cancellation can interrupt an active write', async t => {
  const { root, git } = await fake(t);
  const controller = new AbortController();
  const pending = git.run(root, ['fetch', 'hold', 'id=fetch'], { write: true, lockKey: root, signal: controller.signal, cancelActiveWrite: true });
  const rejected = assert.rejects(pending, /canceled.*outcome may be uncertain/);
  await until(async () => (await readFile(path.join(root, 'started'), 'utf8').catch(() => '')).includes('fetch'));
  controller.abort(); await rejected;
  const local = new AbortController();
  const commit = git.run(root, ['commit', 'hold', 'id=commit'], { write: true, lockKey: root, signal: local.signal, cancelActiveWrite: true });
  await until(async () => (await readFile(path.join(root, 'started'), 'utf8').catch(() => '')).includes('commit'));
  local.abort(); await writeFile(path.join(root, 'release-commit'), '');
  assert.equal((await commit).stdout, 'commit');
});

test('cancellation, deadlines, and output limits reject incomplete results', async t => {
  const { root, git } = await fake(t);
  const controller = new AbortController();
  const pending = git.run(root, ['rev-parse', 'hold', 'id=cancel'], { signal: controller.signal });
  const rejected = assert.rejects(pending, /canceled/);
  await until(async () => (await readFile(path.join(root, 'started'), 'utf8').catch(() => '')).includes('cancel'));
  controller.abort();
  await rejected;
  await assert.rejects(git.run(root, ['rev-parse', 'hold', 'id=timeout'], { timeoutMs: 40 }), /timed out/);
  await assert.rejects(git.run(root, ['rev-parse', 'emit'], { maxBytes: 100 }), /output limit/);
  assert.equal((await git.run(root, ['rev-parse', 'fail'])).exitCode, 23);
  const missing = new Git({ executable: path.join(root, 'missing-executable') });
  await assert.rejects(missing.run(root, ['--version']), /unavailable/);
  missing.dispose();
});

test('static fsmonitor, textconv and external-diff commands remain disabled', async t => {
  const root = await fixture(t); await initialize(root);
  const helper = path.join(root, 'helper');
  await writeFile(helper, '#!/bin/sh\nprintf ran >> "$PWD/executed"\ncat\n'); await chmod(helper, 0o700);
  await writeFile(path.join(root, '.gitattributes'), '*.txt diff=evil\n');
  for (const key of ['core.fsmonitor', 'diff.evil.textconv', 'diff.external']) await raw(root, 'config', key, helper);
  await writeFile(path.join(root, 'file.txt'), 'change\n');
  const git = new Git(); t.after(() => git.dispose());
  assert.equal((await git.run(root, ['status', '--porcelain=v2', '-z'])).exitCode, 0);
  const diff = await git.run(root, ['diff']);
  assert.equal(diff.exitCode, 0, diff.stderr); assert.match(diff.stdout, /change/);
  await assert.rejects(readFile(path.join(root, 'executed')));
});

test('a filter introduced immediately before Git starts cannot escape kernel confinement', async t => {
  const root = await fixture(t); await initialize(root);
  await writeFile(path.join(root, '.gitattributes'), '*.txt filter=late\n');
  await writeFile(path.join(root, 'file.txt'), 'change\n');
  const launcher = path.resolve(__dirname, '../native/minv-git-sandbox');
  const wrapper = path.join(root, 'inject-config');
  await writeFile(wrapper, `#!${process.execPath}\nconst cp=require('node:child_process');\ncp.execFileSync('git',['config','filter.late.clean','touch executed; cat']);\nconst result=cp.spawnSync(${JSON.stringify(launcher)},process.argv.slice(2),{stdio:'inherit'});process.exit(result.status??126);\n`);
  await chmod(wrapper, 0o700);
  const git = new Git({ sandboxExecutable: wrapper }); t.after(() => git.dispose());
  const result = await git.run(root, ['status', '--porcelain=v2', '-z']);
  assert.equal(result.exitCode, 125, result.stderr);
  assert.match(result.stderr, /blocked executable helper/);
  await assert.rejects(readFile(path.join(root, 'executed')));
});

test('the native sandbox blocks file mutation, network sockets and a second exec independently of Git configuration', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'probe.c'); const executable = path.join(root, 'probe');
  const target = path.join(root, 'keep'); await writeFile(target, 'original');
  await writeFile(source, `#include <errno.h>\n#include <stdio.h>\n#include <unistd.h>\n#include <fcntl.h>\n#include <sys/socket.h>\nint main(void) {\nint fd=open("keep",O_WRONLY|O_TRUNC); printf("write=%d\\n",fd);\nint sock=socket(AF_INET,SOCK_STREAM,0);printf("socket=%d\\n",sock);fflush(stdout);\nchar *args[]={"true",0};execv("/usr/bin/true",args);printf("exec=%d\\n",errno);return 0;\n}\n`);
  await exec('cc', [source, '-o', executable]);
  const launcher = path.resolve(__dirname, '../native/minv-git-sandbox');
  try {
    await exec(launcher, [executable], { cwd: root });
    assert.fail('Sandbox did not report denied operations.');
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    assert.equal(result.code, 125, result.stderr);
    assert.match(result.stdout, /write=-1/); assert.match(result.stdout, /socket=-1/); assert.match(result.stdout, /exec=1/);
  }
  assert.equal(await readFile(target, 'utf8'), 'original');
});

test('missing confinement and executable wrappers fail closed', async t => {
  const root = await fixture(t); await initialize(root);
  const missing = new Git({ sandboxExecutable: path.join(root, 'missing') });
  await assert.rejects(missing.run(root, ['status', '--porcelain=v2']), /confinement is unavailable/); missing.dispose();
  const wrapper = path.join(root, 'git-wrapper'); await writeFile(wrapper, '#!/bin/sh\ntouch executed\n'); await chmod(wrapper, 0o700);
  const git = new Git({ executable: wrapper }); t.after(() => git.dispose());
  const result = await git.run(root, ['--version']);
  assert.equal(result.exitCode, 126); assert.match(result.stderr, /native ELF/);
  await assert.rejects(readFile(path.join(root, 'executed')));
});

test('a confined process cannot replace the supervisor with a newer seccomp listener', async t => {
  const root = await fixture(t); const source = path.join(root, 'nested-filter.c'); const executable = path.join(root, 'nested-filter');
  await writeFile(source, `#define _GNU_SOURCE\n#include <linux/filter.h>\n#include <linux/seccomp.h>\n#include <stdio.h>\n#include <sys/prctl.h>\n#include <sys/syscall.h>\n#include <unistd.h>\nint main(void) { struct sock_filter code[]={BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_USER_NOTIF)}; struct sock_fprog program={.len=1,.filter=code};\nint first=syscall(SYS_seccomp,SECCOMP_SET_MODE_FILTER,SECCOMP_FILTER_FLAG_NEW_LISTENER,&program);\nint second=prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program);printf("%d %d\\n",first,second);return 0;}\n`);
  await exec('cc', [source, '-o', executable]);
  const result = await exec(path.resolve(__dirname, '../native/minv-git-sandbox'), [executable]);
  assert.equal(result.stdout.trim(), '-1 -1');
});

test('missing promisor objects do not invoke a remote helper or fetch', async t => {
  const root = await fixture(t); await initialize(root);
  const oid = (await raw(root, 'rev-parse', 'HEAD:file.txt')).trim();
  await raw(root, 'config', 'remote.origin.url', 'ext::sh -c touch\\ executed');
  await raw(root, 'config', 'remote.origin.promisor', 'true');
  await raw(root, 'config', 'extensions.partialClone', 'origin');
  await raw(root, 'config', 'protocol.ext.allow', 'always');
  await rm(path.join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  const git = new Git(); t.after(() => git.dispose());
  const result = await git.run(root, ['cat-file', '-p', oid]);
  assert.notEqual(result.exitCode, 0); assert.doesNotMatch(result.stderr, /blocked executable helper/);
  await assert.rejects(readFile(path.join(root, 'executed')));
});

test('built-in attribute normalization remains equivalent to Git without executable filters', async t => {
  const root = await fixture(t); await initialize(root);
  await writeFile(path.join(root, '.gitattributes'), '*.txt text eol=lf\n');
  await raw(root, 'add', '.gitattributes'); await raw(root, 'commit', '-m', 'attributes');
  await writeFile(path.join(root, 'file.txt'), 'before\r\n');
  const git = new Git(); t.after(() => git.dispose());
  const args = ['status', '--porcelain=v2', '-z', '--ignore-submodules=dirty'];
  const expected = await raw(root, ...args);
  const observed = await git.run(root, args);
  assert.equal(observed.exitCode, 0, observed.stderr); assert.equal(observed.stdout, expected);
});

test('command diagnostics report scheduling and process measurements without repository data', async t => {
  const root = await fixture(t); await initialize(root);
  const traces: unknown[] = []; const git = new Git({ onCommand: trace => traces.push(trace) }); t.after(() => git.dispose());
  const result = await git.run(root, ['symbolic-ref', '--quiet', 'HEAD'], { lane: 'metadata' });
  assert.equal(result.exitCode, 0);
  assert.equal(traces.length, 1);
  const trace = traces[0] as { command: string; lane: string; queueMs: number; durationMs: number; bytes: number };
  assert.equal(trace.command, 'symbolic-ref'); assert.equal(trace.lane, 'metadata');
  assert.ok(trace.queueMs >= 0); assert.ok(trace.durationMs > 0); assert.equal(trace.bytes, Buffer.byteLength(result.stdout));
  assert.ok(!JSON.stringify(trace).includes(root)); assert.ok(!JSON.stringify(trace).includes('HEAD'));
});

test('duplicate in-flight reads coalesce without sharing writes', async t => {
  const { root, git } = await fake(t);
  const one = git.run(root, ['rev-parse', 'hold', 'id=duplicate']);
  const two = git.run(root, ['rev-parse', 'hold', 'id=duplicate']);
  await until(async () => (await readFile(path.join(root, 'started'), 'utf8').catch(() => '')).includes('duplicate'));
  await writeFile(path.join(root, 'release-duplicate'), '');
  assert.deepEqual(await one, await two);
  assert.equal((await readFile(path.join(root, 'started'), 'utf8')).trim(), 'duplicate');
});
