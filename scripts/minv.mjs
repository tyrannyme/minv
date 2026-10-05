#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const location = path.dirname(fileURLToPath(import.meta.url));
const packaged = existsSync(path.join(location, 'cli.cjs'));
const project = path.resolve(location, '..');
const require = createRequire(import.meta.url);
const parserPath = packaged ? path.join(location, 'cli.cjs') : path.join(project, 'dist/src/core/cli.js');

async function run() {
  if (!existsSync(parserPath)) throw new Error('Minv has not been built. Run npm run build first.');
  const { parseCli, cliHelp, acquireApplicationLease } = require(parserPath);
  const argv = process.argv.slice(2);
  const request = parseCli(argv, process.cwd());
  if (request.kind === 'help') { process.stdout.write(cliHelp); return; }
  if (request.kind === 'version') {
    const manifest = packaged ? path.resolve(location, '../app/package.json') : path.join(project, 'package.json');
    process.stdout.write(`${JSON.parse(await readFile(manifest, 'utf8')).version}\n`);
    return;
  }
  const app = packaged ? undefined : path.join(project, 'build/desktop/app');
  if (app && !existsSync(path.join(app, 'main.cjs'))) throw new Error('The desktop application has not been built. Run npm run desktop:build first.');
  const executable = packaged
    ? path.resolve(location, '../../minv')
    : require(path.join(project, 'node_modules/electron'));
  const dataDirectory = process.env.MINV_USER_DATA
    ? path.resolve(process.env.MINV_USER_DATA)
    : path.join(path.resolve(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')), 'Minv');
  const lease = await acquireApplicationLease(dataDirectory);
  const env = { ...process.env, MINV_LAUNCH_CWD: process.cwd() };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MINV_WAIT_FILE;
  delete env.MINV_WAIT_TOKEN;
  delete env.MINV_DESKTOP_LAUNCH;
  let directory;
  let closed;
  let token;
  const waitForHandoff = async child => {
    // A secondary Electron process exits after forwarding to the primary. A new
    // primary publishes its own lease before the launcher can safely let go.
    let exited = child.exitCode !== null || child.signalCode !== null
      ? { code: child.exitCode, signal: child.signalCode } : undefined;
    child.once('exit', (code, signal) => { exited = { code, signal }; });
    const gate = path.join(dataDirectory, 'update-gate');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      for (const name of await readdir(gate)) {
        if (!/^app-[a-f0-9-]{36}$/.test(name)) continue;
        const owner = await readFile(path.join(gate, name), 'utf8').then(JSON.parse).catch(() => null);
        if (owner?.pid === child.pid) return;
      }
      if (exited) {
        if (exited.signal || exited.code) throw new Error(`Minv exited while forwarding the request (${exited.signal ?? exited.code}).`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Minv did not acquire its application lease after launch.');
  };
  const cleanup = async () => {
    if (!directory) return;
    // Remove only the handshake we created, never recursively remove a caller-provided path.
    if (closed) await unlink(closed).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await rmdir(directory); break; }
      catch (error) {
        if (error.code === 'ENOENT') break;
        if (error.code !== 'ENOTEMPTY' || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    directory = undefined;
  };
  try {
    if (request.wait) {
      directory = await mkdtemp(path.join(os.tmpdir(), 'minv-wait-'));
      await chmod(directory, 0o700);
      closed = path.join(directory, 'closed');
      token = randomBytes(32).toString('hex');
      env.MINV_WAIT_FILE = closed;
      env.MINV_WAIT_TOKEN = token;
    }
    // An explicit CLI invocation with no operands opens cwd. A GUI launch with
    // no operands can independently restore its previous workspace.
    const forwarded = argv.length || process.env.MINV_DESKTOP_LAUNCH === '1' ? argv : [process.cwd()];
    const child = spawn(executable, [...(app ? [app] : []), ...forwarded], {
      env, shell: false, detached: !request.wait, stdio: 'inherit',
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    if (!request.wait) { await waitForHandoff(child); child.unref(); return; }
    let failure;
    child.on('exit', (code, signal) => {
      // A forwarding process exits successfully while the primary instance retains the ticket.
      if (signal || (code !== null && code !== 0)) failure = new Error(`Minv exited before opening the requested buffers (${signal ?? code}).`);
    });
    const interrupts = new Map([
      ['SIGINT', () => { failure = Object.assign(new Error('Wait interrupted.'), { exitCode: 130 }); }],
      ['SIGTERM', () => { failure = Object.assign(new Error('Wait interrupted.'), { exitCode: 143 }); }],
    ]);
    for (const [signal, handler] of interrupts) process.on(signal, handler);
    try {
      for (;;) {
        if (failure) throw failure;
        const content = await readFile(closed, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (content !== undefined) {
          if (content.startsWith(`${token}\n`)) throw new Error(content.slice(token.length + 1));
          if (content !== token) throw new Error('Minv returned an invalid wait acknowledgement.');
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    } finally {
      for (const [signal, handler] of interrupts) process.removeListener(signal, handler);
    }
  } finally { await cleanup(); await lease.release(); }
}

run().catch(error => {
  console.error(`minv: ${error.message}`);
  process.exitCode = error.exitCode ?? (error.name === 'CliArgumentError' ? 2 : 1);
});
