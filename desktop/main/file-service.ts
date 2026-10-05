import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileBoundaryError, FileConflictError, WorkspaceFiles, type FileDocument, type RecoveryDraft as CoreDraft } from '../../src/core/files';
import { WorkspaceSearch, type TextMatch } from '../../src/core/search';
import type { Repository, GitRunner } from '../../src/core/types';
import { assertOwnedPath, prepareWrite, withWrite, type WritePrecondition } from '../../src/core/status';
import type { FileContent, HostEvents, HostMethods, SearchMatch, SearchQuery } from '../renderer/src/contract';
import { RequestError, type Handlers } from './protocol';

export interface FileServiceContext {
  files: WorkspaceFiles;
  git?: GitRunner;
  consumeGitReview?(repositoryId: string, token: string, action: 'discard', paths: readonly string[]): WritePrecondition;
  invalidate?(repositoryId: string): void;
  search: WorkspaceSearch;
  getRepository(id: string): Repository;
  getRepositories?(): Repository[];
  canBrowseRepository?(id: string): boolean;
  isTrusted(): boolean;
  confirm(title: string, detail: string): Promise<boolean>;
  emit(event: keyof HostEvents, payload: unknown): void;
  trackFile(key: string, absolutePath: string): void;
  browseExclude?(): string[];
  searchExclude?(): string[];
}
interface Location { repository: Repository; rootId: string; path: string; repositoryPath: string }
interface OpenFile { location: Location; document: FileDocument; notifiedVersion?: string }
const contains = (root: string, file: string) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

/** Electron-free host adapter: renderer ids never authorize a new filesystem root. */
export class FileService {
  readonly handlers: Handlers;
  private readonly open = new Map<string, OpenFile>();
  private readonly versions = new Map<string, Map<string, {encoding: 'utf8' | 'utf16le' | 'utf16be'; bom: boolean}>>();
  private readonly knownRepositories = new Map<string, Repository>();
  private readonly searches = new Map<string, AbortController>();
  private pathSearch?: AbortController;
  private disposed = false;

  constructor(private readonly context: FileServiceContext) {
    this.handlers = {
      'fs.list': async request => this.guard(async () => {
        const location = this.locate(request.repositoryId, request.dir);
        const result = await context.files.list(location.rootId, location.path, { exclude: context.browseExclude?.() });
        if (!result.complete) context.emit('notice', { level: 'warning', message: 'Directory listing reached its limit; additional entries are not shown.', repositoryId: request.repositoryId });
        return { entries: result.entries.map(entry => ({ name: entry.name, kind: entry.kind, size: entry.size })), complete: result.complete, ...(!result.complete ? { note: 'Directory listing reached its limit.' } : {}) };
      }),
      'fs.read': async request => this.guard(() => this.read(request.repositoryId, request.path)),
      'fs.write': async request => this.mutation(() => this.write(request)),
      'fs.findPaths': async request => this.guard(async () => {
        this.pathSearch?.abort();
        const controller = new AbortController(); this.pathSearch = controller;
        const result: {repositoryId: string; path: string}[] = [];
        let complete = true;
        for (const repository of this.repositories(request.scope)) {
          if (controller.signal.aborted) { complete = false; break; }
          const location = this.locate(repository.id, '');
          const found = await context.search.findFiles({ paths: [{ rootId: location.rootId, path: location.path }], query: request.query, maxResults: Math.max(1, request.limit - result.length), signal: controller.signal, exclude: this.searchExcludes(location) });
          for (const file of found.files) result.push({ repositoryId: repository.id, path: this.repoRelative(location, file.path) });
          if (!found.complete || found.errors.length) { complete = false; }
          if (!found.complete || found.errors.length) context.emit('notice', { level: 'warning', message: 'Filename results are incomplete.', repositoryId: repository.id, detail: found.errors.join('\n') });
          if (result.length >= request.limit) { complete = false; break; }
        }
        return { matches: result, complete, ...(!complete ? { note: 'Filename results are incomplete or reached their limit.' } : {}) };
      }),
      'fs.createFile': async request => this.mutation(async () => { const at = this.locate(request.repositoryId, request.path); await context.files.createFile(at.rootId, at.path); }),
      'fs.createDirectory': async request => this.mutation(async () => { const at = this.locate(request.repositoryId, request.path); await context.files.createDirectory(at.rootId, at.path); }),
      'fs.prepareTransfer': async request => this.guard(async () => {
        const from = this.locate(request.repositoryId, request.path); const to = this.locate(request.targetRepositoryId, request.targetPath);
        await context.files.setRepositoryRoots(this.catalog().map(repository => repository.root));
        return context.files.prepareTransfer(request.mode, from.rootId, from.path, to.rootId, to.path);
      }),
      'fs.transfer': async request => this.mutation(async () => { await context.files.transfer(request.token, request.confirmed); }),
      'fs.delete': async request => this.mutation(async () => {
        const at = this.locate(request.repositoryId, request.path);
        if (!await context.confirm('Move file to recovery?', at.repository.root + '\n' + request.path + '\nA recoverable local backup will be retained.')) throw new RequestError('cancelled', 'Deletion cancelled.');
        this.trusted();
        const backup = await context.files.deleteFile(at.rootId, at.path, request.version);
        return { backupId: backup.id };
      }),
      'fs.backups': async () => this.guard(async () => {
        const backups = await context.files.backups();
        return backups.flatMap(backup => { const owner = this.owner(backup.rootId, backup.path); return owner ? [{ id: backup.id, repositoryId: owner.repository.id, path: owner.repositoryPath, createdAt: backup.createdAt }] : []; });
      }),
      'fs.removeBackup': async request => this.guard(async () => {
        const backup = (await context.files.backups()).find(record => record.id === request.backupId);
        const owner = backup && this.owner(backup.rootId, backup.path);
        if (!backup || !owner) throw new RequestError('boundary', 'Backup does not belong to this workspace.');
        if (!await context.confirm('Permanently remove recovery backup?', owner.repository.root + '\n' + owner.repositoryPath + '\nThis deletes the saved backup only. It cannot be undone.')) throw new RequestError('cancelled', 'Backup removal cancelled.');
        this.active();
        await context.files.removeBackup(request.backupId);
      }),
      'fs.restore': async request => this.mutation(async () => {
        const backup = (await context.files.backups()).find(record => record.id === request.backupId);
        if (!backup || !this.owner(backup.rootId, backup.path)) throw new RequestError('boundary', 'Backup does not belong to this workspace.');
        this.trusted();
        await context.files.restoreBackup(request.backupId);
      }),
      'fs.recover': async request => this.guard(() => this.persistDraft(request)),
      'fs.recoveries': async () => this.guard(() => this.recoveries()),
      'fs.readRecovery': async request => this.guard(async () => {
        const draft = await this.draft(request.documentId);
        return { text: draft.text, baseVersion: draft.expectedFingerprint, encoding: draft.encoding, bom: draft.bom };
      }),
      'fs.removeRecovery': async request => this.guard(async () => { await this.draft(request.documentId); await context.files.removeRecovery(request.documentId); }),
      'git.discard': async request => this.mutation(() => this.discard(request)),
      'search.start': async request => this.guard(() => this.startSearch(request)),
      'search.cancel': async request => { this.searches.get(request.searchId)?.abort(); },
    };
  }
  private active(): void { if (this.disposed) throw new RequestError('unavailable', 'Workspace is closed.'); }
  private trusted(): void { this.active(); if (!this.context.isTrusted()) throw new RequestError('untrusted', 'Trust this workspace before changing its files.'); }
  private async mutation<T>(operation: () => Promise<T> | T): Promise<T> { this.trusted(); return this.guard(operation); }
  private async guard<T>(operation: () => Promise<T> | T): Promise<T> {
    this.active();
    try { return await operation(); }
    catch (error) {
      if (error instanceof FileConflictError) throw new RequestError('conflict', error.message);
      if (error instanceof FileBoundaryError) throw new RequestError('boundary', error.message);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RequestError('unavailable', 'File is no longer available on disk.');
      throw error;
    }
  }
  private locate(repositoryId: string, relative: string): Location {
    let repository: Repository;
    try { repository = this.context.getRepository(repositoryId); }
    catch { throw new RequestError('boundary', 'Unknown repository.'); }
    if (!repository || repository.id !== repositoryId) throw new RequestError('boundary', 'Unknown repository.');
    if (!repository.available && !this.context.canBrowseRepository?.(repository.id)) throw new RequestError('unavailable', 'Repository checkout is unavailable.');
    if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || part === '.git')) throw new RequestError('boundary', 'Expected a repository-relative path.');
    const repositoryRoot = path.resolve(repository.root);
    const root = this.context.files.roots.filter(item => contains(item.path, repositoryRoot)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) throw new RequestError('boundary', 'Repository lies outside explicitly approved workspace roots.');
    const absolute = path.resolve(repositoryRoot, relative);
    if (!contains(repositoryRoot, absolute)) throw new RequestError('boundary', 'Path is outside its repository.');
    this.knownRepositories.set(repository.id, repository);
    return { repository, rootId: root.id, path: path.relative(root.path, absolute).split(path.sep).join('/'), repositoryPath: path.relative(repositoryRoot, absolute).split(path.sep).join('/') };
  }
  private catalog(): Repository[] { return this.context.getRepositories?.() ?? [...this.knownRepositories.values()]; }
  private repositories(ids: string[]): Repository[] {
    const repositories = ids.length ? ids.map(id => this.locate(id, '').repository) : this.catalog().filter(repository => repository.available || this.context.canBrowseRepository?.(repository.id));
    if (!repositories.length) throw new RequestError('unavailable', 'No available repositories in the requested search scope.');
    return [...new Map(repositories.map(repository => [repository.id, repository])).values()];
  }
  private searchExcludes(location: Location): string[] {
    const children = this.catalog().filter(repository => repository.id !== location.repository.id && repository.root !== location.repository.root && contains(location.repository.root, repository.root));
    return [...(this.context.searchExclude?.() ?? []), ...children.map(repository => path.relative(location.repository.root, repository.root).split(path.sep).join('/').replace(/[\[\]{}*?]/g, '\\$&') + '/**')];
  }
  private remember(key: string, document: FileDocument): void {
    if (document.kind !== 'text') return;
    const versions = this.versions.get(key) ?? new Map();
    versions.set(document.fingerprint, { encoding: document.encoding, bom: document.bom });
    if (versions.size > 16) versions.delete(versions.keys().next().value!);
    this.versions.set(key, versions);
  }
  private owner(rootId: string, relative: string): Location | undefined {
    const root = this.context.files.roots.find(item => item.id === rootId); if (!root) return;
    const absolute = path.resolve(root.path, relative); if (!contains(root.path, absolute)) return;
    const repository = this.catalog().filter(item => (item.available || this.context.canBrowseRepository?.(item.id)) && contains(item.root, absolute)).sort((a,b) => b.root.length - a.root.length)[0];
    if (!repository) return;
    return this.locate(repository.id, path.relative(repository.root, absolute));
  }
  private key(location: Location): string { return location.repository.id + '\0' + location.repositoryPath; }
  private content(document: FileDocument): FileContent {
    return document.kind === 'text' ? { kind: 'text', text: document.text, version: document.fingerprint, encoding: document.encoding, bom: document.bom, eol: document.eol, size: document.size, large: document.large } : { kind: document.kind, version: document.fingerprint, size: document.size };
  }
  private async read(repositoryId: string, relative: string): Promise<FileContent> {
    const location = this.locate(repositoryId, relative);
    const document = await this.context.files.read(location.rootId, location.path);
    const key = this.key(location);
    this.open.set(key, { location, document, notifiedVersion: document.fingerprint });
    this.remember(key, document);
    this.context.trackFile(key, await this.context.files.absolutePath(location.rootId, location.path));
    return this.content(document);
  }
  private async write(request: HostMethods['fs.write'][0] & { overwrite?: boolean }): Promise<{version: string}> {
    const location = this.locate(request.repositoryId, request.path);
    const opened = this.open.get(this.key(location));
    if (!opened || opened.document.kind !== 'text') throw new RequestError('conflict', 'Open the text file before saving it.');
    const document = opened.document;
    if (request.encoding !== undefined && request.encoding !== document.encoding || request.bom !== undefined && request.bom !== document.bom) throw new RequestError('boundary', 'Changing file encoding requires a separate explicit operation.');
    let expected = request.baseVersion;
    if (request.overwrite === true) {
      const current = await this.context.files.read(location.rootId, location.path);
      if (current.kind !== 'text') throw new RequestError('conflict', 'The disk file is no longer editable text.');
      if (!await this.context.confirm('Replace changed file?', location.repository.root + '\n' + location.repositoryPath + '\nReplace the current disk text with your buffer. A recoverable backup will be retained.')) throw new RequestError('cancelled', 'Replacement cancelled.');
      expected = current.fingerprint;
    } else if (request.baseVersion !== document.fingerprint) throw new RequestError('conflict', 'The save base no longer matches the open document. Compare with disk first.');
    this.trusted();
    const saved = await this.context.files.save({ rootId: location.rootId, path: location.path, text: request.text, encoding: document.encoding, bom: document.bom, expectedFingerprint: expected });
    this.open.set(this.key(location), { location, document: saved, notifiedVersion: saved.fingerprint });
    this.remember(this.key(location), saved);
    return { version: saved.fingerprint };
  }
  async persistDraft(request: HostMethods['fs.recover'][0]): Promise<void> {
    this.active();
    const location = this.locate(request.repositoryId, request.path);
    const opened = this.open.get(this.key(location));
    if (!opened || opened.document.kind !== 'text') throw new RequestError('conflict', 'Open the file before creating a recovery draft.');
    const version = this.versions.get(this.key(location))?.get(request.baseVersion);
    if (!version) throw new RequestError('conflict', 'Recovery draft must reference a disk version opened in this session.');
    // Document IDs are renderer tab IDs, scoped to a validated open file and stored as data only.
    const existing = (await this.context.files.recoveries()).find(draft => draft.documentId === request.documentId);
    if (existing && (existing.rootId !== location.rootId || existing.path !== location.path)) throw new RequestError('boundary', 'Recovery id already belongs to another file.');
    await this.context.files.recover({ documentId: request.documentId, rootId: location.rootId, path: location.path, text: request.text, encoding: version.encoding, bom: version.bom, expectedFingerprint: request.baseVersion });
  }
  private async draft(documentId: string): Promise<CoreDraft> {
    const draft = (await this.context.files.recoveries()).find(item => item.documentId === documentId);
    if (!draft || !this.owner(draft.rootId, draft.path)) throw new RequestError('boundary', 'Recovery draft does not belong to this workspace.');
    return draft;
  }
  async recoveries(): Promise<HostMethods['fs.recoveries'][1]> {
    this.active();
    return (await this.context.files.recoveries()).flatMap(draft => { const owner = this.owner(draft.rootId, draft.path); return owner ? [{ documentId: draft.documentId, repositoryId: owner.repository.id, path: owner.repositoryPath, updatedAt: draft.updatedAt }] : []; });
  }
  session(): {repositoryId: string; path: string}[] { return [...this.open.values()].map(item => ({ repositoryId: item.location.repository.id, path: item.location.repositoryPath })); }
  async onFileChanged(key: string): Promise<void> {
    const opened = this.open.get(key); if (!opened || this.disposed) return;
    try {
      const current = await this.context.files.read(opened.location.rootId, opened.location.path);
      if (current.fingerprint === opened.notifiedVersion) return;
      opened.notifiedVersion = current.fingerprint;
      this.context.emit('file.changed', { repositoryId: opened.location.repository.id, path: opened.location.repositoryPath, version: current.fingerprint });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.context.emit('file.changed', { repositoryId: opened.location.repository.id, path: opened.location.repositoryPath, deleted: true });
      else this.context.emit('notice', { level: 'warning', message: 'Could not check the changed file.', repositoryId: opened.location.repository.id, detail: String(error) });
    }
  }
  private repoRelative(location: Location, relative: string): string {
    const root = this.context.files.roots.find(item => item.id === location.rootId)!;
    const absolute = path.resolve(root.path, relative);
    if (!contains(location.repository.root, absolute)) throw new RequestError('boundary', 'Search result crossed its repository scope.');
    return path.relative(location.repository.root, absolute).split(path.sep).join('/');
  }
  private match(location: Location, match: TextMatch): SearchMatch {
    const owner = this.owner(match.rootId, match.path) ?? location;
    const tail = match.text.slice(match.column);
    let bytes = 0; let length = 0;
    for (const character of tail) { if (bytes >= match.matchLength) break; bytes += Buffer.byteLength(character); length += character.length; }
    return { repositoryId: owner.repository.id, path: this.repoRelative(owner, match.path), line: match.line, column: match.column + 1, preview: match.text, length };
  }
  private async discard(request: HostMethods['git.discard'][0]): Promise<{backupIds: string[]}> {
    const git = this.context.git;
    if (!git || !this.context.consumeGitReview) throw new RequestError('unavailable', 'Recoverable Git discard is unavailable.');
    if (request.confirmed !== true || !request.paths.length) throw new RequestError('cancelled', 'Choose and confirm explicit changed files.');
    const repository = this.locate(request.repositoryId, '').repository;
    if (!repository.available) throw new RequestError('unavailable', 'This folder has no Git checkout.');
    const paths = [...new Set(request.paths)];
    const before = this.context.consumeGitReview(repository.id, request.token, 'discard', paths);
    if (!await this.context.confirm('Discard selected working changes?', repository.root + '\n' + paths.join('\n') + '\n\nTracked files will be restored from the index. Selected untracked files will be removed. Local recovery backups will be retained.')) throw new RequestError('cancelled', 'Discard cancelled.');
    this.trusted();
    const backupIds: string[] = [];
    try {
      return await withWrite(repository, git, before, async () => {
        const tracked: string[] = [];
        const untracked: {location: Location; fingerprint: string}[] = [];
        for (const relative of paths) {
          await assertOwnedPath(repository, relative);
          if (!Object.hasOwn(before.paths, relative)) throw new RequestError('stale-review', 'A path was not part of the reviewed changes.');
          const reviewed = before.paths[relative]!;
          if (reviewed !== 'missing' && !reviewed.startsWith('file:')) throw new RequestError('boundary', 'Discard supports individual regular files; directory, symlink and submodule changes require an external tool.');
          const location = this.locate(repository.id, relative);
          const indexed = await git.run(repository.root, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', relative], { lane: 'foreground' });
          if (indexed.exitCode !== 0) throw new RequestError('git', indexed.stderr || 'Cannot inspect index entry.');
          const entries = indexed.stdout.split('\0').filter(Boolean);
          if (entries.length > 1 || entries.some(entry => !/^100(?:644|755) [a-f0-9]+ 0\t/.test(entry))) throw new RequestError('boundary', 'Conflicted, symlink and submodule entries cannot be discarded through a text-file action.');
          if (entries.length) tracked.push(relative);
          if (reviewed !== 'missing') {
            const document = await this.context.files.read(location.rootId, location.path);
            const backup = await this.context.files.backup(location.rootId, location.path, document.fingerprint);
            backupIds.push(backup.id);
            if (!entries.length) untracked.push({location, fingerprint: document.fingerprint});
          } else if (!entries.length) throw new RequestError('stale-review', 'The selected file is no longer in the index or working tree.');
        }
        const current = await prepareWrite(repository, git);
        if (current.fingerprint !== before.fingerprint) throw new RequestError('stale-review', 'Files changed while preparing recovery backups. Review again.');
        this.trusted();
        // Recheck scope immediately before invoking the trusted write process.
        await this.context.files.absolutePath(this.locate(repository.id, '').rootId, '');
        for (const relative of tracked) await assertOwnedPath(repository, relative);
        if (tracked.length) {
          const result = await git.run(repository.root, ['--literal-pathspecs', 'restore', '--worktree', '--', ...tracked], { write: true, lockKey: repository.commonDir || repository.gitDir || repository.root, lane: 'foreground' });
          if (result.exitCode !== 0) throw new RequestError('uncertain', 'Git did not finish restoring all selected paths. Inspect current state; recovery backups are retained. ' + result.stderr);
        }
        for (const item of untracked) {
          this.trusted();
          const backup = await this.context.files.deleteFile(item.location.rootId, item.location.path, item.fingerprint);
          backupIds.push(backup.id);
        }
        return { backupIds };
      });
    } finally { this.context.invalidate?.(repository.id); }
  }
  private startSearch(request: SearchQuery): {searchId: string} {
    const repositories = this.repositories(request.scope);
    for (const repository of repositories) this.locate(repository.id, '');
    for (const controller of this.searches.values()) controller.abort();
    const searchId = randomUUID(); const controller = new AbortController(); this.searches.set(searchId, controller);
    // Let the invoke reply establish the id before publishing any event.
    setImmediate(() => { void this.runSearch(searchId, controller, repositories, request); });
    return { searchId };
  }
  private async runSearch(searchId: string, controller: AbortController, repositories: Repository[], request: SearchQuery): Promise<void> {
    let complete = true; let searched = 0; let count = 0; const errors: string[] = [];
    try {
      for (const repository of repositories) {
        if (controller.signal.aborted || this.disposed) { complete = false; break; }
        this.active(); const location = this.locate(repository.id, '');
        const result = await this.context.search.search({ paths: [{rootId: location.rootId, path: location.path}], query: request.query, regex: request.regex, caseSensitive: request.caseSensitive, includeIgnored: request.includeIgnored, exclude: this.searchExcludes(location), maxResults: 1000 - count, signal: controller.signal });
        searched++; complete &&= result.complete; errors.push(...result.errors);
        const matches = result.matches.map(match => this.match(location, match)); count += matches.length;
        if (!this.disposed) this.context.emit('search.progress', { searchId, matches, done: false, complete: false, searchedRepositories: searched });
        if (count >= 1000) { complete = false; break; }
      }
    } catch (error) { complete = false; errors.push(String(error)); }
    finally {
      this.searches.delete(searchId);
      if (!this.disposed) this.context.emit('search.progress', { searchId, matches: [], done: true, complete: complete && !controller.signal.aborted, searchedRepositories: searched, errors, ...(controller.signal.aborted ? {note:'Search cancelled; results are incomplete.'} : {}) });
    }
  }
  dispose(): void { this.disposed = true; this.pathSearch?.abort(); for (const controller of this.searches.values()) controller.abort(); this.searches.clear(); this.open.clear(); this.versions.clear(); }
}
