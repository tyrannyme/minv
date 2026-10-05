#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const usage = 'Usage: update-install.mjs stage --feed HTTPS_URL --public-key PEM --store DIR --current-version VERSION | list --public-key PEM --store DIR --current-version VERSION | activate --id ID --public-key PEM --store DIR --current-version VERSION --user-data DIR | rollback --id ID --public-key PEM --store DIR --current-version VERSION --user-data DIR --confirm yes | recover-gate --user-data DIR --clear yes';
try {
  const [operation, ...args] = process.argv.slice(2);
  const expected = {
    stage: ['feed', 'public-key', 'store', 'current-version'],
    list: ['public-key', 'store', 'current-version'],
    activate: ['id', 'public-key', 'store', 'current-version', 'user-data'],
    rollback: ['id', 'public-key', 'store', 'current-version', 'user-data', 'confirm'],
    'recover-gate': ['user-data', 'clear'],
  }[operation];
  if (!expected || args.length !== expected.length * 2) throw new Error(usage);
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !expected.includes(args[i].slice(2)) || values.has(args[i].slice(2)) || !args[i + 1]) throw new Error(usage);
    values.set(args[i].slice(2), args[i + 1]);
  }
  if (expected.some(key => !values.has(key))) throw new Error(usage);
  const lease = require(path.join(root, 'dist/src/core/update-lease.js'));
  if (operation === 'recover-gate') {
    if (values.get('clear') !== 'yes') throw new Error('Explicit --clear yes is required after inspecting Minv recovery drafts.');
    const result = await lease.inspectStaleApplicationLeases(values.get('user-data'), true);
    console.log(`Cleared ${result.stale.length} dead Minv application lease(s). Recovery data ${result.recoveryPresent ? 'exists; review it in Minv' : 'was not found'}.`);
  } else {
    const { UpdateStore } = require(path.join(root, 'dist/src/core/update.js'));
    const publicKey = await readFile(path.resolve(values.get('public-key')));
    const store = new UpdateStore({ directory: values.get('store'), publisherPublicKey: publicKey, currentVersion: values.get('current-version'), platform: 'linux-x64' });
    if (operation === 'stage') {
      const temporary = await mkdtemp(path.join(os.tmpdir(), 'minv-update-'));
      try {
        const { downloadSignedRelease, extractSignedArchive } = require(path.join(root, 'dist/src/core/update-transfer.js'));
        const release = await downloadSignedRelease(values.get('feed'), publicKey, temporary);
        const extracted = path.join(temporary, 'extracted');
        await extractSignedArchive(release.artifact, extracted, release.manifest);
        const staged = await store.stage(release.signed, release.artifact, extracted);
        console.log(JSON.stringify(staged));
      } finally { await rm(temporary, { recursive: true, force: true }); }
    } else if (operation === 'list') console.log(JSON.stringify(await store.list(), null, 2));
    else {
      if (operation === 'rollback' && values.get('confirm') !== 'yes') throw new Error('Explicit --confirm yes is required for offline rollback.');
      const gate = await lease.acquireInstallerLease(values.get('user-data'));
      try {
        const safe = async () => ({ applicationRunning: false, dirtyBuffers: 0, activeWrites: 0 });
        if (operation === 'activate') await store.activate(values.get('id'), safe);
        else await store.rollback(values.get('id'), safe, true);
        console.log(`${operation === 'activate' ? 'Activated' : 'Rolled back to'} retained release ${values.get('id')}.`);
      } finally { await gate.release(); }
    }
  }
} catch (error) { console.error(`Minv update: ${error.message}`); process.exitCode = 1; }
