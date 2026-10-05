import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { renameSync, symlinkSync } from 'node:fs';
import type { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceFiles } from '../src/core/files';
import { WorkspaceSearch } from '../src/core/search';

test('recovery tightens existing storage permissions and keeps backup payloads private', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'minv-release-private-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'workspace');
  const recovery = path.join(temporary, 'recovery');
  await fs.mkdir(root);
  await fs.mkdir(recovery, { mode: 0o755 });
  await fs.chmod(recovery, 0o755);
  await fs.writeFile(path.join(root, 'shared.txt'), 'sensitive code\n', { mode: 0o644 });
  const files = await WorkspaceFiles.create({ roots: [root], recoveryDirectory: recovery });
  const rootId = files.roots[0]!.id;
  const document = await files.read(rootId, 'shared.txt');
  const backup = await files.backup(rootId, 'shared.txt', document.fingerprint);
  assert.equal((await fs.stat(recovery)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(recovery, backup.id + '.backup'))).mode & 0o777, 0o600);
  assert.equal(backup.mode, 0o644, 'original file mode belongs to restoration metadata');
});

test('search cannot follow a workspace root replaced between validation and subprocess launch', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'minv-release-search-race-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'workspace');
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'file.txt'), 'ordinary workspace\n');
  await fs.writeFile(path.join(outside, 'file.txt'), 'outside-secret-only\n');
  const files = await WorkspaceFiles.create({ roots: [root], recoveryDirectory: path.join(temporary, 'recovery') });
  const search = new WorkspaceSearch(files);
  const mutableProcess = require('node:child_process') as { spawn: typeof spawn };
  const originalSpawn = mutableProcess.spawn;
  let injected = false;
  mutableProcess.spawn = ((...args: any[]) => {
    if (!injected && (args[0] === 'rg' || String(args[0]).endsWith('/rg'))) {
      injected = true;
      renameSync(root, root + '-original');
      symlinkSync(outside, root);
    }
    return (originalSpawn as (...args: any[]) => ReturnType<typeof spawn>)(...args);
  }) as typeof spawn;
  try {
    const result = await search.search({ query: 'outside-secret-only' }).catch(error => ({ matches: [], complete: false, errors: [String(error)] }));
    assert.equal(injected, true);
    assert.deepEqual(result.matches, [], 'search returned content from an unapproved root');
    assert.equal(result.complete, false);
    assert.ok(result.errors.length > 0);
  } finally { mutableProcess.spawn = originalSpawn; }
});

test('a directory replaced by an escaping symlink during open cannot expose outside text', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'minv-release-path-race-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'workspace');
  const insideDirectory = path.join(root, 'folder');
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(insideDirectory, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(insideDirectory, 'file.txt'), 'approved data\n');
  await fs.writeFile(path.join(outside, 'file.txt'), 'outside secret\n');
  const files = await WorkspaceFiles.create({ roots: [root], recoveryDirectory: path.join(temporary, 'recovery') });
  // Deterministically deliver an external directory swap after path validation,
  // immediately before the filesystem opens the requested file.
  const mutableFs = require('node:fs/promises') as { open: typeof fs.open };
  const originalOpen = mutableFs.open;
  let injected = false;
  mutableFs.open = (async (...args: Parameters<typeof fs.open>) => {
    if (!injected && args[0] === path.join(insideDirectory, 'file.txt')) {
      injected = true;
      await fs.rename(insideDirectory, insideDirectory + '-original');
      await fs.symlink(outside, insideDirectory);
    }
    return originalOpen(...args);
  }) as typeof fs.open;
  try {
    await assert.rejects(files.read(files.roots[0]!.id, 'folder/file.txt'), /symlink|outside|changed|boundary/i);
    assert.equal(injected, true);
    assert.equal(await fs.readFile(path.join(outside, 'file.txt'), 'utf8'), 'outside secret\n');
  } finally { mutableFs.open = originalOpen; }
});

test('transfer reviews cannot cross a newly discovered repository boundary or be replayed', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'minv-release-transfer-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'workspace');
  const child = path.join(root, 'child');
  await fs.mkdir(child, { recursive: true });
  await fs.writeFile(path.join(root, 'source.txt'), 'source\n');
  const files = await WorkspaceFiles.create({ roots: [root], repositoryRoots: [root], recoveryDirectory: path.join(temporary, 'recovery') });
  const id = files.roots[0]!.id;
  const obsolete = await files.prepareTransfer('move', id, 'source.txt', id, 'child/target.txt');
  assert.equal(obsolete.requiresConfirmation, false);
  await files.setRepositoryRoots([root, child]);
  await assert.rejects(files.transfer(obsolete.token), /scope changed/i);
  assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'source\n');
  await assert.rejects(fs.stat(path.join(child, 'target.txt')), { code: 'ENOENT' });
  const current = await files.prepareTransfer('copy', id, 'source.txt', id, 'child/target.txt');
  assert.equal(current.requiresConfirmation, true);
  await assert.rejects(files.transfer(current.token), /Confirm both repository scopes/);
  await files.transfer(current.token, true);
  await assert.rejects(files.transfer(current.token, true), /expired|unknown|consumed/i);
  assert.equal(await fs.readFile(path.join(child, 'target.txt'), 'utf8'), 'source\n');
});
