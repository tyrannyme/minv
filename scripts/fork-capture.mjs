#!/usr/bin/env node
// Launches the Code-OSS fork from .upstream/build in a private Xvfb display with a throwaway profile,
// waits, and captures the window through the DevTools protocol. Nothing opens on the real desktop.
// Usage: node scripts/fork-capture.mjs <workspace> [out.png] [--app=packaged/minv] [--open=file] [--keys=ctrl+k,v]
//   [--click=row;row] [--type=text] [--scale=2] [--settings=json] [--wait=ms] [--eval=js] [--exceptions] [--log] [--debug]
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
const opened = option('open') ? [resolve(workspace, option('open'))] : [];
const child = spawn(xvfb, ['-a', `--server-args=-screen 0 ${Math.ceil(1600 * Number(option('scale') ?? 1))}x${Math.ceil(1000 * Number(option('scale') ?? 1))}x24`, option('app') ? resolve(option('app')) : join(source, 'scripts/code.sh'), workspace, ...opened,
  '--user-data-dir', join(profile, 'data'), '--extensions-dir', join(profile, 'extensions'), `--remote-debugging-port=${port}`,
  ...(process.env.MINV_FORK_ARGS ? process.env.MINV_FORK_ARGS.split(' ') : []), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--ozone-platform=x11', `--force-device-scale-factor=${option('scale') ?? 1}`],
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
  const caught = [];
  const urls = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') problems.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    if (message.method === 'Network.requestWillBeSent') urls.set(message.params.requestId, message.params.request.url);
    if (message.method === 'Network.loadingFailed') caught.push(`Failed to load ${urls.get(message.params.requestId)}: ${message.params.errorText}`);
    if (message.method === 'Debugger.paused') {
      const frames = message.params.callFrames.slice(0, 4).map(f => `${f.functionName || '?'} ${f.url.split('/').pop()}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`);
      caught.push(`${message.params.data?.description?.split('\n')[0] ?? message.params.reason}\n    ${frames.join('\n    ')}`);
      socket.send(JSON.stringify({ id: ++id, method: 'Debugger.resume' }));
    }
    pending.get(message.id)?.(message); pending.delete(message.id);
  };
  const send = (method, params = {}) => new Promise(done => { const n = ++id; pending.set(n, done); socket.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Runtime.enable');
  if (process.argv.includes('--debug')) { await send('Page.reload', { ignoreCache: true }); await delay(1000); }
  for (let i = 0; i < 300 && !(await evaluate(`!!document.querySelector('.monaco-workbench .part.sidebar')`)); i++) await delay(100);
  console.log(`Workbench painted after ${Date.now() - started} ms`);
  await delay(wait);
  // --exceptions records every exception thrown (even caught ones) while the keys are pressed.
  if (process.argv.includes('--exceptions')) { await send('Network.enable'); await send('Debugger.enable'); await send('Debugger.setPauseOnExceptions', { state: 'all' }); }
  // --keys=ctrl+shift+v,escape presses each chord in order, one second apart.
  for (const chord of (option('keys') ?? '').split(',').filter(Boolean)) {
    const parts = chord.toLowerCase().split('+'); const key = parts.pop();
    const modifiers = (parts.includes('alt') ? 1 : 0) | (parts.includes('ctrl') ? 2 : 0) | (parts.includes('meta') ? 4 : 0) | (parts.includes('shift') ? 8 : 0);
    const named = { escape: ['Escape', 27], enter: ['Enter', 13], tab: ['Tab', 9], backquote: ['`', 192, 'Backquote'] }[key];
    const code = named ? named[1] : key.toUpperCase().charCodeAt(0);
    const keyName = named ? named[0] : key;
    const codeName = named ? (named[2] ?? named[0]) : /[a-z]/.test(key) ? `Key${key.toUpperCase()}` : `Digit${key}`;
    for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, modifiers, key: keyName, code: codeName, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await delay(1000);
  }
  // --click=text1;text2 clicks, in order, the visible list row or tab whose text starts with each entry.
  for (const target of (option('click') ?? '').split(';').filter(Boolean)) {
    const box = await evaluate(`(() => {
      const want = ${JSON.stringify(target)};
      const nodes = [...document.querySelectorAll('.monaco-list-row, .tab, .action-item a, .monaco-button')];
      const visible = nodes.filter(n => n.offsetParent);
      const hit = visible.find(n => (n.textContent ?? '').trim().startsWith(want)) ?? visible.find(n => (n.getAttribute('aria-label') ?? '').startsWith(want));
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 };
    })()`);
    if (!box) { console.log(`click: nothing matches ${target}`); continue; }
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await delay(1500);
  }
  // --type=text types into whatever has focus, then presses Enter.
  if (option('type')) { await send('Input.insertText', { text: option('type') }); for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }); }
  if (option('keys') || option('click') || option('type')) await delay(Number(option('after') ?? 3000));
  if (caught.length) { await send('Debugger.setPauseOnExceptions', { state: 'none' }); console.log(`Exceptions during keys:\n${caught.slice(0, 20).join('\n')}`); }
  if (option('eval')) console.log('eval:', JSON.stringify(await evaluate(option('eval'))));
  if (problems.length) console.log(`Renderer problems:\n${[...new Set(problems)].filter(p => !/depends on UNKNOWN service|NOT registered|Cannot instantiate named customer/.test(p)).slice(0, 15).map(p => String(p).slice(0, 900)).join('\n---\n')}`);
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
  if (process.argv.includes('--log')) console.log(`App output:\n${log.slice(-6000)}`);
}
