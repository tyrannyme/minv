import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export function summarize(samples) {
  if (!samples.length) return { unit: 'ms', count: 0, p50: null, p95: null, worst: null, samples: [] };
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return { unit: 'ms', count: samples.length, p50: percentile(0.5), p95: percentile(0.95), worst: sorted.at(-1), samples };
}
async function command(executable, args) {
  try { return (await execute(executable, args, { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
  catch { return undefined; }
}
export async function machineInfo(root, gitVersion) {
  const filesystem = await statfs(root);
  const info = { platform: process.platform, architecture: process.arch, kernel: os.release(), node: process.version, git: gitVersion, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), filesystemType: `0x${filesystem.type.toString(16)}`, filesystemBlockBytes: filesystem.bsize, availableDiskBytes: filesystem.bavail * filesystem.bsize, securitySoftware: 'Not automatically identified; no security-software configuration was changed' };
  if (process.platform === 'linux') {
    const mount = await command('findmnt', ['--json', '-T', root, '-o', 'SOURCE,FSTYPE,TARGET,OPTIONS']);
    const devices = await command('lsblk', ['--json', '-d', '-o', 'NAME,MODEL,SIZE,ROTA']);
    if (mount) info.mount = JSON.parse(mount).filesystems?.[0];
    if (devices) info.devices = JSON.parse(devices).blockdevices;
  }
  return info;
}
export async function childCpuSnapshot() {
  if (process.platform !== 'linux') return undefined;
  const [stat, clock] = await Promise.all([readFile('/proc/self/stat', 'utf8'), command('getconf', ['CLK_TCK'])]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { childUserTicks: Number(fields[13]), childSystemTicks: Number(fields[14]), clockTicksPerSecond: Number(clock ?? 100) };
}
export function childCpuDelta(before, after) {
  if (!before || !after) return undefined;
  return { user: (after.childUserTicks - before.childUserTicks) / after.clockTicksPerSecond * 1_000_000, system: (after.childSystemTicks - before.childSystemTicks) / after.clockTicksPerSecond * 1_000_000 };
}

/** Linux-only sampled sum; short-lived children can disappear between samples. */
export function sampleProcessTree(rootPid = process.pid, intervalMs = 100) {
  const samples = [];
  let busy = false;
  let stopped = false;
  let result;
  let pending = Promise.resolve();
  async function sample() {
    if (busy || process.platform !== 'linux') return;
    busy = true;
    try {
      const pendingPids = [rootPid];
      const seen = new Set();
      let rssBytes = 0;
      let pssBytes = 0;
      let count = 0;
      while (pendingPids.length && seen.size < 512) {
        const pid = pendingPids.shift();
        if (seen.has(pid)) continue;
        seen.add(pid);
        try {
          const [status, smaps, children] = await Promise.all([
            readFile(`/proc/${pid}/status`, 'utf8'),
            readFile(`/proc/${pid}/smaps_rollup`, 'utf8').catch(() => ''),
            readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => ''),
          ]);
          rssBytes += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
          pssBytes += Number(/^Pss:\s+(\d+)/m.exec(smaps)?.[1] ?? 0) * 1024;
          count++;
          pendingPids.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
        } catch { /* A process can exit during sampling. */ }
      }
      samples.push({ elapsedMs: performance.now() - startedAt, processCount: count, rssBytes, pssBytes });
    } finally { busy = false; }
  }
  const startedAt = performance.now();
  const timer = setInterval(() => { if (!stopped && !busy) pending = sample(); }, intervalMs);
  timer.unref();
  return { async stop() {
    if (result) return result;
    stopped = true;
    clearInterval(timer);
    await pending;
    await sample();
    result = { scope: 'Sampled sum across benchmark Node and live descendant processes; excludes already exited children; not Electron application resources', intervalMs, samples, peakRssBytes: Math.max(0, ...samples.map(item => item.rssBytes)), peakPssBytes: Math.max(0, ...samples.map(item => item.pssBytes)), peakProcesses: Math.max(0, ...samples.map(item => item.processCount)), accounting: 'RSS sums shared pages more than once; PSS apportions shared pages using Linux smaps_rollup. Samples can miss short-lived processes.' };
    return result;
  } };
}
