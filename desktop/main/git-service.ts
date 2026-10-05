import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { readBranch } from '../../src/core/catalog';
import { assertOwnedPath, commit, prepareWrite, readDiff, readStatus, stagePaths, unstagePaths, type WritePrecondition } from '../../src/core/status';
import * as operations from '../../src/core/operations';
import type { GitRunner, Repository } from '../../src/core/types';
import type { DiffResult, HostError, HostMethods, WriteAction, WriteBasis, WriteToken } from '../renderer/src/contract';
import { RequestError, ReviewTickets, type Handlers } from './protocol';

export interface GitServiceContext {
  git: GitRunner;
  getRepository(id: string): Repository;
  isTrusted(): boolean;
  confirm(title: string, detail: string): Promise<boolean>;
  choose(title: string, options: { id: string; label: string; detail?: string }[]): Promise<string | undefined>;
  invalidate(id: string): void;
}
interface Ticket { precondition: WritePrecondition; paths?: readonly string[] }
interface ContentBasis { precondition: WritePrecondition; path: string; side: 'staged' | 'unstaged'; filtered: boolean }
const scoped = new Set<WriteAction>(['stage', 'unstage', 'discard', 'stash']);
const actions = new Set<WriteAction>(['stage', 'unstage', 'discard', 'commit', 'createBranch', 'switchBranch', 'stash', 'applyStash', 'dropStash', 'fetch', 'pull', 'push']);

/** Electron-free adapter. The renderer receives opaque action-bound handles, never fingerprints. */
export class GitService {
  readonly handlers: Handlers;
  private readonly git: GitRunner;
  private readonly tickets = new ReviewTickets<Ticket>();
  private readonly hunks = new ReviewTickets<ContentBasis & { review: operations.HunkReview }>();
  private readonly diffs = new ReviewTickets<ContentBasis>();
  private readonly statusBases = new Map<string, { generation: number; precondition: WritePrecondition }>();
  private readonly activeNetwork = new Map<string, AbortController>();

  constructor(private readonly context: GitServiceContext) {
    this.git = { run: (cwd, args, options) => {
      if (options?.write) this.assertTrusted();
      return context.git.run(cwd, args, options);
    } };
    this.handlers = {
      'git.diff': input => this.guard(async () => {
        const repo = this.repository(input.repositoryId);
        const before = await prepareWrite(repo, this.git);
        const patch = await readDiff(repo, this.git, input.path, input.side === 'staged', { ignoreWhitespace: input.ignoreWhitespace });
        const kind = await this.diffKind(repo, input.path, patch);
        if ((await prepareWrite(repo, this.git)).fingerprint !== before.fingerprint) throw new RequestError('stale-review', 'Repository changed while preparing this diff.');
        const reviewId = this.diffs.issue(repo.id, 'diff', { precondition: before, path: input.path, side: input.side, filtered: Boolean(input.ignoreWhitespace) });
        return { reviewId, patch, kind };
      }),
      'git.hunks': input => this.guard(async () => {
        const repo = this.repository(input.repositoryId);
        const before = await prepareWrite(repo, this.git);
        const review = await operations.readHunks(repo, this.git, input.path, input.side === 'staged');
        if ((await prepareWrite(repo, this.git)).fingerprint !== before.fingerprint) throw new RequestError('stale-review', 'Repository changed while preparing this diff.');
        const reviewId = this.hunks.issue(repo.id, input.side === 'staged' ? 'unstage-hunks' : 'stage-hunks', { review, precondition: before, path: input.path, side: input.side, filtered: false });
        return { reviewId, path: review.path, side: input.side, hunks: review.hunks.map(hunk => ({ ...hunk })) };
      }),
      'git.applyHunks': input => this.write(input.repositoryId, async repo => {
        const stored = this.hunks.consume(input.reviewId, repo.id, ['stage-hunks', 'unstage-hunks']);
        await operations.applyHunks(repo, this.git, stored.review, input.ids);
      }),
      'git.prepare': input => this.guard(() => this.prepare(input.repositoryId, input.action, input.paths, input.basis)),
      'git.stage': input => this.write(input.repositoryId, async repo => {
        const before = this.consumeReview(repo.id, input.token, 'stage', input.paths);
        await stagePaths(repo, this.git, input.paths, before);
      }),
      'git.unstage': input => this.write(input.repositoryId, async repo => {
        const before = this.consumeReview(repo.id, input.token, 'unstage', input.paths);
        await unstagePaths(repo, this.git, input.paths, before);
      }),
      'git.commit': input => this.write(input.repositoryId, async repo => {
        const before = this.consumeReview(repo.id, input.token, 'commit');
        const branch = await readBranch(repo, this.git);
        const staged = await this.gitOutput(repo, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty', '--']);
        if (!staged) throw new RequestError('git', 'There are no staged changes to commit.');
        await this.confirm(`Commit in ${repo.name}?`, `Repository: ${repo.root}\nBranch: ${branch.name ?? branch.oid ?? 'unborn'}\n\nMessage:\n${input.message}\n\nExact staged changes:\n${staged}`);
        this.assertTrusted();
        await commit(repo, this.git, input.message, before);
        return { oid: (await this.gitOutput(repo, ['rev-parse', '--verify', 'HEAD'])).trim() };
      }),
      'git.history': input => this.guard(() => operations.readHistoryPage(this.repository(input.repositoryId), this.git, { revision: input.revision, offset: input.offset, path: input.path })),
      'git.show': input => this.guard(() => operations.readCommitDetail(this.repository(input.repositoryId), this.git, input.oid)),
      'git.revisionDiff': input => this.guard(() => operations.readRevisionDiff(this.repository(input.repositoryId), this.git, input.from, input.to, input.path)),
      'git.operation': input => this.guard(() => operations.readOperationState(this.repository(input.repositoryId), this.git)),
      'git.branches': input => this.guard(() => operations.listBranches(this.repository(input.repositoryId), this.git)),
      'git.createBranch': input => this.write(input.repositoryId, async repo => {
        const before = this.consumeReview(repo.id, input.token, 'createBranch');
        await this.confirm(`Create branch ${input.name}?`, `${repo.root}\nStart: ${input.start.ref} at ${input.start.oid}\n${input.switchTo ? 'Create and switch to this branch.' : 'Keep the current checkout selected.'}`);
        this.assertTrusted();
        await operations.createBranch(repo, this.git, input.name, input.start, before, { switchTo: input.switchTo });
      }),
      'git.switchBranch': input => this.write(input.repositoryId, async repo => {
        const before = this.consumeReview(repo.id, input.token, 'switchBranch');
        await this.confirm(`Switch branch in ${repo.name}?`, `${repo.root}\nTarget: ${input.target.ref}\nCommit: ${input.target.oid}\nGit will refuse to overwrite conflicting local changes.`);
        this.assertTrusted();
        await operations.switchBranch(repo, this.git, input.target, before);
      }),
      'git.stashes': input => this.guard(() => operations.listStashes(this.repository(input.repositoryId), this.git)),
      'git.stash': input => this.write(input.repositoryId, async repo => {
        const before = this.consumeReview(repo.id, input.token, 'stash', input.paths);
        await this.confirm(`Stash selected files in ${repo.name}?`, `${repo.root}\n${input.paths.join('\n')}\n\n${input.includeUntracked ? 'Include selected untracked files.' : 'Tracked files only.'}\nSave these changes in a stash and restore the selected working files.\nMessage: ${input.message}`);
        this.assertTrusted();
        await operations.createStash(repo, this.git, input.message, input.paths, input.includeUntracked, before);
      }),
      'git.applyStash': input => this.write(input.repositoryId, async repo => {
        const before = this.consumeReview(repo.id, input.token, 'applyStash');
        const entry = await this.stash(repo, input.entry);
        await this.confirm(`Apply stash in ${repo.name}?`, `${repo.root}\n${entry.selector}: ${entry.subject}\n${entry.oid}\n${input.restoreIndex ? 'Restore staged state too.' : 'Apply to working files.'}\nThe stash remains available if conflicts occur.`);
        this.assertTrusted();
        await operations.applyStash(repo, this.git, entry, input.restoreIndex, before);
      }),
      'git.dropStash': input => this.write(input.repositoryId, async repo => {
        const before = this.consumeReview(repo.id, input.token, 'dropStash');
        if (input.confirmed !== true) throw new RequestError('cancelled', 'Dropping a stash requires confirmation.');
        const entry = await this.stash(repo, input.entry);
        await this.confirm(`Permanently drop stash in ${repo.name}?`, `${repo.root}\n${entry.selector}: ${entry.subject}\n${entry.oid}\nThis removes the stash recovery entry. It does not apply its contents.`);
        this.assertTrusted();
        await operations.dropStash(repo, this.git, entry, before, true);
      }),
      'git.remotes': input => this.guard(() => operations.listRemotes(this.repository(input.repositoryId), this.git)),
      'git.fetch': input => this.network('fetch', input),
      'git.pull': input => this.network('pull', input),
      'git.push': input => this.network('push', input),
      'git.cancel': input => this.guard(async () => { this.cancelNetwork(input.repositoryId); }),
    };
  }

  clearReviews(): void { this.tickets.clear(); this.hunks.clear(); this.diffs.clear(); this.statusBases.clear(); }

  /** Explicit user cancellation only; selection and review invalidation never call this. */
  cancelNetwork(repositoryId: string): void { this.activeNetwork.get(repositoryId)?.abort(); }

  /** The publisher supplies a snapshot captured with the status observation, never afterwards. */
  recordStatusBasis(repositoryId: string, generation: number, precondition: WritePrecondition): void {
    const repo = this.repository(repositoryId);
    if (!Number.isSafeInteger(generation) || generation < 0 || precondition.repositoryId !== repositoryId || precondition.root !== repo.root) throw new RequestError('stale-review', 'Invalid status observation basis.');
    const previous = this.statusBases.get(repositoryId);
    if (previous && previous.generation >= generation) return;
    if (!previous && this.statusBases.size >= 16) this.statusBases.delete(this.statusBases.keys().next().value!);
    this.statusBases.set(repositoryId, { generation, precondition });
  }

  /** Shared with the recoverable-discard adapter; scope and trust are enforced here too. */
  consumeReview(repositoryId: string, token: string, action: WriteAction, paths?: readonly string[]): WritePrecondition {
    this.assertTrusted();
    const ticket = this.tickets.consume(token, repositoryId, [action]);
    if (scoped.has(action)) {
      const requested = [...new Set(paths ?? [])].sort();
      if (!requested.length || JSON.stringify(requested) !== JSON.stringify(ticket.paths)) throw new RequestError('stale-review', 'The selected paths differ from the reviewed operation.');
    }
    return ticket.precondition;
  }

  private async prepare(repositoryId: string, action: WriteAction, paths: readonly string[] | undefined, basis: WriteBasis): Promise<WriteToken> {
    this.assertTrusted();
    if (!actions.has(action)) throw new RequestError('git', 'Choose the Git operation to prepare.');
    const repo = this.repository(repositoryId);
    const before = await prepareWrite(repo, this.git);
    let selected: string[] | undefined;
    if (scoped.has(action)) {
      selected = [...new Set(paths ?? [])].sort();
      if (!selected.length) throw new RequestError('git', 'Choose explicit changed files.');
      for (const file of selected) {
        await assertOwnedPath(repo, file);
        if (!Object.hasOwn(before.paths, file)) throw new RequestError('stale-review', 'A selected file is no longer part of the changes.');
      }
    } else if (paths?.length) throw new RequestError('git', 'This operation is not scoped by file paths.');
    if (!basis) throw new RequestError('stale-review', 'The displayed state must be supplied when preparing an action.');
    if (basis.kind === 'status') {
      const observed = this.statusBases.get(repo.id);
      if (!observed || observed.generation !== basis.generation || observed.precondition.fingerprint !== before.fingerprint) throw new RequestError('stale-review', 'The displayed status is out of date. Refresh and review the changes.');
    } else if (basis.kind === 'review') {
      let observed: ContentBasis;
      try { observed = this.diffs.peek(basis.reviewId, repo.id, ['diff']); }
      catch { observed = this.hunks.peek(basis.reviewId, repo.id, ['stage-hunks', 'unstage-hunks']); }
      if (observed.filtered || observed.precondition.fingerprint !== before.fingerprint) throw new RequestError('stale-review', 'Review the complete current diff before changing files.');
      if (!selected || selected.length !== 1 || selected[0] !== observed.path || !['stage', 'unstage', 'discard'].includes(action)) throw new RequestError('stale-review', 'The reviewed diff does not cover this operation.');
      if ((action === 'unstage') !== (observed.side === 'staged')) throw new RequestError('stale-review', 'The reviewed diff has the wrong staging direction.');
    } else if (basis.kind === 'none') {
      if (!['createBranch', 'switchBranch', 'applyStash', 'dropStash', 'fetch'].includes(action)) throw new RequestError('stale-review', 'This action requires the status or diff that was reviewed.');
    } else throw new RequestError('stale-review', 'Unknown review basis.');
    const branch = await readBranch(repo, this.git);
    this.assertTrusted();
    return { token: this.tickets.issue(repo.id, action, { precondition: before, paths: selected ? Object.freeze([...selected]) : undefined }), action, ...(selected ? { paths: [...selected] } : {}), ...(before.head ? { head: before.head } : {}), ...(branch.name ? { branch: branch.name } : {}) };
  }

  private network(action: 'fetch' | 'pull' | 'push', input: HostMethods['git.fetch'][0] | HostMethods['git.pull'][0] | HostMethods['git.push'][0]): Promise<void> {
    return this.write(input.repositoryId, async repo => {
      if (this.activeNetwork.has(repo.id)) throw new RequestError('unavailable', 'A network operation is already running for this repository.');
      const controller = new AbortController();
      this.activeNetwork.set(repo.id, controller);
      try {
        const before = this.consumeReview(repo.id, input.token, action);
        const remote = (await operations.listRemotes(repo, this.git)).find(item => item.name === input.remote.name && item.fingerprint === input.remote.fingerprint);
        if (!remote) throw new RequestError('stale-review', 'The selected remote changed. Review its destination again.');
        const branch = 'branch' in input ? input.branch : undefined;
        if (action !== 'fetch' && !branch) throw new RequestError('git', 'Choose an explicit remote branch.');
        const scope = action === 'fetch' ? 'Fetch branch heads only. No tags, pruning, or child-repository updates.' : action === 'pull' ? `Fetch ${branch} and fast-forward the current branch only.` : `Push reviewed commit ${before.head || '(no commit)'} to refs/heads/${branch}. No force or tags.`;
        await this.confirm(`${action === 'fetch' ? 'Fetch' : action === 'pull' ? 'Pull' : 'Push'} ${remote.name}?`, `Repository: ${repo.root}\nRemote: ${remote.name}\nDestination: ${action === 'push' ? remote.pushUrl : remote.fetchUrl}\n${scope}\nThis explicitly contacts the configured remote.`);
        this.assertTrusted();
        if (controller.signal.aborted) throw new RequestError('cancelled', 'Network operation cancelled before dispatch.');
        const options = { signal: controller.signal };
        if (action === 'fetch') await operations.fetchRemote(repo, this.git, remote, before, options);
        else if (action === 'pull') await operations.pullFastForward(repo, this.git, remote, branch!, before, options);
        else await operations.pushBranch(repo, this.git, remote, branch!, before, options);
      } finally { if (this.activeNetwork.get(repo.id) === controller) this.activeNetwork.delete(repo.id); }
    });
  }

  private async stash(repo: Repository, selected: operations.StashEntry): Promise<operations.StashEntry> {
    const current = (await operations.listStashes(repo, this.git)).find(entry => entry.selector === selected.selector && entry.oid === selected.oid);
    if (!current) throw new RequestError('stale-review', 'The stash list changed. Review it again.');
    return current;
  }
  private async diffKind(repo: Repository, file: string, patch: string): Promise<DiffResult['kind']> {
    const change = (await readStatus(repo, this.git)).changes.find(item => item.path === file);
    if (change && (change.index === 'U' || change.workingTree === 'U' || ['AA', 'DD'].includes(change.index + change.workingTree))) return 'conflict';
    if (change?.submodule || /^(?:index .*160000|[+-]Subproject commit )/m.test(patch)) return 'gitlink';
    if (change?.originalPath || /^rename (?:from|to) /m.test(patch)) return 'rename';
    if (/^(?:Binary files |GIT binary patch)/m.test(patch)) return 'binary';
    try { if ((await lstat(path.join(repo.root, file))).isSymbolicLink()) return 'symlink'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (/^(?:index .*120000|(?:deleted|new) file mode 120000)/m.test(patch)) return 'symlink';
    if (/^(?:old mode|new mode) /m.test(patch) && !/^@@ /m.test(patch)) return 'mode';
    return patch ? 'text' : 'empty';
  }
  private repository(id: string): Repository {
    const repo = this.context.getRepository(id);
    if (!repo || !repo.available) throw new RequestError('unavailable', 'This repository is unavailable.');
    return repo;
  }
  private assertTrusted(): void {
    if (!this.context.isTrusted()) throw new RequestError('untrusted', 'Trust this workspace before changing repositories.');
  }
  private async confirm(title: string, detail: string): Promise<void> {
    if (!await this.context.confirm(title, detail)) throw new RequestError('cancelled', 'Operation cancelled.');
  }
  private async gitOutput(repo: Repository, args: readonly string[]): Promise<string> {
    const result = await this.git.run(repo.root, args, { lane: 'foreground' });
    if (result.exitCode !== 0) throw new operations.GitOperationError(result.exitCode, result.stdout, result.stderr, args[0]!);
    return result.stdout;
  }
  private async write<T>(id: string, action: (repo: Repository) => Promise<T>): Promise<T> {
    return this.guard(async () => {
      this.assertTrusted();
      const repo = this.repository(id);
      try { return await action(repo); }
      finally { this.context.invalidate(id); }
    });
  }
  private async guard<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (error instanceof RequestError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      let code: HostError['code'] = 'git';
      if (/uncertain/i.test(message)) code = 'uncertain';
      else if (/cancel(?:led|ed)/i.test(message)) code = 'cancelled';
      else if (/changed since review|changed while preparing|review expired|review.*another repository|branch moved|list changed|configuration changed|reviewed hunks/i.test(message)) code = 'stale-review';
      else if (/unavailable|missing|ENOENT|not a git repository/i.test(message)) code = 'unavailable';
      throw new RequestError(code, message);
    }
  }
}
