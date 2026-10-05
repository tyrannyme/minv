import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GitOptions, GitResult, GitRunner } from './types';
import { confinedLaunch } from './sandbox';
import { redactSensitiveText } from './redact';

interface Job {
  cwd: string; args: readonly string[]; options: GitOptions; controller: AbortController;
  queuedAt: number; startedAt?: number;
  resolve(result: GitResult): void; reject(error: Error): void; cleanup(): void;
}

const READ_COMMANDS = new Set(['--version', 'version', 'rev-parse', 'symbolic-ref', 'config', 'status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'cat-file', 'show-ref', 'check-attr', 'check-ignore', 'for-each-ref', 'reflog', 'check-ref-format', 'diff-tree', 'merge-base', 'remote']);
const SAFE_CONFIG = [
  'core.fsmonitor=false', `core.hooksPath=${os.devNull}`, 'core.pager=', 'color.ui=false',
  'log.showSignature=false', 'diff.external=', 'core.sshCommand=false', 'credential.helper=',
  'protocol.allow=never', ...['file', 'git', 'ssh', 'http', 'https', 'ext'].map(protocol => `protocol.${protocol}.allow=never`),
];

function environment(passive: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_') && !key.startsWith('LD_') && !['GCONV_PATH', 'GLIBC_TUNABLES'].includes(key)) env[key] = value;
  }
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: '', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' });
  if (passive) Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_LFS_SKIP_SMUDGE: '1' });
  return env;
}

function commandIndex(args: readonly string[]): number { return args[0] === '--literal-pathspecs' ? 1 : 0; }
function validate(args: readonly string[], write: boolean): void {
  if (!args.length || args.some(argument => argument.includes('\0'))) throw new Error('Invalid Git arguments.');
  if (write) return;
  const index = commandIndex(args);
  const command = args[index]!;
  if (!READ_COMMANDS.has(command)) throw new Error(`Git command requires an explicit trusted write: ${command}`);
  const options = args.slice(index + 1, args.indexOf('--') === -1 ? undefined : args.indexOf('--'));
  if (options.some(option => ['--ext-diff', '--textconv', '--output', '--exec-path', '--show-signature', '--recurse-submodules'].some(flag => option === flag || option.startsWith(`${flag}=`))
    || (/^--(?:format|pretty)=/.test(option) && option.includes('%G')))) {
    throw new Error('Executable helpers and file output are disabled for passive Git reads.');
  }
  if (command === 'symbolic-ref' && (options.filter(option => !option.startsWith('-')).length !== 1 || options.includes('--delete') || options.includes('-d'))) throw new Error('Only symbolic-ref inspection is allowed.');
  if (command === 'config' && !options.some(option => ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'].includes(option))) throw new Error('Only Git configuration reads are allowed.');
  if (command === 'remote' && options[0] !== 'get-url') throw new Error('Only remote URL inspection is allowed without a trusted write.');
  if (command === 'reflog' && options.some(option => ['delete', 'drop', 'expire', 'write'].includes(option))) throw new Error('Only reflog inspection is allowed without a trusted write.');
}

export interface GitCommandTrace { command: string; lane: 'metadata' | 'foreground' | 'background'; queueMs: number; durationMs: number; exitCode?: number; bytes: number }

/** Bounded Git execution with a metadata slot independent of foreground/background work. */
export class Git implements GitRunner {
  private readonly executable: string;
  private readonly sandboxExecutable?: string;
  private readonly onCommand?: (trace: GitCommandTrace) => void;
  private readonly queues: Record<'metadata' | 'foreground' | 'background', Job[]> = { metadata: [], foreground: [], background: [] };
  private readonly active = new Set<Job>();
  private readonly locks = new Set<string>();
  private readonly reads = new Map<string, Promise<GitResult>>();
  private metadataActive = 0;
  private contentActive = 0;
  private foregroundBurst = 0;
  private disposed = false;

  constructor(options: { executable?: string; sandboxExecutable?: string; onCommand?: (trace: GitCommandTrace) => void } = {}) {
    this.executable = options.executable ?? 'git'; this.sandboxExecutable = options.sandboxExecutable; this.onCommand = options.onCommand;
  }

  async run(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
    validate(args, Boolean(options.write));
    if (this.disposed) throw new Error('Git runner is disposed.');
    if (options.signal?.aborted) throw new Error('Git request canceled.');
    if (options.write) {
      let key = options.lockKey;
      if (!key) {
        const directory = await this.run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { lane: 'metadata' });
        if (directory.exitCode !== 0) return directory;
        key = directory.stdout.replace(/\n$/, '');
      }
      options = { ...options, lane: 'foreground', lockKey: await realpath(key).catch(() => path.resolve(cwd, key!)) };
    }
    const coalesceKey = !options.write && !options.signal ? JSON.stringify([cwd, args, options]) : undefined;
    if (coalesceKey && this.reads.has(coalesceKey)) return this.reads.get(coalesceKey)!;
    const pending = new Promise<GitResult>((resolve, reject) => {
      if (this.disposed) { reject(new Error('Git runner is disposed.')); return; }
      if (Object.values(this.queues).reduce((sum, queue) => sum + queue.length, 0) >= 2048) { reject(new Error('Git request queue is full.')); return; }
      const controller = new AbortController();
      const job: Job = { cwd, args: [...args], options, controller, resolve, reject, queuedAt: performance.now(), cleanup: () => options.signal?.removeEventListener('abort', abort) };
      const abort = () => {
        // Once dispatched, writes run to completion even if UI selection changes.
        if (options.write && this.active.has(job)
          && !(options.cancelActiveWrite && ['fetch', 'push'].includes(args[commandIndex(args)]!))) return;
        controller.abort();
        const queue = this.queues[options.lane ?? 'foreground'];
        const position = queue.indexOf(job);
        if (position !== -1) { queue.splice(position, 1); job.cleanup(); reject(new Error('Git request canceled.')); }
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      this.queues[options.lane ?? 'foreground'].push(job);
      if (options.signal?.aborted) abort();
      this.pump();
    });
    if (coalesceKey) {
      this.reads.set(coalesceKey, pending);
      void pending.finally(() => { this.reads.delete(coalesceKey); }).catch(() => undefined);
    }
    return pending;
  }

  dispose(): void {
    this.disposed = true;
    for (const queue of Object.values(this.queues)) {
      for (const job of queue.splice(0)) { job.cleanup(); job.reject(new Error('Git runner is disposed.')); }
    }
    for (const job of this.active) if (!job.options.write) job.controller.abort();
  }

  private take(lane: 'metadata' | 'foreground' | 'background'): Job | undefined {
    const queue = this.queues[lane];
    const index = queue.findIndex(job => !job.options.lockKey || !this.locks.has(job.options.lockKey));
    return index === -1 ? undefined : queue.splice(index, 1)[0];
  }

  private pump(): void {
    if (this.disposed) return;
    while (this.metadataActive < 4) {
      const job = this.take('metadata');
      if (!job) break;
      this.metadataActive++; this.start(job, true);
    }
    while (this.contentActive < 4) {
      let job: Job | undefined;
      if (this.foregroundBurst >= 3) job = this.take('background');
      if (job) this.foregroundBurst = 0;
      else {
        job = this.take('foreground');
        if (job) this.foregroundBurst++;
        else { job = this.take('background'); this.foregroundBurst = 0; }
      }
      if (!job) break;
      this.contentActive++;
      this.start(job, false);
    }
  }

  private start(job: Job, metadata: boolean): void {
    job.startedAt = performance.now();
    this.active.add(job);
    if (job.options.lockKey) this.locks.add(job.options.lockKey);
    void this.execute(job).then(job.resolve, job.reject).finally(() => {
      job.cleanup(); this.active.delete(job);
      if (job.options.lockKey) this.locks.delete(job.options.lockKey);
      if (metadata) this.metadataActive--; else this.contentActive--;
      this.pump();
    });
  }

  private async execute(job: Job): Promise<GitResult> {
    if (job.options.write) return this.process(job, job.args, false);
    const index = commandIndex(job.args);
    const command = job.args[index]!;
    const args = [...job.args];
    const forced: string[] = [];
    if (['diff', 'diff-tree', 'log', 'show'].includes(command)) forced.push('--no-ext-diff', '--no-textconv', '--submodule=short');
    if (['diff', 'status'].includes(command)) forced.push('--ignore-submodules=dirty');
    if (['log', 'show'].includes(command)) forced.push('--no-show-signature');
    // Put forced options after caller options, before the path separator.
    const separator = args.indexOf('--');
    args.splice(separator === -1 ? args.length : separator, 0, ...forced);
    return this.process(job, ['--no-pager', ...SAFE_CONFIG.flatMap(value => ['-c', value]), ...args], true);
  }

  private async process(job: Job, args: readonly string[], passive: boolean): Promise<GitResult> {
    const launch = passive ? await confinedLaunch(this.executable, job.cwd, args, this.sandboxExecutable) : { executable: this.executable, args: [...args] };
    return new Promise((resolve, reject) => {
      if (job.controller.signal.aborted) { reject(new Error('Git request canceled.')); return; }
      const limit = job.options.maxBytes ?? 16 * 1024 * 1024;
      const timeoutMs = job.options.timeoutMs ?? (job.options.write ? 120_000 : 30_000);
      if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) { reject(new Error('Invalid Git execution limits.')); return; }
      const processStartedAt = performance.now();
      const child = spawn(launch.executable, launch.args, { cwd: job.cwd, env: environment(passive), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      let bytes = 0; let failure: Error | undefined; let escalation: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
      };
      const stop = (reason: string) => {
        if (failure) return;
        failure = new Error(`${reason}${job.options.write ? ' Write outcome may be uncertain; inspect repository state before retrying.' : ''}`);
        kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 250); escalation.unref();
      };
      const timer = setTimeout(() => stop('Git command timed out.'), timeoutMs); timer.unref();
      const abort = () => stop('Git request canceled.');
      job.controller.signal.addEventListener('abort', abort, { once: true });
      for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]] as const) stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) stop('Git output limit exceeded; result is incomplete.');
        else if (!failure) chunks.push(chunk);
      });
      child.once('error', error => { failure = error; });
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop('Cannot provide Git input.'); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); if (escalation) clearTimeout(escalation);
        job.controller.signal.removeEventListener('abort', abort);
        try { this.onCommand?.({ command: job.args[commandIndex(job.args)]!, lane: job.options.lane ?? 'foreground', queueMs: (job.startedAt ?? job.queuedAt) - job.queuedAt, durationMs: performance.now() - processStartedAt, ...(code === null ? {} : { exitCode: code }), bytes }); } catch { /* Diagnostics must never affect Git behavior. */ }
        if (failure) reject(failure);
        else if (code === null) reject(new Error(`Git terminated by ${signal ?? 'an unknown signal'}.`));
        else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: redactSensitiveText(Buffer.concat(stderr).toString('utf8')), exitCode: code });
      });
      child.stdin.end(job.options.input);
    });
  }
}
