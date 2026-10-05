#!/usr/bin/env node
import { createRequire } from 'node:module';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readFixture } from './fixture.mjs';
import { prepareChurn } from './fixture-churn.mjs';
import { machineInfo, sampleProcessTree, summarize } from './bench-support.mjs';
import { sessionAdapter } from './bench-session-adapter.mjs';

const require = createRequire(import.meta.url);
async function until(condition, timeoutMs = 10_000) {
  const startedAt = performance.now();
  while (!condition()) {
    if (performance.now() - startedAt > timeoutMs) return false;
    await delay(20);
  }
  return true;
}
function normalized(status) {
  return JSON.stringify(status?.changes?.map(change => ({ path: change.path, originalPath: change.originalPath, index: change.index, workingTree: change.workingTree, submodule: change.submodule })).sort((a, b) => a.path.localeCompare(b.path)));
}
async function main() {
  const options = { iterations: 1, seconds: 30, rate: 1000, idle: 60, engine: 'session' };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--fixture', '--json', '--iterations', '--seconds', '--rate', '--idle', '--engine'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/bench-churn.mjs --fixture DIRECTORY [--json NEW_FILE] [--iterations 1] [--seconds 30] [--rate 1000] [--idle 60] [--engine session|prototype]');
    const key = args[i].slice(2);
    options[key] = ['iterations', 'seconds', 'rate', 'idle'].includes(key) ? Number(args[i + 1]) : args[i + 1];
  }
  if (!options.fixture || !Number.isSafeInteger(options.iterations) || options.iterations < 1 || options.iterations > 30 || !Number.isSafeInteger(options.idle) || options.idle < 0 || options.idle > 300) throw new Error('Invalid churn benchmark options');
  const progressPath = options.json ? `${path.resolve(options.json)}.progress.ndjson` : undefined;
  if (progressPath) await writeFile(progressPath, '', { flag: 'wx' });
  const root = path.resolve(options.fixture);
  const manifest = await readFixture(root);
  const { Git } = require('../dist/src/core/git.js');
  const { readBranch } = require('../dist/src/core/catalog.js');
  const { readStatus } = require('../dist/src/core/status.js');
  const { RepositoryController } = require('../dist/src/controller.js');
  const { WatchCoordinator } = require('../dist/desktop/main/watcher.js');
  const traces = [];
  const git = new Git({ onCommand: event => traces.push(event) });
  const temporary = await mkdtemp(path.join(root, '.minv-churn-'));
  const errors = [];
  if (!['session', 'prototype'].includes(options.engine)) throw new Error('Unknown benchmark engine');
  const adapter = options.engine === 'session' ? await sessionAdapter(git, temporary, manifest.roots.map(relative => path.join(root, relative)), errors) : undefined;
  const controller = adapter?.controller ?? new RepositoryController(git, path.join(temporary, 'catalog.json'));
  const watcher = adapter?.watcher ?? new WatchCoordinator(git);
  const branchEvents = new Map();
  const sampler = sampleProcessTree(process.pid, 1000);
  let workload;
  let probes;
  const abort = new AbortController();
  const abortHandler = () => abort.abort(new Error('Benchmark interrupted'));
  process.once('SIGINT', abortHandler);
  process.once('SIGTERM', abortHandler);
  try {
    controller.on('problem', error => errors.push(String(error)));
    watcher.on('degraded', event => errors.push(event.error));
    watcher.on('invalidation', event => {
      for (const item of event.branchMetadata ?? []) {
        if (!branchEvents.has(item.id)) branchEvents.set(item.id, []);
        const history = branchEvents.get(item.id);
        history.push(item.deliveredAt);
        if (history.length > 1000) history.shift();
      }
      for (const id of event.ids) controller.invalidate(id, event.metadataIds?.includes(id) === false ? ['status'] : ['branch', 'status']);
    });
    const openAt = performance.now();
    await controller.open(manifest.roots.map(relative => path.join(root, relative)));
    const controllerOpenMs = performance.now() - openAt;
    const repositories = controller.rows.map(row => row.repository);
    const selected = repositories.find(repository => repository.root === path.join(root, manifest.repositories[1]?.path ?? manifest.repositories[0].path));
    if (!selected) throw new Error('Representative fixture repository was not discovered');
    controller.select(selected.id);
    if (!await until(() => controller.get(selected.id).status.state === 'observed')) throw new Error('Initial selected status did not converge');
    const watchAt = performance.now();
    watcher.setRepositories(repositories);
    watcher.watchRoots(manifest.roots.map(relative => path.join(root, relative)));
    const watchRegistrationMs = performance.now() - watchAt;
    if (!await until(() => !watcher.snapshot().initializing, 60_000)) throw new Error('Watcher registration did not settle');
    const watchReadyMs = performance.now() - watchAt;
    await delay(500);
    if (!await until(() => controller.rows.filter(row => row.repository.available).every(row => row.branch.state === 'observed') && controller.get(selected.id).status.state === 'observed', 30_000)) throw new Error('Controller did not settle after watcher registration');
    const idleCpu = process.cpuUsage();
    const idleTraceStart = traces.length;
    const idleAt = performance.now();
    await delay(options.idle * 1000, undefined, { signal: abort.signal });
    const idleDurationMs = performance.now() - idleAt;
    const idleCpuUsed = process.cpuUsage(idleCpu);
    const idle = { durationMs: idleDurationMs, cpuMicroseconds: idleCpuUsed, percentOfOneCore: (idleCpuUsed.user + idleCpuUsed.system) / (idleDurationMs * 1000) * 100, gitProcesses: traces.length - idleTraceStart, scope: 'Node controller/watcher process including 1 Hz resource sampler; not desktop/Electron idle CPU' };
    const runs = [];
    for (let iteration = 0; iteration < options.iterations; iteration++) {
      workload = await prepareChurn(root, manifest, 16);
      const metadataSamples = [];
      const branchDeliverySamples = [];
      const pendingBranches = new Map();
      let selectedObservations = 0;
      let selectedValues = 0;
      const selectedValueStates = {};
      let lastObservedAt = controller.get(selected.id).status.observedAt;
      let pendingProbe = false;
      let missingBranchEvents = 0;
      let supersededBranchObservations = 0;
      const eventsBefore = watcher.snapshot();
      const loop = monitorEventLoopDelay({ resolution: 20 });
      loop.enable();
      const onChange = () => {
        const row = controller.get(selected.id);
        if (row.status.value && row.status.observedAt !== lastObservedAt) {
          selectedValues++;
          selectedValueStates[row.status.state] = (selectedValueStates[row.status.state] ?? 0) + 1;
          if (row.status.state === 'observed') selectedObservations++;
          lastObservedAt = row.status.observedAt;
        }
        for (const [id, expected] of pendingBranches) {
          const branch = controller.get(id).branch;
          if (branch.state === 'observed' && branch.value?.name === expected.name && branch.observedAt >= expected.epoch) {
            const deliveredAt = branchEvents.get(id)?.find(value => value >= expected.startedAt);
            if (deliveredAt !== undefined) branchDeliverySamples.push(performance.now() - deliveredAt);
            else missingBranchEvents++;
            pendingBranches.delete(id);
          }
        }
      };
      controller.on('change', onChange);
      probes = setInterval(async () => {
        if (pendingProbe) return;
        pendingProbe = true;
        const startedAt = performance.now();
        try { await readBranch(selected, git); metadataSamples.push(performance.now() - startedAt); }
        catch (error) { errors.push(String(error)); }
        finally { pendingProbe = false; }
      }, 500);
      let actualWorkload;
      try {
        actualWorkload = await workload.run({ rate: options.rate, seconds: options.seconds, signal: abort.signal, onBranch: event => {
          const repository = repositories.find(item => item.root === event.repository);
          if (pendingBranches.has(repository.id)) supersededBranchObservations++;
          pendingBranches.set(repository.id, { name: event.expectedBranch, startedAt: event.startedAt, epoch: Date.now() - performance.now() + event.startedAt });
          onChange();
        } });
      } finally { clearInterval(probes); probes = undefined; loop.disable(); }
      const burstEndedAt = performance.now();
      const observedDuringBurst = selectedObservations;
      const valuesDuringBurst = selectedValues;
      const statesDuringBurst = { ...selectedValueStates };
      const expected = await readStatus(selected, git);
      const converged = await until(() => {
        const status = controller.get(selected.id).status;
        return status.state === 'observed' && normalized(status.value) === normalized(expected);
      });
      const convergenceMs = performance.now() - burstEndedAt;
      await until(() => pendingBranches.size === 0, 1000);
      controller.off('change', onChange);
      runs.push({ iteration: iteration + 1, workload: actualWorkload, metadataRequestMs: summarize(metadataSamples), branchFromNativeEventMs: summarize(branchDeliverySamples), undeliveredBranchObservations: pendingBranches.size, supersededBranchObservations, missingBranchEvents, selectedObservedUpdatesDuringBurst: observedDuringBurst, selectedPublishedValuesDuringBurst: valuesDuringBurst, selectedValueStatesDuringBurst: statesDuringBurst, selectedStatusConverged: converged, selectedStatusConvergenceMs: convergenceMs, eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p95: loop.percentile(95) / 1e6, max: loop.max / 1e6, scope: 'Node event-loop scheduling only; not painted input latency' }, watcherBefore: eventsBefore, watcherAfter: watcher.snapshot() });
      if (progressPath) await appendFile(progressPath, `${JSON.stringify(runs.at(-1))}\n`);
      console.error(JSON.stringify({ iteration: iteration + 1, total: options.iterations, rate: actualWorkload.achievedFileChangesPerSecond, selectedObservedUpdates: selectedObservations, converged, convergenceMs }));
      await workload.restore();
      workload = undefined;
      await delay(500);
    }
    const report = { schemaVersion: 2, timestamp: new Date().toISOString(), engine: options.engine, scope: `${options.engine === 'session' ? 'Actual desktop WorkspaceSession and its WatchCoordinator' : 'Prototype RepositoryController and actual WatchCoordinator'} with real Git, outside Electron; no UI or complete product budget verdict`, fixture: { profile: manifest.profile, counts: manifest.counts }, machine: await machineInfo(root, (await git.run(root, ['--version'], { lane: 'metadata' })).stdout.trim()), controllerOpenMs, watchRegistrationMs: adapter ? undefined : watchRegistrationMs, watchReadyMs: adapter ? undefined : watchReadyMs, monitoringReadyFromOpenMs: adapter ? controllerOpenMs + watchReadyMs : undefined, idle, runs, errors, resources: await sampler.stop(), finalWatcher: watcher.snapshot(), releaseEvidence: false };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.json) await writeFile(path.resolve(options.json), json, { flag: 'wx' });
    if (progressPath) await rm(progressPath);
    console.log(json);
  } finally {
    if (probes) clearInterval(probes);
    watcher.dispose();
    await controller.dispose();
    if (workload) await workload.restore();
    git.dispose();
    await sampler.stop();
    await rm(temporary, { recursive: true, force: true });
    process.off('SIGINT', abortHandler);
    process.off('SIGTERM', abortHandler);
  }
}
main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
