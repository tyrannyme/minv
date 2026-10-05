import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('minv.minv');
  assert.ok(extension, 'Minv extension was discovered by the editor host');
  await extension.activate();
  assert.ok(extension.isActive, 'Minv activated');
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['minv.home', 'minv.refresh', 'minv.refreshAll', 'minv.history', 'minv.commit']) assert.ok(commands.includes(id), `${id} registered`);
  await vscode.commands.executeCommand('minv.home');
  assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'Minv' && tab.input instanceof vscode.TabInputWebview)), 'Minv home opens as a real webview editor');
  await vscode.commands.executeCommand('minv.repositories.focus');
  await vscode.commands.executeCommand('minv.refresh');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root, 'Smoke fixture workspace is open');
  const file = vscode.Uri.joinPath(root, 'host-smoke.txt');
  await writeFile(file.fsPath, 'Minv boot smoke\n');
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  await editor.edit(edit => edit.insert(new vscode.Position(1, 0), 'Editor works\n'));
  await document.save();
  assert.equal(document.getText(), 'Minv boot smoke\nEditor works\n');
  await vscode.commands.executeCommand('minv.refresh');
  if (process.env.MINV_HOST_SMOKE_RESULT) await writeFile(process.env.MINV_HOST_SMOKE_RESULT, JSON.stringify({ passed: true, hostVersion: vscode.version, activated: extension.isActive, editorSaved: document.getText() === 'Minv boot smoke\nEditor works\n' }));
  console.log('MINV_HOST_SMOKE_OK: activation, repository view, refresh, editor, and save passed.');
}
