import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Change, GitOptions, GitRunner, Repository, RepositoryStatus } from './types';

async function run(repo: Repository, git: GitRunner, args: readonly string[], options?: GitOptions): Promise<string> {
  if (!repo.available) throw new Error(`Repository is unavailable: ${repo.root}`);
  const result = await git.run(repo.root, args, options);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Git ${args[0]} failed (${result.exitCode})`);
  return result.stdout;
}

/** Porcelain v2 -z paths are raw, including spaces, tabs and newlines. */
export function parseStatus(output: string): RepositoryStatus {
  if (output && !output.endsWith('\0')) throw new Error('Incomplete Git status output');
  if (output.includes('\uFFFD')) throw new Error('Git returned a filename that cannot be safely represented as UTF-8');
  const records = output.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < records.length - 1; i++) {
    const record = records[i]!;
    if (record.startsWith('# ')) continue;
    if (record.startsWith('? ') || record.startsWith('! ')) {
      changes.push({ path: record.slice(2), index: record[0]!, workingTree: record[0]! });
      continue;
    }
    const kind = record[0];
    const fields = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : 0;
    if (!fields) throw new Error('Unsupported Git status record');
    let offset = 0;
    const header: string[] = [];
    for (let field = 0; field < fields; field++) {
      const end = record.indexOf(' ', offset);
      if (end < 0) throw new Error('Malformed Git status record');
      header.push(record.slice(offset, end));
      offset = end + 1;
    }
    const xy = header[1]!;
    if (xy.length !== 2 || !record.slice(offset)) throw new Error('Malformed Git status record');
    const change: Change = { path: record.slice(offset), index: xy[0]!, workingTree: xy[1]! };
    if (header[2] !== 'N...') change.submodule = header[2];
    if (kind === '2') {
      const original = records[++i];
      if (!original) throw new Error('Missing original rename path');
      change.originalPath = original;
    }
    changes.push(change);
  }
  return { changes, complete: true };
}

export async function readStatus(repo: Repository, git: GitRunner): Promise<RepositoryStatus> {
  // Child working-tree dirtiness belongs to the child's independent status row.
  // Native recursive status could execute helpers from unaudited child config.
  return parseStatus(await run(repo, git, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=dirty'], { lane: 'foreground' }));
}

export function validatePath(value: string): void {
  if (!value || value.includes('\0') || (process.platform === 'win32' && value.includes('\\')) || path.isAbsolute(value) || value.split('/').some(part => part === '..' || part === '.git') || value === '.') {
    throw new Error('Choose an explicit repository-relative file path');
  }
}

export async function readDiff(repo: Repository, git: GitRunner, file: string, staged: boolean, options: { ignoreWhitespace?: boolean } = {}): Promise<string> {
  validatePath(file);
  const args = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short', '--ignore-submodules=dirty'];
  if (options.ignoreWhitespace) args.push('--ignore-all-space');
  if (staged) args.push('--cached');
  else {
    await assertOwnedPath(repo, file);
    const tracked = await git.run(repo.root, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', file], { lane: 'foreground' });
    if (tracked.exitCode === 1) {
      const absolute = path.join(repo.root, file);
      const stat = await lstat(absolute);
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Choose a file to review');
      const result = await git.run(repo.root, [...args, '--no-index', '--', os.devNull, absolute], { lane: 'foreground' });
      if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr.trim() || 'Cannot read untracked diff');
      return result.stdout;
    }
    if (tracked.exitCode !== 0) throw new Error(tracked.stderr.trim() || 'Cannot inspect selected path');
  }
  return run(repo, git, [...args, '--', file], { lane: 'foreground' });
}

export interface HistoryEntry { oid: string; subject: string; author: string; date: string }

export async function readHistory(repo: Repository, git: GitRunner, skip = 0): Promise<HistoryEntry[]> {
  if (!Number.isSafeInteger(skip) || skip < 0) throw new Error('Invalid history offset');
  const head = await git.run(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { lane: 'foreground' });
  if (head.exitCode === 1) return [];
  if (head.exitCode !== 0) throw new Error(head.stderr.trim() || 'Cannot read HEAD');
  const output = await run(repo, git, ['log', '--no-show-signature', '--no-decorate', '-z', '--max-count=50', `--skip=${skip}`, '--format=%H%x00%s%x00%an%x00%aI', 'HEAD', '--'], { lane: 'foreground' });
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 4 !== 0) throw new Error('Incomplete Git history output');
  const entries: HistoryEntry[] = [];
  for (let i = 0; i < fields.length; i += 4) entries.push({ oid: fields[i]!, subject: fields[i + 1]!, author: fields[i + 2]!, date: fields[i + 3]! });
  return entries;
}

export interface WritePrecondition {
  readonly repositoryId: string;
  readonly root: string;
  readonly fingerprint: string;
  readonly head: string;
  readonly paths: Readonly<Record<string, string>>;
  readonly renames: Readonly<Record<string, string>>;
}

function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

async function fingerprintFile(file: string): Promise<string> {
  let stat;
  try { stat = await lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  if (stat.isSymbolicLink()) return `symlink:${await readlink(file)}`;
  if (stat.isDirectory()) return 'directory'; // Gitlink state is also present in porcelain output.
  if (!stat.isFile()) throw new Error(`Unsupported special file: ${file}`);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  return `file:${stat.mode}:${digest.digest('hex')}`;
}

export async function assertOwnedPath(repo: Repository, file: string): Promise<void> {
  validatePath(file);
  const root = await realpath(repo.root);
  // Do not follow ancestor symlinks or stage through another checkout.
  const parts = file.split('/').filter(Boolean);
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Path traverses a symlink: ${file}`);
      await lstat(path.join(directory, '.git'));
      throw new Error(`Path belongs to a nested repository: ${file}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Snapshot the reviewed state; callers must obtain trust before requesting writes. */
export async function prepareWrite(repo: Repository, git: GitRunner): Promise<WritePrecondition> {
  const headResult = await git.run(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { lane: 'foreground' });
  if (headResult.exitCode !== 0 && headResult.exitCode !== 1) throw new Error(headResult.stderr.trim() || 'Cannot read HEAD');
  const refResult = await git.run(repo.root, ['symbolic-ref', '--quiet', 'HEAD'], { lane: 'foreground' });
  if (refResult.exitCode !== 0 && refResult.exitCode !== 1) throw new Error(refResult.stderr.trim() || 'Cannot read HEAD reference');
  const indexPath = (await run(repo, git, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { lane: 'foreground' })).trimEnd();
  const index = await fingerprintFile(indexPath);
  if (index.startsWith('symlink:') || index === 'directory') throw new Error('Unsupported index storage; cannot safely prepare a write');
  const output = await run(repo, git, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=dirty'], { lane: 'foreground' });
  const status = parseStatus(output);
  const paths: Record<string, string> = Object.create(null) as Record<string, string>;
  const renames: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const change of status.changes) {
    for (const file of [change.path, change.originalPath].filter((item): item is string => item !== undefined)) {
      await assertOwnedPath(repo, file);
      paths[file] = await fingerprintFile(path.join(repo.root, file));
      if (paths[file] === 'directory' && change.submodule) {
        const child = await git.run(path.join(repo.root, file), ['rev-parse', '--verify', '--quiet', 'HEAD'], { lane: 'foreground' });
        if (child.exitCode !== 0) throw new Error(`Cannot verify submodule HEAD: ${file}`);
        paths[file] = `gitlink:${child.stdout.trim()}`;
      }
    }
    if (change.originalPath) renames[change.path] = change.originalPath;
  }
  const head = headResult.stdout.trim();
  return Object.freeze({ repositoryId: repo.id, root: repo.root, head, paths: Object.freeze(paths), renames: Object.freeze(renames), fingerprint: hash(JSON.stringify([await realpath(repo.root), indexPath, head, refResult.stdout, index, output, paths])) });
}

const writes = new Map<string, Promise<unknown>>();

export async function withWrite<T>(repo: Repository, git: GitRunner, precondition: WritePrecondition, action: () => Promise<T>): Promise<T> {
  const key = await realpath(repo.commonDir || repo.gitDir || repo.root);
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    if (precondition.repositoryId !== repo.id || precondition.root !== repo.root) throw new Error('The operation belongs to another repository');
    const current = await prepareWrite(repo, git);
    if (current.fingerprint !== precondition.fingerprint) throw new Error('Repository changed since review. Refresh and review the changes before trying again.');
    return action();
  });
  writes.set(key, next);
  try { return await next; } finally { if (writes.get(key) === next) writes.delete(key); }
}

async function selectedPaths(repo: Repository, paths: readonly string[], precondition: WritePrecondition): Promise<string[]> {
  if (!paths.length) throw new Error('Choose at least one changed file');
  const selected = new Set<string>();
  for (const file of paths) {
    await assertOwnedPath(repo, file);
    if (!Object.hasOwn(precondition.paths, file)) throw new Error(`File was not part of the reviewed changes: ${file}`);
    if (precondition.paths[file] === 'directory') throw new Error(`Select individual files instead of a directory: ${file}`);
    selected.add(file);
    const original = precondition.renames[file];
    if (original) selected.add(original);
  }
  return [...selected];
}

export async function stagePaths(repo: Repository, git: GitRunner, paths: readonly string[], precondition: WritePrecondition): Promise<void> {
  await withWrite(repo, git, precondition, async () => {
    const files = await selectedPaths(repo, paths, precondition);
    await run(repo, git, ['--literal-pathspecs', 'add', '--', ...files], { write: true, lockKey: repo.commonDir || repo.gitDir || repo.root });
  });
}

export async function unstagePaths(repo: Repository, git: GitRunner, paths: readonly string[], precondition: WritePrecondition): Promise<void> {
  await withWrite(repo, git, precondition, async () => {
    const files = await selectedPaths(repo, paths, precondition);
    const command = precondition.head ? ['reset', '--quiet', 'HEAD'] : ['rm', '--cached', '-f', '--ignore-unmatch'];
    await run(repo, git, ['--literal-pathspecs', ...command, '--', ...files], { write: true, lockKey: repo.commonDir || repo.gitDir || repo.root });
  });
}

export async function commit(repo: Repository, git: GitRunner, message: string, precondition: WritePrecondition): Promise<void> {
  if (!message.trim() || message.includes('\0')) throw new Error('Enter a commit message');
  await withWrite(repo, git, precondition, async () => {
    await run(repo, git, ['commit', '--file=-'], { write: true, lockKey: repo.commonDir || repo.gitDir || repo.root, input: message });
  });
}
