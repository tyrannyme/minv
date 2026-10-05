#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
try {
  const [operation, ...args] = process.argv.slice(2);
  if (!['sign', 'verify'].includes(operation)) throw new Error('Usage: update-release.mjs sign --directory RELEASE --artifact ARCHIVE --private-key PEM --sequence INTEGER --output JSON | verify --manifest JSON --public-key PEM');
  const allowed = operation === 'sign' ? ['directory', 'artifact', 'private-key', 'sequence', 'output'] : ['manifest', 'public-key'];
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !allowed.includes(name) || values.has(name) || !args[i + 1]) throw new Error('Unknown, duplicate, or incomplete signing argument.');
    values.set(name, args[i + 1]);
  }
  if (allowed.some(key => !values.has(key))) throw new Error('All explicit signing/verification arguments are required.');
  const api = require(path.join(root, 'dist/src/core/update.js'));
  if (operation === 'verify') {
    const release = api.verifyReleaseManifest(JSON.parse(await readFile(path.resolve(values.get('manifest')), 'utf8')), await readFile(path.resolve(values.get('public-key'))), 'linux-x64');
    console.log(`Verified publisher signature: Minv ${release.version}, linux-x64, sequence ${release.sequence}.`);
  } else {
    const directory = path.resolve(values.get('directory')); const artifact = path.resolve(values.get('artifact'));
    const output = path.resolve(values.get('output'));
    if (!/^[1-9]\d*$/.test(values.get('sequence')) || !Number.isSafeInteger(Number(values.get('sequence')))) throw new Error('Release sequence must be a positive safe integer.');
    if (output === directory || output.startsWith(`${directory}${path.sep}`)) throw new Error('Detached signed metadata must be written outside the audited release tree.');
    execFileSync(process.execPath, [path.join(root, 'scripts/package-desktop.mjs'), '--audit', directory], { stdio: 'inherit', shell: false });
    const product = JSON.parse(await readFile(path.join(directory, 'resources/app/package.json'), 'utf8'));
    const manifest = await api.createReleaseManifest(directory, artifact, { version: product.version, sequence: Number(values.get('sequence')) });
    const signed = api.signReleaseManifest(manifest, await readFile(path.resolve(values.get('private-key'))));
    await writeFile(output, `${JSON.stringify(signed)}\n`, { mode: 0o644, flag: 'wx' });
    console.log(`Signed Minv ${manifest.version}, sequence ${manifest.sequence}; detached manifest written to ${output}.`);
  }
} catch (error) {
  console.error(`Release metadata failed: ${error.message}`); process.exitCode = 1;
}
