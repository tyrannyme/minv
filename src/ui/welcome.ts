import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

interface Action { command: string; label: string; detail: string; keys?: string }

const sections: { title: string; actions: Action[] }[] = [
  { title: 'Browse', actions: [
    { command: 'workbench.action.quickOpen', label: 'Open file', detail: 'Jump to any path by name', keys: 'P' },
    { command: 'workbench.view.explorer', label: 'Files', detail: 'Lazy tree of the workspace', keys: 'Shift E' },
    { command: 'workbench.action.findInFiles', label: 'Search text', detail: 'Plain text or regular expression', keys: 'Shift F' },
  ] },
  { title: 'Review', actions: [
    { command: 'minv.repositories.focus', label: 'Repositories', detail: 'Branch, changes and freshness' },
    { command: 'minv.openRepository', label: 'Find repository', detail: 'By name or path, including submodules' },
    { command: 'minv.history', label: 'Recent history', detail: 'Commits of the selected repository' },
  ] },
  { title: 'Commit', actions: [
    { command: 'minv.refreshAll', label: 'Refresh all', detail: 'Re-check every repository now' },
    { command: 'minv.commit', label: 'Review and commit', detail: 'Staged changes, with confirmation' },
    { command: 'minv.diagnostics', label: 'Diagnostics', detail: 'Observation state, written to Output' },
  ] },
];
const allowed = new Set(sections.flatMap(section => section.actions.map(action => action.command)));
let current: vscode.WebviewPanel | undefined;

/** Opens (or reveals) the Minv home page. Only the fixed commands above can be run from it. */
export function showWelcome(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (current) { current.reveal(); return current; }
  const panel = vscode.window.createWebviewPanel('minv.welcome', 'Minv', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
  current = panel;
  context.subscriptions.push(panel);
  panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'minv.svg'));
  panel.webview.html = welcomeHtml(readFileSync(path.join(context.extensionPath, 'media', 'minv.svg'), 'utf8'), process.platform === 'darwin' ? '⌘' : 'Ctrl');
  panel.webview.onDidReceiveMessage((message: unknown) => {
    const command = (message as { type?: unknown; command?: unknown } | undefined);
    if (command?.type === 'ready') { void panel.webview.postMessage({ type: 'workspace', name: vscode.workspace.name ?? 'No folder open' }); return; }
    if (command?.type === 'run' && typeof command.command === 'string' && allowed.has(command.command)) {
      void Promise.resolve(vscode.commands.executeCommand(command.command)).catch(error => {
        void vscode.window.showErrorMessage(`Minv: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }, undefined, context.subscriptions);
  panel.onDidDispose(() => { if (current === panel) current = undefined; }, undefined, context.subscriptions);
  return panel;
}

function escape(value: string): string {
  return value.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
}

/** Exported for tests. Markup is built only from the fixed catalog above and the bundled mark. */
export function welcomeHtml(mark: string, modifier: string): string {
  const nonce = randomBytes(18).toString('base64');
  const keys = (value: string) => [modifier, ...value.split(' ')].map(key => `<kbd>${escape(key)}</kbd>`).join('');
  const columns = sections.map(section => `<section><h2>${section.title}</h2><ul>${section.actions.map(action =>
    `<li><button data-command="${escape(action.command)}"><span class="label">${escape(action.label)}</span><span class="detail">${escape(action.detail)}</span>${action.keys ? `<span class="keys" aria-label="Shortcut ${escape([modifier, ...action.keys.split(' ')].join('+'))}">${keys(action.keys)}</span>` : ''}</button></li>`).join('')}</ul></section>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Minv</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.5; }
main { max-width: 880px; padding: clamp(28px, 8vh, 72px) clamp(20px, 6vw, 56px) 48px; }
.brand { display: flex; align-items: center; gap: 10px; color: var(--vscode-foreground); }
.brand svg { width: 28px; height: 28px; color: var(--vscode-focusBorder); }
.wordmark { font-size: 15px; font-weight: 600; letter-spacing: .01em; }
.build { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); }
h1 { margin: 36px 0 8px; font-size: 28px; line-height: 1.15; font-weight: 600; letter-spacing: -.015em; }
.lede { margin: 0; max-width: 56ch; color: var(--vscode-descriptionForeground); }
.workspace { display: flex; gap: 10px; align-items: baseline; margin: 28px 0 0; padding: 10px 0; border-block: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); font-size: 12px; }
.workspace dt { color: var(--vscode-descriptionForeground); }
.workspace dd { margin: 0; font-family: var(--vscode-editor-font-family, monospace); overflow-wrap: anywhere; }
.columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 28px; margin-top: 28px; }
h2 { margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
ul { list-style: none; margin: 0; padding: 0; }
button { all: unset; box-sizing: border-box; display: grid; grid-template-columns: 1fr auto; column-gap: 8px; width: 100%; padding: 7px 8px; margin-left: -8px; border-radius: 4px; cursor: pointer; }
button:hover { background: var(--vscode-list-hoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.label { font-weight: 600; }
button:hover .label, button:focus-visible .label { color: var(--vscode-textLink-foreground); }
.detail { grid-column: 1 / -1; font-size: 12px; color: var(--vscode-descriptionForeground); }
.keys { grid-column: 2; grid-row: 1; display: flex; gap: 3px; align-self: center; }
kbd { font: 11px var(--vscode-editor-font-family, monospace); padding: 0 5px; border: 1px solid var(--vscode-keybindingLabel-border, var(--vscode-widget-border)); border-bottom-color: var(--vscode-keybindingLabel-bottomBorder, var(--vscode-widget-border)); border-radius: 3px; color: var(--vscode-keybindingLabel-foreground, inherit); background: var(--vscode-keybindingLabel-background, transparent); }
footer { margin-top: 36px; max-width: 64ch; font-size: 12px; color: var(--vscode-descriptionForeground); }
footer p { margin: 0 0 6px; }
body.vscode-high-contrast button, body.vscode-high-contrast-light button { outline: 1px dashed transparent; }
body.vscode-high-contrast button:hover, body.vscode-high-contrast-light button:hover { outline-color: var(--vscode-contrastActiveBorder); }
@media (forced-colors: active) { .brand svg { color: CanvasText; } .label { color: LinkText; } }
</style></head><body><main>
<div class="brand">${mark.replace('<svg ', '<svg aria-hidden="true" ')}<span class="wordmark">minv</span><span class="build">Development prototype</span></div>
<h1>Browse. Review. Commit.</h1>
<p class="lede">A focused repository companion for large, multi-repository workspaces. It sits beside your terminal and external tools; it does not host an agent.</p>
<dl class="workspace"><dt>Workspace</dt><dd id="workspace">…</dd></dl>
<div class="columns">${columns}</div>
<footer><p>This build runs as an isolated extension inside a Code-OSS host. Host features outside Minv's scope are still present until the focused fork ships; the built-in Git provider is disabled in this profile.</p></footer>
</main>
<script nonce="${nonce}">(() => {
  const api = acquireVsCodeApi();
  for (const button of document.querySelectorAll('button[data-command]')) button.addEventListener('click', () => api.postMessage({ type: 'run', command: button.dataset.command }));
  window.addEventListener('message', event => { if (event.data?.type === 'workspace' && typeof event.data.name === 'string') document.getElementById('workspace').textContent = event.data.name; });
  api.postMessage({ type: 'ready' });
})();</script></body></html>`;
}
