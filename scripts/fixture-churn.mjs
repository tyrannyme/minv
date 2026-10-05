import { execFile } from 'node:child_process';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0' });
async function git(cwd, ...args) {
  return (await execute('git', ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, env: environment, timeout: 30_000 })).stdout.trim();
}

/** Only accepts the generator's disposable fixture; always restores original file bytes and HEAD. */
export async function prepareChurn(root, manifest, repositoryCount = 16) {
  if (manifest.version !== 1 || manifest.seed !== 20261005) throw new Error('Churn requires a Minv-generated disposable fixture');
  const repositories = [];
  for (const entry of manifest.repositories.slice(0, repositoryCount)) {
    const cwd = path.resolve(root, entry.path);
    if (!cwd.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid fixture path');
    const files = [];
    for (let i = 0; i < Math.min(64, entry.dataFiles); i++) {
      const file = path.join(cwd, 'src', '00000', `f${String(i).padStart(7, '0')}.txt`);
      const destination = `${file}.minv-benchmark-rename`;
      try { await lstat(destination); throw new Error(`Churn destination already exists: ${destination}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const info = await lstat(file);
      if (!info.isFile()) throw new Error('Churn data files must be ordinary files');
      files.push({ original: file, active: file, destination, contents: await readFile(file) });
    }
    if (!files.length) throw new Error('Fixture repository has no churn data files');
    const oid = await git(cwd, 'rev-parse', 'HEAD');
    const branch = await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => undefined);
    const temporaryBranch = `minv-benchmark-churn-${process.pid}`;
    if (await git(cwd, 'branch', '--list', temporaryBranch)) throw new Error('Temporary churn branch already exists');
    repositories.push({ cwd, files, oid, branch, temporaryBranch, branchCreated: false, branchActive: false });
  }
  let restored = false;
  return {
    repositories: repositories.map(repository => repository.cwd),
    async run({ rate = 1000, seconds = 30, onMutation = () => {}, onBranch = () => {}, signal } = {}) {
      if (restored) throw new Error('Churn workload already restored');
      if (!Number.isSafeInteger(rate) || rate < 1 || rate > 10_000 || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300) throw new Error('Invalid churn workload bounds');
      const total = rate * seconds;
      const startedAt = performance.now();
      let writes = 0;
      let renames = 0;
      let branchSwitches = 0;
      let maximumSchedulingLagMs = 0;
      for (let start = 0; start < total; start += 10) {
        signal?.throwIfAborted();
        const deadline = startedAt + start / rate * 1000;
        const wait = deadline - performance.now();
        if (wait > 0) await delay(wait, undefined, { signal });
        maximumSchedulingLagMs = Math.max(maximumSchedulingLagMs, performance.now() - deadline);
        await Promise.all(Array.from({ length: Math.min(10, total - start) }, async (_, offset) => {
          const index = start + offset;
          const repository = repositories[index % repositories.length];
          const file = repository.files[Math.floor(index / repositories.length) % repository.files.length];
          const mutationStartedAt = performance.now();
          let kind = 'write';
          if (index % 50 === 0) {
            const target = file.active === file.original ? file.destination : file.original;
            await rename(file.active, target);
            file.active = target;
            renames++;
            kind = 'rename';
          } else {
            await writeFile(file.active, `Minv deterministic churn ${index}\n`);
            writes++;
          }
          onMutation({ repository: repository.cwd, file: file.active, kind, startedAt: mutationStartedAt, completedAt: performance.now() });
        }));
        if (start > 0 && start % rate === 0) {
          const repository = repositories[Math.floor(start / rate) % repositories.length];
          if (!repository.branchCreated) { await git(repository.cwd, 'branch', repository.temporaryBranch, repository.oid); repository.branchCreated = true; }
          const branchStartedAt = performance.now();
          if (!repository.branchActive) await git(repository.cwd, 'switch', '--quiet', repository.temporaryBranch);
          else if (repository.branch) await git(repository.cwd, 'switch', '--quiet', repository.branch);
          else await git(repository.cwd, 'switch', '--quiet', '--detach', repository.oid);
          repository.branchActive = !repository.branchActive;
          branchSwitches++;
          onBranch({ repository: repository.cwd, expectedBranch: repository.branchActive ? repository.temporaryBranch : repository.branch, startedAt: branchStartedAt, completedAt: performance.now() });
        }
      }
      const remaining = startedAt + seconds * 1000 - performance.now();
      if (remaining > 0) await delay(remaining, undefined, { signal });
      const durationMs = performance.now() - startedAt;
      return { requestedFileChangesPerSecond: rate, requestedSeconds: seconds, actualFileChanges: writes + renames, writes, renames, branchSwitches, repositories: repositories.length, durationMs, achievedFileChangesPerSecond: (writes + renames) / durationMs * 1000, maximumSchedulingLagMs };
    },
    async restore() {
      if (restored) return;
      const errors = [];
      for (const repository of repositories) {
        for (let start = 0; start < repository.files.length; start += 16) {
          const outcomes = await Promise.allSettled(repository.files.slice(start, start + 16).map(async file => {
            if (file.active !== file.original) { await rename(file.active, file.original); file.active = file.original; }
            await writeFile(file.original, file.contents);
          }));
          errors.push(...outcomes.filter(result => result.status === 'rejected').map(result => result.reason));
        }
        try {
          if (repository.branchActive) {
            if (repository.branch) await git(repository.cwd, 'switch', '--quiet', repository.branch);
            else await git(repository.cwd, 'switch', '--quiet', '--detach', repository.oid);
          }
          if (repository.branchCreated) await git(repository.cwd, 'branch', '-D', repository.temporaryBranch);
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Could not completely restore disposable churn fixture');
      restored = true;
    },
  };
}
