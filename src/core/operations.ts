import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertOwnedPath, prepareWrite, readStatus, validatePath, withWrite, type HistoryEntry, type WritePrecondition } from './status';
import type { Change, GitOptions, GitRunner, Repository } from './types';
import { redactSensitiveText } from './redact';

export class GitOperationError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  constructor(readonly exitCode: number, stdout: string, stderr: string, command: string) {
    const safeOut = redactSensitiveText(stdout); const safeError = redactSensitiveText(stderr);
    super(safeError.trim() || safeOut.trim() || `Git ${command} failed (${exitCode})`);
    this.name = 'GitOperationError'; this.stdout = safeOut; this.stderr = safeError;
  }
}

async function run(repo: Repository, git: GitRunner, args: readonly string[], options: GitOptions = {}): Promise<string> {
  if (!repo.available) throw new Error('Repository is unavailable');
  const result = await git.run(repo.root, args, { lane: 'foreground', ...options });
  if (result.exitCode !== 0) throw new GitOperationError(result.exitCode, result.stdout, result.stderr, args[0]!);
  return result.stdout;
}
function writeOptions(repo: Repository, input?: string): GitOptions {
  return { write: true, lockKey: repo.commonDir || repo.gitDir || repo.root, ...(input === undefined ? {} : { input }) };
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
async function resolveRevision(repo: Repository, git: GitRunner, revision: string): Promise<string> {
  if (!revision || revision.includes('\0')) throw new Error('Choose an explicit revision');
  return (await run(repo, git, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).trim();
}
async function checkBranchName(repo: Repository, git: GitRunner, name: string): Promise<void> {
  if (!name || name.startsWith('-') || name === 'HEAD') throw new Error('Choose a valid branch name');
  await run(repo, git, ['check-ref-format', `refs/heads/${name}`]);
}

export interface Hunk { readonly id: string; readonly header: string; readonly patch: string }
export interface HunkReview { readonly id: string; readonly path: string; readonly staged: boolean; readonly hunks: readonly Hunk[] }
interface StoredHunks { repositoryId: string; precondition: WritePrecondition; header: string; hunks: readonly Hunk[]; staged: boolean; bytes: number }
const reviews = new Map<string, StoredHunks>();
let reviewBytes = 0;
function deleteReview(id: string): void { reviewBytes -= reviews.get(id)?.bytes ?? 0; reviews.delete(id); }

/** The returned ID refers to an immutable backend-owned patch, never client-supplied patch text. */
export async function readHunks(repo: Repository, git: GitRunner, file: string, staged: boolean): Promise<HunkReview> {
  await assertOwnedPath(repo, file);
  const precondition = await prepareWrite(repo, git);
  const change = (await readStatus(repo, git)).changes.find(item => item.path === file);
  if (!change) throw new Error('No changes to review');
  if (change.submodule || change.originalPath || change.index === 'U' || change.workingTree === 'U' || precondition.paths[file]?.startsWith('symlink:')) throw new Error('Resolve conflicts or use the explicit whole-file action for this change');
  const args = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/', '--ignore-submodules=dirty'];
  if (staged) args.push('--cached');
  const untracked = change.index === '?';
  if (untracked && staged) throw new Error('Untracked files have no staged changes');
  if (untracked) args.push('--no-index');
  const result = await git.run(repo.root, [...args, '--', ...(untracked ? [os.devNull, file] : [file])], { lane: 'foreground', maxBytes: 4 * 1024 * 1024 });
  if (result.exitCode !== 0 && !(untracked && result.exitCode === 1)) throw new Error(result.stderr.trim() || 'Cannot read hunks');
  if (/^(?:Binary files|GIT binary patch|old mode|new mode|rename from|rename to)/m.test(result.stdout)) throw new Error('Binary, mode and rename changes require an explicit whole-file action');
  const start = result.stdout.indexOf('\n@@ ');
  if (start < 0) throw new Error('This change has no selectable text hunks');
  const header = result.stdout.slice(0, start + 1);
  if ((header.match(/^diff --git /gm) ?? []).length !== 1) throw new Error('A hunk review must contain exactly one file');
  const pieces = result.stdout.slice(start + 1).split(/(?=^@@ )/m);
  const hunks = Object.freeze(pieces.filter(Boolean).map((patch, index) => Object.freeze({ id: `${index}:${digest(patch)}`, header: patch.split('\n', 1)[0]!, patch })));
  if ((await prepareWrite(repo, git)).fingerprint !== precondition.fingerprint) throw new Error('Repository changed while preparing the diff; review it again');
  const id = randomUUID();
  const bytes = Buffer.byteLength(result.stdout);
  while (reviews.size && (reviews.size >= 100 || reviewBytes + bytes > 16 * 1024 * 1024)) deleteReview(reviews.keys().next().value!);
  reviews.set(id, { repositoryId: repo.id, precondition, header, hunks, staged, bytes });
  reviewBytes += bytes;
  return Object.freeze({ id, path: file, staged, hunks });
}

export async function applyHunks(repo: Repository, git: GitRunner, review: HunkReview | string, ids: readonly string[]): Promise<void> {
  const id = typeof review === 'string' ? review : review.id;
  const stored = reviews.get(id);
  if (!stored || stored.repositoryId !== repo.id) throw new Error('Hunk review expired or belongs to another repository');
  const selected = new Set(ids);
  if (!selected.size || [...selected].some(key => !stored.hunks.some(hunk => hunk.id === key))) throw new Error('Choose reviewed hunks');
  const patch = stored.header + stored.hunks.filter(hunk => selected.has(hunk.id)).map(hunk => hunk.patch).join('');
  try {
    await withWrite(repo, git, stored.precondition, async () => {
      const args = ['apply', '--cached', '--whitespace=nowarn', ...(stored.staged ? ['--reverse'] : [])];
      await run(repo, git, [...args, '--check', '-'], writeOptions(repo, patch));
      await run(repo, git, [...args, '-'], writeOptions(repo, patch));
    });
  } finally { deleteReview(id); }
}

export interface BranchTarget { readonly name: string; readonly ref: string; readonly oid: string; readonly remote: boolean; readonly current: boolean; readonly upstream?: string }
export async function listBranches(repo: Repository, git: GitRunner): Promise<BranchTarget[]> {
  const output = await run(repo, git, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)', 'refs/heads/', 'refs/remotes/']);
  return output.trimEnd().split('\n').filter(Boolean).map(line => {
    const [ref, oid, upstream, current] = line.split('\0');
    if (!ref || !oid) throw new Error('Malformed branch data');
    const remote = ref.startsWith('refs/remotes/');
    return Object.freeze({ ref, oid, remote, name: ref.slice(remote ? 13 : 11), current: current === '*', ...(upstream ? { upstream } : {}) });
  });
}
async function verifyBranch(repo: Repository, git: GitRunner, target: BranchTarget): Promise<void> {
  if (!target.ref.startsWith('refs/heads/') && !target.ref.startsWith('refs/remotes/')) throw new Error('Choose a listed branch');
  if (await resolveRevision(repo, git, target.ref) !== target.oid) throw new Error('Selected branch moved; refresh before continuing');
}
export async function createBranch(repo: Repository, git: GitRunner, name: string, start: BranchTarget, precondition: WritePrecondition, options: { switchTo?: boolean } = {}): Promise<void> {
  await checkBranchName(repo, git, name);
  await withWrite(repo, git, precondition, async () => {
    await verifyBranch(repo, git, start);
    const args = options.switchTo
      ? ['switch', '--create', name, '--no-guess', '--no-recurse-submodules', '--no-overwrite-ignore', '--', start.oid]
      : ['branch', '--no-track', '--', name, start.oid];
    await run(repo, git, args, writeOptions(repo));
  });
}
export async function switchBranch(repo: Repository, git: GitRunner, target: BranchTarget, precondition: WritePrecondition): Promise<void> {
  if (target.remote || !target.ref.startsWith('refs/heads/')) throw new Error('Create a local branch before switching to a remote branch');
  await withWrite(repo, git, precondition, async () => {
    await verifyBranch(repo, git, target);
    await run(repo, git, ['switch', '--no-guess', '--no-recurse-submodules', '--no-overwrite-ignore', '--', target.ref.slice(11)], writeOptions(repo));
  });
}

export interface StashEntry { readonly selector: string; readonly oid: string; readonly subject: string; readonly date: string }
export async function listStashes(repo: Repository, git: GitRunner): Promise<StashEntry[]> {
  const exists = await git.run(repo.root, ['rev-parse', '--verify', '--quiet', 'refs/stash']);
  if (exists.exitCode === 1) return [];
  if (exists.exitCode !== 0) throw new Error(exists.stderr.trim() || 'Cannot inspect stashes');
  const output = await run(repo, git, ['log', '-g', '-z', '--format=%gd%x00%H%x00%gs%x00%aI', 'refs/stash', '--']);
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 4) throw new Error('Malformed stash data');
  const result: StashEntry[] = [];
  for (let i = 0; i < fields.length; i += 4) result.push(Object.freeze({ selector: fields[i]!, oid: fields[i + 1]!, subject: fields[i + 2]!, date: fields[i + 3]! }));
  return result;
}
async function verifyStash(repo: Repository, git: GitRunner, entry: StashEntry): Promise<void> {
  if (!/^stash@\{\d+\}$/.test(entry.selector)) throw new Error('Choose a listed stash');
  const current = (await listStashes(repo, git)).find(item => item.selector === entry.selector);
  if (!current || current.oid !== entry.oid) throw new Error('Stash list changed; refresh before continuing');
}
export async function createStash(repo: Repository, git: GitRunner, message: string, paths: readonly string[], includeUntracked: boolean, precondition: WritePrecondition): Promise<void> {
  if (!message.trim() || message.includes('\0') || !paths.length) throw new Error('Provide a stash message and explicit file selection');
  await withWrite(repo, git, precondition, async () => {
    const selected = new Set<string>();
    for (const file of paths) {
      await assertOwnedPath(repo, file);
      const fingerprint = precondition.paths[file];
      if (!fingerprint || fingerprint === 'directory' || fingerprint.startsWith('gitlink:')) throw new Error('Select reviewed files within this repository');
      selected.add(file);
      if (precondition.renames[file]) selected.add(precondition.renames[file]!);
    }
    const changes = (await readStatus(repo, git)).changes;
    if (!includeUntracked && changes.some(change => change.index === '?' && selected.has(change.path))) throw new Error('Selected untracked files require Include untracked');
    // Native pathspec stash still captures every staged file in its index parent
    // (and working snapshot). Refuse to silently capture unrelated staged work.
    if (changes.some(change => !['.', '?', '!'].includes(change.index) && !selected.has(change.path))) throw new Error('Git would include unrelated staged files in this stash. Unstage them or select them explicitly.');
    await run(repo, git, ['--literal-pathspecs', 'stash', 'push', '--message', message, ...(includeUntracked ? ['--include-untracked'] : []), '--', ...selected], writeOptions(repo));
  });
}
export async function applyStash(repo: Repository, git: GitRunner, entry: StashEntry, restoreIndex: boolean, precondition: WritePrecondition): Promise<void> {
  await withWrite(repo, git, precondition, async () => {
    await verifyStash(repo, git, entry);
    await run(repo, git, ['stash', 'apply', ...(restoreIndex ? ['--index'] : []), entry.oid], writeOptions(repo));
  });
}
export async function dropStash(repo: Repository, git: GitRunner, entry: StashEntry, precondition: WritePrecondition, confirmation: true): Promise<void> {
  if (confirmation !== true) throw new Error('Dropping a stash requires explicit confirmation');
  await withWrite(repo, git, precondition, async () => {
    await verifyStash(repo, git, entry);
    await run(repo, git, ['stash', 'drop', entry.selector], writeOptions(repo));
  });
}

export interface RemoteTarget { readonly name: string; readonly fetchUrl: string; readonly pushUrl: string; readonly fingerprint: string; readonly lastFetchedAt?: number }
const fetchTimes = new Map<string, number>();
function checkRemoteName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) || name.includes('..')) throw new Error('Choose a valid configured remote');
}
export async function listRemotes(repo: Repository, git: GitRunner): Promise<RemoteTarget[]> {
  const result = await git.run(repo.root, ['config', '--null', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']);
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Cannot read remotes');
  const records = new Map<string, { urls: string[]; pushUrls: string[] }>();
  for (const entry of result.stdout.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\n');
    const match = /^remote\.(.*)\.(url|pushurl)$/.exec(entry.slice(0, separator));
    if (!match) throw new Error('Malformed remote configuration');
    const name = match[1]!;
    const row = records.get(name) ?? { urls: [], pushUrls: [] };
    (match[2] === 'url' ? row.urls : row.pushUrls).push(entry.slice(separator + 1));
    records.set(name, row);
  }
  const remotes: RemoteTarget[] = [];
  for (const [name] of records) {
    checkRemoteName(name);
    const urls = await run(repo, git, ['remote', 'get-url', '--all', name]);
    const pushUrls = await run(repo, git, ['remote', 'get-url', '--push', '--all', name]);
    const lastFetchedAt = fetchTimes.get(`${repo.id}\0${name}`);
    remotes.push(Object.freeze({ name, fetchUrl: redactSensitiveText(urls.replace(/\n$/, '')), pushUrl: redactSensitiveText(pushUrls.replace(/\n$/, '')), fingerprint: digest(JSON.stringify([urls, pushUrls])), ...(lastFetchedAt === undefined ? {} : { lastFetchedAt }) }));
  }
  return remotes;
}
async function verifyRemote(repo: Repository, git: GitRunner, remote: RemoteTarget): Promise<void> {
  checkRemoteName(remote.name);
  const current = (await listRemotes(repo, git)).find(item => item.name === remote.name);
  if (!current || current.fingerprint !== remote.fingerprint) throw new Error('Remote configuration changed; review its destination again');
}
export interface NetworkOptions { signal?: AbortSignal }
function networkOptions(repo: Repository, options: NetworkOptions): GitOptions {
  return { ...writeOptions(repo), signal: options.signal, cancelActiveWrite: true };
}
export async function fetchRemote(repo: Repository, git: GitRunner, remote: RemoteTarget, precondition: WritePrecondition, options: NetworkOptions = {}): Promise<void> {
  await withWrite(repo, git, precondition, async () => {
    await verifyRemote(repo, git, remote);
    await run(repo, git, ['fetch', '--no-recurse-submodules', '--no-tags', '--no-prune', '--no-prune-tags', '--no-auto-maintenance', '--', remote.name, `refs/heads/*:refs/remotes/${remote.name}/*`], networkOptions(repo, options));
    fetchTimes.set(`${repo.id}\0${remote.name}`, Date.now());
  });
}
export async function pushBranch(repo: Repository, git: GitRunner, remote: RemoteTarget, destinationBranch: string, precondition: WritePrecondition, options: NetworkOptions = {}): Promise<void> {
  await checkBranchName(repo, git, destinationBranch);
  if (!precondition.head) throw new Error('Create a commit before pushing');
  await withWrite(repo, git, precondition, async () => {
    await verifyRemote(repo, git, remote);
    await run(repo, git, ['push', '--porcelain', '--no-force', '--no-follow-tags', '--recurse-submodules=no', '--', remote.name, `${precondition.head}:refs/heads/${destinationBranch}`], networkOptions(repo, options));
  });
}
export async function pullFastForward(repo: Repository, git: GitRunner, remote: RemoteTarget, branch: string, precondition: WritePrecondition, options: NetworkOptions = {}): Promise<void> {
  await checkBranchName(repo, git, branch);
  await withWrite(repo, git, precondition, async () => {
    await verifyRemote(repo, git, remote);
    if (Object.keys(precondition.paths).length) throw new Error('Commit or explicitly stash local changes before pulling');
    const tracking = `refs/remotes/${remote.name}/${branch}`;
    await run(repo, git, ['fetch', '--no-recurse-submodules', '--no-tags', '--no-prune', '--no-prune-tags', '--no-auto-maintenance', '--', remote.name, `refs/heads/${branch}:${tracking}`], networkOptions(repo, options));
    fetchTimes.set(`${repo.id}\0${remote.name}`, Date.now());
    if (options.signal?.aborted) throw new Error('Pull canceled after fetch; local branch was not merged');
    const target = await resolveRevision(repo, git, tracking);
    if ((await prepareWrite(repo, git)).fingerprint !== precondition.fingerprint) throw new Error('Repository changed during fetch; review before merging');
    await run(repo, git, ['-c', 'submodule.recurse=false', 'merge', '--ff-only', '--no-edit', '--no-autostash', '--no-overwrite-ignore', target], writeOptions(repo));
  });
}

export interface OperationState { kinds: ('merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect')[]; conflicts: Change[]; mergeHeads: string[]; indexLocked: boolean }
async function operationMetadata(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Unsupported Git operation metadata');
    const buffer = Buffer.alloc(64 * 1024 + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset === buffer.length) throw new Error('Git operation metadata exceeds the supported size');
    return buffer.subarray(0, offset).toString('utf8');
  } finally { await handle.close(); }
}
export async function readOperationState(repo: Repository, git: GitRunner): Promise<OperationState> {
  const directory = (await run(repo, git, ['rev-parse', '--absolute-git-dir'])).replace(/\n$/, '');
  const exists = async (name: string) => {
    try { await lstat(path.join(directory, name)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const kinds: OperationState['kinds'] = [];
  const merge = await exists('MERGE_HEAD');
  if (merge) kinds.push('merge');
  if (await exists('rebase-merge') || await exists('rebase-apply')) kinds.push('rebase');
  if (await exists('CHERRY_PICK_HEAD')) kinds.push('cherry-pick');
  if (await exists('REVERT_HEAD')) kinds.push('revert');
  if (await exists('BISECT_LOG')) kinds.push('bisect');
  const conflicts = (await readStatus(repo, git)).changes.filter(change => change.index === 'U' || change.workingTree === 'U' || ['AA', 'DD'].includes(change.index + change.workingTree));
  const mergeHeads = merge ? (await operationMetadata(path.join(directory, 'MERGE_HEAD'))).trim().split('\n').filter(value => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) : [];
  return { kinds, conflicts, mergeHeads, indexLocked: await exists('index.lock') };
}

export interface HistoryPage { entries: HistoryEntry[]; revision?: string; nextOffset?: number }
export interface HistoryOptions { revision?: string; path?: string; offset?: number; limit?: number }
export async function readHistoryPage(repo: Repository, git: GitRunner, options: HistoryOptions = {}): Promise<HistoryPage> {
  const offset = options.offset ?? 0; const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid history page');
  if (options.path) validatePath(options.path);
  if (!options.revision) {
    const exists = await git.run(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (exists.exitCode === 1) return { entries: [] };
    if (exists.exitCode !== 0) throw new Error(exists.stderr.trim() || 'Cannot inspect HEAD');
  }
  const revision = await resolveRevision(repo, git, options.revision ?? 'HEAD');
  const output = await run(repo, git, ['--literal-pathspecs', 'log', '-z', '--no-show-signature', '--no-decorate', `--skip=${offset}`, `--max-count=${limit + 1}`, '--format=%H%x00%s%x00%an%x00%aI', ...(options.path ? ['--follow'] : []), revision, '--', ...(options.path ? [options.path] : [])]);
  const fields = output.split('\0'); if (fields.at(-1) === '') fields.pop();
  if (fields.length % 4) throw new Error('Malformed history output');
  const entries: HistoryEntry[] = [];
  for (let i = 0; i < fields.length; i += 4) entries.push({ oid: fields[i]!, subject: fields[i + 1]!, author: fields[i + 2]!, date: fields[i + 3]! });
  return { entries: entries.slice(0, limit), revision, ...(entries.length > limit ? { nextOffset: offset + limit } : {}) };
}
export interface CommitChange { status: string; path: string; originalPath?: string }
export interface CommitDetail extends HistoryEntry { parents: string[]; message: string; changes: CommitChange[] }
export async function readCommitDetail(repo: Repository, git: GitRunner, revision: string): Promise<CommitDetail> {
  const oid = await resolveRevision(repo, git, revision);
  const output = await run(repo, git, ['show', '--no-patch', '--format=%H%x00%s%x00%an%x00%aI%x00%P%x00%B', oid, '--']);
  const fields = output.replace(/\n$/, '').split('\0');
  if (fields.length !== 6) throw new Error('Malformed commit metadata');
  const parents = fields[4]!.split(' ').filter(Boolean);
  const names = parents.length ? await run(repo, git, ['diff', '--name-status', '-z', '--find-renames', parents[0]!, oid, '--']) : await run(repo, git, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', oid, '--']);
  if (names.includes('\uFFFD')) throw new Error('Commit paths cannot be safely represented as UTF-8');
  const tokens = names.split('\0'); if (tokens.at(-1) === '') tokens.pop();
  const changes: CommitChange[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++]!; const first = tokens[index++];
    if (first === undefined) throw new Error('Malformed changed-file data');
    if (status.startsWith('R') || status.startsWith('C')) {
      const file = tokens[index++]; if (file === undefined) throw new Error('Malformed renamed-file data');
      changes.push({ status, originalPath: first, path: file });
    } else changes.push({ status, path: first });
  }
  return { oid, subject: fields[1]!, author: fields[2]!, date: fields[3]!, parents, message: fields[5]!, changes };
}
export async function readRevisionDiff(repo: Repository, git: GitRunner, from: string, to: string, file?: string): Promise<string> {
  if (file) validatePath(file);
  const [left, right] = await Promise.all([resolveRevision(repo, git, from), resolveRevision(repo, git, to)]);
  return run(repo, git, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty', left, right, '--', ...(file ? [file] : [])]);
}
