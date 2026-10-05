import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { WorkspaceFiles } from './files';

export interface SearchScope { rootId: string; path: string }
export interface SearchPolicies { rootIds?: string[]; paths?: SearchScope[]; includeIgnored?: boolean; includeHidden?: boolean; exclude?: string[]; maxResults?: number; signal?: AbortSignal }
export interface TextSearchRequest extends SearchPolicies { query: string; regex?: boolean; caseSensitive?: boolean; maxFileBytes?: number }
export interface FileSearchRequest extends SearchPolicies { query?: string }
export interface TextMatch { rootId: string; path: string; line: number; column: number; text: string; matchLength: number }
export interface FileMatch { rootId: string; path: string }
export interface SearchResult<T> { complete: boolean; cancelled: boolean; errors: string[] }
export interface TextSearchResult extends SearchResult<TextMatch> { matches: TextMatch[] }
export interface FileSearchResult extends SearchResult<FileMatch> { files: FileMatch[] }
interface Scope { rootId: string; root: string; base: string; validationPath: string; paths: string[]; include?: string }
interface RunResult { complete: boolean; cancelled: boolean; error?: string }

/** Search is requested work, never a prerequisite for showing the catalog. */
export class WorkspaceSearch {
  private readonly rgPath: string;
  private readonly filenameIndex = new Map<string, FileMatch[]>();
  constructor(private readonly files: WorkspaceFiles, options: { rgPath?: string } = {}) { this.rgPath = options.rgPath ?? 'rg'; }
  /** A partial navigation hint only; findFiles revalidates the requested policy. */
  cachedFiles(query = ''): FileSearchResult {
    const needle = query.toLocaleLowerCase();
    return { files: [...this.filenameIndex.values()].flat().filter(file => file.path.toLocaleLowerCase().includes(needle)), complete: false, cancelled: false, errors: [] };
  }
  private async scopes(request: SearchPolicies): Promise<Scope[]> {
    const ids = request.rootIds ?? (request.paths ? [...new Set(request.paths.map(scope => scope.rootId))] : this.files.roots.map(root => root.id));
    const scopes: Scope[] = [];
    for (const id of new Set(ids)) {
      const root = this.files.roots.find(item => item.id === id);
      if (!root) throw new Error('Unknown search root');
      const paths = request.paths?.filter(scope => scope.rootId === id).map(scope => scope.path) ?? [''];
      if (!paths.length) continue;
      for (const relative of paths) {
        const absolute = await this.files.absolutePath(id, relative);
        const info = await fs.lstat(absolute);
        if (!info.isFile() && !info.isDirectory()) throw new Error('Search scope must be a regular file or directory');
        const directory = info.isDirectory() ? absolute : path.dirname(absolute);
        const include = info.isFile() ? '/' + path.basename(absolute).replace(/[\[\]{}*?\\]/g, '\\$&') : undefined;
        scopes.push({ rootId: id, root: directory, base: root.path, validationPath: relative, paths: ['.'], include });
      }
    }
    return scopes;
  }
  private policyArgs(request: SearchPolicies): string[] {
    const args = ['--no-config', '--no-follow', '--no-mmap', '--color', 'never', '--glob', '!.git', '--glob', '!**/.git/**'];
    if (request.includeIgnored) args.push('--no-ignore');
    if (request.includeHidden) args.push('--hidden');
    for (const pattern of request.exclude ?? []) { if (pattern.includes('\0')) throw new Error('Invalid exclude pattern'); args.push('--glob', '!' + pattern); }
    return args;
  }
  private async validateScope(scope: Scope): Promise<void> {
    await this.files.absolutePath(scope.rootId, '');
    await this.files.absolutePath(scope.rootId, scope.validationPath);
  }
  private async run(scope: Scope, args: string[], separator: string, signal: AbortSignal | undefined, onRecord: (record: string) => boolean): Promise<RunResult> {
    const directory = await fs.open(scope.root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      await this.validateScope(scope);
      const opened = await directory.stat(); const current = await fs.lstat(scope.root);
      if (opened.ino !== current.ino || opened.dev !== current.dev) throw new Error('Search directory changed before launch');
      // Linux cwd resolves a held parent descriptor, so a path replacement cannot retarget rg.
      const cwd = process.platform === 'linux' ? '/proc/' + process.pid + '/fd/' + directory.fd : scope.root;
      return await this.runProcess(scope, args, separator, signal, onRecord, cwd);
    } finally { await directory.close(); }
  }
  private runProcess(scope: Scope, args: string[], separator: string, signal: AbortSignal | undefined, onRecord: (record: string) => boolean, cwd: string): Promise<RunResult> {
    if (signal?.aborted) return Promise.resolve({ complete: false, cancelled: true });
    return new Promise(resolve => {
      let stopped = false; let cancelled = false; let ended = false; let stderr = ''; let totalBytes = 0; let pending = ''; let killTimer: ReturnType<typeof setTimeout> | undefined;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const child = spawn(this.rgPath, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RIPGREP_CONFIG_PATH: '' } });
      const stop = () => { stopped = true; child.kill('SIGTERM'); if (!killTimer) { killTimer = setTimeout(() => child.kill('SIGKILL'), 500); killTimer.unref(); } };
      const cancel = () => { cancelled = true; stop(); };
      const finish = (result: RunResult) => { if (ended) return; ended = true; if (killTimer) clearTimeout(killTimer); signal?.removeEventListener('abort', cancel); resolve(result); };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      child.stdout.pause();
      void this.validateScope(scope).then(() => child.stdout.resume(), error => { stderr += String(error); stop(); child.stdout.resume(); });
      child.stdout.on('data', (chunk: Buffer) => {
        if (stopped) return;
        totalBytes += chunk.length;
        if (totalBytes > 32 * 1024 * 1024) { stop(); return; }
        try { pending += decoder.decode(chunk, { stream: true }); } catch { stderr += 'Search output contains an unsupported non-UTF-8 filename'; stop(); return; }
        let index: number;
        while (!stopped && (index = pending.indexOf(separator)) >= 0) {
          const record = pending.slice(0, index); pending = pending.slice(index + separator.length);
          try { if (!onRecord(record)) stop(); }
          catch (error) { stderr += String(error); stop(); }
        }
        if (pending.length > 4 * 1024 * 1024) stop();
      });
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 65536) stderr += chunk.toString('utf8').slice(0, 65536 - stderr.length); });
      child.once('error', error => finish({ complete: false, cancelled, error: error.message }));
      child.once('close', code => {
        if (!stopped) {
          try { pending += decoder.decode(); } catch { stderr += 'Search output contains invalid UTF-8'; stopped = true; }
          if (pending) { try { if (!onRecord(pending)) stopped = true; } catch (error) { stderr += String(error); stopped = true; } }
        }
        finish({ complete: !stopped && (code === 0 || code === 1), cancelled, ...(stderr.trim() ? { error: stderr.trim() } : (code !== 0 && code !== 1 && !stopped ? { error: 'Search exited with code ' + code } : {})) });
      });
    });
  }
  private relative(scope: Scope, reported: string): string {
    const absolute = path.resolve(scope.root, reported);
    const relative = path.relative(scope.base, absolute);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || relative.split(path.sep).includes('.git')) throw new Error('Search returned a path outside its approved scope');
    return relative.split(path.sep).join('/');
  }
  async search(request: TextSearchRequest): Promise<TextSearchResult> {
    const matches: TextMatch[] = []; const errors: string[] = [];
    let complete = true; let cancelled = request.signal?.aborted === true;
    if (!request.query) throw new Error('Search query must not be empty');
    if (request.query.includes('\0') || request.query.length > 100_000) throw new Error('Invalid search query');
    const limit = Math.max(1, Math.min(request.maxResults ?? 1000, 100_000));
    for (const scope of await this.scopes(request)) {
      if (cancelled) { complete = false; break; }
      const args = [...this.policyArgs(request), ...(scope.include ? ['--glob', scope.include] : []), '--json', '--line-number', '--with-filename', '--max-filesize', String(Math.max(1, request.maxFileBytes ?? 2 * 1024 * 1024))];
      if (!request.regex) args.push('--fixed-strings');
      args.push(request.caseSensitive ? '--case-sensitive' : '--ignore-case', '--', request.query, ...scope.paths);
      const scopeStart = matches.length;
      const result = await this.run(scope, args, '\n', request.signal, record => {
        const event = JSON.parse(record) as { type: string; data?: { path?: { text?: string; bytes?: string }; lines?: { text?: string; bytes?: string }; line_number?: number; submatches?: { start: number; end: number }[] } };
        if (event.type !== 'match' || !event.data) return true;
        const data = event.data;
        const reportedPath = data.path?.text ?? (data.path?.bytes ? Buffer.from(data.path.bytes, 'base64').toString('utf8') : undefined);
        const lineText = data.lines?.text ?? (data.lines?.bytes ? Buffer.from(data.lines.bytes, 'base64').toString('utf8') : undefined);
        if (!reportedPath || lineText === undefined) throw new Error('Unreadable search result');
        if (data.path?.bytes) {
          try { new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(data.path.bytes, 'base64')); } catch { throw new Error('Search returned an unsupported non-UTF-8 filename'); }
        }
        const relative = this.relative(scope, reportedPath);
        const bytes = Buffer.from(lineText);
        for (const submatch of data.submatches ?? []) {
          if (matches.length >= limit) return false;
          matches.push({ rootId: scope.rootId, path: relative, line: data.line_number ?? 1, column: bytes.subarray(0, submatch.start).toString('utf8').length, text: lineText.replace(/\r?\n$/, ''), matchLength: submatch.end - submatch.start });
        }
        return true;
      });
      try { await this.validateScope(scope); } catch (error) { result.complete = false; result.error = String(error); matches.splice(scopeStart); }
      complete &&= result.complete;
      cancelled ||= result.cancelled;
      if (result.error) { errors.push(result.error); complete = false; }
      if (!result.complete && matches.length >= limit) break;
    }
    return { matches, complete: complete && !cancelled, cancelled, errors };
  }
  async findFiles(request: FileSearchRequest = {}, onBatch?: (files: FileMatch[]) => void): Promise<FileSearchResult> {
    const files: FileMatch[] = []; const errors: string[] = [];
    let complete = true; let cancelled = request.signal?.aborted === true;
    const limit = Math.max(1, Math.min(request.maxResults ?? 2000, 100_000));
    const query = (request.query ?? '').toLocaleLowerCase();
    let batch: FileMatch[] = [];
    const flush = () => { if (batch.length) { onBatch?.(batch); batch = []; } };
    for (const scope of await this.scopes(request)) {
      if (cancelled) { complete = false; break; }
      const encountered: FileMatch[] = [];
      this.filenameIndex.set(scope.rootId, encountered);
      const args = [...this.policyArgs(request), ...(scope.include ? ['--glob', scope.include] : []), '--files', '--null', '--', ...scope.paths];
      const result = await this.run(scope, args, '\0', request.signal, record => {
        const relative = this.relative(scope, record);
        const entry = { rootId: scope.rootId, path: relative };
        if (encountered.length < 100_000) encountered.push(entry);
        if (!relative.toLocaleLowerCase().includes(query)) return true;
        if (files.length >= limit) return false;
        files.push(entry); batch.push(entry);
        // Deliver batches only after scope ownership is revalidated below.
        return true;
      });
      try { await this.validateScope(scope); } catch (error) { result.complete = false; result.error = String(error); files.splice(files.length - batch.length); batch = []; this.filenameIndex.delete(scope.rootId); }
      const pendingBatch = batch; batch = [];
      for (let index = 0; index < pendingBatch.length; index += 100) { batch = pendingBatch.slice(index, index + 100); flush(); }
      complete &&= result.complete;
      cancelled ||= result.cancelled;
      if (result.error) { errors.push(result.error); complete = false; }
      if (!result.complete && files.length >= limit) break;
    }
    return { files, complete: complete && !cancelled, cancelled, errors };
  }
}
