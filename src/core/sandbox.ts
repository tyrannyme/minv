import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/** These paths are application-owned launch configuration, never workspace settings. */
export interface SandboxLaunch { executable: string; args: string[] }

export async function resolveExecutable(executable: string, cwd: string): Promise<string> {
  const candidates = executable.includes(path.sep)
    ? [path.resolve(cwd, executable)]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory, executable));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Try the next trusted executable directory. */ }
  }
  throw new Error(`Git executable is unavailable: ${executable}`);
}

export async function confinedLaunch(executable: string, cwd: string, args: readonly string[], launcher?: string): Promise<SandboxLaunch> {
  if (process.platform !== 'linux') throw new Error('Confined passive Git reads currently require Linux with Landlock ABI 6 and seccomp notifications.');
  const sandbox = launcher ?? path.resolve(__dirname, '../../native/minv-git-sandbox');
  try { await access(sandbox, constants.X_OK); }
  catch { throw new Error('Minv Git confinement is unavailable. Build or reinstall its native Linux sandbox; passive reads will not run without it.'); }
  return { executable: sandbox, args: [await resolveExecutable(executable, cwd), ...args] };
}
