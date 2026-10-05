import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { APP_URL, CONTENT_SECURITY_POLICY, localAsset } from '../desktop/main/local-assets';

test('desktop resource protocol serves only shipped public assets under its exact origin', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'minv-assets-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, 'app');
  await mkdir(path.join(directory, 'renderer'), { recursive: true });
  await writeFile(path.join(directory, 'index.html'), '<html></html>');
  await writeFile(path.join(directory, 'renderer', 'entry.js'), 'export {};');
  await writeFile(path.join(directory, 'main.js'), 'private main code');
  await writeFile(path.join(temporary, 'secret.js'), 'outside secret');
  await symlink(path.join(temporary, 'secret.js'), path.join(directory, 'renderer', 'escape.js'));
  assert.deepEqual(await localAsset(directory, APP_URL), { file: path.join(directory, 'index.html'), type: 'text/html; charset=utf-8' });
  assert.equal((await localAsset(directory, 'minv-app://app/renderer/entry.js')).type, 'text/javascript; charset=utf-8');
  for (const url of [
    'https://app/index.html', 'minv-app://evil/index.html', 'minv-app://user@app/index.html',
    'minv-app://app:123/index.html', 'minv-app://app/main.js', 'minv-app://app/renderer/escape.js',
    'minv-app://app/renderer/%2e%2e%2fmain.js', 'minv-app://app/renderer/%5c..%5cmain.js',
    'minv-app://app/renderer/%00entry.js', 'minv-app://app/renderer/entry.js.map', 'minv-app://app/renderer/',
  ]) await assert.rejects(localAsset(directory, url), Error, url);
});

test('desktop CSP disables remote origins, child frames, objects and forms', () => {
  for (const directive of ["default-src 'none'", "connect-src 'self'", "frame-src 'none'", "object-src 'none'", "form-action 'none'"]) assert.ok(CONTENT_SECURITY_POLICY.includes(directive));
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /https?:|'unsafe-eval'/);
});
