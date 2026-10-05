import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, chmod, symlink, mkdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { cliWaitTicket, parseCli, signalCliWait } from '../src/core/cli';

const execute = promisify(execFile);

test('CLI accepts roots, files, explicit repository and safe option terminator', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'minv-cli-test-'));
  try {
    await writeFile(path.join(directory, 'read me.ts'), '');
    const request = parseCli([directory, 'read me.ts', '--repo', directory, '--', '-literal.ts'], directory);
    assert.deepEqual(request, {
      kind: 'launch', roots: [directory], rootsExplicit: true,
      files: [{ path: path.join(directory, 'read me.ts') }, { path: path.join(directory, '-literal.ts') }],
      repository: directory, wait: false, reuseWindow: true, newWindow: false,
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI parses POSIX, Windows drive and UNC goto positions without splitting the drive colon', () => {
  for (const [input, file, line, column] of [
    ['file.ts:42:5', '/workspace/file.ts', 42, 5],
    ['src/na:me.ts:3', '/workspace/src/na:me.ts', 3, 1],
    ['C:\\work\\my file.ts:42:5', 'C:\\work\\my file.ts', 42, 5],
    ['\\\\server\\share\\file.ts:4', '\\\\server\\share\\file.ts', 4, 1],
  ] as const) {
    const result = parseCli(['--goto', input, '--wait'], '/workspace');
    assert.equal(result.kind, 'launch');
    if (result.kind === 'launch') assert.deepEqual(result.files, [{ path: file, line, column }]);
  }
  const windows = parseCli(['--goto', 'src\\file.ts:1'], 'D:\\project');
  assert.equal(windows.kind, 'launch');
  if (windows.kind === 'launch') assert.deepEqual(windows.files, [{ path: 'D:\\project\\src\\file.ts', line: 1, column: 1 }]);
});

test('CLI diffs keep paths literal and explicit new windows disable reuse', () => {
  const result = parseCli(['--new-window', '--diff', 'before $(touch nope)', 'after; nope', '--wait'], '/workspace');
  assert.deepEqual(result, {
    kind: 'launch', roots: ['/workspace'], rootsExplicit: false, files: [], wait: true, reuseWindow: false, newWindow: true,
    diff: { before: '/workspace/before $(touch nope)', after: '/workspace/after; nope' },
  });
});

test('CLI reports malformed and conflicting options instead of guessing', () => {
  for (const args of [
    ['--unknown'], ['--repo'], ['--diff', 'one'], ['--wait'], ['--goto', 'file'],
    ['--goto', 'file:0'], ['--goto', 'file:1:0'], ['--goto', 'file:9007199254740992'],
    ['--goto', 'C:file:1'], ['--new-window', '--reuse-window'], ['--wait=true'],
    ['--diff', 'a', 'b', '--diff', 'c', 'd'], ['--repo', 'a', '--repo', 'b'],
    ['--help', '--version'], ['--repo', '\0'], ['--repo='],
  ]) assert.throws(() => parseCli(args, '/workspace'), { name: 'CliArgumentError' }, args.join(' '));
  assert.deepEqual(parseCli(['--help'], '/workspace'), { kind: 'help' });
  assert.deepEqual(parseCli(['--version'], '/workspace'), { kind: 'version' });
  assert.equal(parseCli(['--goto=./-file.ts:1'], '/workspace').kind, 'launch');
  const empty = parseCli([], '/workspace');
  assert.equal(empty.kind, 'launch');
  if (empty.kind === 'launch') { assert.deepEqual(empty.roots, ['/workspace']); assert.equal(empty.rootsExplicit, false); }
});

test('CLI wait acknowledgements require private directories and never overwrite existing files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'minv-wait-'));
  await chmod(directory, 0o700);
  const ticket = { file: path.join(directory, 'closed'), token: 'a'.repeat(64) };
  try {
    assert.deepEqual(cliWaitTicket({ MINV_WAIT_FILE: ticket.file, MINV_WAIT_TOKEN: ticket.token }), ticket);
    await signalCliWait(ticket);
    assert.equal(await readFile(ticket.file, 'utf8'), ticket.token);
    await assert.rejects(signalCliWait(ticket), { code: 'EEXIST' });
    assert.throws(() => cliWaitTicket({ MINV_WAIT_FILE: '/etc/passwd', MINV_WAIT_TOKEN: ticket.token }));
    assert.throws(() => cliWaitTicket({ MINV_WAIT_FILE: ticket.file, MINV_WAIT_TOKEN: '../anything' }));
    assert.equal(cliWaitTicket({}), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI refuses symlinked wait directories and public wait directories', async () => {
  if (process.platform === 'win32') return;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'minv-wait-'));
  const alias = `${directory}alias`;
  try {
    await symlink(directory, alias, 'dir');
    await assert.rejects(signalCliWait({ file: path.join(alias, 'closed'), token: 'b'.repeat(64) }), /private/);
    await chmod(directory, 0o755);
    await assert.rejects(signalCliWait({ file: path.join(directory, 'closed'), token: 'b'.repeat(64) }), /private/);
  } finally {
    await rm(alias, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged launcher forwards literal arguments, clears Electron Node mode and waits for acknowledgement', async () => {
  if (process.platform === 'win32') return;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'minv-cli-package-test-'));
  const capture = path.join(directory, 'capture.json');
  try {
    await mkdir(path.join(directory, 'resources/cli'), { recursive: true });
    await mkdir(path.join(directory, 'resources/app'), { recursive: true });
    await copyFile(path.resolve(__dirname, '../../scripts/minv.mjs'), path.join(directory, 'resources/cli/minv.mjs'));
    await build({ entryPoints: [path.resolve(__dirname, '../../src/core/cli.ts')], outfile: path.join(directory, 'resources/cli/cli.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
    await writeFile(path.join(directory, 'resources/app/package.json'), JSON.stringify({ name: 'minv', version: '1.2.3' }));
    await writeFile(path.join(directory, 'minv'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.MINV_TEST_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.env.MINV_LAUNCH_CWD, nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null, waitFile: process.env.MINV_WAIT_FILE }));
if (process.env.MINV_WAIT_FILE) setTimeout(() => fs.writeFileSync(process.env.MINV_WAIT_FILE, process.env.MINV_WAIT_TOKEN + (process.env.MINV_TEST_FAILURE ? '\\nCannot open requested file.' : ''), { flag: 'wx' }), 100);
`, { mode: 0o755 });
    const launcher = path.join(directory, 'resources/cli/minv.mjs');
    const launchEnv = { ...process.env, MINV_USER_DATA: path.join(directory, 'user-data'), MINV_TEST_CAPTURE: capture };
    const args = ['--wait', '--goto', 'name $(echo nope);.ts:42:5'];
    await execute(process.execPath, [launcher, ...args], {
      cwd: directory,
      env: { ...launchEnv, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 5000,
    });
    const forwarded = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(forwarded.args, args);
    assert.equal(forwarded.cwd, directory);
    assert.equal(forwarded.nodeMode, null);
    await assert.rejects(readFile(forwarded.waitFile), { code: 'ENOENT' });
    assert.equal((await execute(process.execPath, [launcher, '--version'])).stdout, '1.2.3\n');
    await execute(process.execPath, [launcher], { cwd: directory, env: { ...launchEnv, MINV_DESKTOP_LAUNCH: '' } });
    assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')).args, [directory]);
    await execute(process.execPath, [launcher], { cwd: directory, env: { ...launchEnv, MINV_DESKTOP_LAUNCH: '1' } });
    assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')).args, []);
    await assert.rejects(execute(process.execPath, [launcher, '--unknown']), (error: unknown) => {
      assert.equal((error as { code: number }).code, 2);
      return true;
    });
    await assert.rejects(execute(process.execPath, [launcher, '--wait', 'file.ts'], {
      cwd: directory, env: { ...launchEnv, MINV_TEST_FAILURE: '1' }, timeout: 5000,
    }), (error: unknown) => {
      assert.equal((error as { code: number }).code, 1);
      assert.match((error as { stderr: string }).stderr, /Cannot open requested file/);
      return true;
    });
    await assert.rejects(readFile(JSON.parse(await readFile(capture, 'utf8')).waitFile), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
