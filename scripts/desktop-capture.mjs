#!/usr/bin/env node
// Opens the built desktop on a real workspace in a private Xvfb display, records when branches and
// statuses arrive, and captures the Minv window. Usage: node scripts/desktop-capture.mjs <workspace> [out-dir]
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));

async function launch() {
  const workspace = resolve(process.argv[2] ?? '');
  if (!process.argv[2] || !existsSync(workspace)) throw new Error('Usage: node scripts/desktop-capture.mjs <workspace> [out-dir]');
  if (!existsSync(join(root, 'build/desktop/app/main.cjs'))) throw new Error('Build the desktop first with npm run desktop:build.');
  mkdirSync(join(root, '.minv-dev'), { recursive: true });
  const out = resolve(process.argv[3] ?? mkdtempSync(join(root, '.minv-dev', 'capture-')));
  const profile = join(out, 'profile'); mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'state.json'), JSON.stringify({
    version: 1, trustedRoots: [workspace], recentWorkspaces: [],
    workspace: { roots: [workspace], repositoryOrder: [], pinnedRepositories: [], openDocuments: [] },
    preferences: { appearance: process.env.MINV_CAPTURE_APPEARANCE ?? 'dark', motion: 'reduce', density: 'comfortable', editorFontSize: 13, tabSize: 2, wordWrap: false, renderWhitespace: false, gitPath: 'git', terminal: '', browseExclude: [], searchExclude: [] },
    bounds: { width: 1440, height: 960, maximized: false },
  }));
  const xvfb = spawnSync('which', ['xvfb-run'], { encoding: 'utf8' });
  if (xvfb.status !== 0) throw new Error('Install Xvfb (xvfb-run) for private captures.');
  const env = { ...process.env, MINV_CAPTURE_CHILD: '1', MINV_CAPTURE_OUT: out, MINV_USER_DATA: profile, MINV_LAUNCH_CWD: workspace, ELECTRON_OZONE_PLATFORM_HINT: 'x11' };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'WAYLAND_DISPLAY', 'MINV_WAIT_FILE', 'MINV_WAIT_TOKEN']) delete env[name];
  const child = spawn(xvfb.stdout.trim(), ['-a', '--server-args=-screen 0 1600x1100x24', require('electron'), fileURLToPath(import.meta.url), workspace, ...process.argv.slice(4)], { cwd: root, env, stdio: 'inherit' });
  process.exitCode = await new Promise(done => child.once('exit', code => done(code ?? 1)));
}

function capture() {
  const { app } = require('electron');
  const out = process.env.MINV_CAPTURE_OUT;
  const started = Date.now();
  const report = { workspace: process.argv[2], marks: {} };
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  const fail = error => { report.error = String(error?.stack ?? error); writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2)); console.error(report.error); app.exit(1); };
  setTimeout(() => fail(new Error('Capture timed out after 120 seconds.')), 120_000);
  app.on('browser-window-created', (_event, window) => {
    window.setSize(1440, 960);
    window.webContents.once('did-finish-load', () => void (async () => {
      const js = expression => window.webContents.executeJavaScript(expression);
      const until = async (expression, mark) => {
        for (;;) { const value = await js(expression); if (value) { report.marks[mark] = Date.now() - started; return value; } await delay(50); }
      };
      await until('!!window.minvHost && /minv/i.test(document.body.innerText)', 'interface');
      const snapshot = `window.minvHost.invoke('workspace.get')`;
      report.timeline = [];
      const sample = setInterval(() => void js(`(async()=>{const s=await ${snapshot};return s&&{rows:s.rows.length,discovery:s.discovery,branches:s.rows.filter(r=>r.branch.state==='observed').length,statuses:s.rows.filter(r=>r.status.state==='observed').length};})()`)
        .then(value => { const last = report.timeline.at(-1); if (value && JSON.stringify({ ...last, t: 0 }) !== JSON.stringify({ ...value, t: 0 })) report.timeline.push({ t: Date.now() - started, ...value }); }, () => {}), 50);
      await until(`(async()=>{const s=await ${snapshot};return s && s.rows.length > 1;})()`, 'firstRows');
      await until(`(async()=>{const s=await ${snapshot};return s?.discovery==='complete' && s.rows.filter(r=>r.available).every(r=>r.branch.state==='observed');})()`, 'allBranches');
      const final = await until(`(async()=>{const s=await ${snapshot};return s.rows.filter(r=>r.available).every(r=>r.status.state==='observed'||r.status.state==='error')&&s;})()`, 'allStatuses');
      clearInterval(sample);
      if (process.env.MINV_CAPTURE_SETTLE) await delay(Number(process.env.MINV_CAPTURE_SETTLE));
      report.repositories = final.rows.length;
      report.available = final.rows.filter(row => row.available).length;
      report.changed = final.rows.filter(row => row.status.value && row.status.value.changes.length).length;
      if (process.env.MINV_CAPTURE_SELECT) {
        await js(`(()=>{const el=[...document.querySelectorAll('.row')].find(r=>r.textContent.includes(${JSON.stringify(process.env.MINV_CAPTURE_SELECT)}));el?.click();})()`);
        await delay(1500);
      }
      await js('document.fonts.ready.then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))');
      await delay(400);
      writeFileSync(join(out, 'window.png'), (await window.webContents.capturePage()).toPNG());
      writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
      console.log(`Captured ${report.repositories} repositories (${report.changed} changed). Marks (ms): ${JSON.stringify(report.marks)}\n${join(out, 'window.png')}`);
      app.quit();
    })().catch(fail));
  });
  require(join(root, 'build/desktop/app/main.cjs'));
}

if (process.env.MINV_CAPTURE_CHILD === '1') capture();
else launch().catch(error => { console.error(error.message); process.exitCode = 1; });
