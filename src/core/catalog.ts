import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Branch, CatalogSnapshot, GitRunner, Repository } from './types';

const MAX_REPOSITORIES = 4096;
const MAX_DEPTH = 32;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const metadata = { lane: 'metadata' as const, timeoutMs: 10_000, maxBytes: 1024 * 1024 };

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function line(value: string): string { return value.endsWith('\n') ? value.slice(0, -1) : value; }
function identity(root: string): string { return createHash('sha256').update(root).digest('hex').slice(0, 24); }
async function canonical(root: string): Promise<string> { return realpath(root).catch(() => path.resolve(root)); }
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
function note(repository: Repository, error: string): void {
  repository.error = repository.error ? `${repository.error}; ${error}` : error;
}

interface Candidate { root: string; parentId?: string; depth: number }

async function inspect(candidate: Candidate, git: GitRunner): Promise<Repository> {
  let root = await canonical(candidate.root);
  const repository: Repository = {
    id: identity(root), root, name: path.basename(root) || root,
    ...(candidate.parentId ? { parentId: candidate.parentId } : {}), available: false,
  };
  try {
    const result = await git.run(root, ['rev-parse', '--show-toplevel'], metadata);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Checkout is unavailable or is not a Git working tree.');
    const top = await canonical(line(result.stdout));
    // An uninitialized submodule inherits its parent's Git context. It is not a checkout.
    if (candidate.parentId && top !== root) throw new Error('Submodule is not initialized as an independent checkout.');
    root = top;
    const [gitDir, commonDir] = await Promise.all([
      git.run(root, ['rev-parse', '--absolute-git-dir'], metadata),
      git.run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], metadata),
    ]);
    if (gitDir.exitCode !== 0 || commonDir.exitCode !== 0) {
      throw new Error(gitDir.stderr.trim() || commonDir.stderr.trim() || 'Git metadata directories are unavailable.');
    }
    Object.assign(repository, {
      id: identity(root), root, name: path.basename(root) || root,
      gitDir: path.resolve(root, line(gitDir.stdout)), commonDir: path.resolve(root, line(commonDir.stdout)), available: true,
    });
  } catch (error) { repository.error = message(error); }
  return repository;
}

async function children(repository: Repository, git: GitRunner): Promise<string[]> {
  const paths = new Set<string>();
  // Read only declarations and index entries; never recursively walk source directories.
  try {
    const file = path.join(repository.root, '.gitmodules');
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info) {
      if (!info.isFile() || info.size > metadata.maxBytes) throw new Error('Unsupported or oversized .gitmodules file.');
      const result = await git.run(repository.root, ['config', '--null', '--no-includes', '--file', file, '--get-regexp', '^submodule\\..*\\.path$'], metadata);
      if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr.trim() || 'Cannot read submodule declarations.');
      for (const entry of result.stdout.split('\0')) {
        const separator = entry.indexOf('\n');
        if (separator !== -1) paths.add(entry.slice(separator + 1));
      }
    }
  } catch (error) { note(repository, message(error)); }
  try {
    // Omit per-file object IDs: LARGE1 needs modes and paths, not a full stage dump.
    const result = await git.run(repository.root, ['ls-files', '--format=%(objectmode)\t%(path)', '-z'], { ...metadata, lane: 'background', maxBytes: 32 * 1024 * 1024 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Cannot read recorded submodules.');
    for (const entry of result.stdout.split('\0')) {
      if (entry.startsWith('160000\t')) {
        const separator = entry.indexOf('\t');
        if (separator !== -1) paths.add(entry.slice(separator + 1));
      }
    }
  } catch (error) { note(repository, message(error)); }
  const roots: string[] = [];
  for (const relative of [...paths].sort()) {
    const candidate = path.resolve(repository.root, relative);
    const segments = relative.split(/[\\/]/);
    if (!relative || path.isAbsolute(relative) || segments.includes('..') || segments.includes('.git') || !inside(repository.root, candidate)) {
      note(repository, `Ignored unsafe submodule path: ${JSON.stringify(relative)}`);
      continue;
    }
    const resolved = await canonical(candidate);
    if (!inside(repository.root, resolved)) {
      note(repository, `Ignored submodule path outside checkout: ${JSON.stringify(relative)}`);
      continue;
    }
    roots.push(resolved);
    if (roots.length === MAX_REPOSITORIES) { note(repository, 'Submodule discovery limit reached.'); break; }
  }
  return roots;
}

/** Discovery is bounded and local. Checkout identity never depends on branch or remote. */
export async function discoverRepositories(roots: string[], git: GitRunner, onRepository?: (repository: Repository) => void): Promise<Repository[]> {
  const pending: Candidate[] = roots.slice(0, MAX_REPOSITORIES).map(root => ({ root: path.resolve(root), depth: 0 }));
  const repositories: Repository[] = [];
  const seen = new Map<string, Repository>();
  const queued = new Set<string>(pending.map(item => item.root));
  const parents = new Map<string, string>();
  while (pending.length && repositories.length < MAX_REPOSITORIES) {
    const batch = pending.splice(0, Math.min(4, MAX_REPOSITORIES - repositories.length));
    const found = await Promise.all(batch.map(async candidate => {
      const repository = await inspect(candidate, git);
      // Publish checkout metadata before declaration/index work, which can be much slower.
      onRepository?.(repository);
      const childRoots = repository.available ? await children(repository, git) : [];
      return { candidate, repository, childRoots };
    }));
    for (const { candidate, repository, childRoots } of found) {
      const parentId = parents.get(repository.root);
      if (!repository.parentId && parentId) repository.parentId = parentId;
      const existing = seen.get(repository.id);
      if (existing) {
        if (!existing.parentId && repository.parentId) existing.parentId = repository.parentId;
        continue;
      }
      seen.set(repository.id, repository);
      repositories.push(repository);
      if (roots.length > MAX_REPOSITORIES && repositories.length === 1) note(repository, 'Workspace root discovery limit reached.');
      if (candidate.depth >= MAX_DEPTH && childRoots.length) { note(repository, 'Nested submodule depth limit reached.'); continue; }
      for (const root of childRoots) {
        parents.set(root, repository.id);
        if (queued.has(root)) {
          const existingChild = seen.get(identity(root));
          if (existingChild && existingChild.id !== repository.id) existingChild.parentId ??= repository.id;
          continue;
        }
        if (queued.size >= MAX_REPOSITORIES) { note(repository, 'Repository discovery limit reached.'); break; }
        queued.add(root);
        pending.push({ root, parentId: repository.id, depth: candidate.depth + 1 });
      }
    }
  }
  return repositories;
}

/** Cheap metadata only: never status, diff, history, or worktree traversal. */
export async function readBranch(repository: Repository, git: GitRunner): Promise<Branch> {
  if (!repository.available) throw new Error(repository.error || 'Checkout is unavailable.');
  const [symbolic, revision] = await Promise.all([
    git.run(repository.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], metadata),
    git.run(repository.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], metadata),
  ]);
  if (symbolic.exitCode !== 0 && symbolic.exitCode !== 1) throw new Error(symbolic.stderr.trim() || 'Cannot read current branch.');
  if (symbolic.exitCode === 0 && !line(symbolic.stdout)) throw new Error('Git returned an empty branch name.');
  if (revision.exitCode === 0 && !/^[0-9a-f]{40,64}$/i.test(line(revision.stdout))) throw new Error('Git returned an invalid HEAD revision.');
  let branch: Branch;
  if (symbolic.exitCode === 0) {
    if ((revision.exitCode !== 0 && revision.exitCode !== 1) || (revision.exitCode !== 0 && revision.stderr.trim())) throw new Error(revision.stderr.trim() || 'Cannot resolve HEAD.');
    branch = revision.exitCode === 0
      ? { kind: 'branch', name: line(symbolic.stdout), oid: line(revision.stdout) }
      : { kind: 'unborn', name: line(symbolic.stdout) };
  } else {
    if (revision.exitCode !== 0) throw new Error(revision.stderr.trim() || 'HEAD is neither a branch nor a valid detached commit.');
    branch = { kind: 'detached', oid: line(revision.stdout) };
  }
  let gitDir = repository.gitDir;
  if (!gitDir) {
    const result = await git.run(repository.root, ['rev-parse', '--absolute-git-dir'], metadata);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Cannot resolve Git directory.');
    gitDir = line(result.stdout);
  }
  const operations = [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase or am'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']] as const;
  for (const [marker, operation] of operations) {
    try { await stat(path.join(gitDir, marker)); branch.operation = operation; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return branch;
}

function isRepository(value: unknown): value is Repository {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.root === 'string' && path.isAbsolute(row.root)
    && row.id === identity(row.root) && typeof row.name === 'string' && typeof row.available === 'boolean'
    && ['gitDir', 'commonDir'].every(key => row[key] === undefined || (typeof row[key] === 'string' && path.isAbsolute(row[key])))
    && ['parentId', 'error'].every(key => row[key] === undefined || typeof row[key] === 'string');
}

/** Disposable caches are never authoritative; the caller marks loaded observations cached. */
export async function loadCatalog(file: string): Promise<Repository[]> {
  try {
    if ((await stat(file)).size > MAX_CACHE_BYTES) return [];
    const snapshot: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!snapshot || typeof snapshot !== 'object') return [];
    const { version, repositories } = snapshot as CatalogSnapshot;
    if (version !== 1 || !Array.isArray(repositories) || repositories.length > MAX_REPOSITORIES || !repositories.every(isRepository)) return [];
    if (new Set(repositories.map(repository => repository.id)).size !== repositories.length) return [];
    return repositories;
  } catch { return []; }
}

export async function saveCatalog(file: string, repositories: Repository[]): Promise<void> {
  if (repositories.length > MAX_REPOSITORIES || !repositories.every(isRepository)) throw new Error('Invalid repository catalog.');
  if (new Set(repositories.map(repository => repository.id)).size !== repositories.length) throw new Error('Duplicate checkout identities in repository catalog.');
  const snapshot: CatalogSnapshot = { version: 1, repositories };
  const contents = JSON.stringify(snapshot);
  if (Buffer.byteLength(contents) > MAX_CACHE_BYTES) throw new Error('Repository catalog exceeds cache limit.');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
