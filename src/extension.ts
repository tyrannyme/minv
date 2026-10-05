import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { watch, FSWatcher } from 'node:fs';
import path from 'node:path';
import { Git } from './core/git';
import { readBranch } from './core/catalog';
import { commit, prepareWrite, readDiff, readHistory, stagePaths, unstagePaths } from './core/status';
import { RepositoryController } from './controller';
import { RepositoriesView } from './ui/repositories';
import { showWelcome } from './ui/welcome';
import { Repository } from './core/types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Minv');
  const git = new Git({ executable: vscode.workspace.getConfiguration('minv').get<string>('gitPath', 'git') });
  context.subscriptions.push(git);
  const version = await git.run(context.extensionPath, ['--version'], { lane: 'metadata' });
  const parsedVersion = /git version (\d+)\.(\d+)/.exec(version.stdout);
  if (version.exitCode !== 0 || !parsedVersion || Number(parsedVersion[1]) < 2 || (Number(parsedVersion[1]) === 2 && Number(parsedVersion[2]) < 48)) {
    throw new Error('Minv requires Git 2.48 or newer. Set minv.gitPath to a supported executable.');
  }
  const roots = () => (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
  const cacheKey = createHash('sha256').update(JSON.stringify(roots())).digest('hex').slice(0, 24);
  const controller = new RepositoryController(git, path.join(context.globalStorageUri.fsPath, `${cacheKey}.json`), () => vscode.workspace.isTrusted);
  const snapshots = new Map<string, string>();
  const drafts = new Map<string, string>();
  const busy = new Set<string>();
  let snapshotId = 0;
  const metadataWatches = new Map<string, { watcher: FSWatcher; ids: Set<string> }>();
  const snapshot = (name: string, content: string) => {
    const uri = vscode.Uri.from({ scheme: 'minv', path: `/${++snapshotId}/${name}` });
    snapshots.set(uri.toString(), content);
    return uri;
  };
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    void vscode.window.showErrorMessage(`Minv: ${message}`);
  };
  const run = (operation: () => Promise<unknown> | void) => { Promise.resolve().then(operation).catch(report); };
  const selected = (id?: string) => controller.get(id ?? controller.selectedId ?? '').repository;
  const trusted = async () => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before inspecting file content or running Git writes.');
  };
  const ownedPath = (repo: Repository, relativePath: string) => {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..') || relativePath.includes('\0')) throw new Error('Invalid repository path.');
    return path.join(repo.root, relativePath);
  };
  const showPatch = async (repo: Repository, file: string, staged: boolean) => {
    await trusted();
    ownedPath(repo, file);
    const patch = await readDiff(repo, git, file, staged);
    const document = await vscode.workspace.openTextDocument(snapshot(`${path.basename(file)}.diff`, patch || 'No text diff. This may be a binary, mode-only, or submodule change.'));
    await vscode.languages.setTextDocumentLanguage(document, 'diff');
    await vscode.window.showTextDocument(document, { preview: true });
  };
  const performWrite = async (id: string, action: () => Promise<void>) => {
    await trusted();
    if (busy.has(id)) throw new Error('A write is already in progress for this repository.');
    busy.add(id);
    try { await action(); } finally { busy.delete(id); controller.invalidate(id); }
  };
  const changeFile = async (id: string, file: string, staged: boolean) => {
    const repo = selected(id);
    ownedPath(repo, file);
    await performWrite(id, async () => {
      const before = await prepareWrite(repo, git);
      await showPatch(repo, file, staged);
      const verb = staged ? 'Unstage' : 'Stage';
      const choice = await vscode.window.showInformationMessage(`${verb} ${file} in ${repo.name}?`, { modal: true, detail: `Repository: ${repo.root}\nThe displayed diff is the content being reviewed. External changes will stop this operation.` }, verb);
      if (choice !== verb) return;
      if (staged) await unstagePaths(repo, git, [file], before);
      else await stagePaths(repo, git, [file], before);
    });
  };
  const commitRepository = async (id: string) => {
    const repo = selected(id);
    await performWrite(id, async () => {
      const before = await prepareWrite(repo, git);
      const result = await git.run(repo.root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames'], { lane: 'foreground' });
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Cannot read staged changes.');
      if (!result.stdout.trim()) throw new Error('There are no staged changes to commit.');
      const branch = await readBranch(repo, git);
      const branchName = branch?.name ?? branch?.oid?.slice(0, 8) ?? 'unverified branch';
      const document = await vscode.workspace.openTextDocument(snapshot(`${repo.name}-staged.diff`, result.stdout));
      await vscode.languages.setTextDocumentLanguage(document, 'diff');
      await vscode.window.showTextDocument(document, { preview: false });
      const input = vscode.window.createInputBox();
      input.title = `Commit to ${repo.name} (${branchName})`;
      input.prompt = 'Review the staged diff, then enter a commit message. Only staged changes will be committed.';
      input.value = drafts.get(id) ?? context.workspaceState.get<string>(`draft:${id}`, '');
      input.ignoreFocusOut = true;
      const message = await new Promise<string | undefined>(resolve => {
        let accepted = false;
        input.onDidChangeValue(value => { drafts.set(id, value); void context.workspaceState.update(`draft:${id}`, value); });
        input.onDidAccept(() => { if (input.value.trim()) { accepted = true; resolve(input.value); input.hide(); } });
        input.onDidHide(() => { if (!accepted) resolve(undefined); input.dispose(); });
        input.show();
      });
      if (!message) return;
      const answer = await vscode.window.showInformationMessage(`Commit staged changes in ${repo.name}?`, { modal: true, detail: `Repository: ${repo.root}\nBranch: ${branchName}\nMessage: ${message}\nConfigured hooks and signing may run.` }, 'Commit');
      if (answer !== 'Commit') return;
      await commit(repo, git, message, before);
      drafts.delete(id);
      await context.workspaceState.update(`draft:${id}`, undefined);
      void vscode.window.showInformationMessage(`Committed staged changes in ${repo.name}.`);
    });
  };

  const view = new RepositoriesView(context, {
    select(id) { controller.select(id); },
    refresh() { run(() => controller.refresh()); },
    openChange(id, file, staged) { run(() => showPatch(selected(id), file, staged)); },
    stage(id, file) { run(() => changeFile(id, file, false)); },
    unstage(id, file) { run(() => changeFile(id, file, true)); },
    commit(id) { run(() => commitRepository(id)); }
  });
  context.subscriptions.push(output, controller, vscode.window.registerWebviewViewProvider('minv.repositories', view),
    vscode.workspace.registerTextDocumentContentProvider('minv', { provideTextDocumentContent: uri => snapshots.get(uri.toString()) ?? 'This review snapshot is no longer available.' }),
    vscode.workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === 'minv') snapshots.delete(document.uri.toString()); })
  );
  const installMetadataWatches = () => {
    for (const row of controller.rows) {
      const repo = row.repository;
      for (const directory of new Set([repo.gitDir, repo.commonDir, repo.commonDir && path.join(repo.commonDir, 'refs')])) {
        if (!directory) continue;
        const existing = metadataWatches.get(directory);
        if (existing) { existing.ids.add(repo.id); continue; }
        const ids = new Set([repo.id]);
        try {
          const watcher = watch(directory, { recursive: path.basename(directory) === 'refs', persistent: false }, (_event, file) => {
            if (file?.toString() === 'objects') return;
            for (const id of ids) controller.invalidate(id);
          });
          watcher.on('error', error => {
            output.appendLine(`Metadata monitoring unavailable: ${error.message}`);
            watcher.close(); metadataWatches.delete(directory);
            for (const id of ids) { controller.get(id).monitoringError = 'Metadata monitoring stopped. Refresh manually or refocus the window.'; controller.invalidate(id); }
          });
          metadataWatches.set(directory, { watcher, ids });
        } catch (error) { row.monitoringError = 'Metadata monitoring is unavailable. Refresh manually or refocus the window.'; view.update(controller.rows, controller.selectedId); output.appendLine(`Metadata watcher unavailable for ${repo.name}: ${String(error)}. Refresh manually or refocus the window.`); }
      }
    }
  };
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  let savedSelection = context.workspaceState.get<string>('selectedRepository');
  controller.on('change', () => {
    if (publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = undefined;
      view.update(controller.rows, controller.selectedId);
      if (savedSelection !== controller.selectedId) {
        savedSelection = controller.selectedId;
        void context.workspaceState.update('selectedRepository', savedSelection);
      }
    }, 16);
  });
  context.subscriptions.push({ dispose() { if (publishTimer) clearTimeout(publishTimer); } });
  controller.on('problem', (error: unknown) => output.appendLine(String(error)));
  const openWorkspace = async () => {
    for (const entry of metadataWatches.values()) entry.watcher.close();
    metadataWatches.clear();
    await controller.open(roots(), context.workspaceState.get('selectedRepository'));
    installMetadataWatches();
  };
  let rediscover: ReturnType<typeof setTimeout> | undefined;
  const files = vscode.workspace.createFileSystemWatcher('**/*');
  const onFile = (uri: vscode.Uri) => {
    if (path.basename(uri.fsPath) === '.gitmodules') {
      if (!rediscover) rediscover = setTimeout(() => { rediscover = undefined; run(openWorkspace); }, 500);
    }
    // Parent submodule summaries depend on child dirtiness as well as gitlink identity.
    for (const row of controller.rows) {
      if (uri.fsPath.startsWith(`${row.repository.root}${path.sep}`)) controller.invalidate(row.repository.id);
    }
  };
  context.subscriptions.push(files, files.onDidChange(onFile), files.onDidCreate(onFile), files.onDidDelete(onFile),
    vscode.workspace.onDidGrantWorkspaceTrust(() => run(() => controller.refresh(true))),
    vscode.workspace.onDidChangeWorkspaceFolders(() => run(openWorkspace)),
    vscode.window.onDidChangeWindowState(state => { if (state.focused) { for (const row of controller.rows) controller.invalidate(row.repository.id); } }),
    { dispose() { for (const entry of metadataWatches.values()) entry.watcher.close(); if (rediscover) clearTimeout(rediscover); } }
  );
  const command = (id: string, fn: (...args: any[]) => Promise<unknown> | void) => context.subscriptions.push(vscode.commands.registerCommand(id, (...args) => Promise.resolve().then(() => fn(...args)).catch(report)));
  command('minv.home', () => { showWelcome(context); });
  command('minv.refresh', () => controller.refresh());
  command('minv.refreshAll', () => controller.refresh(true));
  command('minv.openRepository', async () => {
    const picked = await vscode.window.showQuickPick(controller.rows.map(row => ({ label: row.repository.name, description: row.repository.root, id: row.repository.id })), { placeHolder: 'Select a repository' });
    if (picked) { controller.select(picked.id); await vscode.commands.executeCommand('minv.repositories.focus'); }
  });
  command('minv.stage', async () => {
    const row = controller.get(controller.selectedId ?? '');
    const choices = row.status.value?.changes.filter(change => change.workingTree !== '.' && change.workingTree !== ' ') ?? [];
    const picked = await vscode.window.showQuickPick(choices.map(change => change.path), { placeHolder: `Stage a file in ${row.repository.name}` });
    if (picked) await changeFile(row.repository.id, picked, false);
  });
  command('minv.unstage', async () => {
    const row = controller.get(controller.selectedId ?? '');
    const choices = row.status.value?.changes.filter(change => !['.', ' ', '?'].includes(change.index)) ?? [];
    const picked = await vscode.window.showQuickPick(choices.map(change => change.path), { placeHolder: `Unstage a file in ${row.repository.name}` });
    if (picked) await changeFile(row.repository.id, picked, true);
  });
  command('minv.commit', () => commitRepository(selected().id));
  command('minv.history', async () => {
    await trusted();
    const repo = selected();
    const entries = await readHistory(repo, git);
    const picked = await vscode.window.showQuickPick(entries.map(entry => ({ label: entry.subject, description: `${entry.oid.slice(0, 8)} · ${entry.author}`, detail: entry.date, oid: entry.oid })), { title: `Recent history — ${repo.name}` });
    if (!picked) return;
    const result = await git.run(repo.root, ['show', '--no-ext-diff', '--no-textconv', '--format=fuller', '--stat', '--patch', picked.oid, '--'], { lane: 'foreground' });
    if (result.exitCode !== 0) throw new Error(result.stderr);
    const document = await vscode.workspace.openTextDocument(snapshot(`${picked.oid.slice(0, 8)}.diff`, result.stdout));
    await vscode.window.showTextDocument(document);
  });
  command('minv.diagnostics', () => {
    output.appendLine(JSON.stringify({ version: context.extension.packageJSON.version, repositories: controller.rows.length, trusted: vscode.workspace.isTrusted, metadataWatches: metadataWatches.size,
      observations: controller.rows.map(row => ({ name: row.repository.name, branch: row.branch.state, status: row.status.state, branchObservedAt: row.branch.observedAt, statusObservedAt: row.status.observedAt })) }, null, 2));
    output.show();
  });
  if (vscode.window.tabGroups.all.every(group => group.tabs.length === 0)) showWelcome(context);
  await openWorkspace();
}

export function deactivate(): void {}
