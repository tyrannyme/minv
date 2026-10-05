#!/usr/bin/env node
// Launches the Code-OSS fork from .upstream/build in a private Xvfb display with a throwaway profile,
// waits, and captures the window through the DevTools protocol. Nothing opens on the real desktop.
// Usage: node scripts/fork-capture.mjs <workspace> [out.png] [--wait=ms] [--eval=js] [--settings=json]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '.upstream/build');
const positional = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const workspace = resolve(positional[0] ?? '.');
const out = resolve(positional[1] ?? join(root, '.minv-dev/fork-capture.png'));
const wait = Number(option('wait') ?? 8000);
const delay = ms => new Promise(done => setTimeout(done, ms));

mkdirSync(join(root, '.minv-dev'), { recursive: true });
const profile = mkdtempSync(join(root, '.minv-dev', 'fork-profile-'));
mkdirSync(join(profile, 'data/User'), { recursive: true });
writeFileSync(join(profile, 'data/User/settings.json'), option('settings') ?? '{}');
const port = 9300 + Math.floor(Math.random() * 600);
const xvfb = spawnSync('which', ['xvfb-run'], { encoding: 'utf8' }).stdout.trim();
if (!xvfb) throw new Error('xvfb-run is required.');
const env = { ...process.env, VSCODE_SKIP_PRELAUNCH: '1' };
for (const name of ['ELECTRON_RUN_AS_NODE', 'WAYLAND_DISPLAY']) delete env[name];
const started = Date.now();
const child = spawn(xvfb, ['-a', '--server-args=-screen 0 1600x1000x24', join(source, 'scripts/code.sh'), workspace,
  '--user-data-dir', join(profile, 'data'), '--extensions-dir', join(profile, 'extensions'), `--remote-debugging-port=${port}`,
  ...(process.env.MINV_FORK_ARGS ? process.env.MINV_FORK_ARGS.split(' ') : []), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--ozone-platform=x11', '--force-device-scale-factor=1'],
  { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let log = '';
child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });

async function page() {
  for (let i = 0; i < 300; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const target = targets.find(t => t.type === 'page' && /workbench/.test(t.url));
      if (target) return target.webSocketDebuggerUrl;
    } catch { /* Not listening yet. */ }
    await delay(100);
  }
  throw new Error(`No workbench page.\n${log.slice(-3000)}`);
}

try {
  const socket = new WebSocket(await page());
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let id = 0; const pending = new Map();
  const problems = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') problems.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    pending.get(message.id)?.(message); pending.delete(message.id);
  };
  const send = (method, params = {}) => new Promise(done => { const n = ++id; pending.set(n, done); socket.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  if (process.argv.includes('--debug')) { await send('Runtime.enable'); await send('Page.reload', { ignoreCache: true }); await delay(1000); }
  for (let i = 0; i < 300 && !(await evaluate(`!!document.querySelector('.monaco-workbench .part.sidebar')`)); i++) await delay(100);
  console.log(`Workbench painted after ${Date.now() - started} ms`);
  await delay(wait);
  if (option('eval')) console.log('eval:', JSON.stringify(await evaluate(option('eval'))));
  if (problems.length) console.log(`Renderer problems:\n${[...new Set(problems)].slice(0, 15).map(p => String(p).slice(0, 600)).join('\n---\n')}`);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`Captured ${out}`);
  socket.close();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already gone. */ }
  await delay(500);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ }
  // Surface the workbench's own error log, which is where missing services and failed contributions land.
  const logs = spawnSync('sh', ['-c', `grep -rhE "\\[error\\]" ${JSON.stringify(join(profile, 'data/logs'))} 2>/dev/null | sort | uniq -c | sort -rn | head -40`], { encoding: 'utf8' }).stdout;
  if (logs.trim()) console.log(`Workbench errors:\n${logs}`);
}
