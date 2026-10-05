import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { compareVersions, createReleaseManifest, signReleaseManifest, UpdateStore, verifyReleaseManifest, type SignedRelease } from '../src/core/update';

const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const idle = async () => ({ applicationRunning: false, dirtyBuffers: 0, activeWrites: 0 });
async function cleanup(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined); if (!info) return;
  if (info.isDirectory()) { await chmod(directory, 0o700); for (const entry of await readdir(directory)) await cleanup(path.join(directory, entry)); }
  await rm(directory, { force: true, recursive: true });
}
async function setup(t: TestContext): Promise<{ root: string; directory: string; store: UpdateStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-update-')); t.after(() => cleanup(root));
  const directory = path.join(root, 'install');
  return { root, directory, store: new UpdateStore({ directory, publisherPublicKey: publicKey, currentVersion: '0.0.0', platform: 'linux-x64' }) };
}
async function release(root: string, version: string, sequence: number): Promise<{ source: string; artifact: string; signed: SignedRelease }> {
  const source = path.join(root, `source-${version}`); await mkdir(path.join(source, 'resources/app'), { recursive: true });
  await writeFile(path.join(source, 'minv'), `verified executable ${version}\n`, { mode: 0o755 });
  await writeFile(path.join(source, 'resources/app/package.json'), JSON.stringify({ name: 'minv', version }));
  await writeFile(path.join(source, 'resources/app/main.cjs'), `// release ${version}\n${'x'.repeat(150_000)}`);
  const artifact = path.join(root, `minv-${version}-linux-x64.tar.gz`);
  // Archive bytes are opaque to the installer; extraction is a separate host operation.
  await writeFile(artifact, gzipSync(`archive fixture ${version}`));
  return { source, artifact, signed: signReleaseManifest(await createReleaseManifest(source, artifact, { version, sequence }), privateKey) };
}

test('Ed25519 verification binds canonical product/version/platform/artifact/inventory metadata', async t => {
  const { root } = await setup(t); const candidate = await release(root, '1.0.0', 1);
  assert.equal(verifyReleaseManifest(candidate.signed, publicKey, 'linux-x64').version, '1.0.0');
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' });
  assert.throws(() => verifyReleaseManifest(candidate.signed, other, 'linux-x64'), /signature/);
  assert.throws(() => verifyReleaseManifest({ ...candidate.signed, payload: candidate.signed.payload.replace('1.0.0', '9.0.0') }, publicKey, 'linux-x64'), /signature/);
  assert.throws(() => verifyReleaseManifest({ payload: candidate.signed.payload }, publicKey, 'linux-x64'), /fields/);
  assert.throws(() => verifyReleaseManifest(candidate.signed, '', 'linux-x64'), /configured publisher/);
  assert.throws(() => verifyReleaseManifest(candidate.signed, publicKey, 'darwin-arm64' as 'linux-x64'), /platform/);
  const duplicate = candidate.signed.payload.replace('"schema":1', '"schema":1,"schema":1');
  assert.throws(() => verifyReleaseManifest({ payload: duplicate, signature: sign(null, Buffer.from(duplicate), pair.privateKey).toString('base64') }, publicKey, 'linux-x64'), /Noncanonical/);
});

test('version comparison follows release/prerelease precedence without unsafe numeric coercion', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('2.0.0', '2.0.0-rc.9') > 0);
  assert.ok(compareVersions('2.0.0-beta.10', '2.0.0-beta.2') > 0);
  assert.equal(compareVersions('2.0.0+build1', '2.0.0+build2'), 0);
  assert.throws(() => compareVersions('1.0.0-alpha-x.02', '1.0.0'));
});

test('verified files are staged read-only and current changes through one atomic symlink', async t => {
  const { root, directory, store } = await setup(t); const candidate = await release(root, '1.0.0', 1);
  const staged = await store.stage(candidate.signed, candidate.artifact, candidate.source);
  await assert.rejects(readlink(path.join(directory, 'current')), { code: 'ENOENT' });
  assert.equal((await stat(path.join(directory, 'releases', staged.id, 'payload/minv'))).mode & 0o777, 0o555);
  assert.equal((await stat(path.join(directory, 'releases', staged.id, 'payload/resources/app/main.cjs'))).mode & 0o777, 0o444);
  await store.activate(staged.id, idle);
  assert.equal(await readlink(path.join(directory, 'current')), `releases/${staged.id}/payload`);
  assert.equal(await readFile(path.join(directory, 'current/resources/app/main.cjs'), 'utf8'), await readFile(path.join(candidate.source, 'resources/app/main.cjs'), 'utf8'));
  assert.deepEqual(await store.list(), [{ ...staged, current: true }]);
  await assert.rejects(store.activate(staged.id, idle), /latest verified upgrade/);
});

test('artifact and extracted-tree tampering cannot become a staged release', async t => {
  const { root, store } = await setup(t); const candidate = await release(root, '1.0.0', 1);
  const original = await readFile(candidate.artifact); const changed = Buffer.from(original); changed[changed.length - 1] = changed.at(-1)! ^ 1;
  await writeFile(candidate.artifact, changed);
  await assert.rejects(store.stage(candidate.signed, candidate.artifact, candidate.source), /artifact hash/);
  await writeFile(candidate.artifact, original);
  await writeFile(path.join(candidate.source, 'unexpected'), 'extra');
  await assert.rejects(store.stage(candidate.signed, candidate.artifact, candidate.source), /inventory/);
  await rm(path.join(candidate.source, 'unexpected'));
  await symlink('/etc/passwd', path.join(candidate.source, 'unexpected'));
  await assert.rejects(store.stage(candidate.signed, candidate.artifact, candidate.source), /symlinks/);
  await rm(path.join(candidate.source, 'unexpected'));
  assert.equal((await store.stage(candidate.signed, candidate.artifact, candidate.source)).version, '1.0.0');
});

test('replay and downgrade floors persist across restart and explicit offline rollback', async t => {
  const { root, directory, store } = await setup(t);
  const first = await release(root, '1.0.0', 10); const a = await store.stage(first.signed, first.artifact, first.source); await store.activate(a.id, idle);
  const second = await release(root, '2.0.0', 20); const b = await store.stage(second.signed, second.artifact, second.source); await store.activate(b.id, idle);
  await store.rollback(a.id, idle, true);
  assert.equal((await store.list()).find(item => item.current)?.id, a.id);
  const restarted = new UpdateStore({ directory, publisherPublicKey: publicKey, currentVersion: '1.0.0', platform: 'linux-x64' });
  await assert.rejects(restarted.stage(first.signed, first.artifact, first.source), /Replayed/);
  const downgrade = await release(root, '1.5.0', 21);
  await assert.rejects(restarted.stage(downgrade.signed, downgrade.artifact, downgrade.source), /downgraded/);
  const replaySequence = await release(root, '3.0.0', 20);
  await assert.rejects(restarted.stage(replaySequence.signed, replaySequence.artifact, replaySequence.source), /Replayed/);
  await restarted.activate(b.id, idle);
  assert.equal((await restarted.list()).find(item => item.current)?.id, b.id);
  await assert.rejects(restarted.rollback(a.id, idle, false as true), /confirmation/);
});

test('rollback re-verifies signatures/files and never accepts a forged or changed retained release', async t => {
  const { root, directory, store } = await setup(t);
  const first = await release(root, '1.0.0', 1); const a = await store.stage(first.signed, first.artifact, first.source); await store.activate(a.id, idle);
  const second = await release(root, '2.0.0', 2); const b = await store.stage(second.signed, second.artifact, second.source); await store.activate(b.id, idle);
  const victim = path.join(directory, 'releases', a.id, 'payload/minv'); await chmod(victim, 0o755); await writeFile(victim, 'tampered');
  await assert.rejects(store.rollback(a.id, idle, true), /signed inventory/);
  assert.equal(await readlink(path.join(directory, 'current')), `releases/${b.id}/payload`);
  await assert.rejects(store.rollback('../outside', idle, true), /Invalid retained/);
});

test('activation refuses running apps, dirty buffers, active writes, and changing safety state', async t => {
  const { root, directory, store } = await setup(t); const candidate = await release(root, '1.0.0', 1);
  const a = await store.stage(candidate.signed, candidate.artifact, candidate.source);
  for (const unsafe of [
    { applicationRunning: true, dirtyBuffers: 0, activeWrites: 0 },
    { applicationRunning: false, dirtyBuffers: 1, activeWrites: 0 },
    { applicationRunning: false, dirtyBuffers: 0, activeWrites: 1 },
  ]) await assert.rejects(store.activate(a.id, async () => unsafe), /Close Minv normally/);
  let checks = 0;
  await assert.rejects(store.activate(a.id, async () => ({ applicationRunning: ++checks > 1, dirtyBuffers: 0, activeWrites: 0 })), /Close Minv normally/);
  await assert.rejects(readlink(path.join(directory, 'current')), { code: 'ENOENT' });
});

test('missing or changed trust state fails closed rather than resetting the replay floor', async t => {
  const { root, directory, store } = await setup(t); const candidate = await release(root, '1.0.0', 1);
  await store.stage(candidate.signed, candidate.artifact, candidate.source);
  await rm(path.join(directory, 'state.json'));
  await assert.rejects(store.list(), /state is missing/);
  const outside = path.join(root, 'outside'); await mkdir(outside, { mode: 0o700 });
  const linked = path.join(root, 'linked-store'); await symlink(outside, linked);
  const redirected = new UpdateStore({ directory: linked, publisherPublicKey: publicKey, currentVersion: '0.0.0', platform: 'linux-x64' });
  await assert.rejects(redirected.list(), /private, user-owned/);
});
