/**
 * Preview fixture host. Loaded only when no real `window.minvHost` exists.
 * The `minv` repository serves the real Minv source over localhost; the rest of the
 * catalog is a seeded synthetic workspace shaped like the PRD's R64 fixture.
 * Timings are simulated so every freshness state is visible; nothing here is a measurement.
 */
import type { Branch, BranchTarget, Change, DiffSide, DirectoryEntry, FileContent, HistoryEntry, HostEvents, HostMethods, MinvHost, Observation, Preferences, RepositoryRow, SearchMatch, StashEntry, TextFile, Upstream, WorkspaceSnapshot, WriteAction, WriteBasis, WriteToken } from '../contract.js';
import { MINV_TREE } from './manifest.generated.js';

const ROOT = '/home/kaf/code/tyranny';
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Spec { path: string; branch: Branch; cached?: Branch; available?: boolean; error?: string; late?: boolean; upstream?: Upstream; statusError?: string; degraded?: boolean }

const libs = ['nbt', 'codecs', 'registry', 'events', 'config-spec', 'math', 'render-util', 'text', 'i18n', 'network', 'scheduler', 'storage', 'test-harness', 'datagen', 'resource-pack', 'gametest', 'ui-kit', 'color', 'logging', 'commands', 'permissions', 'mixin-extras', 'compat-iris', 'compat-jei', 'compat-emi', 'compat-modmenu', 'serialization', 'benchmarks'];
const branches = ['main', 'main', 'main', 'dev', '1.21.x', 'release/2.4', 'feature/lazy-registry', 'fix/codec-nulls', 'main'];
const b = (name: string): Branch => ({ kind: 'branch', name });

function specs(): Spec[] {
  const list: Spec[] = [
    { path: '', branch: b('main'), upstream: { name: 'origin/main', ahead: 0, behind: 0 } },
    { path: 'minv', branch: b('feature/desktop-shell'), upstream: { name: 'origin/feature/desktop-shell', ahead: 3, behind: 0 } },
    { path: 'amber', branch: b('1.21.x'), upstream: { name: 'origin/1.21.x', ahead: 0, behind: 2 } },
    { path: 'amber/api', branch: b('1.21.x') },
    { path: 'amber/fabric', branch: b('1.21.x'), cached: b('dev') },
    { path: 'amber/neoforge', branch: b('1.21.x') },
    { path: 'amber/vendor/lwjgl', branch: { kind: 'detached', oid: '9c41e07b2d5f8a1e66c0d3b7a52f19e0c8d4b6a1' } },
    { path: 'bonded', branch: b('main'), upstream: { name: 'origin/main', ahead: 1, behind: 0 } },
    { path: 'bonded/common', branch: b('main') },
    { path: 'bonded/fabric', branch: b('feature/link-render') },
    { path: 'bonded/neoforge', branch: b('main') },
    { path: 'bonded/sandbox', branch: { kind: 'unborn', name: 'main' } },
    { path: 'konfig', branch: b('main') },
    { path: 'konfig/core', branch: b('main') },
    { path: 'konfig/gui', branch: b('dev') },
    { path: 'konfig/docs', branch: b('main'), available: false, error: 'Submodule is not initialized. Minv never initializes submodules on open.' },
    { path: 'konfig/examples', branch: b('main') },
    { path: 'liteminer', branch: b('main') },
    { path: 'liteminer/common', branch: b('main') },
    { path: 'liteminer/fabric', branch: b('main') },
    { path: 'liteminer/neoforge', branch: b('release/2.4') },
    { path: 'liteminer/forge-legacy', branch: { kind: 'branch', name: 'port/1.20.1', operation: 'rebase' } },
    { path: 'infra', branch: b('main') },
    { path: 'infra/ci', branch: b('main') },
    { path: 'infra/deploy', branch: b('main'), statusError: 'fatal: index file smaller than expected' },
    { path: 'site', branch: b('main') },
    { path: 'site/content', branch: b('drafts/october'), degraded: true },
    { path: 'site/theme', branch: b('main') },
    { path: 'tooling', branch: b('main') },
    { path: 'tooling/gradle-plugins', branch: b('main') },
    { path: 'tooling/mappings', branch: b('1.21.x') },
    { path: 'tooling/release', branch: b('main') },
    { path: 'tooling/sbom', branch: b('main'), late: true },
  ];
  for (const name of libs) list.push({ path: `libs/${name}`, branch: b(pick(branches)) });
  list.push({ path: 'libs/compat-sodium', branch: b('main'), late: true });
  return list;
}

const parentPath = (path: string, all: Set<string>): string | undefined => {
  if (!path) return undefined;
  const parts = path.split('/');
  for (let i = parts.length - 1; i > 0; i--) { const p = parts.slice(0, i).join('/'); if (all.has(p)) return p; }
  return '';
};
const idOf = (path: string) => `repo:${path || '.'}`;

// ── Changes ───────────────────────────────────────────────────────────────────

interface FileState { staged: string[]; unstaged: string[]; header?: string[]; untracked?: string; conflict?: boolean }

function hunk(oldStart: number, newStart: number, section: string, lines: string[]): string {
  const oldCount = lines.filter(l => l[0] !== '+').length;
  const newCount = lines.filter(l => l[0] !== '-').length;
  return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@ ${section}`, ...lines].join('\n');
}

function minvChanges(): Record<string, FileState> {
  return {
    'src/core/status.ts': {
      staged: [],
      unstaged: [
        hunk(14, 14, 'function run(repo: Repository, git: GitRunner, args: readonly string[], options?: GitOptions): Promise<string> {', [
          ' /** Porcelain v2 -z paths are raw, including spaces, tabs and newlines. */',
          ' export function parseStatus(output: string): RepositoryStatus {',
          "-  if (output && !output.endsWith('\\0')) throw new Error('Incomplete Git status output');",
          "+  if (output && !output.endsWith('\\0')) throw new Error('Git status ended before its last record');",
          "   if (output.includes('\\uFFFD')) throw new Error('Git returned a filename that cannot be safely represented as UTF-8');",
          "   const records = output.split('\\0');",
          '   const changes: Change[] = [];',
        ]),
        hunk(52, 52, 'export async function readStatus(repo: Repository, git: GitRunner): Promise<RepositoryStatus> {', [
          ' export async function readStatus(repo: Repository, git: GitRunner): Promise<RepositoryStatus> {',
          '   // Child working-tree dirtiness belongs to the child\'s independent status row.',
          '   // Native recursive status could execute helpers from unaudited child config.',
          "-  return parseStatus(await run(repo, git, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=dirty'], { lane: 'foreground' }));",
          "+  const args = ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=dirty'];",
          "+  return parseStatus(await run(repo, git, args, { lane: 'foreground' }));",
          ' }',
        ]),
      ],
    },
    'src/controller.ts': {
      staged: [hunk(118, 118, 'invalidate(id: string): void {', [
        '     this.emit(\'change\');',
        '     // Throttle, rather than indefinitely debounce, sustained external writes.',
        '     if (this.timers.has(id)) return;',
        '-    this.timers.set(id, setTimeout(() => {',
        '+    const delay = id === this.selectedId ? 60 : 150;',
        '+    this.timers.set(id, setTimeout(() => {',
        '       this.timers.delete(id);',
      ])],
      unstaged: [hunk(124, 125, 'invalidate(id: string): void {', [
        '       void this.observe(row, \'branch\');',
        '       if (id === this.selectedId) void this.observe(row, \'status\');',
        '-    }, 150));',
        '+    }, delay));',
        '   }',
      ])],
    },
    'docs/DESIGN.md': { staged: [hunk(0, 1, '', ['+# Minv design', '+', '+The desk, the index, the folio and the sheet.', '+', '+Minv draws its own window around the Code-OSS editor.'])], unstaged: [], header: ['diff --git a/docs/DESIGN.md b/docs/DESIGN.md', 'new file mode 100644', 'index 0000000..3b18e51', '--- /dev/null', '+++ b/docs/DESIGN.md'] },
    'desktop/renderer/src/contract.ts': { staged: [], unstaged: [], untracked: 'desktop/renderer/src/contract.ts' },
    'desktop/renderer/src/diff.ts': { staged: [], unstaged: [], untracked: 'desktop/renderer/src/diff.ts' },
    'themes/minv-paper-color-theme.json': {
      staged: [], unstaged: [hunk(3, 3, '', [
        '   "type": "light",',
        '   "colors": {',
        '-    "foreground": "#24221e",',
        '+    "foreground": "#1c1a16",',
        '     "descriptionForeground": "#5f5a50",',
      ])],
    },
  };
}

function syntheticChanges(path: string): Record<string, FileState> {
  const files: Record<string, FileState> = {};
  const n = path === '' ? 0 : Math.floor(random() * random() * 7);
  const pool = ['src/main/java/Registry.java', 'src/main/java/Codec.java', 'build.gradle.kts', 'README.md', 'src/main/resources/fabric.mod.json', 'gradle.properties', 'src/test/java/RegistryTest.java'];
  for (let i = 0; i < n; i++) {
    const file = pick(pool);
    const lines = [' plugins {', `-    id("fabric-loom") version "1.${7 + i}.1"`, `+    id("fabric-loom") version "1.${8 + i}.0"`, ' }'];
    if (random() < 0.3) files[file] = { staged: [], unstaged: [], untracked: file };
    else if (random() < 0.4) files[file] = { staged: [hunk(3, 3, 'plugins', lines)], unstaged: [] };
    else files[file] = { staged: [], unstaged: [hunk(3, 3, 'plugins', lines)] };
  }
  return files;
}

function toChanges(files: Record<string, FileState>, pointers: Change[] = []): Change[] {
  const changes: Change[] = [...pointers];
  for (const [path, state] of Object.entries(files)) {
    if (state.untracked) { changes.push({ path, index: '?', workingTree: '?' }); continue; }
    if (state.conflict) { changes.push({ path, index: 'U', workingTree: 'U' }); continue; }
    const added = state.header?.some(h => h.startsWith('new file'));
    const index = state.staged.length ? (added ? 'A' : 'M') : '.';
    const workingTree = state.unstaged.length ? 'M' : '.';
    if (index !== '.' || workingTree !== '.') changes.push({ path, index, workingTree });
  }
  return changes;
}

// ── Host ──────────────────────────────────────────────────────────────────────

interface Repo { row: RepositoryRow; spec: Spec; files: Record<string, FileState>; pointers: Change[]; history: HistoryEntry[]; edits: Map<string, { text: string; version: number }> }

export function createFixtureHost(): MinvHost {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emit = <E extends keyof HostEvents>(event: E, payload: HostEvents[E]) => { for (const l of listeners.get(event) ?? []) l(payload); };
  let generation = 1;
  const all = specs();
  const paths = new Set(all.map(s => s.path));
  const repos = new Map<string, Repo>();
  let discovery: WorkspaceSnapshot['discovery'] = 'cached';
  let prefs: Preferences = { appearance: 'system', motion: 'system', density: 'compact', editorFontSize: 13, tabSize: 2, wordWrap: false, renderWhitespace: false, gitPath: 'git', terminal: '', browseExclude: ['**/build/**'], searchExclude: [] };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('minv.preview.prefs') ?? '{}')); } catch { /* preview only */ }

  const now = Date.now();
  for (const spec of all) {
    const parent = parentPath(spec.path, paths);
    const name = spec.path ? spec.path.split('/').at(-1)! : 'tyranny';
    const files = spec.path === 'minv' ? minvChanges() : syntheticChanges(spec.path);
    if (spec.path === 'liteminer/forge-legacy') files['src/main/java/dev/kaf/liteminer/MinerConfig.java'] = { staged: [], unstaged: [], conflict: true };
    const pointers: Change[] = spec.path === '' ? [
      { path: 'minv', index: '.', workingTree: 'M', submodule: 'SC..' },
      { path: 'amber', index: '.', workingTree: 'M', submodule: 'S.M.' },
      { path: 'bonded', index: 'M', workingTree: '.', submodule: 'SC..' },
    ] : [];
    const row: RepositoryRow = {
      id: idOf(spec.path), root: spec.path ? `${ROOT}/${spec.path}` : ROOT, name, relativePath: spec.path,
      ...(parent !== undefined ? { parentId: idOf(parent) } : {}),
      available: spec.available !== false, ...(spec.error ? { error: spec.error } : {}),
      branch: { state: 'cached', value: spec.cached ?? spec.branch, observedAt: now - 86_400_000 * 0.6, generation: generation++ },
      status: { state: 'unknown', generation: generation++ },
      ...(spec.upstream ? { upstream: { state: 'cached', value: spec.upstream, generation: generation++ } as Observation<Upstream> } : {}),
      monitoring: 'live',
    };
    if (!row.available) row.branch = { state: 'error', error: spec.error, generation: generation++ };
    const subjects = spec.path === 'minv'
      ? ['Separate branch metadata from status scans', 'Keep row positions stable during discovery', 'Add write preconditions for staging and commit', 'Reject results from superseded refreshes', 'Prepare Code-OSS source with contribution allowlist', 'Add R64 fixture generator', 'Initial catalog and branch reader']
      : ['Update mappings', 'Fix codec null handling', 'Bump loader version', 'Add gametest coverage', 'Tidy build script', 'Port registry to 1.21', 'Initial commit'];
    const history: HistoryEntry[] = spec.branch.kind === 'unborn' ? [] : Array.from({ length: 140 }, (_, i) => ({
      oid: hex(40), subject: i < subjects.length ? subjects[i]! : `${pick(subjects)} (${140 - i})`, author: pick(['Kaf', 'Kaf', 'Kaf', 'Mira Sato', 'Jonas Weber']), date: new Date(now - (i * 7.3 + random() * 5) * 3_600_000).toISOString(),
    }));
    repos.set(row.id, { row, spec, files, pointers, history, edits: new Map() });
  }

  const snapshotRow = (repo: Repo): RepositoryRow => structuredClone(repo.row);
  const publish = (...list: Repo[]) => emit('rows', { rows: list.map(snapshotRow), discovery });
  const repo = (id: string) => { const r = repos.get(id); if (!r) throw { code: 'unavailable', message: 'This repository is no longer in the workspace.' }; return r; };

  const visible = () => [...repos.values()].filter(r => !r.spec.late || discovery !== 'cached');

  const observeBranch = async (r: Repo, delay: number) => {
    if (!r.row.available) return;
    r.row.branch = { ...r.row.branch, state: 'refreshing', generation: generation++ };
    publish(r);
    await wait(delay);
    r.row.branch = { state: 'observed', value: r.spec.branch, observedAt: Date.now(), generation: generation++ };
    if (r.row.upstream) r.row.upstream = { state: 'observed', value: r.spec.upstream, observedAt: Date.now(), generation: generation++ };
    publish(r);
  };
  const observeStatus = async (r: Repo, delay: number) => {
    if (!r.row.available) return;
    r.row.status = { ...r.row.status, state: 'refreshing', generation: generation++ };
    publish(r);
    await wait(delay);
    if (r.spec.statusError) r.row.status = { state: 'error', error: r.spec.statusError, generation: generation++ };
    else r.row.status = { state: 'observed', value: { changes: toChanges(r.files, r.pointers), complete: true }, observedAt: Date.now(), generation: generation++ };
    publish(r);
  };

  let selected = idOf('minv');
  const statusQueue: Repo[] = [];
  const pumpStatus = async () => {
    for (let r = statusQueue.shift(); r; r = statusQueue.shift()) {
      if (r.row.status.state === 'observed' || r.row.status.state === 'error') continue;
      await observeStatus(r, 60 + random() * 140);
    }
  };

  // Startup choreography: selection first, bounded parallel branch reads, then background status.
  void (async () => {
    await wait(30);
    discovery = 'discovering';
    const first = repos.get(selected)!;
    void observeBranch(first, 45);
    void observeStatus(first, 260);
    const queue = visible().filter(r => r !== first);
    await Promise.all(Array.from({ length: 4 }, async () => { for (let r = queue.shift(); r; r = queue.shift()) await observeBranch(r, 25 + random() * 70); }));
    for (const r of repos.values()) if (r.spec.late && r.row.branch.state === 'cached') {
      r.row.branch = { state: 'unknown', generation: generation++ };
      publish(r);
      void observeBranch(r, 120);
    }
    discovery = 'complete';
    publish(...[...repos.values()].filter(r => r.spec.late));
    statusQueue.push(...[...repos.values()].filter(r => r !== first));
    await Promise.all(Array.from({ length: 3 }, pumpStatus));
    await wait(2400);
    const degraded = [...repos.values()].find(r => r.spec.degraded)!;
    degraded.row.monitoring = 'degraded';
    degraded.row.monitoringError = 'The file watcher hit its limit for this checkout. Changes are rechecked on focus and on request.';
    degraded.row.status = { ...degraded.row.status, state: 'stale', generation: generation++ };
    publish(degraded);
  })();

  const changeText = (r: Repo, path: string): FileState => {
    const state = r.files[path];
    if (!state) throw { code: 'git', message: `${path} has no changes in this review` };
    return state;
  };
  const header = (path: string, state: FileState) => state.header ?? [`diff --git a/${path} b/${path}`, `index ${hex(7)}..${hex(7)} 100644`, `--- a/${path}`, `+++ b/${path}`];
  const refreshStatus = (r: Repo) => {
    r.row.status = { state: 'observed', value: { changes: toChanges(r.files, r.pointers), complete: true }, observedAt: Date.now(), generation: generation++ };
    publish(r);
  };
  // Tickets and reviews behave like the real host: bound to action, paths and the basis the user saw.
  let serialId = 0;
  const reviews = new Map<string, { repo: Repo; path: string; side: DiffSide; generation: number; hunks: Map<string, string> }>();
  const tickets = new Map<string, { repo: Repo; action: WriteAction; paths?: string[] }>();
  const issue = (repo: Repo, action: WriteAction, basis: WriteBasis, paths?: string[]): WriteToken => {
    if (!trusted) throw { code: 'untrusted', message: 'Restricted mode: trust this workspace to make changes.' };
    if (basis.kind === 'status' && basis.generation !== repo.row.status.generation) throw { code: 'stale-review', message: 'The change list moved on since you looked at it. Review the current state and try again.' };
    if (basis.kind === 'review') { const review = reviews.get(basis.reviewId); if (!review || review.generation !== repo.row.status.generation) throw { code: 'stale-review', message: 'That diff is no longer current. It has been read again; review it before acting.' }; }
    const token = `t${++serialId}`;
    tickets.set(token, { repo, action, paths });
    return { token, action, ...(paths ? { paths } : {}), branch: repo.spec.branch.name };
  };
  const redeem = (repo: Repo, token: string, action: WriteAction, paths?: string[]) => {
    const t = tickets.get(token); tickets.delete(token);
    if (!t || t.repo !== repo || t.action !== action || (t.paths ?? []).join('\0') !== (paths ?? t.paths ?? []).join('\0')) throw { code: 'stale-review', message: 'This action was not the one that was reviewed.' };
  };
  let trusted = true;
  const network = new Map<string, () => void>();
  const remoteOp = (r: Repo, ms: number) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { network.delete(r.row.id); resolve(); }, ms);
    network.set(r.row.id, () => { clearTimeout(timer); network.delete(r.row.id); reject({ code: 'cancelled', message: 'Stopped. Nothing was changed.' }); });
  });
  const stashes = new Map<string, StashEntry[]>();

  const minvUrl = (path: string) => new URL(`../../${path}`, location.href).href;
  const readMinv = async (path: string): Promise<string | undefined> => {
    const response = await fetch(minvUrl(path));
    return response.ok ? response.text() : undefined;
  };
  const synthetic = (r: Repo, path: string) => path.endsWith('.md')
    ? `# ${r.row.name}\n\nPart of the tyranny workspace.\n\n## Building\n\n    ./gradlew build\n`
    : path.endsWith('.kts') ? `plugins {\n    id("fabric-loom") version "1.8.0"\n}\n\nversion = "2.4.1"\ngroup = "dev.kaf.${r.row.name.replace(/\W/g, '')}"\n`
    : `package dev.kaf.${r.row.name.replace(/\W/g, '')};\n\npublic final class ${path.split('/').at(-1)!.replace(/\.\w+$/, '')} {\n    private ${path.split('/').at(-1)!.replace(/\.\w+$/, '')}() {}\n}\n`;
  const syntheticTree: Record<string, DirectoryEntry[]> = {
    '': [{ name: 'src', kind: 'directory' }, { name: 'build.gradle.kts', kind: 'file', size: 812 }, { name: 'gradle.properties', kind: 'file', size: 140 }, { name: 'README.md', kind: 'file', size: 1204 }],
    'src': [{ name: 'main', kind: 'directory' }, { name: 'test', kind: 'directory' }],
    'src/main': [{ name: 'java', kind: 'directory' }, { name: 'resources', kind: 'directory' }],
    'src/main/java': [{ name: 'Codec.java', kind: 'file', size: 2210 }, { name: 'Registry.java', kind: 'file', size: 4890 }],
    'src/main/resources': [{ name: 'fabric.mod.json', kind: 'file', size: 610 }],
    'src/test': [{ name: 'java', kind: 'directory' }],
    'src/test/java': [{ name: 'RegistryTest.java', kind: 'file', size: 1320 }],
  };
  const allPaths = (tree: Record<string, DirectoryEntry[]>) => Object.entries(tree).flatMap(([dir, entries]) => entries.filter(e => e.kind === 'file').map(e => dir ? `${dir}/${e.name}` : e.name));
  const isMinv = (r: Repo) => r.spec.path === 'minv';

  const text = (body: string): TextFile => ({ kind: 'text', text: body, version: `v${body.length}`, encoding: 'utf8', bom: false, eol: body.includes('\r\n') ? 'crlf' : 'lf', size: body.length, large: body.length > 2_000_000 });
  const contentOf = async (r: Repo, path: string) => r.edits.get(path)?.text ?? (isMinv(r) ? await readMinv(path) : synthetic(r, path));
  const snapshot = (): WorkspaceSnapshot => ({ contract: 4, id: 'tyranny', name: 'tyranny', roots: [ROOT], discovery, trusted, gitAvailable: true, rows: visible().map(snapshotRow), selectedId: selected, platform: 'linux', fixture: 'Preview fixture' });
  let open = true;
  const branchesOf = (r: Repo): BranchTarget[] => {
    const current = r.spec.branch.kind === 'branch' ? r.spec.branch.name : undefined;
    const names = [...new Set([current, 'main', 'dev', '1.21.x', 'feature/lazy-registry'].filter((n): n is string => !!n))];
    return [...names.map(name => ({ name, ref: `refs/heads/${name}`, oid: hex(40), remote: false, current: name === current })), ...names.slice(0, 3).map(name => ({ name: `origin/${name}`, ref: `refs/remotes/origin/${name}`, oid: hex(40), remote: true, current: false }))];
  };

  const methods: { [M in keyof HostMethods]: (params: HostMethods[M][0]) => Promise<HostMethods[M][1]> } = {
    'workspace.get': async () => open ? snapshot() : null,
    'workspace.open': async () => { open = true; const w = snapshot(); emit('workspace', w); return w; },
    'workspace.recent': async () => [{ id: 'tyranny', name: 'tyranny', roots: [ROOT], openedAt: Date.now() - 3_600_000, available: true }, { id: 'bonded', name: 'bonded-standalone', roots: ['/home/kaf/code/bonded'], openedAt: Date.now() - 86_400_000 * 3, available: true }],
    'workspace.close': async () => { open = false; },
    'workspace.closeReady': async () => {},
    'session.get': async () => { try { return JSON.parse(localStorage.getItem('minv.preview.session') ?? 'null'); } catch { return null; } },
    'session.save': async (session) => { localStorage.setItem('minv.preview.session', JSON.stringify(session)); },
    'workspace.trust': async ({ trusted: t }) => { trusted = t; return snapshot(); },
    'repo.select': async ({ id }) => {
      if (selected === id) return;
      selected = id;
      const r = repo(id);
      if (r.row.status.state === 'unknown') void observeStatus(r, 140);
    },
    'repo.refresh': async ({ id, all: every }) => {
      const list = every ? [...repos.values()] : id ? [repo(id)] : [];
      await Promise.all(list.map(r => Promise.all([observeBranch(r, 40 + random() * 60), (async () => { if (r.spec.degraded) { r.row.monitoring = 'live'; delete r.row.monitoringError; } await observeStatus(r, 120 + random() * 200); })()])));
    },
    'fs.list': async ({ repositoryId, dir }) => {
      const r = repo(repositoryId);
      await wait(15);
      if (isMinv(r)) return { entries: MINV_TREE[dir] ?? [], complete: true };
      if (r.spec.path === '') return { entries: [...visible().filter(x => x.row.parentId === r.row.id).map(x => ({ name: x.spec.path, kind: 'submodule' as const })), { name: '.gitmodules', kind: 'file', size: 3120 }, { name: 'README.md', kind: 'file', size: 2048 }], complete: true };
      return { entries: syntheticTree[dir] ?? [], complete: true };
    },
    'fs.read': async ({ repositoryId, path }): Promise<FileContent> => {
      const r = repo(repositoryId);
      if (/\.(png|woff2|ico)$/.test(path)) return { kind: 'binary', size: 48_213, version: 'v0' };
      const body = await contentOf(r, path);
      if (body === undefined) throw { code: 'unavailable', message: `${path} could not be read` };
      return text(body);
    },
    'fs.readRef': async ({ ref }) => { const [id, path] = ref.split('\0') as [string, string]; return text((await contentOf(repo(id), path)) ?? ''); },
    'fs.write': async ({ repositoryId, path, text: body, baseVersion }) => {
      const r = repo(repositoryId);
      const current = await contentOf(r, path);
      if (current !== undefined && `v${current.length}` !== baseVersion) throw { code: 'conflict', message: `${path} changed on disk since you opened it.` };
      r.edits.set(path, { text: body, version: 0 });
      return { version: `v${body.length}` };
    },
    'fs.findPaths': async ({ query, scope, limit }) => {
      const q = query.toLowerCase();
      const out: { repositoryId: string; path: string; score: number }[] = [];
      for (const r of visible()) {
        if ((scope.length && !scope.includes(r.row.id)) || !r.row.available) continue;
        for (const path of isMinv(r) ? allPaths(MINV_TREE) : allPaths(syntheticTree)) {
          const hay = path.toLowerCase();
          let i = 0;
          for (const c of hay) if (c === q[i]) i++;
          if (i === q.length) out.push({ repositoryId: r.row.id, path, score: (hay.includes(q) ? 100 : 0) - path.length / 100 });
        }
      }
      return { matches: out.sort((a, b) => b.score - a.score).slice(0, limit).map(({ repositoryId, path }) => ({ repositoryId, path })), complete: true };
    },
    'fs.createFile': async ({ repositoryId, path }) => { const r = repo(repositoryId); if (r.edits.has(path)) throw { code: 'conflict', message: `${path} already exists.` }; r.edits.set(path, { text: '', version: 0 }); r.files[path] = { staged: [], unstaged: [], untracked: path }; refreshStatus(r); },
    'fs.createDirectory': async () => {},
    'fs.prepareTransfer': async ({ repositoryId, targetRepositoryId, mode }) => ({ token: `x${++serialId}:${mode}`, sourceScope: repo(repositoryId).row.name, targetScope: repo(targetRepositoryId).row.name, requiresConfirmation: repositoryId !== targetRepositoryId }),
    'fs.transfer': async () => {},
    'fs.delete': async () => ({ backupId: `b${++serialId}` }),
    'fs.backups': async () => [{ id: 'b-demo', repositoryId: idOf('minv'), path: 'src/core/catalog.ts', createdAt: Date.now() - 7_200_000 }],
    'fs.restore': async () => {},
    'fs.removeBackup': async () => {},
    'fs.recover': async () => {},
    'fs.recoveries': async () => [],
    'fs.readRecovery': async () => { throw { code: 'unavailable', message: 'No draft.' }; },
    'fs.removeRecovery': async () => {},

    'git.diff': async ({ repositoryId, path, side }) => {
      const r = repo(repositoryId);
      await wait(30);
      const reviewId = `r${++serialId}`;
      reviews.set(reviewId, { repo: r, path, side, generation: r.row.status.generation, hunks: new Map() });
      const pointer = r.pointers.find(p => p.path === path);
      if (pointer) return { reviewId, kind: 'gitlink', patch: `diff --git a/${path} b/${path}\nindex 4be1c0d..9c41e07 160000\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-Subproject commit 4be1c0d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6\n+Subproject commit 9c41e07b2d5f8a1e66c0d3b7a52f19e0c8d4b6a1\n` };
      const state = changeText(r, path);
      if (state.conflict) return { reviewId, kind: 'conflict', patch: [`diff --cc ${path}`, `--- a/${path}`, `+++ b/${path}`].join('\n') + '\n' };
      const hunks = side === 'staged' ? state.staged : state.unstaged;
      return { reviewId, kind: hunks.length ? 'text' : 'empty', patch: hunks.length ? [...header(path, state), ...hunks].join('\n') + '\n' : '' };
    },
    'git.hunks': async ({ repositoryId, path, side }) => {
      const r = repo(repositoryId);
      await wait(30);
      if (r.pointers.some(p => p.path === path)) throw { code: 'git', message: 'Submodule pointers use whole-file actions.' };
      const state = changeText(r, path);
      if (state.conflict) throw { code: 'git', message: 'Resolve conflicts first.' };
      let list = side === 'staged' ? state.staged : state.unstaged;
      if (state.untracked && side === 'unstaged') {
        const body = (await contentOf(r, path)) ?? '';
        const lines = body.replace(/\n$/, '').split('\n');
        list = [`@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}`];
      }
      if (!list.length) throw { code: 'git', message: 'No changes on this side.' };
      const reviewId = `r${++serialId}`;
      const hunks = list.map((patch, i) => ({ id: `${i}:${patch.length}`, header: patch.split('\n', 1)[0]!, patch: `${patch}\n` }));
      reviews.set(reviewId, { repo: r, path, side, generation: r.row.status.generation, hunks: new Map(hunks.map((x, i) => [x.id, list[i]!])) });
      return { reviewId, path, side, hunks };
    },
    'git.applyHunks': async ({ repositoryId, reviewId, ids }) => {
      const r = repo(repositoryId);
      const review = reviews.get(reviewId); reviews.delete(reviewId);
      if (!trusted) throw { code: 'untrusted', message: 'Restricted mode: trust this workspace to stage.' };
      if (!review || review.repo !== r || review.generation !== r.row.status.generation) throw { code: 'stale-review', message: 'That diff changed since you reviewed it. It has been read again.' };
      const s = changeText(r, review.path);
      if (s.untracked) { await methods['git.stage']({ repositoryId, paths: [review.path], token: issue(r, 'stage', { kind: 'none' }, [review.path]).token }); return; }
      const from = review.side === 'staged' ? s.staged : s.unstaged, to = review.side === 'staged' ? s.unstaged : s.staged;
      for (const id of ids) { const body = review.hunks.get(id); const i = body === undefined ? -1 : from.indexOf(body); if (i >= 0) to.push(...from.splice(i, 1)); }
      refreshStatus(r);
    },
    'git.prepare': async ({ repositoryId, action, paths, basis }) => issue(repo(repositoryId), action, basis, paths),
    'git.stage': async ({ repositoryId, paths: list, token: t }) => {
      const r = repo(repositoryId); redeem(r, t, 'stage', list);
      for (const path of list) {
        const pointer = r.pointers.find(p => p.path === path);
        if (pointer) { pointer.index = 'M'; pointer.workingTree = '.'; continue; }
        const s = changeText(r, path);
        if (s.untracked) { const body = (await contentOf(r, path)) ?? ''; const lines = body.replace(/\n$/, '').split('\n'); s.header = [`diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..3b18e51', '--- /dev/null', `+++ b/${path}`]; s.staged = [`@@ -0,0 +1,${lines.length} @@\n` + lines.map(l => `+${l}`).join('\n')]; delete s.untracked; }
        else if (s.conflict) { delete s.conflict; s.staged = [hunk(41, 41, 'public final class MinerConfig {', ['   public static int maxBlocks() {', '-    return config.getInt("veinLimit", 64);', '+    return config.getInt("maxBlocks", 128);', '   }'])]; }
        else { s.staged.push(...s.unstaged); s.unstaged = []; }
      }
      refreshStatus(r);
    },
    'git.unstage': async ({ repositoryId, paths: list, token: t }) => {
      const r = repo(repositoryId); redeem(r, t, 'unstage', list);
      for (const path of list) {
        const pointer = r.pointers.find(p => p.path === path);
        if (pointer) { pointer.index = '.'; pointer.workingTree = 'M'; continue; }
        const s = changeText(r, path);
        if (s.header?.some(x => x.startsWith('new file'))) { s.untracked = path; s.staged = []; delete s.header; continue; }
        s.unstaged.unshift(...s.staged); s.staged = [];
      }
      refreshStatus(r);
    },
    'git.discard': async ({ repositoryId, paths: list, token: t }) => {
      const r = repo(repositoryId); redeem(r, t, 'discard', list);
      for (const path of list) { const s = changeText(r, path); if (s.untracked || !s.staged.length) delete r.files[path]; else s.unstaged = []; }
      refreshStatus(r);
      return { backupIds: list.map(() => `b${++serialId}`) };
    },
    'git.commit': async ({ repositoryId, message, token: t }) => {
      const r = repo(repositoryId); redeem(r, t, 'commit');
      await wait(180);
      const oid = hex(40);
      for (const s of Object.values(r.files)) { s.staged = []; delete s.header; }
      for (const [path, s] of Object.entries(r.files)) if (!s.unstaged.length && !s.untracked && !s.conflict) delete r.files[path];
      r.history.unshift({ oid, subject: message.split('\n')[0]!, author: 'Kaf', date: new Date().toISOString() });
      if (r.spec.upstream) r.spec.upstream = { ...r.spec.upstream, ahead: r.spec.upstream.ahead + 1 };
      if (r.row.upstream && r.spec.upstream) r.row.upstream = { state: 'observed', value: r.spec.upstream, observedAt: Date.now(), generation: generation++ };
      refreshStatus(r);
      return { oid };
    },
    'git.history': async ({ repositoryId, offset }) => { await wait(40); const all = repo(repositoryId).history; return { entries: all.slice(offset, offset + 50), ...(offset + 50 < all.length ? { nextOffset: offset + 50 } : {}) }; },
    'git.show': async ({ repositoryId, oid }) => {
      const entry = repo(repositoryId).history.find(x => x.oid === oid);
      if (!entry) throw { code: 'unavailable', message: 'Commit is not available locally.' };
      return { ...entry, message: `${entry.subject}\n\nRepository rows now keep their first-seen position while\nbranch and status observations arrive independently.`, parents: [hex(40)], changes: [{ status: 'M', path: 'src/core/catalog.ts' }] };
    },
    'git.revisionDiff': async () => ['diff --git a/src/core/catalog.ts b/src/core/catalog.ts', 'index 1f2e3d4..5a6b7c8 100644', '--- a/src/core/catalog.ts', '+++ b/src/core/catalog.ts', hunk(6, 6, '', [' const MAX_REPOSITORIES = 4096;', '-const MAX_DEPTH = 16;', '+const MAX_DEPTH = 32;', ' const MAX_CACHE_BYTES = 8 * 1024 * 1024;'])].join('\n') + '\n',
    'git.operation': async ({ repositoryId }) => { const r = repo(repositoryId); return { kinds: r.spec.branch.operation ? ['rebase'] : [], conflicts: [], mergeHeads: [], indexLocked: false }; },
    'git.branches': async ({ repositoryId }) => branchesOf(repo(repositoryId)),
    'git.createBranch': async ({ repositoryId, name, switchTo, token: t }) => { const r = repo(repositoryId); redeem(r, t, 'createBranch'); if (switchTo) { r.spec.branch = { kind: 'branch', name }; await observeBranch(r, 60); } },
    'git.switchBranch': async ({ repositoryId, target, token: t }) => { const r = repo(repositoryId); redeem(r, t, 'switchBranch'); r.spec.branch = { kind: 'branch', name: target.name }; await observeBranch(r, 80); },
    'git.stashes': async ({ repositoryId }) => stashes.get(repositoryId) ?? (repositoryId === idOf('minv') ? [{ selector: 'stash@{0}', oid: hex(40), subject: 'On feature/desktop-shell: sidebar experiment', date: new Date(Date.now() - 172_800_000).toISOString() }] : []),
    'git.stash': async ({ repositoryId, message, paths: list, token: t }) => {
      const r = repo(repositoryId); redeem(r, t, 'stash', list);
      for (const path of list) delete r.files[path];
      const prev = await methods['git.stashes']({ repositoryId });
      stashes.set(repositoryId, [{ selector: 'stash@{0}', oid: hex(40), subject: `On ${r.spec.branch.name}: ${message || 'stashed changes'}`, date: new Date().toISOString() }, ...prev.map((x, i) => ({ ...x, selector: `stash@{${i + 1}}` }))]);
      refreshStatus(r);
    },
    'git.applyStash': async ({ repositoryId, token: t }) => { redeem(repo(repositoryId), t, 'applyStash'); },
    'git.dropStash': async ({ repositoryId, entry, token: t }) => { redeem(repo(repositoryId), t, 'dropStash'); stashes.set(repositoryId, (await methods['git.stashes']({ repositoryId })).filter(x => x.oid !== entry.oid)); },
    'git.remotes': async ({ repositoryId }) => repo(repositoryId).spec.upstream ? [{ name: 'origin', fetchUrl: `git@github.com:kaf/${repo(repositoryId).row.name}.git`, pushUrl: `git@github.com:kaf/${repo(repositoryId).row.name}.git`, fingerprint: 'f' }] : [],
    'git.fetch': async ({ repositoryId, token: t }) => { const r = repo(repositoryId); redeem(r, t, 'fetch'); await remoteOp(r, 2200); if (r.row.upstream?.value) { r.row.upstream = { state: 'observed', value: { ...r.row.upstream.value, lastFetchAt: Date.now() }, observedAt: Date.now(), generation: generation++ }; publish(r); } },
    'git.pull': async ({ repositoryId, token: t }) => { const r = repo(repositoryId); redeem(r, t, 'pull'); await remoteOp(r, 900); throw { code: 'git', message: 'Not possible to fast-forward: the branches have diverged.', detail: 'fatal: Not possible to fast-forward, aborting.' }; },
    'git.push': async ({ repositoryId, token: t }) => { const r = repo(repositoryId); redeem(r, t, 'push'); await remoteOp(r, 1600); if (r.row.upstream?.value) { r.spec.upstream = { ...r.row.upstream.value, ahead: 0 }; r.row.upstream = { state: 'observed', value: r.spec.upstream, observedAt: Date.now(), generation: generation++ }; publish(r); } },
    'git.cancel': async ({ repositoryId }) => { network.get(repositoryId)?.(); },
    'search.start': async (query) => {
      const searchId = `s${++serialId}`;
      void (async () => {
        let pattern: RegExp;
        try { pattern = new RegExp(query.regex ? query.query : query.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), query.caseSensitive ? 'g' : 'gi'); }
        catch (error) { emit('search.progress', { searchId, matches: [], done: true, complete: false, searchedRepositories: 0, note: `invalid expression: ${(error as Error).message}` }); return; }
        const targets = visible().filter(r => (!query.scope.length || query.scope.includes(r.row.id)) && r.row.available);
        let total = 0, searched = 0;
        for (const r of targets) {
          const files = isMinv(r) ? allPaths(MINV_TREE).filter(p => !/\.(png|woff2)$/.test(p)) : allPaths(syntheticTree);
          for (const path of files) {
            const body = await contentOf(r, path);
            if (!body) continue;
            const matches: SearchMatch[] = [];
            body.split('\n').forEach((line, i) => { pattern.lastIndex = 0; const m = pattern.exec(line); if (m) matches.push({ repositoryId: r.row.id, path, line: i + 1, column: m.index + 1, preview: line.slice(0, 400), length: m[0].length || 1 }); });
            if (matches.length) { total += matches.length; emit('search.progress', { searchId, matches, done: false, complete: true, searchedRepositories: searched }); }
            if (total > 1000) { emit('search.progress', { searchId, matches: [], done: true, complete: false, searchedRepositories: searched, note: 'stopped at 1,000 matches' }); return; }
          }
          searched++;
        }
        emit('search.progress', { searchId, matches: [], done: true, complete: true, searchedRepositories: searched });
      })();
      return { searchId };
    },
    'search.cancel': async () => {},
    'shell.openTerminal': async () => { throw { code: 'unavailable', message: 'The preview fixture cannot open a terminal.' }; },
    'shell.reveal': async () => { throw { code: 'unavailable', message: 'The preview fixture cannot reveal files.' }; },
    'diagnostics.open': async () => { throw { code: 'unavailable', message: 'Diagnostics require the desktop host.' }; },
    'prefs.get': async () => prefs,
    'prefs.set': async (patch) => { prefs = { ...prefs, ...patch }; localStorage.setItem('minv.preview.prefs', JSON.stringify(prefs)); emit('prefs', prefs); return prefs; },
    'window.ready': async () => {},
    'window.minimize': async () => {},
    'window.toggleMaximize': async () => {},
    'window.close': async () => {},
    'cli.released': async () => {},
  };

  return {
    invoke: (method, params) => (methods[method] as (p: unknown) => Promise<never>)(params),
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (payload: unknown) => void);
      listeners.set(event, set);
      return () => set.delete(listener as (payload: unknown) => void);
    },
  };
}
