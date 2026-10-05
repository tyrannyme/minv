#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readFixture } from './fixture.mjs';
import { sampleProcessTree, machineInfo } from './bench-support.mjs';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) options[args[i]?.replace(/^--/, '')] = args[i + 1];
async function main() {
  if (!options.fixture || !options.module) throw new Error('Usage: node scripts/desktop-bench-watch-startup.mjs --fixture DIRECTORY --module WATCHER_JS [--json NEW_FILE]');
  const root = path.resolve(options.fixture);
  if (options.child) {
    const manifest = await readFixture(root);
    const require = createRequire(import.meta.url);
    const { WatchCoordinator } = require(path.resolve(options.module));
    const watcher = new WatchCoordinator();
    const repositories = manifest.repositories.map((entry, index) => ({ id: String(index), root: path.join(root, entry.path), gitDir: path.join(root, entry.path, '.git'), commonDir: path.join(root, entry.path, '.git'), available: true, name: String(index) }));
    const startedAt = performance.now();
    try {
      watcher.setRepositories(repositories);
      watcher.watchRoots(manifest.roots.map(relative => path.join(root, relative)));
      const registrationReturnMs = performance.now() - startedAt;
      while (watcher.snapshot().initializing) await delay(20);
      console.log(JSON.stringify({ registrationReturnMs, readyMs: performance.now() - startedAt, watcher: watcher.snapshot() }));
    } finally { watcher.dispose(); }
    return;
  }
  const child = spawn(process.execPath, ['--max-old-space-size=512', fileURLToPath(import.meta.url), '--fixture', root, '--module', path.resolve(options.module), '--child', 'yes'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const sampler = sampleProcessTree(child.pid, 100);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Number(options.timeout ?? 20_000));
  const outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timeout);
  const report = { timestamp: new Date().toISOString(), scope: 'Actual WatchCoordinator startup in isolated Node child; 512MiB V8 heap cap and20s deadline, not desktop launch', machine: await machineInfo(root, 'See corresponding core benchmark'), timedOut, outcome, measurement: stdout.trim() ? JSON.parse(stdout.trim()) : undefined, stderr, resources: await sampler.stop(), releaseEvidence: false };
  if (options.json) await writeFile(path.resolve(options.json), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ timedOut, outcome, measurement: report.measurement, peakRssBytes: report.resources.peakRssBytes, peakPssBytes: report.resources.peakPssBytes }, null, 2));
}
main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
