#!/usr/bin/env node
// Measure the real Electron main/preload/renderer on a generated R64 fixture.
// Run only on an otherwise quiet machine; this script does not police host load.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFixture } from './fixture.mjs';
import { machineInfo, summarize } from './bench-support.mjs';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = createRequire(import.meta.url)('electron');
const script = fileURLToPath(import.meta.url);
const delay = ms => new Promise(done => setTimeout(done, ms));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

async function run() {
  if (!options.fixture || !options.json) throw new Error('Usage: node scripts/desktop-bench.mjs --fixture R64_DIR --json NEW_REPORT [--repetitions 30] [--idle 60]');
  const fixture = resolve(options.fixture);
  const repetitions = Number(options.repetitions ?? 30);
  const idleSeconds = Number(options.idle ?? 60);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 30 || !Number.isInteger(idleSeconds) || idleSeconds < 0 || idleSeconds > 300) throw new Error('Invalid benchmark bounds');
  if (!existsSync(join(project, 'build/desktop/app/main.cjs'))) throw new Error('Build the desktop first');
  if (!options.inside && !process.env.DISPLAY) {
    const available = spawnSync('which', ['xvfb-run'], { encoding: 'utf8' });
    if (available.status !== 0) throw new Error('Xvfb or an application display is required');
    const child = spawn(available.stdout.trim(), ['-a', '--server-args=-screen 0 1600x1100x24', process.execPath, script, ...process.argv.slice(2), '--inside', 'yes'], { stdio: 'inherit', shell: false });
    process.exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => done(code ?? 1)); });
    return;
  }
  const manifest = await readFixture(fixture);
  if (manifest.profile !== 'R64') throw new Error('Desktop reference benchmark requires R64');
  const root = join(fixture, manifest.roots[0]);
  const file = join(root, 'src/00000/f0000000.txt');
  const runDir = mkdtempSync(join(project, '.minv-dev/desktop-bench-'));
  const profile = join(runDir, 'profile'); mkdirSync(profile, { mode: 0o700 });
  writeFileSync(join(profile, 'state.json'), JSON.stringify({
    version: 1, trustedRoots: [root], recentWorkspaces: [],
    workspace: { roots: [root], repositoryOrder: [], pinnedRepositories: [], openDocuments: [] },
    preferences: { appearance: 'system', motion: 'reduce', density: 'comfortable', editorFontSize: 13, tabSize: 2, wordWrap: false, renderWhitespace: false, gitPath: 'git', terminal: '', browseExclude: [], searchExclude: [] },
    bounds: { width: 1440, height: 960, maximized: false },
  }), { mode: 0o600 });
  const launches = [];
  for (let iteration = 0; iteration <= repetitions; iteration++) {
    const env = { ...process.env, MINV_DESKTOP_BENCH_CHILD: '1', MINV_DESKTOP_BENCH_IDLE: String(iteration === repetitions ? idleSeconds : 0), MINV_USER_DATA: profile, MINV_LAUNCH_CWD: root, ELECTRON_OZONE_PLATFORM_HINT: 'x11' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.WAYLAND_DISPLAY;
    const started = Date.now();
    const child = spawn(executable, [script, root, '--goto', `${file}:1:1`], { cwd: project, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(60_000, idleSeconds * 1000 + 60_000));
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', result => done(result ?? 1)); });
    clearTimeout(timer);
    const marker = stdout.split('\n').find(line => line.startsWith('MINV_DESKTOP_BENCH='));
    if (code !== 0 || !marker) throw new Error(`Electron repetition ${iteration} failed (${code}): ${stderr || stdout.slice(-2000)}`);
    const result = JSON.parse(marker.slice('MINV_DESKTOP_BENCH='.length));
    result.launchToPaintMs = result.paintAt - started;
    result.launchToBranchesMs = result.branchesAt - started;
    if (iteration > 0) launches.push(result);
    console.error(`Desktop repetition ${iteration}/${repetitions}: painted ${Math.round(result.launchToPaintMs)} ms`);
  }
  const report = {
    timestamp: new Date().toISOString(), fixture: 'R64', scope: 'Real Electron desktop launch with persistent Minv workspace cache and OS cache warm; private Xvfb display, local Git fixture; warm-up excluded',
    repetitions, machine: await machineInfo(fixture, 'git version recorded in core fixture benchmark'),
    launchToPaintMs: summarize(launches.map(run => run.launchToPaintMs)),
    launchToBranchesMs: summarize(launches.map(run => run.launchToBranchesMs)),
    launches, idle: launches.at(-1)?.idle, artifactDirectory: runDir, releaseEvidence: false,
  };
  writeFileSync(resolve(options.json), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ launchToPaintMs: report.launchToPaintMs, launchToBranchesMs: report.launchToBranchesMs, idle: report.idle }, null, 2));
}

function runElectron() {
  const { app } = createRequire(import.meta.url)('electron');
  const startedAt = Date.now();
  let window, done = false, paintAt, branchesAt;
  const idleSeconds = Number(process.env.MINV_DESKTOP_BENCH_IDLE ?? 0);
  const timer = setTimeout(() => finish(new Error('Desktop benchmark timed out')), Math.max(45_000, idleSeconds * 1000 + 45_000));
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  async function waitFor(expression, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await window.webContents.executeJavaScript(expression)) return; } catch { /* Renderer may still be loading. */ }
      await delay(25);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }
  function metrics() {
    return app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type, serviceName: item.serviceName, workingSetBytes: item.memory?.workingSetSize ? item.memory.workingSetSize * 1024 : undefined, cpuPercent: item.cpu?.percentCPUUsage }));
  }
  function processTree() {
    if (process.platform !== 'linux') return undefined;
    const pending = [process.pid], seen = new Set();
    let rssBytes = 0, pssBytes = 0, ticks = 0;
    while (pending.length) {
      const pid = pending.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      try {
        const directory = `/proc/${pid}`;
        const status = readFileSync(join(directory, 'status'), 'utf8');
        const smaps = readFileSync(join(directory, 'smaps_rollup'), 'utf8');
        const stat = readFileSync(join(directory, 'stat'), 'utf8');
        const children = readFileSync(join(directory, `task/${pid}/children`), 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        rssBytes += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
        pssBytes += Number(/^Pss:\s+(\d+)/m.exec(smaps)?.[1] ?? 0) * 1024;
        ticks += Number(fields[11]) + Number(fields[12]);
        pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
      } catch { /* Short-lived subprocesses can exit during a sample. */ }
    }
    return { processes: seen.size, rssBytes, pssBytes, ticks };
  }
  async function finish(error, idle) {
    if (done) return; done = true; clearTimeout(timer);
    const result = { startedAt, paintAt, branchesAt, idle, processMetrics: metrics(), error: error?.message };
    console.log(`MINV_DESKTOP_BENCH=${JSON.stringify(result)}`);
    app.exit(error ? 1 : 0);
  }
  app.on('browser-window-created', (_event, candidate) => {
    if (window) return;
    window = candidate;
    candidate.webContents.once('did-finish-load', () => void (async () => {
      await waitFor('!!window.minvHost && !!window.minvEditor && document.body.innerText.length > 0');
      await candidate.webContents.executeJavaScript('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
      paintAt = Date.now();
      await waitFor('(async()=>{const s=await window.minvHost.invoke("workspace.get");const rows=s?.rows.filter(r=>r.available);return s?.discovery==="complete"&&rows?.length===64&&rows.every(r=>r.branch.state==="observed")})()');
      await waitFor('document.querySelectorAll(".monaco-editor").length>0 && document.body.innerText.includes("f0000000.txt")');
      await candidate.webContents.executeJavaScript('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
      branchesAt = Date.now();
      if (idleSeconds) {
        const before = processTree(); const start = Date.now();
        await delay(idleSeconds * 1000);
        const after = processTree();
        const durationMs = Date.now() - start;
        const hertz = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim() || 100);
        await finish(undefined, { durationMs, before, after, percentOfOneCore: before && after ? (after.ticks - before.ticks) / hertz / (durationMs / 1000) * 100 : undefined, scope: 'Linux /proc snapshot of Electron main and live descendants. RSS sums shared pages; PSS apportions them. CPU includes processes surviving both snapshots; short-lived processes can be missed.' });
      } else await finish();
    })().catch(error => finish(error)));
  });
  requireMain();
  function requireMain() { createRequire(import.meta.url)(join(project, 'build/desktop/app/main.cjs')); }
}

if (process.env.MINV_DESKTOP_BENCH_CHILD === '1') runElectron();
else run().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
