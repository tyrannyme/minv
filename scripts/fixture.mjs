#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const profiles = {
  smoke: { available: 8, tracked: 256, ignored: 128, untracked: 24, modified: 16, dirtyRepositories: 4, unavailable: 2 },
  R64: { available: 64, tracked: 200_000, ignored: 1_000_000, untracked: 2_000, modified: 1_000, dirtyRepositories: 16, unavailable: 3 },
  R256: { available: 256, tracked: 1_000_000, ignored: 0, untracked: 2_000, modified: 1_000, dirtyRepositories: 16, unavailable: 3 },
  LARGE1: { available: 1, tracked: 500_000, ignored: 0, untracked: 100, modified: 100, dirtyRepositories: 1, unavailable: 0 },
};
const seed = 20261005;
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'Minv Fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid', GIT_COMMITTER_NAME: 'Minv Fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_TERMINAL_PROMPT: '0' });
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, env: environment, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function portion(total, index, count) { return Math.floor(total / count) + (index < total % count ? 1 : 0); }
function fileName(i) { return `f${String(i).padStart(7, '0')}.txt`; }
async function requireSpace(root, minimum) {
  if (!minimum) return;
  const filesystem = await statfs(root);
  const available = filesystem.bavail * filesystem.bsize;
  if (available < minimum) throw new Error(`Disk guard: ${(available / 1024 ** 3).toFixed(2)} GiB free, ${(minimum / 1024 ** 3).toFixed(2)} GiB required. Partial fixture retained.`);
}
async function files(root, directory, count, bytes, offset = 0, minimum = 0) {
  for (let start = 0; start < count; start += 128) {
    if (start % 8192 === 0) await requireSpace(root, minimum);
    const batch = Array.from({ length: Math.min(128, count - start) }, (_, n) => start + n);
    const folder = path.join(root, directory, String(Math.floor(start / 128)).padStart(5, '0'));
    await mkdir(folder, { recursive: true });
    await Promise.all(batch.map(i => writeFile(path.join(folder, fileName(i)), `${seed}:${offset}:${i}\n`.padEnd(bytes, 'x'))));
  }
}
function trackedFile(root, index) { return path.join(root, 'src', String(Math.floor(index / 128)).padStart(5, '0'), fileName(index)); }

export async function generateFixture(profile = 'smoke', output, options = {}) {
  if (!Object.hasOwn(profiles, profile)) throw new Error(`Unknown profile ${profile}`);
  const specification = profiles[profile];
  const minimum = (options.minFreeGiB ?? (profile === 'smoke' ? 0 : 12)) * 1024 ** 3;
  if (!Number.isFinite(minimum) || minimum < 0) throw new Error('Minimum free space must be a nonnegative number');
  const progress = options.progress ?? (() => {});
  // Exclusive creation is intentional. Never clean or reuse a caller's directory.
  const root = output ? path.resolve(output) : await mkdtemp(path.join(tmpdir(), 'minv-fixture-'));
  if (output) await mkdir(root, { recursive: false });
  const estimatedBytes = specification.tracked * 8192 + (specification.ignored + specification.untracked) * 4096;
  await requireSpace(root, minimum ? minimum + estimatedBytes : 0);
  const entries = [];
  for (let i = 0; i < specification.available; i++) {
    const parent = i === 0 ? undefined : i >= 2 && i <= Math.min(13, specification.available - 1) ? 1 : i >= 14 && i <= 17 ? 2 : 0;
    const relative = parent === undefined ? 'workspace' : `${entries[parent].path}/modules/repo-${String(i).padStart(3, '0')}`;
    entries.push({ path: relative, parent, available: true, branch: i === 0 ? 'main' : `fixture/repo-${i}`, children: [], trackedFiles: 0 });
    if (parent !== undefined) entries[parent].children.push(i);
    const cwd = path.join(root, relative);
    await mkdir(cwd, { recursive: true });
    git(cwd, 'init', '--quiet', '--template=', '--object-format=sha1', `--initial-branch=${entries[i].branch}`);
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const cwd = path.join(root, entry.path);
    const declarations = entry.children.map(child => ({ name: `repo-${child}`, path: path.relative(cwd, path.join(root, entries[child].path)).split(path.sep).join('/') }));
    if (i === 0) for (let n = 0; n < specification.unavailable; n++) declarations.push({ name: `uninitialized-${n}`, path: `modules/uninitialized-${n}` });
    await writeFile(path.join(cwd, '.gitignore'), '/generated/\n');
    if (declarations.length) await writeFile(path.join(cwd, '.gitmodules'), declarations.map(item => `[submodule "${item.name}"]\n\tpath = ${item.path}\n\turl = https://fixture.invalid/${item.name}.git\n\tbranch = intentionally-not-the-checkout-branch\n`).join(''));
    entry.trackedFiles = portion(specification.tracked, i, entries.length);
    entry.dataFiles = entry.trackedFiles - 1 - Number(declarations.length > 0);
    progress({ phase: 'tracked', repository: i + 1, total: entries.length });
    await files(cwd, 'src', entry.dataFiles, 128, i, minimum);
    // Only explicit files are staged; embedded child repositories are handled as gitlinks below.
    git(cwd, 'add', '--', 'src', '.gitignore', ...(declarations.length ? ['.gitmodules'] : []));
  }
  // Children must have a commit before their parent's gitlink is written.
  for (let i = entries.length - 1; i >= 0; i--) {
    await requireSpace(root, minimum);
    const entry = entries[i];
    const cwd = path.join(root, entry.path);
    for (const child of entry.children) {
      const oid = git(path.join(root, entries[child].path), 'rev-parse', 'HEAD');
      git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${oid},${path.relative(cwd, path.join(root, entries[child].path)).split(path.sep).join('/')}`);
    }
    git(cwd, 'commit', '--quiet', '-m', 'Deterministic baseline');
    git(cwd, 'commit', '--quiet', '--allow-empty', '-m', 'Second history entry');
  }
  const workspace = path.join(root, entries[0].path);
  if (specification.unavailable) {
    const oid = git(workspace, 'rev-parse', 'HEAD');
    for (let n = 0; n < specification.unavailable; n++) git(workspace, 'update-index', '--add', '--cacheinfo', `160000,${oid},modules/uninitialized-${n}`);
    git(workspace, 'commit', '--quiet', '-m', 'Record unavailable submodules');
  }
  let stagedGitlink;
  if (entries.length > 1) {
    const childIndex = entries.length - 1;
    const child = entries[childIndex];
    const cwd = path.join(root, child.path);
    git(cwd, 'commit', '--quiet', '--allow-empty', '-m', 'Advance child pointer');
    git(cwd, 'checkout', '--quiet', '--detach');
    child.branch = null;
    const parentCwd = path.join(root, entries[child.parent].path);
    const relative = path.relative(parentCwd, cwd).split(path.sep).join('/');
    git(parentCwd, 'update-index', '--cacheinfo', `160000,${git(cwd, 'rev-parse', 'HEAD')},${relative}`);
    stagedGitlink = { parent: entries[child.parent].path, child: child.path };
  }
  for (let i = 0; i < entries.length; i++) {
    progress({ phase: 'working-tree', repository: i + 1, total: entries.length });
    const cwd = path.join(root, entries[i].path);
    await files(cwd, 'generated', portion(specification.ignored, i, entries.length), 32, i, minimum);
    await files(cwd, 'untracked', portion(specification.untracked, i, entries.length), 64, i, minimum);
    if (i < specification.dirtyRepositories) {
      const count = portion(specification.modified, i, specification.dirtyRepositories);
      if (count > entries[i].dataFiles) throw new Error('Profile has too few tracked data files for modifications');
      for (let j = 0; j < count; j++) await writeFile(trackedFile(cwd, j), `modified:${seed}:${i}:${j}\n`);
    }
  }
  const unborn = path.join(root, 'unborn-companion');
  await mkdir(unborn);
  git(unborn, 'init', '--quiet', '--template=', '--object-format=sha1', '--initial-branch=unborn');
  const manifest = { version: 1, profile, seed, specification, roots: ['workspace'], companionRoots: ['unborn-companion'], repositories: entries, stagedGitlink, counts: { availableWorkspaceCheckouts: entries.length, unavailableEntries: specification.unavailable, workspaceCatalogEntries: entries.length + specification.unavailable, companionCheckouts: 1, trackedRegularFiles: specification.tracked }, generator: { git: git(root, '--version'), fileBytes: { tracked: 128, ignored: 32, untracked: 64 }, commits: '2 per checkout, plus unavailable declaration and pointer advances', layout: '128 data files per directory; generated/ ignored; child modules declared in .gitmodules', network: false } };
  await writeFile(path.join(root, 'fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifest };
}

export async function readFixture(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'fixture.json'), 'utf8'));
  if (manifest.version !== 1 || !Object.hasOwn(profiles, manifest.profile)) throw new Error('Unsupported fixture manifest');
  for (const relative of [...manifest.roots, ...manifest.companionRoots]) {
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`) || !(await stat(target)).isDirectory()) throw new Error('Invalid fixture root');
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      console.log('Usage: node scripts/fixture.mjs [--profile smoke|R64|R256|LARGE1] [--output NEW_DIRECTORY] [--min-free-gib 12]\nLarge profiles are opt-in and can create millions of files. Existing output paths are refused.');
    } else {
      const values = {};
      for (let i = 0; i < args.length; i += 2) {
        if (!['--profile', '--output', '--min-free-gib'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument ${args[i]}`);
        values[args[i]] = args[i + 1];
      }
      const result = await generateFixture(values['--profile'] ?? 'smoke', values['--output'], { minFreeGiB: values['--min-free-gib'] === undefined ? undefined : Number(values['--min-free-gib']), progress: values['--profile'] && values['--profile'] !== 'smoke' ? update => console.error(JSON.stringify(update)) : undefined });
      console.log(JSON.stringify({ root: result.root, manifest: path.join(result.root, 'fixture.json'), counts: result.manifest.counts }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
