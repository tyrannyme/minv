#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'minv-host-'));
const workspace = path.join(temporary, 'workspace');
const resultPath = path.join(temporary, 'result.json');
await mkdir(workspace);
function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${file} exited with ${code}`)));
  });
}
try {
  await command('git', ['init', '-b', 'main', workspace]);
  await writeFile(path.join(workspace, 'example.txt'), 'A disposable Minv host fixture.\n');
  await mkdir(path.join(temporary, 'profile', 'User'), { recursive: true });
  await writeFile(path.join(temporary, 'profile', 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false, 'git.enabled': false, 'chat.disableAIFeatures': true,
    'workbench.enableExperiments': false, 'workbench.startupEditor': 'none'
  }));
  await command(process.env.MINV_CODE_EXECUTABLE || 'code', [
    '--user-data-dir', path.join(temporary, 'profile'), '--extensions-dir', path.join(temporary, 'extensions'),
    '--new-window', '--wait', '--disable-extensions', '--disable-extension', 'vscode.git',
    '--disable-extension', 'vscode.github', '--disable-extension', 'vscode.github-authentication',
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--extensionDevelopmentPath', root, '--extensionTestsPath', path.join(root, 'dist/test/host/smoke.js'), workspace
  ], { env: { ...process.env, MINV_HOST_SMOKE_RESULT: resultPath } });
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  if (!result.passed || !result.activated || !result.editorSaved) throw new Error('Host smoke did not verify activation and editor save.');
  console.log(`Minv desktop-host smoke passed on ${result.hostVersion}: activation, repository view, refresh, editor and save.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
