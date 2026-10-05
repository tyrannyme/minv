import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { setImmediate as yieldThread } from 'node:timers/promises';
import path from 'node:path';
import { Git } from '../../src/core/git';
import type { GitRunner, Repository } from '../../src/core/types';

interface Scope { key: string; root: string; kind: 'git' | 'plain' | 'metadataTree' | 'metadata' | 'opened'; repository?: Repository; canonicalRoot?: string }
interface Watched { watcher: FSWatcher; root: string; owners: Set<string> }
const contains = (root: string, file: string) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const MAX_DIRECTORIES = 40_000;
const MAX_ENTRIES = 5_000_000;

/** Watch directories, never every file. Git supplies ignored/tracked scope without a source crawl. */
export class WatchCoordinator extends EventEmitter {
  private readonly git: GitRunner;
  private readonly ownGit?: Git;
  private watches = new Map<string, Watched>();
  private scopes = new Map<string, Scope>();
  private queued = new Set<string>();
  private running = new Set<string>();
  private rerun = new Set<string>();
  private repositories: Repository[] = [];
  private roots: string[] = [];
  private files = new Map<string, string>();
  private failures = new Map<string, { root: string; message: string }>();
  private invalidated = new Set<string>();
  private metadataInvalidated = new Set<string>();
  // Registration gaps: when each repository's watches finished registering. Reported once setup settles so the
  // session re-reads only observations that started before their watches existed.
  private gap = new Map<string, { at: number; metadata: boolean }>();
  private branchEvents = new Map<string, number[]>();
  private changedFiles = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private eventCount = 0;
  private batches = 0;
  private repositorySignature = '';
  private deferPlain = false;

  constructor(git?: GitRunner) {
    super();
    this.git = git ?? (this.ownGit = new Git());
  }
  watchRoots(roots: string[], options: { deferPlain?: boolean } = {}): void {
    this.deferPlain = Boolean(options.deferPlain);
    this.roots = [...new Set(roots.map(root => path.resolve(root)))].filter((root, _index, all) => !all.some(other => other !== root && contains(other, root)));
    this.reconcile();
    this.settle();
  }
  setRepositories(repositories: Repository[]): void {
    const signature = JSON.stringify(repositories.map(repo => [repo.id, repo.root, repo.gitDir, repo.commonDir, repo.available]));
    this.repositories = [...repositories];
    if (signature === this.repositorySignature) return;
    this.repositorySignature = signature;
    this.reconcile();
    // A startup failure can predate discovery. New rows inherit that failure.
    for (const failure of this.failures.values()) this.emit('degraded', { ids: this.affected(failure.root), error: failure.message });
  }
  trackFile(key: string, absolutePath: string): void {
    if (!this.roots.some(root => contains(root, absolutePath))) throw new Error('Cannot monitor a file outside the workspace.');
    this.files.set(key, path.resolve(absolutePath));
    this.reconcile();
  }
  untrackFile(key: string): void { this.files.delete(key); this.reconcile(); }
  snapshot() { return { strategy: 'native-directory', watches: this.watches.size, openedFiles: this.files.size, events: this.eventCount, batches: this.batches, initializing: this.deferPlain || this.queued.size + this.running.size > 0, pendingScopes: this.queued.size + this.running.size + Number(this.deferPlain), degraded: this.failures.size > 0, failures: [...new Set([...this.failures.values()].map(failure => failure.message))] }; }
  dispose(): void {
    this.disposed = true;
    for (const entry of this.watches.values()) entry.watcher.close();
    this.watches.clear(); this.queued.clear(); this.rerun.clear(); this.gap.clear();
    if (this.timer) clearTimeout(this.timer);
    this.files.clear(); this.ownGit?.dispose(); this.removeAllListeners();
  }
  retry(): void {
    this.failures.clear();
    for (const scope of this.scopes.values()) this.enqueue(scope.key);
  }
  private affected(root: string): string[] {
    return this.repositories.filter(repo => contains(root, repo.root) || contains(repo.root, root) || [repo.gitDir, repo.commonDir].some(dir => dir && (contains(dir, root) || contains(root, dir)))).map(repo => repo.id);
  }
  private reconcile(): void {
    if (this.disposed) return;
    const desired = new Map<string, Scope>();
    const put = (kind: Scope['kind'], root: string, repository?: Repository) => { const key = `${kind}:${root}`; desired.set(key, { key, kind, root, repository }); };
    for (const root of this.deferPlain ? [] : this.roots) {
      if (!this.repositories.some(repo => repo.available && contains(repo.root, root))) put('plain', root);
    }
    for (const repo of this.repositories) {
      if (!repo.available) continue;
      put('git', repo.root, repo);
      for (const root of new Set([repo.gitDir, repo.commonDir])) if (root) {
        put('metadata', root, repo);
        put('metadataTree', path.join(root, 'refs'), repo);
        put('metadataTree', path.join(root, 'info'), repo);
      }
    }
    for (const file of this.files.values()) put('opened', path.dirname(file));
    for (const [key] of this.scopes) if (!desired.has(key)) {
      this.scopes.delete(key); this.queued.delete(key); this.rerun.delete(key);
      // Retain failure evidence if its failed root still covers a current workspace.
      const failure = this.failures.get(key);
      if (failure && !this.roots.some(root => contains(root, failure.root) || contains(failure.root, root))) this.failures.delete(key);
      for (const entry of this.watches.values()) this.removeOwner(entry, key);
    }
    for (const [key, scope] of desired) if (!this.scopes.has(key)) { this.scopes.set(key, scope); this.enqueue(key); }
  }
  private removeOwner(entry: Watched, key: string): void {
    entry.owners.delete(key);
    if (!entry.owners.size) { entry.watcher.close(); this.watches.delete(entry.root); }
  }
  private enqueue(key: string): void {
    if (this.disposed || !this.scopes.has(key)) return;
    if (this.running.has(key)) this.rerun.add(key);
    else this.queued.add(key);
    this.pump();
  }
  private pump(): void {
    while (!this.disposed && this.running.size < 2 && this.queued.size) {
      const key = this.queued.values().next().value!;
      this.queued.delete(key);
      const scope = this.scopes.get(key);
      if (!scope) continue;
      this.running.add(key);
      void this.scan(scope).catch(error => this.failed(scope, error)).finally(() => {
        this.running.delete(key);
        if (this.disposed) return;
        if (this.rerun.delete(key)) this.queued.add(key);
        this.pump();
        this.settle();
      });
    }
  }
  private async gitOutput(scope: Scope, args: string[], input?: string): Promise<string> {
    const result = await this.git.run(scope.repository!.root, args, { lane: 'background', maxBytes: 64 * 1024 * 1024, timeoutMs: 30_000, input });
    if (result.exitCode !== 0 && !(args[0] === 'check-ignore' && result.exitCode === 1)) throw new Error('Git could not determine complete watch scope.');
    return result.stdout;
  }
  private async scan(scope: Scope): Promise<void> {
    try { scope.canonicalRoot = await realpath(scope.root); }
    catch (error) { if (scope.kind === 'metadataTree' && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const directories = new Set<string>([scope.root]);
    if (scope.kind === 'git') {
      const output = await this.gitOutput(scope, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
      let entries = 0;
      for (const file of output.split('\0')) {
        if (!file) continue;
        let directory = path.dirname(path.resolve(scope.root, file));
        if (!contains(scope.root, directory) || path.relative(scope.root, directory).split(path.sep).includes('.git')) throw new Error('Unsafe watch scope from Git.');
        while (!directories.has(directory)) { directories.add(directory); directory = path.dirname(directory); }
        if (++entries % 1024 === 0) await yieldThread();
        if (directories.size > MAX_DIRECTORIES) throw new Error('Watch directory budget exceeded.');
      }
      const other = await this.gitOutput(scope, ['ls-files', '-z', '--others', '--exclude-standard', '--directory']);
      for (const directory of other.split('\0').filter(item => item.endsWith('/'))) {
        const absolute = path.resolve(scope.root, directory);
        if (!contains(scope.root, absolute)) throw new Error('Unsafe untracked directory.');
        await this.walk(scope, absolute, directories, true);
      }
    } else if (scope.kind === 'plain' || scope.kind === 'metadataTree') {
      await this.walk(scope, scope.root, directories, false);
    }
    const registered = new Set<string>();
    for (const directory of directories) {
      if (this.disposed || this.scopes.get(scope.key) !== scope) return;
      if (await this.register(scope, directory)) registered.add(directory);
    }
    for (const entry of this.watches.values()) if (entry.owners.has(scope.key) && !registered.has(entry.root)) this.removeOwner(entry, scope.key);
    // Reconcile observations after the registration gap, including newly created directories.
    const at = performance.now(), metadata = scope.kind === 'metadata' || scope.kind === 'metadataTree';
    for (const id of this.affected(scope.root)) {
      const previous = this.gap.get(id);
      this.gap.set(id, { at, metadata: metadata || Boolean(previous?.metadata) });
    }
  }
  private settle(): void {
    if (this.disposed || this.snapshot().initializing) return;
    if (this.gap.size) {
      const gaps = [...this.gap].map(([id, gap]) => ({ id, ...gap })); this.gap.clear();
      this.emit('gap', gaps);
    }
    this.emit('ready', this.snapshot());
  }
  private async walk(scope: Scope, start: string, directories: Set<string>, ignored: boolean): Promise<void> {
    const pending = [start];
    let entries = 0;
    while (pending.length && !this.disposed && this.scopes.get(scope.key) === scope) {
      const directory = pending.shift()!;
      if (scope.kind === 'plain' && this.repositories.some(repo => repo.available && contains(repo.root, directory))) continue;
      let handle;
      try { handle = await opendir(directory, { bufferSize: 256 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      directories.add(directory);
      const children: string[] = [];
      for await (const entry of handle) {
        if (++entries > MAX_ENTRIES) throw new Error('Watch traversal budget exceeded.');
        if (entry.isDirectory() && entry.name !== '.git') children.push(path.join(directory, entry.name));
        if (entries % 512 === 0) await yieldThread();
      }
      let excluded = new Set<string>();
      if (ignored && children.length) {
        const relative = children.map(child => path.relative(scope.repository!.root, child).split(path.sep).join('/'));
        excluded = new Set((await this.gitOutput(scope, ['check-ignore', '-z', '--stdin'], `${relative.join('\0')}\0`)).split('\0').filter(Boolean));
      }
      for (const child of children) if (!excluded.has(path.relative(scope.repository?.root ?? scope.root, child).split(path.sep).join('/'))) pending.push(child);
      if (directories.size + pending.length > MAX_DIRECTORIES) throw new Error('Watch directory budget exceeded.');
    }
  }
  private async register(scope: Scope, directory: string): Promise<boolean> {
    const existing = this.watches.get(directory);
    if (existing) { existing.owners.add(scope.key); return true; }
    if (this.watches.size >= MAX_DIRECTORIES) throw new Error('Native watch budget exceeded.');
    let info;
    try { info = await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || this.disposed) return false;
    if (!contains(scope.canonicalRoot!, await realpath(directory))) return false;
    const concurrent = this.watches.get(directory);
    if (concurrent) { concurrent.owners.add(scope.key); return true; }
    const watcher = watch(directory, { persistent: false }, (kind, name) => this.changed(directory, kind, name?.toString()));
    const entry = { watcher, root: directory, owners: new Set([scope.key]) };
    watcher.on('error', error => {
      watcher.close(); this.watches.delete(directory);
      for (const key of entry.owners) { const owner = this.scopes.get(key); if (owner) this.failed(owner, error); }
    });
    this.watches.set(directory, entry);
    return true;
  }
  private changed(directory: string, kind: string, name?: string): void {
    if (this.disposed) return;
    this.eventCount++;
    const entry = this.watches.get(directory);
    if (!entry) return;
    const file = name ? path.resolve(directory, name) : directory;
    const owners = [...entry.owners].map(key => this.scopes.get(key)).filter((scope): scope is Scope => Boolean(scope));
    const metadata = owners.some(scope => scope.kind === 'metadata' || scope.kind === 'metadataTree');
    if (metadata && name === 'objects') return;
    if (metadata) {
      for (const repo of this.repositories) if ([repo.gitDir, repo.commonDir].some(root => root && contains(root, directory))) {
        this.invalidated.add(repo.id); this.metadataInvalidated.add(repo.id);
        if (repo.parentId) { this.invalidated.add(repo.parentId); this.metadataInvalidated.add(repo.parentId); }
        if ((repo.gitDir && file === path.join(repo.gitDir, 'HEAD')) || (repo.commonDir && (file === path.join(repo.commonDir, 'packed-refs') || contains(path.join(repo.commonDir, 'refs'), file)))) {
          const events = this.branchEvents.get(repo.id) ?? [];
          if (events.length < 64) events.push(performance.now());
          this.branchEvents.set(repo.id, events);
        }
      }
    } else {
      const nearest = this.repositories.filter(repo => contains(repo.root, file)).sort((a, b) => b.root.length - a.root.length)[0];
      if (nearest) this.invalidated.add(nearest.id);
    }
    for (const [key, opened] of this.files) if (opened === file || contains(file, opened)) this.changedFiles.add(key);
    if (path.basename(file) === '.gitmodules' || this.repositories.some(repo => !repo.available && contains(repo.root, file))) this.emit('topology');
    if (path.basename(file) === '.gitignore' || (metadata && (path.basename(file) === 'exclude' || path.basename(file) === 'config'))) {
      for (const scope of this.scopes.values()) if (scope.kind === 'git' && (contains(scope.root, file) || (metadata && this.affected(directory).includes(scope.repository!.id)))) this.enqueue(scope.key);
    }
    if (kind === 'rename') void lstat(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      entry.watcher.close(); this.watches.delete(directory);
      for (const owner of owners) {
        if (directory === owner.root) this.failed(owner, error);
        else this.enqueue(owner.key);
      }
    });
    if (kind === 'rename') void lstat(file).then(info => {
      if (info.isDirectory() && !info.isSymbolicLink() && path.basename(file) !== '.git') {
        for (const owner of owners) this.enqueue(owner.key);
        for (const scope of this.scopes.values()) if (contains(file, scope.root)) this.enqueue(scope.key);
      }
    }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && this.watches.has(file)) for (const owner of owners) this.enqueue(owner.key);
    });
    this.schedule();
  }
  private failed(scope: Scope, error: unknown): void {
    if (this.disposed) return;
    const code = (error as NodeJS.ErrnoException).code;
    const message = `File monitoring is degraded${code ? ` (${code})` : ''}. Refresh manually; selected data needs bounded fallback checks.`;
    this.failures.set(scope.key, { root: scope.root, message });
    const ids = this.affected(scope.root);
    for (const id of ids) { this.invalidated.add(id); this.metadataInvalidated.add(id); }
    this.emit('degraded', { ids, error: message });
    this.schedule();
  }
  private schedule(): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined; this.batches++;
      const ids = [...this.invalidated]; this.invalidated.clear();
      const branchMetadata = [...this.branchEvents].flatMap(([id, timestamps]) => timestamps.map(deliveredAt => ({ id, deliveredAt }))); this.branchEvents.clear();
      const metadataIds = [...this.metadataInvalidated]; this.metadataInvalidated.clear();
      if (ids.length) this.emit('invalidation', { ids, reason: 'filesystem', branchMetadata, metadataIds });
      const changed = [...this.changedFiles]; this.changedFiles.clear();
      for (const key of changed) this.emit('fileChanged', { key, path: this.files.get(key) });
    }, 40);
  }
}
