#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.env.MINV_PROFILE_DIR ? path.resolve(process.env.MINV_PROFILE_DIR) : path.join(root, '.minv-dev');
await mkdir(path.join(profile, 'user', 'User'), { recursive: true });
await mkdir(path.join(profile, 'extensions'), { recursive: true });
const settings = path.join(profile, 'user', 'User', 'settings.json');
const profileDefaults = {
  'git.enabled': false, 'git.autofetch': false, 'telemetry.telemetryLevel': 'off',
  'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
  'workbench.enableExperiments': false, 'chat.disableAIFeatures': true,
  'files.autoSave': 'off', 'editor.formatOnSave': false, 'security.workspace.trust.enabled': true,
  'workbench.startupEditor': 'none'
};
// Minv's look for this isolated profile only. Missing keys are added on each launch;
// values already present in the profile (including your own changes) are kept.
const appearance = {
  'workbench.colorTheme': 'Minv Ink',
  'workbench.preferredDarkColorTheme': 'Minv Ink',
  'workbench.preferredLightColorTheme': 'Minv Paper',
  'window.autoDetectHighContrast': true,
  'window.title': '${rootName}${separator}Minv',
  'window.menuBarVisibility': 'compact',
  'workbench.layoutControl.enabled': false,
  'workbench.tips.enabled': false,
  'workbench.editor.empty.hint': 'hidden',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.commandCenter.enabled': false,
  'workbench.tree.indent': 12,
  'workbench.tree.renderIndentGuides': 'onHover',
  'editor.fontFamily': "'JetBrains Mono', 'IBM Plex Mono', 'Cascadia Code', 'Noto Sans Mono', monospace",
  'editor.fontSize': 13,
  'editor.lineHeight': 1.6,
  'editor.padding.top': 8,
  'editor.minimap.enabled': false,
  'editor.renderLineHighlight': 'line',
  'editor.cursorBlinking': 'solid',
  'editor.smoothScrolling': false,
  'editor.overviewRulerBorder': false,
  'editor.scrollbar.verticalScrollbarSize': 10
};
let current;
try { current = JSON.parse(await readFile(settings, 'utf8')); } catch (error) {
  if (error.code !== 'ENOENT') { console.warn(`Keeping ${settings} unchanged: it is not plain JSON.`); current = null; }
}
if (current !== null) {
  const merged = { ...profileDefaults, ...appearance, ...current };
  if (JSON.stringify(merged) !== JSON.stringify(current)) await writeFile(settings, JSON.stringify(merged, null, 2));
}
const executable = process.env.MINV_CODE_EXECUTABLE || 'code';
const args = [
  '--new-window', '--user-data-dir', path.join(profile, 'user'),
  '--extensions-dir', path.join(profile, 'extensions'), '--disable-extensions',
  '--disable-extension', 'vscode.git', '--disable-extension', 'vscode.github',
  '--disable-extension', 'vscode.github-authentication',
  '--extensionDevelopmentPath', root, ...process.argv.slice(2)
];
console.log('Launching the Minv development prototype in an isolated Code-OSS-compatible host.');
const result = spawnSync(executable, args, { stdio: 'inherit', shell: false });
if (result.error) console.error(`Cannot launch ${executable}: ${result.error.message}. Set MINV_CODE_EXECUTABLE to your Code-OSS executable.`);
process.exitCode = result.status ?? 1;
