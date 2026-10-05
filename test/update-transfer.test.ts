import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createReleaseManifest, signReleaseManifest } from '../src/core/update';
import { downloadSignedRelease, extractSignedArchive } from '../src/core/update-transfer';

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = 'minv-1.0.0-linux-x64'; const source = path.join(root, name);
  await mkdir(path.join(source, 'resources/app'), { recursive: true });
  await writeFile(path.join(source, 'minv'), 'binary', { mode: 0o755 }); await chmod(path.join(source, 'minv'), 0o755);
  await writeFile(path.join(source, 'resources/app/package.json'), JSON.stringify({ name: 'minv', version: '1.0.0' }));
  const artifact = path.join(root, `${name}.tar.gz`);
  const pack = () => execFileSync('tar', ['--format=pax', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', artifact, '-C', root, name]);
  pack();
  return { root, name, source, artifact, pack };
}

test('HTTPS signed feed bounds archive bytes and rejects redirects and tampering', async t => {
  const f = await fixture(t); const manifest = await createReleaseManifest(f.source, f.artifact, { version: '1.0.0', sequence: 1 });
  const signed = signReleaseManifest(manifest, privateKey); const archive = await readFile(f.artifact);
  const feed = 'https://updates.example.test/releases/latest.json';
  const mock = (input: URL, body: BodyInit, redirected = false): Response => {
    const result = new Response(body, { status: 200 });
    Object.defineProperty(result, 'url', { value: input.href });
    Object.defineProperty(result, 'redirected', { value: redirected });
    return result;
  };
  const fetcher = (async (input: URL) => mock(input, input.href === feed ? JSON.stringify(signed) : archive)) as typeof fetch;
  const received = await downloadSignedRelease(feed, publicKey, path.join(f.root, 'download'), fetcher);
  assert.deepEqual(await readFile(received.artifact), archive);
  await extractSignedArchive(received.artifact, path.join(f.root, 'extracted'), received.manifest);
  assert.equal(await readFile(path.join(f.root, 'extracted/minv'), 'utf8'), 'binary');
  const tampered = (async (input: URL) => mock(input, input.href === feed ? JSON.stringify(signed) : Buffer.concat([archive, Buffer.from('bad')]))) as typeof fetch;
  await assert.rejects(downloadSignedRelease(feed, publicKey, path.join(f.root, 'tampered'), tampered), /signed size/);
  await assert.rejects(downloadSignedRelease('http://updates.example.test/latest.json', publicKey, path.join(f.root, 'http'), fetcher), /HTTPS/);
  const redirected = (async (input: URL) => mock(input, '{}', true)) as typeof fetch;
  await assert.rejects(downloadSignedRelease(feed, publicKey, path.join(f.root, 'redirect'), redirected), /endpoint failed or redirected/);
});

test('confined extraction rejects symlink entries even when archive hash is signed', async t => {
  const f = await fixture(t);
  await symlink('/etc/passwd', path.join(f.source, 'resources/app/escape'));
  f.pack();
  // A malicious archive can itself be signed; extraction still limits entry types
  // to the independently signed regular-file inventory.
  await rm(path.join(f.source, 'resources/app/escape'));
  const manifest = await createReleaseManifest(f.source, f.artifact, { version: '1.0.0', sequence: 1 });
  await assert.rejects(extractSignedArchive(f.artifact, path.join(f.root, 'malicious'), manifest), /link, device|signed inventory/);
});

test('PAX long paths from the release packager extract under the signed root', async t => {
  const f = await fixture(t);
  const long = `resources/app/${'long-segment-'.repeat(9)}.txt`;
  await writeFile(path.join(f.source, long), 'long path content');
  f.pack();
  const manifest = await createReleaseManifest(f.source, f.artifact, { version: '1.0.0', sequence: 1 });
  const destination = path.join(f.root, 'long-extracted');
  await extractSignedArchive(f.artifact, destination, manifest);
  assert.equal(await readFile(path.join(destination, long), 'utf8'), 'long path content');
});
