import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Interprocess gate shared by the launcher, application, and offline installer. */
export interface UpdateLease { release(): Promise<void> }

async function processBirth(pid: number): Promise<string | undefined> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(')') + 2).split(' ')[19]; // Linux stat field 22.
  } catch { return undefined; }
}
async function privateGate(dataDirectory: string): Promise<string> {
  const directory = path.join(path.resolve(dataDirectory), 'update-gate');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Update gate must be a private, user-owned directory.');
  return directory;
}
async function exclusivePresent(directory: string): Promise<boolean> {
  try { await stat(path.join(directory, 'installer')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function liveApplicationLeases(directory: string): Promise<string[]> {
  const live: string[] = [];
  for (const name of await readdir(directory)) {
    if (!/^app-[a-f0-9-]{36}$/.test(name)) continue;
    const file = path.join(directory, name);
    let lease: { pid: number; birth: string };
    try { lease = JSON.parse(await readFile(file, 'utf8')); }
    catch { live.push(name); continue; } // Unknown state cannot authorize an install.
    if (!Number.isSafeInteger(lease.pid) || lease.pid < 1 || !lease.birth) { live.push(name); continue; }
    // A crashed application may have unreviewed dirty recovery. Fail closed until
    // a human inspects it; an absent PID is not proof of a clean normal exit.
    live.push(name);
  }
  return live;
}
export async function acquireApplicationLease(dataDirectory: string): Promise<UpdateLease> {
  const directory = await privateGate(dataDirectory);
  if (await exclusivePresent(directory)) throw new Error('A release installation is in progress.');
  const birth = await processBirth(process.pid);
  if (!birth) throw new Error('Cannot establish Linux process identity for the update gate.');
  const file = path.join(directory, `app-${randomUUID()}`);
  await writeFile(file, JSON.stringify({ pid: process.pid, birth }), { flag: 'wx', mode: 0o600 });
  if (await exclusivePresent(directory)) { await rm(file, { force: true }); throw new Error('A release installation is in progress.'); }
  return { release: () => rm(file, { force: true }) };
}
export async function acquireInstallerLease(dataDirectory: string): Promise<UpdateLease> {
  const directory = await privateGate(dataDirectory);
  const lock = path.join(directory, 'installer');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another release installation is in progress.'); throw error; }
  try {
    const birth = await processBirth(process.pid);
    if (!birth) throw new Error('Cannot establish Linux process identity for the update gate.');
    const handle = await open(path.join(lock, 'owner.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, birth })); await handle.sync(); } finally { await handle.close(); }
    if ((await liveApplicationLeases(directory)).length) throw new Error('Close Minv normally before changing its release.');
    return { release: () => rm(lock, { recursive: true, force: true }) };
  } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
}

/** Inspect stale app leases; clearing is an explicit recovery action after reviewing drafts. */
export async function inspectStaleApplicationLeases(dataDirectory: string, clear = false): Promise<{ stale: string[]; recoveryPresent: boolean }> {
  const directory = await privateGate(dataDirectory);
  if (await exclusivePresent(directory)) throw new Error('Cannot inspect app leases while an installer is active.');
  const stale: string[] = [];
  for (const name of await readdir(directory)) {
    if (!/^app-[a-f0-9-]{36}$/.test(name)) continue;
    let lease: { pid: number; birth: string };
    try { lease = JSON.parse(await readFile(path.join(directory, name), 'utf8')); }
    catch { throw new Error('Unreadable app lease requires manual investigation.'); }
    if (!Number.isSafeInteger(lease.pid) || lease.pid < 1 || typeof lease.birth !== 'string') throw new Error('Invalid app lease requires manual investigation.');
    if (await processBirth(lease.pid) !== lease.birth) stale.push(name);
  }
  const recovery = path.join(path.resolve(dataDirectory), 'recovery');
  const recoveryPresent = (await readdir(recovery).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; })).length > 0;
  if (clear) {
    // Recheck identities immediately before removal. This only removes Minv's own
    // lease markers, never recovery drafts, workspaces, or Git lockfiles.
    for (const name of stale) {
      const file = path.join(directory, name);
      const lease = JSON.parse(await readFile(file, 'utf8')) as { pid: number; birth: string };
      if (await processBirth(lease.pid) === lease.birth) throw new Error('Application restarted; stale-lease cleanup cancelled.');
      await rm(file);
    }
  }
  return { stale, recoveryPresent };
}
