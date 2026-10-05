import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireApplicationLease, acquireInstallerLease, inspectStaleApplicationLeases } from '../src/core/update-lease';

test('installation and application launches exclude each other; stale recovery is explicit', async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'minv-update-gate-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const app = await acquireApplicationLease(data);
  await assert.rejects(acquireInstallerLease(data), /Close Minv normally/);
  await app.release();
  const installer = await acquireInstallerLease(data);
  await assert.rejects(acquireApplicationLease(data), /installation is in progress/);
  await installer.release();
  const gate = path.join(data, 'update-gate');
  const stale = 'app-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  await writeFile(path.join(gate, stale), JSON.stringify({ pid: 99999999, birth: '0' }));
  await mkdir(path.join(data, 'recovery'));
  await writeFile(path.join(data, 'recovery/draft'), 'preserve');
  await assert.rejects(acquireInstallerLease(data), /Close Minv normally/);
  assert.deepEqual(await inspectStaleApplicationLeases(data), { stale: [stale], recoveryPresent: true });
  assert.deepEqual(await inspectStaleApplicationLeases(data, true), { stale: [stale], recoveryPresent: true });
  const after = await acquireInstallerLease(data); await after.release();
});
