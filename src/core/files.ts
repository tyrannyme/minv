import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type TextEncoding = 'utf8' | 'utf16le' | 'utf16be';
export type LineEnding = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';
export interface WorkspaceRoot { id: string; path: string }
export interface FileEntry { name: string; path: string; kind: 'file' | 'directory' | 'symlink' | 'other'; size: number }
interface FileMetadata { id: string; rootId: string; path: string; scope: string; size: number; fingerprint: string }
export type FileDocument = FileMetadata & ({ kind: 'text'; text: string; encoding: TextEncoding; bom: boolean; eol: LineEnding; large: boolean } | { kind: 'binary' | 'large' });
export interface SaveRequest { rootId: string; path: string; text: string; encoding: TextEncoding; bom: boolean; expectedFingerprint: string }
export interface RecoveryDraft extends SaveRequest { documentId: string; updatedAt?: number }
export interface BackupRecord { id: string; rootId: string; path: string; fingerprint: string; createdAt: number; mode: number }
export interface TransferPlan { token: string; sourceScope: string; targetScope: string; requiresConfirmation: boolean }
interface PreparedTransfer extends TransferPlan { kind: 'copy' | 'move'; sourceRootId: string; sourcePath: string; targetRootId: string; targetPath: string; fingerprint: string; expires: number }
export class FileConflictError extends Error { readonly code = 'FILE_CONFLICT'; constructor(message = 'The file changed on disk. Compare your buffer with disk before saving.') { super(message); this.name = 'FileConflictError'; } }
export class FileBoundaryError extends Error { readonly code = 'FILE_BOUNDARY'; constructor(message: string) { super(message); this.name = 'FileBoundaryError'; } }
export interface WorkspaceFileOptions { roots: string[]; recoveryDirectory: string; repositoryRoots?: string[]; maxTextBytes?: number; largeTextBytes?: number; maxRecoveryBytes?: number; maxRecoveryRecords?: number }

function within(root: string, file: string): boolean { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function glob(pattern: string): RegExp { return new RegExp('^' + pattern.split('**').map(part => part.split('*').map(piece => piece.split('?').map(bit => bit.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('[^/]')).join('[^/]*')).join('.*') + '$'); }
function encode(text: string, encoding: TextEncoding, bom: boolean): Buffer {
  if (!['utf8', 'utf16le', 'utf16be'].includes(encoding)) throw new Error('Unsupported text encoding');
  // Reject unmatched UTF-16 surrogates rather than silently substituting replacement characters.
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = text.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Text contains an unmatched surrogate'); }
    else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error('Text contains an unmatched surrogate');
  }
  let bytes = Buffer.from(text, encoding === 'utf8' ? 'utf8' : 'utf16le');
  if (encoding === 'utf16be') bytes = bytes.swap16();
  if (bom) bytes = Buffer.concat([Buffer.from(encoding === 'utf8' ? [0xef, 0xbb, 0xbf] : encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]), bytes]);
  return bytes;
}
function decode(bytes: Buffer): { text: string; encoding: TextEncoding; bom: boolean; eol: LineEnding } | undefined {
  let encoding: TextEncoding = 'utf8'; let offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf16le'; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf16be'; offset = 2; }
  let text: string;
  try { text = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset)); }
  catch { return undefined; }
  if (text.includes('\0') || /[\x01-\x08\x0e-\x1f]/.test(text)) return undefined;
  const types = new Set(Array.from(text.matchAll(/\r\n|\r|\n/g), item => item[0]));
  const eol: LineEnding = types.size > 1 ? 'mixed' : types.has('\r\n') ? 'crlf' : types.has('\r') ? 'cr' : types.has('\n') ? 'lf' : 'none';
  return { text, encoding, bom: offset > 0, eol };
}

/** Explicit-root, nonrecursive file operations. No workspace code is executed. */
export class WorkspaceFiles {
  readonly roots: readonly WorkspaceRoot[];
  private readonly recoveryDirectory: string;
  private readonly maxTextBytes: number;
  private readonly largeTextBytes: number;
  private readonly maxRecoveryBytes: number;
  private readonly maxRecoveryRecords: number;
  private readonly rootIdentities = new Map<string, string>();
  private repositoryRoots: string[] = [];
  private readonly transfers = new Map<string, PreparedTransfer>();
  private writes: Promise<unknown> = Promise.resolve();

  private constructor(roots: WorkspaceRoot[], options: WorkspaceFileOptions) {
    this.roots = Object.freeze(roots.map(root => Object.freeze(root)));
    this.recoveryDirectory = path.resolve(options.recoveryDirectory);
    this.maxTextBytes = options.maxTextBytes ?? 16 * 1024 * 1024;
    this.largeTextBytes = options.largeTextBytes ?? 2 * 1024 * 1024;
    this.maxRecoveryBytes = options.maxRecoveryBytes ?? 512 * 1024 * 1024;
    this.maxRecoveryRecords = options.maxRecoveryRecords ?? 1024;
  }
  static async create(options: WorkspaceFileOptions): Promise<WorkspaceFiles> {
    const roots: WorkspaceRoot[] = [];
    for (const input of options.roots) {
      const canonical = await fs.realpath(path.resolve(input));
      if (!(await fs.stat(canonical)).isDirectory()) throw new FileBoundaryError('Workspace root is not a directory');
      if (!roots.some(root => root.path === canonical)) roots.push({ id: digest(canonical).slice(0, 24), path: canonical });
    }
    const service = new WorkspaceFiles(roots, options);
    for (const root of roots) { const info = await fs.stat(root.path); service.rootIdentities.set(root.id, info.dev + ":" + info.ino); }
    await fs.mkdir(service.recoveryDirectory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(service.recoveryDirectory)).isSymbolicLink()) throw new FileBoundaryError('Recovery storage cannot be a symlink');
    await fs.chmod(service.recoveryDirectory, 0o700);
    await service.setRepositoryRoots(options.repositoryRoots ?? []);
    return service;
  }
  async setRepositoryRoots(paths: string[]): Promise<void> {
    const roots: string[] = [];
    for (const input of paths) {
      try {
        const canonical = await fs.realpath(input);
        if (this.roots.some(root => within(root.path, canonical))) roots.push(canonical);
      } catch (error) { if (!missing(error)) throw error; }
    }
    this.repositoryRoots = [...new Set(roots)].sort((a, b) => b.length - a.length);
  }
  private root(id: string): WorkspaceRoot { const root = this.roots.find(item => item.id === id); if (!root) throw new FileBoundaryError('Unknown workspace root'); return root; }
  private async resolve(rootId: string, relative: string, allowMissing = false): Promise<string> {
    const root = this.root(rootId);
    if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) throw new FileBoundaryError('Expected a root-relative path');
    const segments = relative.split(/[\\/]/);
    if (segments.some(part => part === '..' || part === '.git')) throw new FileBoundaryError('Path crosses workspace or Git metadata boundary');
    const absolute = path.resolve(root.path, relative);
    if (!within(root.path, absolute)) throw new FileBoundaryError('Path is outside the approved workspace');
    let current = root.path;
    // Recheck the root itself: external programs may replace directories with links.
    const rootInfo = await fs.lstat(current);
    if (rootInfo.isSymbolicLink() || await fs.realpath(current) !== current || this.rootIdentities.get(rootId) !== rootInfo.dev + ':' + rootInfo.ino) throw new FileBoundaryError('Workspace root changed');
    const parts = path.relative(root.path, absolute).split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]!);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new FileBoundaryError('Symlink traversal is disabled; open the target as an approved root'); }
      catch (error) { if (allowMissing && index === parts.length - 1 && missing(error)) return absolute; throw error; }
    }
    return absolute;
  }
  async absolutePath(rootId: string, relative: string): Promise<string> { return this.resolve(rootId, relative); }
  async list(rootId: string, relative = '', options: { limit?: number; exclude?: string[] } = {}): Promise<{ entries: FileEntry[]; complete: boolean }> {
    const directory = await this.resolve(rootId, relative);
    const limit = Math.max(1, Math.min(options.limit ?? 2000, 10000));
    const excludes = (options.exclude ?? []).map(glob);
    const entries: FileEntry[] = []; let complete = true;
    const stream = await fs.opendir(directory);
    try { await this.resolve(rootId, relative); } catch (error) { await stream.close(); throw error; }
    for await (const entry of stream) {
      const file = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
      if (entry.name === '.git' || excludes.some(rule => rule.test(file) || rule.test(entry.name))) continue;
      if (entries.length >= limit) { complete = false; break; }
      try {
        const info = await fs.lstat(path.join(directory, entry.name));
        entries.push({ name: entry.name, path: file, kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size });
      } catch (error) { if (!missing(error)) throw error; complete = false; }
    }
    entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
    return { entries, complete };
  }
  private async snapshot(rootId: string, relative: string): Promise<{ absolute: string; bytes?: Buffer; fingerprint: string; size: number; mode: number }> {
    const absolute = await this.resolve(rootId, relative);
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      await this.resolve(rootId, relative);
      const openedPath = await fs.lstat(absolute);
      if (openedPath.ino !== before.ino || openedPath.dev !== before.dev) throw new FileBoundaryError('File ownership changed while opening');
      if (!before.isFile()) throw new FileBoundaryError('Only regular files support this operation');
      const signature = (stat: typeof before) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(':');
      const bytes = before.size <= this.maxTextBytes ? await handle.readFile() : undefined;
      const after = await handle.stat();
      await this.resolve(rootId, relative);
      const current = await fs.lstat(absolute);
      if (signature(before) !== signature(after) || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev) throw new FileConflictError('File changed while reading it');
      return { absolute, bytes, fingerprint: digest(signature(after) + ':' + (bytes ? digest(bytes) : 'metadata-only')), size: after.size, mode: after.mode };
    } finally { await handle.close(); }
  }
  async read(rootId: string, relative: string): Promise<FileDocument> {
    const snapshot = await this.snapshot(rootId, relative);
    const canonicalRelative = path.relative(this.root(rootId).path, snapshot.absolute).split(path.sep).join('/');
    const metadata: FileMetadata = { id: digest(snapshot.absolute), rootId, path: canonicalRelative, scope: this.scope(snapshot.absolute, rootId), size: snapshot.size, fingerprint: snapshot.fingerprint };
    if (!snapshot.bytes) return { ...metadata, kind: 'large' };
    const decoded = decode(snapshot.bytes);
    return decoded ? { ...metadata, kind: 'text', ...decoded, large: snapshot.size > this.largeTextBytes } : { ...metadata, kind: 'binary' };
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> { const run = this.writes.then(operation, operation); this.writes = run.catch(() => undefined); return run; }
  private async assertExpected(rootId: string, relative: string, expected: string): Promise<Awaited<ReturnType<WorkspaceFiles['snapshot']>>> {
    try { const snapshot = await this.snapshot(rootId, relative); if (snapshot.fingerprint !== expected) throw new FileConflictError(); return snapshot; }
    catch (error) { if (missing(error)) throw new FileConflictError('File was deleted on disk. Your buffer has not been saved.'); throw error; }
  }
  private async syncDirectory(directory: string): Promise<void> { const handle = await fs.open(directory, 'r'); try { await handle.sync(); } catch (error) { if (process.platform !== 'win32') throw error; } finally { await handle.close(); } }
  private async writeDurable(file: string, content: string | Buffer): Promise<void> {
    const temporary = file + '.' + randomUUID() + '.tmp';
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file); await this.syncDirectory(path.dirname(file));
    } finally { await fs.rm(temporary, { force: true }); }
  }
  private async copySnapshot(rootId: string, relative: string, destination: string, expected: string, mode: number, target?: {rootId: string; path: string}): Promise<void> {
    const snapshot = await this.assertExpected(rootId, relative, expected);
    const output = await fs.open(destination, 'wx', mode);
    try {
      if (target) await this.resolve(target.rootId, target.path);
      if (snapshot.bytes) await output.writeFile(snapshot.bytes);
      else {
        const input = await fs.open(snapshot.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await input.stat();
          await this.resolve(rootId, relative);
          const current = await fs.lstat(snapshot.absolute);
          if (!opened.isFile() || current.ino !== opened.ino || current.dev !== opened.dev) throw new FileBoundaryError('Source ownership changed during copy');
          const chunk = Buffer.alloc(64 * 1024);
          let position = 0;
          while (position < snapshot.size) {
            const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, snapshot.size - position), position);
            if (!bytesRead) throw new FileConflictError('Source changed during copy');
            await output.writeFile(chunk.subarray(0, bytesRead));
            position += bytesRead;
          }
        } finally { await input.close(); }
      }
      await output.sync();
      await this.assertExpected(rootId, relative, expected);
      if (target) await this.resolve(target.rootId, target.path);
    } finally { await output.close(); }
  }
  private async checkRecoveryCapacity(bytes: number, replacing?: string): Promise<void> {
    let used = 0; let records = 0;
    for (const name of await fs.readdir(this.recoveryDirectory)) {
      if (name === replacing) continue;
      const info = await fs.lstat(path.join(this.recoveryDirectory, name));
      if (info.isSymbolicLink()) throw new FileBoundaryError('Unexpected symlink in recovery storage');
      used += info.size;
      if (name.endsWith('.json')) records++;
    }
    if (used + bytes > this.maxRecoveryBytes || records >= this.maxRecoveryRecords) throw new Error('Recovery storage is full. Explicitly remove saved backups or resolved drafts; unsaved drafts were preserved.');
  }
  private async createBackup(rootId: string, relative: string, expected?: string): Promise<BackupRecord> {
    const snapshot = expected ? await this.assertExpected(rootId, relative, expected) : await this.snapshot(rootId, relative);
    await this.checkRecoveryCapacity(snapshot.size + 4096);
    const record: BackupRecord = { id: randomUUID(), rootId, path: relative, fingerprint: snapshot.fingerprint, createdAt: Date.now(), mode: snapshot.mode & 0o777 };
    const destination = path.join(this.recoveryDirectory, record.id + '.backup');
    try { await this.copySnapshot(rootId, relative, destination, snapshot.fingerprint, 0o600); }
    catch (error) { await fs.rm(destination, { force: true }); throw error; }
    await this.writeDurable(path.join(this.recoveryDirectory, record.id + '.backup.json'), JSON.stringify(record));
    return record;
  }
  async backup(rootId: string, relative: string, expectedFingerprint?: string): Promise<BackupRecord> { return this.serialize(() => this.createBackup(rootId, relative, expectedFingerprint)); }
  async save(request: SaveRequest): Promise<FileDocument> {
    return this.serialize(async () => {
      const bytes = encode(request.text, request.encoding, request.bom);
      if (bytes.length > this.maxTextBytes) throw new Error('Text exceeds the editable file limit');
      const snapshot = await this.assertExpected(request.rootId, request.path, request.expectedFingerprint);
      if (!snapshot.bytes || !decode(snapshot.bytes)) throw new Error('Binary and over-limit files cannot be saved as text');
      await this.createBackup(request.rootId, request.path, request.expectedFingerprint);
      const temporary = path.join(path.dirname(snapshot.absolute), '.minv-save-' + randomUUID());
      const handle = await fs.open(temporary, 'wx', snapshot.mode & 0o777);
      try {
        try { await this.resolve(request.rootId, request.path); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await this.assertExpected(request.rootId, request.path, request.expectedFingerprint);
        await fs.rename(temporary, snapshot.absolute);
        await this.syncDirectory(path.dirname(snapshot.absolute));
      } finally { await fs.rm(temporary, { force: true }); }
      return this.read(request.rootId, request.path);
    });
  }
  async recover(draft: RecoveryDraft): Promise<void> {
    this.root(draft.rootId);
    // Missing/deleted source paths are intentional: recovery must survive them.
    if (!draft.documentId || typeof draft.text !== 'string') throw new Error('Invalid recovery draft');
    encode(draft.text, draft.encoding, draft.bom);
    await this.serialize(async () => {
      const name = digest(draft.documentId) + '.draft.json';
      const content = JSON.stringify({ ...draft, updatedAt: Date.now() });
      if (Buffer.byteLength(draft.text) > this.maxTextBytes * 2) throw new Error('Recovery draft exceeds the bounded editable-buffer limit; existing draft was preserved');
      await this.checkRecoveryCapacity(Buffer.byteLength(content), name);
      await this.writeDurable(path.join(this.recoveryDirectory, name), content);
    });
  }
  async recoveries(): Promise<RecoveryDraft[]> { return this.records<RecoveryDraft>('.draft.json'); }
  async removeRecovery(documentId: string): Promise<void> { await this.serialize(async () => { await fs.rm(path.join(this.recoveryDirectory, digest(documentId) + '.draft.json'), { force: true }); await this.syncDirectory(this.recoveryDirectory); }); }
  private async records<T>(suffix: string): Promise<T[]> {
    const result: T[] = [];
    for (const name of await fs.readdir(this.recoveryDirectory)) {
      if (!name.endsWith(suffix)) continue;
      try { result.push(JSON.parse(await fs.readFile(path.join(this.recoveryDirectory, name), 'utf8')) as T); }
      catch (error) { if (missing(error)) continue; throw new Error('Recovery record could not be read: ' + name, { cause: error }); }
    }
    return result;
  }
  async createFile(rootId: string, relative: string, text = ''): Promise<FileDocument> {
    return this.serialize(async () => {
      const bytes = encode(text, 'utf8', false);
      if (bytes.length > this.maxTextBytes) throw new Error('Text exceeds the editable file limit');
      const absolute = await this.resolve(rootId, relative, true);
      const handle = await fs.open(absolute, 'wx', 0o644);
      try { await this.resolve(rootId, relative); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await this.syncDirectory(path.dirname(absolute));
      return this.read(rootId, relative);
    });
  }
  async createDirectory(rootId: string, relative: string): Promise<void> { await this.serialize(async () => { const absolute = await this.resolve(rootId, relative, true); await fs.mkdir(absolute); await this.syncDirectory(path.dirname(absolute)); }); }
  private scope(absolute: string, rootId: string): string { return this.repositoryRoots.find(root => within(root, absolute)) ?? this.root(rootId).path; }
  async prepareTransfer(kind: 'copy' | 'move', sourceRootId: string, sourcePath: string, targetRootId: string, targetPath: string): Promise<TransferPlan> {
    if (kind !== 'copy' && kind !== 'move') throw new Error('Unknown transfer operation');
    const source = await this.snapshot(sourceRootId, sourcePath);
    const target = await this.resolve(targetRootId, targetPath, true);
    const sourceScope = this.scope(source.absolute, sourceRootId); const targetScope = this.scope(target, targetRootId);
    const plan: PreparedTransfer = { token: randomUUID(), kind, sourceRootId, sourcePath, targetRootId, targetPath, sourceScope, targetScope, requiresConfirmation: sourceScope !== targetScope, fingerprint: source.fingerprint, expires: Date.now() + 5 * 60_000 };
    this.transfers.set(plan.token, plan);
    return { token: plan.token, sourceScope, targetScope, requiresConfirmation: plan.requiresConfirmation };
  }
  async transfer(token: string, confirmed = false): Promise<FileDocument> {
    return this.serialize(async () => {
      const plan = this.transfers.get(token);
      if (!plan || plan.expires < Date.now()) throw new FileConflictError('Transfer preparation expired');
      if (plan.requiresConfirmation && !confirmed) throw new FileBoundaryError('Confirm both repository scopes before transferring');
      this.transfers.delete(token);
      const source = await this.assertExpected(plan.sourceRootId, plan.sourcePath, plan.fingerprint);
      const target = await this.resolve(plan.targetRootId, plan.targetPath, true);
      if (this.scope(source.absolute, plan.sourceRootId) !== plan.sourceScope || this.scope(target, plan.targetRootId) !== plan.targetScope) throw new FileBoundaryError('Repository scope changed; prepare the transfer again');
      await this.copySnapshot(plan.sourceRootId, plan.sourcePath, target, plan.fingerprint, source.mode & 0o777, { rootId: plan.targetRootId, path: plan.targetPath });
      try {
        await this.assertExpected(plan.sourceRootId, plan.sourcePath, plan.fingerprint);
        const handle = await fs.open(target, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
        await this.syncDirectory(path.dirname(target));
        if (plan.kind === 'move') {
          await this.createBackup(plan.sourceRootId, plan.sourcePath, plan.fingerprint);
          await this.assertExpected(plan.sourceRootId, plan.sourcePath, plan.fingerprint);
          await fs.unlink(source.absolute);
          await this.syncDirectory(path.dirname(source.absolute));
        }
      } catch (error) {
        // Preserve the destination if another process touched it; never remove it blindly.
        throw new FileConflictError('Transfer did not finish safely. Inspect both paths; copied content was retained. ' + String(error));
      }
      return this.read(plan.targetRootId, plan.targetPath);
    });
  }
  async deleteFile(rootId: string, relative: string, expectedFingerprint: string): Promise<BackupRecord> {
    return this.serialize(async () => {
      const record = await this.createBackup(rootId, relative, expectedFingerprint);
      const current = await this.assertExpected(rootId, relative, expectedFingerprint);
      await fs.unlink(current.absolute);
      await this.syncDirectory(path.dirname(current.absolute));
      return record;
    });
  }
  async backups(): Promise<BackupRecord[]> { return this.records<BackupRecord>('.backup.json'); }
  async removeBackup(id: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid backup id');
    await this.serialize(async () => {
      await fs.rm(path.join(this.recoveryDirectory, id + '.backup'), { force: true });
      await fs.rm(path.join(this.recoveryDirectory, id + '.backup.json'), { force: true });
      await this.syncDirectory(this.recoveryDirectory);
    });
  }
  async restoreBackup(id: string): Promise<FileDocument> {
    return this.serialize(async () => {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid backup id');
      const record = (await this.backups()).find(item => item.id === id);
      if (!record) throw new Error('Backup not found');
      const destination = await this.resolve(record.rootId, record.path, true);
      await fs.copyFile(path.join(this.recoveryDirectory, id + '.backup'), destination, constants.COPYFILE_EXCL);
      await fs.chmod(destination, record.mode);
      const handle = await fs.open(destination, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      await this.syncDirectory(path.dirname(destination));
      return this.read(record.rootId, record.path);
    });
  }
}
