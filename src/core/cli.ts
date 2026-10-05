import { statSync } from 'node:fs';
import { link, lstat, realpath, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export { acquireApplicationLease } from './update-lease';

export interface CliFile {
  path: string;
  /** One-based editor coordinates. */
  line?: number;
  column?: number;
}

export interface CliLaunchRequest {
  kind: 'launch';
  roots: string[];
  /** True only for positional directories or --repo, not an inferred cwd root. */
  rootsExplicit: boolean;
  files: CliFile[];
  repository?: string;
  diff?: { before: string; after: string };
  wait: boolean;
  reuseWindow: boolean;
  newWindow: boolean;
}

export type CliRequest = CliLaunchRequest | { kind: 'help' } | { kind: 'version' };

export const cliHelp = `Minv — Browse. Review. Commit.

Usage: minv [options] [folder | file ...]

  --goto, -g file:line[:column]  Open a file at a one-based position
  --repo path                  Open and select a repository
  --diff, -d before after       Compare two files
  --wait, -w                   Wait until the requested buffers close
  --reuse-window, -r           Reuse the existing window (default)
  --new-window, -n             Open a separate window
  --help, -h                   Print this help
  --version, -v                Print the application version
  --                           Treat remaining arguments as paths

Quote paths containing spaces. Use -- before paths beginning with a dash.
No arguments opens the current directory. Git must be installed separately.
`;

export class CliArgumentError extends Error {
  constructor(message: string) { super(message); this.name = 'CliArgumentError'; }
}

function absolutePath(value: string, cwd: string): string {
  if (!value || value.includes('\0')) throw new CliArgumentError('A nonempty path without NUL characters is required.');
  // Preserve native Windows paths even when requests are parsed on another OS.
  if (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) return path.win32.normalize(value);
  if (/^[a-z]:/i.test(value)) {
    throw new CliArgumentError(`Drive-relative paths are ambiguous: ${value}. Use a full drive path.`);
  }
  return /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith('\\\\')
    ? path.win32.resolve(cwd, value)
    : path.resolve(cwd, value);
}

function gotoFile(value: string, cwd: string): CliFile {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(value);
  if (!match || !match[1]) throw new CliArgumentError('--goto requires file:line[:column].');
  const line = Number(match[2]);
  const column = match[3] === undefined ? 1 : Number(match[3]);
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) {
    throw new CliArgumentError('--goto line and column must be positive safe integers.');
  }
  return { path: absolutePath(match[1], cwd), line, column };
}

/** Parse only argv supplied by the launcher, without executing a shell or changing cwd. */
export function parseCli(argv: readonly string[], cwd: string): CliRequest {
  const request: CliLaunchRequest = { kind: 'launch', roots: [], rootsExplicit: false, files: [], wait: false, reuseWindow: true, newWindow: false };
  let positional = false;
  let reuseExplicit = false;
  let informational: 'help' | 'version' | undefined;
  const addPath = (value: string) => {
    const absolute = absolutePath(value, cwd);
    let directory = false;
    try { directory = statSync(absolute).isDirectory(); } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (directory) { request.roots.push(absolute); request.rootsExplicit = true; }
    else request.files.push({ path: absolute });
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (positional) { addPath(argument); continue; }
    if (argument === '--') { positional = true; continue; }
    const separator = argument.indexOf('=');
    const option = argument.startsWith('--') && separator !== -1 ? argument.slice(0, separator) : argument;
    const inline = option !== argument ? argument.slice(separator + 1) : undefined;
    const value = () => {
      const next = inline ?? argv[++index];
      if (next === undefined || !next || (inline === undefined && next.startsWith('-'))) {
        throw new CliArgumentError(`${option} requires a path. Use ${option}=./-name for a path beginning with a dash.`);
      }
      return next;
    };
    if (inline !== undefined && option !== '--goto' && option !== '--repo') {
      throw new CliArgumentError(`${option} does not accept an equals value.`);
    }
    switch (option) {
      case '--help': case '-h':
      case '--version': case '-v': {
        const kind = option === '--help' || option === '-h' ? 'help' : 'version';
        if (informational && informational !== kind) throw new CliArgumentError('--help and --version cannot be combined.');
        informational = kind;
        break;
      }
      case '--goto': case '-g': request.files.push(gotoFile(value(), cwd)); break;
      case '--repo':
        if (request.repository) throw new CliArgumentError('--repo may be specified only once.');
        request.repository = absolutePath(value(), cwd);
        break;
      case '--diff': case '-d': {
        if (request.diff) throw new CliArgumentError('--diff may be specified only once.');
        const before = absolutePath(value(), cwd);
        const after = absolutePath(value(), cwd);
        request.diff = { before, after };
        break;
      }
      case '--wait': case '-w': request.wait = true; break;
      case '--reuse-window': case '-r': reuseExplicit = true; break;
      case '--new-window': case '-n': request.newWindow = true; request.reuseWindow = false; break;
      default:
        if (argument.startsWith('-')) throw new CliArgumentError(`Unknown option: ${argument}`);
        addPath(argument);
    }
  }
  if (informational) {
    if (argv.length !== 1) throw new CliArgumentError(`--${informational} must be used alone.`);
    return { kind: informational };
  }
  if (reuseExplicit && request.newWindow) throw new CliArgumentError('--new-window and --reuse-window cannot be combined.');
  if (request.wait && !request.files.length && !request.diff) throw new CliArgumentError('--wait requires a file, --goto, or --diff.');
  if (request.repository) { request.roots.push(request.repository); request.rootsExplicit = true; }
  if (!request.roots.length) request.roots.push(absolutePath('.', cwd));
  request.roots = [...new Set(request.roots)];
  return request;
}

export interface CliWaitTicket { file: string; token: string }

/** Pass this ticket in Electron's single-instance additionalData; never trust renderer input. */
export function cliWaitTicket(env: NodeJS.ProcessEnv = process.env): CliWaitTicket | undefined {
  const file = env.MINV_WAIT_FILE;
  const token = env.MINV_WAIT_TOKEN;
  if (!file && !token) return undefined;
  if (!file || !token || !/^[a-f0-9]{64}$/.test(token) || path.basename(file) !== 'closed') {
    throw new CliArgumentError('Invalid CLI wait ticket.');
  }
  const directory = path.dirname(file);
  if (!path.isAbsolute(file) || path.resolve(path.dirname(directory)) !== path.resolve(os.tmpdir()) ||
      !/^minv-wait-[A-Za-z0-9]+$/.test(path.basename(directory))) {
    throw new CliArgumentError('CLI wait tickets must use a private Minv temporary directory.');
  }
  return { file, token };
}

/** Called once every buffer belonging to a request has closed. Never overwrites an existing file. */
export async function signalCliWait(ticket: CliWaitTicket, failure?: string): Promise<void> {
  cliWaitTicket({ MINV_WAIT_FILE: ticket.file, MINV_WAIT_TOKEN: ticket.token });
  const directory = path.dirname(ticket.file);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (process.platform !== 'win32' && (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0))) {
    throw new CliArgumentError('CLI wait directory is not private and owned by the current user.');
  }
  const temporaryRoot = await realpath(os.tmpdir());
  if (path.dirname(await realpath(directory)) !== temporaryRoot) throw new CliArgumentError('CLI wait directory resolves outside the temporary directory.');
  // Publish a complete acknowledgement atomically; a polling launcher must never
  // mistake an opened-but-not-yet-written file for an invalid token.
  const temporary = `${ticket.file}.${ticket.token}.tmp`;
  await writeFile(temporary, ticket.token + (failure ? `\n${failure.slice(0, 4096)}` : ''), { flag: 'wx', mode: 0o600 });
  try { await link(temporary, ticket.file); }
  finally { await unlink(temporary); }
}
