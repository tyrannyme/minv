#!/usr/bin/env node
// Real packaged-main integration. No test hooks are added to production code.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = resolve(root, 'build/desktop/app');
const require = createRequire(import.meta.url);
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const jsonWrite = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

function git(directory, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Minv Smoke', '-c', 'user.email=smoke@minv.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: directory, encoding: 'utf8', shell: false,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: '2026-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T12:00:00Z' },
  });
  if (result.status !== 0) throw new Error(`Git fixture failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function createDesktopSmokeFixture(directory) {
  mkdirSync(directory, { recursive: true });
  git(directory, 'init', '--initial-branch=review/main');
  mkdirSync(join(directory, 'src'));
  mkdirSync(join(directory, 'docs'));
  writeFileSync(join(directory, 'src/app.ts'), 'export const product = "Minv";\nexport const purpose = "Browse. Review. Commit.";\n');
  writeFileSync(join(directory, 'docs/notes.md'), '# Review notes\n\nA focused home for local changes.\n');
  const children = [{ path: 'packages/editor', branch: 'feature/text-review' }, { path: 'packages/git', branch: 'fix/branch-freshness' }];
  for (const child of children) {
    const folder = join(directory, child.path); mkdirSync(folder, { recursive: true });
    git(folder, 'init', `--initial-branch=${child.branch}`);
    writeFileSync(join(folder, 'index.ts'), `export const component = ${JSON.stringify(child.path)};\n`);
    git(folder, 'add', '--', 'index.ts'); git(folder, 'commit', '-m', 'Initial component');
    git(directory, 'config', '--file', '.gitmodules', `submodule.${child.path}.path`, child.path);
    git(directory, 'config', '--file', '.gitmodules', `submodule.${child.path}.url`, `./${child.path}`);
    git(directory, 'update-index', '--add', '--cacheinfo', `160000,${git(folder, 'rev-parse', 'HEAD')},${child.path}`);
  }
  git(directory, 'config', '--file', '.gitmodules', 'submodule.docs.path', 'packages/docs');
  git(directory, 'config', '--file', '.gitmodules', 'submodule.docs.url', './packages/docs');
  git(directory, 'update-index', '--add', '--cacheinfo', `160000,${git(join(directory, children[0].path), 'rev-parse', 'HEAD')},packages/docs`);
  mkdirSync(join(directory, 'packages/docs'));
  git(directory, 'add', '--', '.gitmodules', 'src', 'docs'); git(directory, 'commit', '-m', 'A local workspace ready for review');
  writeFileSync(join(directory, 'src/app.ts'), 'export const product = "Minv";\nexport const purpose = "Browse. Review. Commit.";\nexport const mode = "local";\n');
  writeFileSync(join(directory, 'docs/notes.md'), '# Review notes\n\nReview the selected repository before committing.\n');
  git(directory, 'add', '--', 'docs/notes.md');
  writeFileSync(join(directory, 'packages/editor/index.ts'), 'export const component = "text review";\n');
  return { root: directory, children, branch: 'review/main', unavailable: 'packages/docs' };
}

async function launchHarness() {
  if (!existsSync(join(appDirectory, 'main.cjs'))) throw new Error('Build the real desktop first with npm run desktop:build.');
  const runs = resolve(root, '.minv-dev'); mkdirSync(runs, { recursive: true });
  const run = mkdtempSync(join(runs, 'desktop-smoke-'));
  const workspace = createDesktopSmokeFixture(join(run, 'minv-workspace'));
  const profile = join(run, 'profile'); mkdirSync(profile);
  // Saved trust is scoped exclusively to repositories this test just created.
  jsonWrite(join(profile, 'state.json'), {
    version: 1, trustedRoots: [workspace.root], recentWorkspaces: [],
    workspace: { roots: [workspace.root], repositoryOrder: [], pinnedRepositories: [], openDocuments: [] },
    preferences: { appearance: 'system', motion: 'reduce', density: 'comfortable', editorFontSize: 13, tabSize: 2, wordWrap: false, renderWhitespace: false, gitPath: 'git', terminal: '', browseExclude: [], searchExclude: [] },
    bounds: { width: 1440, height: 960, maximized: false },
  });
  jsonWrite(join(run, 'fixture.json'), workspace);
  const electron = require('electron');
  const xvfb = spawnSync('which', ['xvfb-run'], { encoding: 'utf8' });
  const hasXvfb = xvfb.status === 0;
  if (!hasXvfb && !process.env.DISPLAY) throw new Error('Install Xvfb or provide a display for the real Electron smoke.');
  const command = hasXvfb ? xvfb.stdout.trim() : electron;
  const args = [...(hasXvfb ? ['-a', '--server-args=-screen 0 1600x1100x24', electron] : []), fileURLToPath(import.meta.url), workspace.root, '--goto', join(workspace.root, 'src/app.ts') + ':1:1'];
  const environment = { ...process.env, MINV_DESKTOP_SMOKE_CHILD: '1', MINV_DESKTOP_SMOKE_RUN: run, MINV_USER_DATA: profile, MINV_LAUNCH_CWD: workspace.root, ELECTRON_OZONE_PLATFORM_HINT: 'x11' };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.MINV_WAIT_FILE;
  delete environment.MINV_WAIT_TOKEN;
  if (hasXvfb) delete environment.WAYLAND_DISPLAY;
  console.log(`Desktop smoke: private ${hasXvfb ? 'Xvfb' : 'application'} window, isolated fixture ${run}`);
  const child = spawn(command, args, { cwd: root, env: environment, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const watchdog = setTimeout(() => {
    console.error('Desktop smoke process group exceeded 80 seconds.');
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }, 80_000);
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    const text = String(bytes); log += text; process.stdout.write(text);
  });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', status => done(status ?? 1)); });
  clearTimeout(watchdog);
  writeFileSync(join(run, 'process.log'), log, { mode: 0o600 });
  let leaseFailed = false;
  if (existsSync(join(run, 'report.json'))) {
    const report = JSON.parse(readFileSync(join(run, 'report.json'), 'utf8'));
    const gate = join(profile, 'update-gate');
    const stale = existsSync(gate) && readdirSync(gate).some(name => /^app-[a-f0-9-]{36}$/.test(name));
    report.observed.appLeaseReleasedOnQuit = !stale;
    if (stale) { report.passed = false; report.failures.push('Application update lease remained after normal quit.'); leaseFailed = true; }
    jsonWrite(join(run, 'report.json'), report);
  }
  if (existsSync(join(run, 'report.json'))) copyFileSync(join(run, 'report.json'), resolve(root, 'build/desktop/smoke.json'));
  if (existsSync(join(run, 'window.png'))) copyFileSync(join(run, 'window.png'), resolve(root, 'build/desktop/smoke.png'));
  console.log(`Desktop smoke artifacts: ${run}\nLatest report: build/desktop/smoke.json\nApplication-window screenshot: build/desktop/smoke.png`);
  process.exitCode = code || leaseFailed ? 1 : 0;
}

function runElectronHarness() {
  const { app, session } = require('electron');
  const run = process.env.MINV_DESKTOP_SMOKE_RUN;
  const expected = JSON.parse(readFileSync(join(run, 'fixture.json'), 'utf8'));
  const failures = [], consoleMessages = [], requests = [];
  let phase = 'boot';
  let window;
  let completed = false;
  const observed = {};
  const workerTargets = [];
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  const timer = setTimeout(() => void finish(new Error(`Desktop smoke timed out in ${phase}.`)), 60_000);

  async function finish(error) {
    if (completed) return;
    completed = true; clearTimeout(timer);
    if (error) failures.push(error.message || String(error));
    let screenshot;
    if (window && !window.isDestroyed()) {
      try {
        observed.finalDOM = await window.webContents.executeJavaScript('({title:document.title,text:document.body.innerText.slice(0,14000),editorCount:document.querySelectorAll(".monaco-editor").length})');
        const image = await window.webContents.capturePage();
        const bytes = image.toPNG(); writeFileSync(join(run, 'window.png'), bytes);
        screenshot = { file: 'window.png', ...image.getSize(), sha256: createHash('sha256').update(bytes).digest('hex'), target: 'Minv webContents only' };
      } catch (captureError) { failures.push(`Window capture failed: ${captureError.message}`); }
    }
    const report = {
      passed: failures.length === 0, fixture: expected, electron: process.versions.electron,
      node: process.versions.node, phase, observed, requests, consoleMessages, failures, screenshot,
      evidenceScope: 'Real packaged desktop main/preload/renderer, live synthetic Git workspace and actual local editor. No production test hooks or fixture/mock renderer.',
    };
    jsonWrite(join(run, 'report.json'), report);
    console.log(`Desktop smoke ${report.passed ? 'PASS' : 'FAIL'}: ${failures.join('; ') || 'real renderer, IPC, Git data, source editor and scoped screenshot verified.'}`);
    process.exitCode = report.passed ? 0 : 1;
    app.quit();
  }

  function assert(condition, message) { if (!condition) throw new Error(message); }
  async function waitFor(expression, label, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await window.webContents.executeJavaScript(expression);
      if (value) return value;
      await delay(100);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }

  app.on('browser-window-created', (_event, candidate) => {
    if (window) return;
    window = candidate;
    candidate.webContents.debugger.attach('1.3');
    candidate.webContents.debugger.on('message', (_event, method, params) => {
      if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'worker') workerTargets.push(params.targetInfo.url);
      if (method === 'Target.targetCreated' && params.targetInfo.type === 'worker') workerTargets.push(params.targetInfo.url);
    });
    void candidate.webContents.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    void candidate.webContents.debugger.sendCommand('Target.setDiscoverTargets', { discover: true });
    candidate.setSize(1440, 960); candidate.webContents.setZoomFactor(1);
    candidate.webContents.on('console-message', event => {
      consoleMessages.push({ phase, level: event.level, message: event.message });
      if (event.level === 'error' && phase !== 'negative') failures.push(`Renderer error: ${event.message}`);
    });
    candidate.webContents.on('render-process-gone', (_event, details) => void finish(new Error(`Renderer exited: ${details.reason}`)));
    candidate.webContents.once('did-finish-load', () => void verify().catch(finish));
  });
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onCompleted(details => {
      requests.push({ phase, url: details.url, status: details.statusCode, type: details.resourceType });
      if (!details.url.startsWith('minv-app://app/')) failures.push(`Unexpected completed request: ${details.url}`);
      if (details.statusCode >= 400 && phase !== 'negative') failures.push(`Application asset failed: ${details.url} (${details.statusCode})`);
    });
    session.defaultSession.webRequest.onErrorOccurred(details => {
      requests.push({ phase, url: details.url, error: details.error, type: details.resourceType });
      if (phase !== 'negative' && details.error !== 'net::ERR_ABORTED') failures.push(`Application request failed: ${details.url} (${details.error})`);
    });
  });

  async function verify() {
    phase = 'interface'; console.log('Desktop smoke: real window loaded; waiting for renderer.');
    observed.preferences = window.webContents.getLastWebPreferences();
    const gate = join(process.env.MINV_USER_DATA, 'update-gate');
    observed.appLeaseDuringRun = existsSync(gate) && readdirSync(gate).some(name => {
      if (!/^app-[a-f0-9-]{36}$/.test(name)) return false;
      try { return JSON.parse(readFileSync(join(gate, name), 'utf8')).pid === process.pid; } catch { return false; }
    });
    assert(observed.appLeaseDuringRun, 'Application update lease was not held during the desktop run.');
    assert(observed.preferences.contextIsolation && observed.preferences.sandbox && !observed.preferences.nodeIntegration, 'Unsafe renderer webPreferences.');
    await waitFor('!!window.minvHost && window.minvEditor?.name === "Code-OSS" && /minv/i.test(document.body.innerText) && !document.body.innerText.includes("could not load")', 'real Minv interface');
    observed.security = await window.webContents.executeJavaScript('({require:typeof require,process:typeof process,editor:window.minvEditor.name,origin:location.href})');
    assert(observed.security.require === 'undefined' && observed.security.process === 'undefined', 'Node globals leaked into renderer.');
    phase = 'workspace';
    const snapshot = await waitFor('(async()=>{ const s=await window.minvHost.invoke("workspace.get"); return s?.discovery === "complete" && s.rows.filter(r=>r.available).every(r=>r.branch.state === "observed") ? s : null; })()', 'live repository discovery and branches');
    observed.workspace = snapshot;
    assert(!snapshot.fixture && snapshot.gitAvailable && snapshot.trusted, 'Expected trusted real fixture with actual Git.');
    assert(snapshot.roots.length === 1 && snapshot.roots[0] === expected.root, 'Desktop opened a different workspace.');
    const parent = snapshot.rows.find(row => row.root === expected.root);
    assert(parent?.branch.value?.name === expected.branch, 'Parent branch differs from Git fixture.');
    for (const child of expected.children) {
      const row = snapshot.rows.find(row => row.root === join(expected.root, child.path));
      assert(row?.branch.value?.name === child.branch, `Live child branch incorrect: ${child.path}`);
    }
    assert(snapshot.rows.some(row => row.root === join(expected.root, expected.unavailable) && !row.available), 'Uninitialized submodule disappeared.');
    await window.webContents.executeJavaScript(`window.minvHost.invoke('repo.refresh',{id:${JSON.stringify(parent.id)}})`);
    const currentParent = await waitFor(`(async()=>{const s=await window.minvHost.invoke('workspace.get');const r=s.rows.find(r=>r.id===${JSON.stringify(parent.id)});return r?.status.state==='observed'?r:null;})()`, 'live staged and unstaged Git status');
    observed.parentStatus = currentParent.status;
    assert(currentParent.status.value.changes.some(change => change.path === 'src/app.ts' && change.workingTree === 'M'), 'Live working-tree changes differ from fixture.');
    assert(currentParent.status.value.changes.some(change => change.path === 'docs/notes.md' && change.index === 'M'), 'Live staged changes differ from fixture.');
    console.log('Desktop smoke: live branches and unavailable submodule verified.');
    phase = 'editor';
    await waitFor('document.querySelectorAll(".monaco-editor").length > 0 && document.body.innerText.includes("app.ts")', '--goto opening the real file');
    observed.editor = await window.webContents.executeJavaScript(`(async()=>{
      const api = await import('minv-app://app/editor/editor.js');
      const view = api.editor.getEditors().find(item=>!item.getRawOptions().readOnly && item.getModel()?.uri.toString().includes('app.ts'));
      if (!view) throw new Error('CLI target has no editable source-built editor.');
      const model=view.getModel(); const before=model.getValue();
      view.pushUndoStop(); view.executeEdits('desktop-smoke',[{range:new api.Range(1,1,1,1),text:'// smoke\\n'}]); view.pushUndoStop();
      const edited=model.getValue(); await model.undo(); const undone=model.getValue();
      const container=document.createElement('div'); container.style.cssText='position:fixed;width:600px;height:200px;left:0;top:0'; document.body.append(container);
      const comparison=window.minvEditor.createComparison(container,{uri:'minv-test://before/file.ts',text:'const value = 1;\\n',languageId:'typescript',readOnly:true},{uri:'minv-test://after/file.ts',text:'const value = 2;\\n',languageId:'typescript',readOnly:true},false);
      const diff=api.editor.getDiffEditors().find(item=>item.getContainerDomNode()===container);
      const until=Date.now()+5000; while(!diff?.getLineChanges()?.length && Date.now()<until) await new Promise(done=>setTimeout(done,25));
      const changes=diff?.getLineChanges(); comparison.dispose(); container.remove();
      const banned=view.getSupportedActions().map(action=>action.id).filter(id=>/(^|[.])(chat|debug|terminal|inlineSuggest|suggest|rename|formatDocument)([.]|$)/i.test(id));
      return {before,edited,undone,changes,banned};
    })()`);
    assert(observed.editor.edited.startsWith('// smoke\n') && observed.editor.before === observed.editor.undone, 'Real editor edit/undo failed.');
    assert(observed.editor.changes?.length && observed.editor.banned.length === 0, 'Diff worker or excluded editor action gate failed.');
    const targets = await window.webContents.debugger.sendCommand('Target.getTargets');
    observed.workerTargets = [...new Set([...workerTargets, ...targets.targetInfos.filter(item => item.type === 'worker').map(item => item.url)])];
    const hasWorker = observed.workerTargets.includes('minv-app://app/editor/editor.worker.js') || requests.some(request => request.url === 'minv-app://app/editor/editor.worker.js');
    assert(hasWorker, 'Desktop did not load its local diff worker.');

    phase = 'negative'; console.log('Desktop smoke: testing IPC origin and network rejection.');
    observed.originRejection = await window.webContents.executeJavaScript(`(async()=>{
      const original=location.href; history.replaceState({},'',location.pathname+'?unapproved=1');
      try { await window.minvHost.invoke('workspace.get'); return {rejected:false}; }
      catch(error) { return {rejected:true,code:error.code,message:error.message}; }
      finally {history.replaceState({},'',original);}
    })()`);
    assert(observed.originRejection.rejected, 'IPC accepted an unapproved sender URL.');
    assert(observed.originRejection.code === 'invalid-request', 'HostError.code did not survive the IPC bridge.');
    observed.remoteRejection = await window.webContents.executeJavaScript(`fetch('https://minv-smoke.invalid/probe').then(()=>false,()=>true)`);
    assert(observed.remoteRejection, 'Remote renderer request was permitted.');
    observed.privateAsset = await window.webContents.executeJavaScript(`fetch('minv-app://app/main.cjs').then(r=>r.status)`);
    assert(observed.privateAsset === 404, 'Main-process source is exposed by the UI protocol.');
    phase = 'screenshot';
    observed.rendered = await window.webContents.executeJavaScript(`(async()=>{await document.fonts.ready;await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));return {text:document.body.innerText,stockWorkbench:!!document.querySelector('.monaco-workbench'),appTitle:document.title};})()`);
    assert(!observed.rendered.stockWorkbench && /minv/i.test(observed.rendered.text), 'Stock workbench or missing Minv branding.');
    const graph = JSON.parse(readFileSync(resolve(root, 'build/desktop/bundle-meta.json'), 'utf8'));
    const sources = Object.values(graph).flatMap(bundle => Object.keys(bundle.inputs));
    observed.productionInputs = sources.length;
    assert(!sources.some(file => /(?:^|\/)(?:mock|mocks|fixtures|test|tests)(?:\/|\.)/.test(file)), 'Mock/test inputs reached the real desktop bundle.');
    observed.processes = app.getAppMetrics().map(metric => ({ type: metric.type, serviceName: metric.serviceName, name: metric.name }));
    assert(!observed.processes.some(item=>/extension.?host|agent.?host/i.test(`${item.name} ${item.serviceName}`)), 'Excluded process running.');
    if (process.env.MINV_SMOKE_GALLERY) await gallery();
    await finish();
  }

  // Optional captures of editor-owned widgets, for visual review only.
  async function gallery() {
    const shot = async name => { await delay(300); writeFileSync(join(run, `${name}.png`), (await window.webContents.capturePage()).toPNG()); };
    const view = `(await import('minv-app://app/editor/editor.js')).editor.getEditors().find(item=>!item.getRawOptions().readOnly)`;
    await window.webContents.executeJavaScript(`(async()=>{const v=${view};v.focus();v.setSelection({startLineNumber:1,startColumn:14,endLineNumber:1,endColumn:21});await v.getAction('actions.find').run();})()`);
    await shot('find');
    await window.webContents.executeJavaScript(`(async()=>{const v=${view};v.trigger('gallery','closeFindWidget');await v.getAction('editor.action.startFindReplaceAction').run();})()`);
    await shot('replace');
    await window.webContents.executeJavaScript(`(async()=>{const v=${view};v.trigger('gallery','closeFindWidget');[...document.querySelectorAll('button')].find(b=>b.textContent==='Line').click();})()`);
    await shot('goto-line');
    await window.webContents.executeJavaScript(`(async()=>{document.querySelector('.dialog')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));const v=${view};const t=v.getDomNode().querySelector('.view-lines');const r=t.getBoundingClientRect();t.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+120,clientY:r.top+30,button:2}));})()`);
    await shot('context-menu');
  }

  // Synchronous require registers schemes before Electron's ready event.
  require(join(appDirectory, 'main.cjs'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.MINV_DESKTOP_SMOKE_CHILD === '1') runElectronHarness();
  else launchHarness().catch(error => { console.error(error.message); process.exitCode = 1; });
}
