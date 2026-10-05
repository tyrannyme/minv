import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSensitiveText } from '../../src/core/redact';
import { WorkspaceFiles } from '../../src/core/files';
import { acquireApplicationLease } from '../../src/core/update-lease';
import { Git } from '../../src/core/git';
import { cliHelp, cliWaitTicket, parseCli, signalCliWait, type CliLaunchRequest, type CliWaitTicket } from '../../src/core/cli';
import { resolveExecutable } from '../../src/core/sandbox';
import type { HostEvents } from '../renderer/src/contract';
import { StateStore } from './state';
import { Diagnostics } from './diagnostics';
import { RequestError, RequestRouter, type Handlers } from './protocol';
import { WorkspaceSession } from './workspace';
import { APP_URL, CONTENT_SECURITY_POLICY, localAsset } from './local-assets';

app.setName('Minv');
protocol.registerSchemesAsPrivileged([{ scheme: 'minv-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const traces = new Diagnostics();
const windows = new Map<number, WindowController>();
const closingTasks = new Set<Promise<unknown>>();
const MUTATIONS = new Set(['git.stage', 'git.unstage', 'git.applyHunks', 'git.discard', 'git.commit', 'git.createBranch', 'git.switchBranch', 'git.stash', 'git.applyStash', 'git.dropStash', 'git.fetch', 'git.pull', 'git.push', 'fs.write', 'fs.createFile', 'fs.createDirectory', 'fs.transfer', 'fs.delete', 'fs.restore']);
const applicationDirectory = __dirname;
const dataDirectory = process.env.MINV_USER_DATA ? path.resolve(process.env.MINV_USER_DATA) : path.join(app.getPath('appData'), 'Minv');
app.setPath('userData', dataDirectory);
interface Launch { argv: string[]; cwd: string; ticket?: CliWaitTicket }
const initial: Launch = { argv: process.argv.slice(process.defaultApp ? 2 : 1), cwd: process.env.MINV_LAUNCH_CWD || process.cwd(), ticket: cliWaitTicket() };
let initialRequest: ReturnType<typeof parseCli>;
try { initialRequest = parseCli(initial.argv, initial.cwd); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); app.exit(2); initialRequest = { kind: 'help' }; }

// Deliberately local and bounded: never persist workspace text or raw Git stderr in diagnostics.
function safeMessage(error: unknown, maximum = 8192): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, maximum);
}
function validLaunch(value: unknown): Launch {
  if (!value || typeof value !== 'object') throw new Error('Invalid launch request.');
  const request = value as Launch;
  if (!Array.isArray(request.argv) || request.argv.length > 4096 || request.argv.some(arg => typeof arg !== 'string' || arg.length > 32768 || arg.includes('\0')) || typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd)) throw new Error('Invalid launch arguments.');
  if (request.ticket) cliWaitTicket({ MINV_WAIT_FILE: request.ticket.file, MINV_WAIT_TOKEN: request.ticket.token });
  return request;
}
function containing(root: string, file: string): boolean { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }

class WindowController {
  readonly window: BrowserWindow;
  readonly workspace: WorkspaceSession;
  private readonly git: Git;
  private loaded = false;
  private rendererReady = false;
  private rendererConnected?: () => void;
  private closing = false;
  private crashed = false;
  private closeAllowed = false;
  private activeWrites = 0;
  private closeAfterWrites = false;
  private pendingClose?: { id: string; resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout> };
  private readonly queued: { event: keyof HostEvents; payload: unknown }[] = [];
  private readonly references = new Map<string, { files: WorkspaceFiles; rootId: string; path: string }>();
  private readonly waiting = new Map<string, { ticket: CliWaitTicket; remaining: Set<string> }>();
  readonly ready: Promise<void>;
  constructor(private readonly state: StateStore, launch: Launch, request: CliLaunchRequest, background: string) {
    const saved = state.snapshot.bounds;
    const preferences = state.preferences;
    this.window = new BrowserWindow({
      title: 'Minv', width: saved?.width ?? 1440, height: saved?.height ?? 960,
      ...(saved?.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
      minWidth: 900, minHeight: 600, show: false, frame: false,
      backgroundColor: background,
      webPreferences: { preload: path.join(applicationDirectory, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, navigateOnDragDrop: false }
    });
    windows.set(this.window.webContents.id, this);
    this.git = new Git({ executable: preferences.gitPath || 'git', sandboxExecutable: path.join(applicationDirectory, 'native/minv-git-sandbox'), onCommand: trace => traces.record({ kind: `git.${trace.command}`, queueMs: trace.queueMs, durationMs: trace.durationMs, count: trace.bytes, status: String(trace.exitCode ?? 'cancelled') }) });
    this.workspace = new WorkspaceSession({ state, git: this.git, dataDirectory, rgPath: path.join(applicationDirectory, 'native/rg'), emit: (event, payload) => this.emit(event, payload), confirm: (title, detail) => this.confirm(title, detail), choose: async (title, options) => {
      const result = await dialog.showMessageBox(this.window, { type: 'question', title, message: title, detail: options.map(item => `${item.label}\n${item.detail ?? ''}`).join('\n\n'), buttons: [...options.map(item => item.label), 'Cancel'], cancelId: options.length, defaultId: options.length });
      return options[result.response]?.id;
    } });
    const contents = this.window.webContents; const contentsId = contents.id;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('render-process-gone', (_event, details) => { this.crashed = true; traces.record({ kind: 'renderer.crash', status: details.reason }); void this.failWaits('Minv renderer stopped before the requested files closed.'); });
    contents.on('will-prevent-unload', async event => {
      // Renderer beforeunload protects active dirty buffers. Closing is an explicit user choice.
      const result = dialog.showMessageBoxSync(this.window, { type: 'warning', title: 'Unsaved files', message: 'Close Minv with unsaved files?', detail: 'Save your changes before closing. Recovery drafts are retained when successfully written.', buttons: ['Keep editing', 'Close'], defaultId: 0, cancelId: 0 });
      if (result === 1) event.preventDefault();
    });
    const windowState = () => { this.workspace.setFocused(this.window.isFocused()); this.emit('window.state', { maximized: this.window.isMaximized(), focused: this.window.isFocused() }); };
    this.window.on('maximize', windowState); this.window.on('unmaximize', windowState); this.window.on('focus', windowState); this.window.on('blur', windowState);
    this.window.on('close', event => {
      if (this.activeWrites && this.crashed) { event.preventDefault(); this.closeAfterWrites = true; return; }
      if (!this.closeAllowed && this.loaded && !this.crashed) {
        event.preventDefault();
        if (!this.pendingClose) void this.prepareClose('window').then(allow => { if (allow && !this.window.isDestroyed()) { this.closeAllowed = true; this.window.close(); } });
        return;
      }
      const bounds = this.window.getNormalBounds(); this.state.setBounds({ ...bounds, maximized: this.window.isMaximized() }); void this.state.flush();
    });
    this.window.on('closed', () => {
      windows.delete(contentsId); this.closing = true;
      if (this.pendingClose) { clearTimeout(this.pendingClose.timer); this.pendingClose.resolve(false); this.pendingClose = undefined; }
      const cleanup = Promise.allSettled([this.workspace.close().finally(() => this.git.dispose()), this.failWaits(this.crashed ? 'Minv stopped unexpectedly.' : undefined), this.state.flush()]);
      closingTasks.add(cleanup); void cleanup.finally(() => closingTasks.delete(cleanup));
    });
    this.window.once('ready-to-show', () => { if (saved?.maximized) this.window.maximize(); this.window.show(); });
    contents.on('console-message', event => { if (event.level === 'error') traces.record({ kind: 'renderer.console', status: 'error' }); });
    const workspace = this.workspace; const window = this.window;
    const connected = new Promise<void>(resolve => { this.rendererConnected = resolve; });
    this.ready = (async () => {
      const roots = launch.argv.length ? request.roots : state.workspace.roots;
      if (roots.length || request.files.length) await workspace.open(await this.launchRoots(request, roots));
      await window.loadURL(APP_URL);
      this.loaded = true;
      await connected;
      await this.openFiles(request, launch.ticket);
      traces.record({ kind: 'window.loaded' });
    })().catch(async error => { await this.failWaits(safeMessage(error)); if (launch.ticket) await signalCliWait(launch.ticket, safeMessage(error)).catch(() => undefined); throw error; });
  }
  emit(event: keyof HostEvents, payload: unknown): void {
    if (this.closing) return;
    if (!this.rendererReady) {
      // Boot reads a current snapshot. Replaying earlier snapshots afterwards would
      // move observations backwards and rebuild rows several times before first input.
      if (!['workspace', 'rows', 'prefs'].includes(event) && this.queued.length < 8192) this.queued.push({ event, payload });
      return;
    }
    if (!this.window.isDestroyed()) this.window.webContents.send('minv:event', event, payload);
  }
  async confirm(title: string, detail: string): Promise<boolean> {
    const result = await dialog.showMessageBox(this.window, { type: 'question', title, message: title, detail: detail.length > 32768 ? safeMessage(detail.slice(0, 32768), 32768) + '\n\n[Preview shortened. Review the complete diff in Minv before continuing.]' : safeMessage(detail, 32768), buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0, noLink: true });
    return result.response === 1;
  }
  private async launchRoots(request: CliLaunchRequest, roots = request.roots): Promise<string[]> {
    const result = [...roots];
    const paths = request.files.map(file => file.path);
    for (const file of paths) {
      const parent = await realpath(path.dirname(file));
      if (!result.some(root => containing(root, parent))) result.push(parent);
    }
    return result;
  }
  async launch(launch: Launch, request: CliLaunchRequest): Promise<void> {
    await this.ready;
    const currentRoots = this.workspace.snapshot?.roots;
    const reuseRoots = !request.rootsExplicit && currentRoots?.length && (request.files.length > 0 || request.diff) && request.files.every(file => currentRoots.some(root => containing(root, file.path)));
    const roots = await this.launchRoots(request, reuseRoots ? currentRoots : request.roots);
    if (JSON.stringify(roots) !== JSON.stringify(this.workspace.snapshot?.roots)) {
      if (!await this.prepareClose('cli')) throw new RequestError('cancelled', 'Workspace change cancelled.');
      await this.workspace.open(roots);
    }
    await this.openFiles(request, launch.ticket);
    if (this.window.isMinimized()) this.window.restore(); this.window.show(); this.window.focus();
  }
  private async openFiles(request: CliLaunchRequest, ticket?: CliWaitTicket): Promise<void> {
    if (!request.files.length && !request.diff && !request.repository) return;
    await this.workspace.ready;
    const target = async (file: string) => {
      const absolute = path.join(await realpath(path.dirname(file)), path.basename(file));
      const repository = this.workspace.repositories().filter(repo => containing(repo.root, absolute)).sort((a, b) => b.root.length - a.root.length)[0];
      if (!repository) throw new RequestError('boundary', 'The requested file has no approved workspace root.');
      return { repositoryId: repository.id, path: path.relative(repository.root, absolute).split(path.sep).join('/') };
    };
    const waitKey = ticket ? randomUUID() : undefined;
    const remaining = new Set<string>();
    if (ticket && waitKey) this.waiting.set(waitKey, { ticket, remaining });
    for (const file of request.files) {
      const wait = waitKey ? `${waitKey}:${remaining.size}` : undefined; if (wait) remaining.add(wait);
      this.emit('open', { ...await target(file.path), line: file.line, column: file.column, wait });
    }
    if (request.diff) {
      const wait = waitKey ? `${waitKey}:${remaining.size}` : undefined; if (wait) remaining.add(wait);
      const reference = async (file: string) => {
        const directory = await realpath(path.dirname(file));
        const files = await WorkspaceFiles.create({ roots: [directory], recoveryDirectory: path.join(dataDirectory, 'recovery', 'comparisons') });
        const ref = randomUUID();
        this.references.set(ref, { files, rootId: files.roots[0]!.id, path: path.basename(file) });
        if (this.references.size > 128) this.references.delete(this.references.keys().next().value!);
        return { ref, label: file };
      };
      this.emit('compare', { left: await reference(request.diff.before), right: await reference(request.diff.after), wait });
    }
    if (request.repository) {
      const root = await realpath(request.repository);
      const repo = this.workspace.repositories().find(item => item.root === root);
      if (repo) { await this.workspace.handlers['repo.select']?.({ id: repo.id }); this.emit('open', { repositoryId: repo.id }); }
    }
  }
  async performRequest(method: unknown, dispatch: () => Promise<unknown>): Promise<unknown> {
    const writing = typeof method === 'string' && MUTATIONS.has(method);
    if (writing && method !== 'fs.write' && this.pendingClose) throw new RequestError('unavailable', 'Finish the current workspace-close decision before starting another write.');
    if (writing) this.activeWrites++;
    try { return await dispatch(); }
    finally {
      if (writing) this.activeWrites--;
      if (!this.activeWrites && this.closeAfterWrites && !this.window.isDestroyed()) this.window.close();
    }
  }
  private async prepareClose(reason: HostEvents['workspace.willClose']['reason']): Promise<boolean> {
    if (this.activeWrites) {
      this.emit('notice', { level: 'warning', message: 'A write is still running. Let it finish before closing this workspace; network operations can be stopped from their progress control.' });
      return false;
    }
    if (!this.rendererReady || !this.workspace.snapshot && reason !== 'window') return true;
    if (this.pendingClose) throw new RequestError('unavailable', 'Finish the current unsaved-file decision first.');
    return new Promise<boolean>(resolve => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (this.pendingClose?.id !== id) return;
        this.pendingClose = undefined; resolve(false);
        this.emit('notice', { level: 'warning', message: 'The workspace was kept open because its files did not finish closing.' });
      }, 120000);
      this.pendingClose = { id, resolve, timer };
      this.emit('workspace.willClose', { requestId: id, reason });
    });
  }
  private acknowledge(ticket: CliWaitTicket, failure?: string): Promise<void> {
    const pending = signalCliWait(ticket, failure); closingTasks.add(pending);
    void pending.finally(() => closingTasks.delete(pending)).catch(() => undefined);
    return pending;
  }
  private async release(wait: string): Promise<void> {
    for (const [key, item] of this.waiting) if (item.remaining.delete(wait) && !item.remaining.size) { this.waiting.delete(key); await this.acknowledge(item.ticket); }
  }
  private async failWaits(failure?: string): Promise<void> {
    const pending = [...this.waiting.values()]; this.waiting.clear();
    await Promise.all(pending.map(item => this.acknowledge(item.ticket, failure).catch(() => undefined)));
  }
  handlers(): Handlers {
    return {
      ...this.workspace.handlers,
      'workspace.closeReady': input => {
        if (this.pendingClose?.id !== input.requestId) throw new RequestError('boundary', 'This close request is no longer pending.');
        const pending = this.pendingClose; this.pendingClose = undefined; clearTimeout(pending.timer); pending.resolve(input.allow && this.activeWrites === 0);
      },
      'workspace.close': async () => { if (await this.prepareClose('close')) await this.workspace.handlers['workspace.close']?.(); },
      'workspace.open': async input => {
        if (input.recentId) {
          const recents = await this.workspace.handlers['workspace.recent']?.();
          const recent = recents?.find(item => item.id === input.recentId);
          if (!recent) throw new RequestError('unavailable', 'Recent workspace is unavailable.');
          if (!await this.prepareClose('open')) return null;
          return this.workspace.open(recent.roots);
        }
        const picked = await dialog.showOpenDialog(this.window, { title: 'Open a workspace', properties: ['openDirectory', 'multiSelections'] });
        if (picked.canceled || !await this.prepareClose('open')) return null;
        return this.workspace.open(picked.filePaths);
      },
      'fs.readRef': async input => {
        const reference = this.references.get(input.ref);
        if (!reference) throw new RequestError('boundary', 'This file comparison reference has expired.');
        const document = await reference.files.read(reference.rootId, reference.path);
        return document.kind === 'text' ? { kind: 'text', text: document.text, version: document.fingerprint, encoding: document.encoding, bom: document.bom, eol: document.eol, size: document.size, large: document.large } : { kind: document.kind, version: document.fingerprint, size: document.size };
      },
      'prefs.get': () => this.state.preferences,
      'prefs.set': async preferences => {
        this.state.setPreferences(preferences); await this.state.flush();
        this.emit('prefs', this.state.preferences);
        if (preferences.gitPath !== undefined) this.emit('notice', { level: 'info', message: 'The Git executable setting applies after restarting Minv.' });
        return this.state.preferences;
      },
      'shell.reveal': async input => {
        const repo = this.workspace.repository(input.repositoryId);
        const file = path.resolve(repo.root, input.path ?? '');
        if (!containing(repo.root, file)) throw new RequestError('boundary', 'Path is outside its repository.');
        const canonical = await realpath(file);
        if (!containing(repo.root, canonical)) throw new RequestError('boundary', 'Path resolves outside its repository.');
        if (input.path) shell.showItemInFolder(canonical); else { const error = await shell.openPath(canonical); if (error) throw new Error(error); }
      },
      'shell.openTerminal': async input => {
        if (!this.workspace.snapshot?.trusted) throw new RequestError('untrusted', 'Trust this workspace before opening a terminal.');
        const workspaceId = this.workspace.snapshot.id;
        const repo = this.workspace.repository(input.repositoryId);
        const configured = this.state.preferences.terminal;
        const candidates = configured ? [configured] : ['konsole', 'gnome-terminal', 'x-terminal-emulator', 'xterm'];
        let executable: string | undefined;
        for (const candidate of candidates) { try { executable = await resolveExecutable(candidate, app.getPath('home')); break; } catch { /* Next installed terminal. */ } }
        if (!executable) throw new RequestError('unavailable', 'Choose an installed terminal executable in preferences.');
        if (!this.workspace.snapshot?.trusted || this.workspace.snapshot.id !== workspaceId) throw new RequestError('untrusted', 'Workspace trust changed before opening the terminal.');
        const name = path.basename(executable);
        const args = name === 'konsole' ? ['--workdir', repo.root] : name === 'gnome-terminal' ? ['--working-directory', repo.root] : [];
        const child = spawn(executable, args, { cwd: repo.root, shell: false, detached: true, stdio: 'ignore' });
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
      },
      'diagnostics.open': async () => {
        const chosen = await dialog.showSaveDialog(this.window, { title: 'Export local diagnostics', defaultPath: 'minv-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (!chosen.canceled && chosen.filePath) await writeFile(chosen.filePath, JSON.stringify({ ...traces.snapshot(), watchers: this.workspace.diagnostics(), workspace: this.workspace.snapshot ? { discovery: this.workspace.snapshot.discovery, repositories: this.workspace.snapshot.rows.length, branchStates: this.workspace.snapshot.rows.reduce<Record<string, number>>((states, row) => { states[row.branch.state] = (states[row.branch.state] ?? 0) + 1; return states; }, {}) } : null, electronProcesses: app.getAppMetrics().map(metric => ({ type: metric.type, cpu: metric.cpu, memory: metric.memory })) }, null, 2), { mode: 0o600 });
      },
      'window.ready': () => {
        if (!this.rendererReady) {
          this.rendererReady = true;
          this.emit('workspace', this.workspace.snapshot);
          this.emit('prefs', this.state.preferences);
          for (const item of this.queued.splice(0)) this.emit(item.event, item.payload);
          this.rendererConnected?.();
        }
      },
      'window.minimize': () => this.window.minimize(),
      'window.toggleMaximize': () => { if (this.window.isMaximized()) this.window.unmaximize(); else this.window.maximize(); },
      'window.close': () => this.window.close(),
      'cli.released': input => this.release(input.wait),
    };
  }
}

async function openWindow(launch: Launch, request: CliLaunchRequest): Promise<WindowController> {
  const state = new StateStore(dataDirectory); await state.load();
  const appearance = state.preferences.appearance === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : state.preferences.appearance;
  let background = nativeTheme.shouldUseDarkColors ? '#101114' : '#f5f6f8';
  try {
    const tokens = JSON.parse(await readFile(path.join(applicationDirectory, 'design-tokens.json'), 'utf8'));
    const theme = tokens.themes?.[appearance];
    const candidate = theme?.canvas ?? theme?.window ?? theme?.background ?? theme?.surface;
    if (typeof candidate === 'string' && /^#[a-f0-9]{6}$/i.test(candidate)) background = candidate;
  } catch { /* A neutral native backdrop remains usable if optional tokens are unavailable. */ }
  const controller = new WindowController(state, launch, request, background); await controller.ready; return controller;
}
async function runApplication(): Promise<void> {
  const lease = await acquireApplicationLease(dataDirectory);
  let quitting = false;
  const finish = async (code: number) => {
    await Promise.allSettled([...closingTasks]);
    try { await lease.release(); }
    catch (error) { console.error('Minv update lease cleanup:', safeMessage(error)); }
    finally { app.exit(code); }
  };
  app.on('will-quit', event => {
    event.preventDefault();
    if (!quitting) { quitting = true; void finish(typeof process.exitCode === 'number' ? process.exitCode : 0); }
  });
  if (!app.requestSingleInstanceLock(initial)) { app.quit(); return; }
  app.on('second-instance', async (_event, _argv, _cwd, additionalData) => {
    let launch: Launch | undefined;
    try {
      launch = validLaunch(additionalData); const request = parseCli(launch.argv, launch.cwd);
      if (request.kind !== 'launch') return;
      const current = [...windows.values()].at(-1);
      if (!current || request.newWindow) await openWindow(launch, request); else await current.launch(launch, request);
    } catch (error) { if (launch?.ticket) await signalCliWait(launch.ticket, safeMessage(error)).catch(() => undefined); }
  });
  app.on('window-all-closed', () => { void Promise.allSettled([...closingTasks]).then(() => { if (!windows.size) app.quit(); }); });
  app.whenReady().then(async () => {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('minv-app://app/') && !details.url.startsWith('devtools://') }));
    protocol.handle('minv-app', async request => {
      try {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
        const asset = await localAsset(applicationDirectory, request.url);
        return new Response(await readFile(asset.file), { headers: { 'Content-Type': asset.type, 'Content-Security-Policy': CONTENT_SECURITY_POLICY, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' } });
      } catch { return new Response('Not found', { status: 404 }); }
    });
    ipcMain.handle('minv:request', async (event, method, parameters) => {
      try {
        const controller = windows.get(event.sender.id);
        const frame = event.senderFrame;
        if (!controller || !frame) throw new RequestError('boundary', 'Unknown window.');
        const identity = (target: Electron.WebFrameMain) => `${target.processId}:${target.routingId}`;
        const router = new RequestRouter(() => ({ webContentsId: controller.window.webContents.id, frameId: identity(controller.window.webContents.mainFrame) }), controller.handlers());
        const value = await controller.performRequest(method, () => router.dispatch({ webContentsId: event.sender.id, frameId: identity(frame), url: frame.url }, method, parameters));
        return { ok: true, value };
      } catch (error) {
        traces.record({ kind: 'request.error', status: error instanceof RequestError ? error.code : 'internal' });
        return { ok: false, error: { code: error instanceof RequestError ? error.code : 'internal', message: safeMessage(error) } };
      }
    });
    if (initialRequest.kind === 'help') { console.log(cliHelp); app.quit(); return; }
    if (initialRequest.kind === 'version') { console.log(app.getVersion()); app.quit(); return; }
    await openWindow(initial, initialRequest);
  }).catch(async error => {
    if (initial.ticket) await signalCliWait(initial.ticket, safeMessage(error)).catch(() => undefined);
    dialog.showErrorBox('Minv could not start', safeMessage(error)); await finish(1);
  });
}

void runApplication().catch(async error => {
  if (initial.ticket) await signalCliWait(initial.ticket, safeMessage(error)).catch(() => undefined);
  dialog.showErrorBox('Minv could not start', safeMessage(error)); app.exit(1);
});
