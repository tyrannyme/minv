#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readFixture } from './fixture.mjs';
import { summarize, machineInfo, childCpuSnapshot, childCpuDelta, sampleProcessTree } from './bench-support.mjs';

const require = createRequire(import.meta.url);
function argumentsFor(argv) {
  const result = { iterations: 30 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--fixture', '--iterations', '--json'].includes(key) || !value || value.startsWith('--')) throw new Error(`Invalid argument ${key}`);
    result[key.slice(2)] = key === '--iterations' ? Number(value) : value;
  }
  if (!result.fixture) throw new Error('--fixture DIRECTORY is required');
  if (!Number.isSafeInteger(result.iterations) || result.iterations < 1 || result.iterations > 1000) throw new Error('--iterations must be an integer from 1 to 1000');
  return result;
}
async function measure(action) {
  const start = performance.now();
  const value = await action();
  return { ms: performance.now() - start, value };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/bench.mjs --fixture DIRECTORY [--iterations 30] [--json NEW_FILE]\nBuild first with npm run build. API/process timings only: no UI or release-budget claim.');
    return;
  }
  const options = argumentsFor(process.argv.slice(2));
  const root = path.resolve(options.fixture);
  const fixture = await readFixture(root);
  let core;
  try {
    core = { ...require('../dist/src/core/git.js'), ...require('../dist/src/core/catalog.js'), ...require('../dist/src/core/status.js') };
  } catch (error) { throw new Error(`Build Minv first with npm run build (${error.message})`); }
  const commandSamples = new Map();
  const processTraces = [];
  const rawGit = new core.Git({ onCommand: trace => processTraces.push(trace) });
  const git = { run: async (cwd, args, config) => {
    const startedAt = performance.now();
    try { return await rawGit.run(cwd, args, config); }
    finally {
      const name = `${config?.lane ?? 'foreground'}:${args[0] === '--literal-pathspecs' ? args[1] : args[0]}`;
      if (!commandSamples.has(name)) commandSamples.set(name, []);
      commandSamples.get(name).push(performance.now() - startedAt);
    }
  } };
  const temporary = await mkdtemp(path.join(root, '.minv-bench-'));
  const roots = fixture.roots.map(relative => path.join(root, relative));
  const samples = { catalogDiscovery: [], catalogCacheRead: [], selectedBranch: [], allAvailableBranches: [], selectedBranchWhileStatusHeld: [], selectedCompleteStatus: [], workspaceCompleteStatus: [] };
  const sourceHashes = Object.fromEntries(await Promise.all(['git', 'catalog', 'status'].map(async name => [name, createHash('sha256').update(await readFile(new URL(`../dist/src/core/${name}.js`, import.meta.url))).digest('hex')])));
  const machine = await machineInfo(root, (await git.run(root, ['--version'], { lane: 'metadata' })).stdout.trim());
  const childCpuBefore = await childCpuSnapshot();
  const sampler = sampleProcessTree();
  const cpuBefore = process.cpuUsage();
  const resourcesBefore = process.resourceUsage();
  const memoryBefore = process.memoryUsage();
  try {
    const repositories = await core.discoverRepositories(roots, git);
    const available = repositories.filter(repository => repository.available);
    if (available.some(repository => repository.error)) throw new Error(`Incomplete catalog discovery: ${available.filter(repository => repository.error).map(repository => repository.error).join('; ')}`);
    if (available.length !== fixture.counts.availableWorkspaceCheckouts || repositories.length !== fixture.counts.workspaceCatalogEntries) throw new Error(`Catalog mismatch: found ${available.length} available / ${repositories.length} entries; expected ${fixture.counts.availableWorkspaceCheckouts} / ${fixture.counts.workspaceCatalogEntries}`);
    const selected = available.find(repository => repository.root === path.join(root, fixture.repositories[1]?.path ?? fixture.repositories[0].path)) ?? available[0];
    await core.saveCatalog(path.join(temporary, 'catalog.json'), repositories);
    let heldStatusChecks = 0;
    for (let iteration = 0; iteration < options.iterations; iteration++) {
      const discovery = await measure(() => core.discoverRepositories(roots, git));
      if (discovery.value.length !== repositories.length || discovery.value.filter(repository => repository.available).length !== available.length || discovery.value.some(repository => repository.available && repository.error)) throw new Error('Catalog changed or became incomplete during benchmark');
      samples.catalogDiscovery.push(discovery.ms);
      const cached = await measure(() => core.loadCatalog(path.join(temporary, 'catalog.json')));
      if (cached.value.length !== repositories.length) throw new Error('Saved catalog could not be read completely');
      samples.catalogCacheRead.push(cached.ms);
      samples.selectedBranch.push((await measure(() => core.readBranch(selected, git))).ms);
      const branches = await measure(() => Promise.all(available.map(repository => core.readBranch(repository, git))));
      samples.allAvailableBranches.push(branches.ms);
      // Fault injection holds a sibling's status API at its GitRunner boundary.
      // This verifies service independence, not OS scheduling or UI latency.
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      let began;
      const statusBegan = new Promise(resolve => { began = resolve; });
      let statusFinished = false;
      const runner = { run: async (cwd, args, config) => {
        if (args.includes('status')) { began(); await gate; }
        return git.run(cwd, args, config);
      } };
      const held = core.readStatus(available[0], runner).finally(() => { statusFinished = true; });
      // Observe rejection immediately, including failures before status is invoked.
      const started = Promise.race([statusBegan, held.then(() => { throw new Error('Status completed without reaching the injected gate'); })]);
      try {
        await started;
        const branch = await measure(() => core.readBranch(selected, runner));
        if (statusFinished) throw new Error('Expected status to remain held during metadata lookup');
        heldStatusChecks++;
        samples.selectedBranchWhileStatusHeld.push(branch.ms);
      } finally { release(); await held; }
      const selectedStatus = await measure(() => core.readStatus(selected, git));
      if (!selectedStatus.value.complete) throw new Error('Selected status result is incomplete');
      samples.selectedCompleteStatus.push(selectedStatus.ms);
      const workspaceStatus = await measure(() => Promise.all(available.map(repository => core.readStatus(repository, git))));
      if (workspaceStatus.value.some(status => !status.complete)) throw new Error('Workspace status result is incomplete');
      samples.workspaceCompleteStatus.push(workspaceStatus.ms);
      console.error(JSON.stringify({ profile: fixture.profile, iteration: iteration + 1, total: options.iterations, discoveryMs: discovery.ms, selectedStatusMs: selectedStatus.ms, workspaceStatusMs: workspaceStatus.ms }));
    }
    const processTree = await sampler.stop();
    const childCpuAfter = await childCpuSnapshot();
    const resourcesAfter = process.resourceUsage();
    const report = {
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
      scope: 'Node API/process measurements only; no rendered UI, application launch, or product budget verdict',
      cacheState: 'OS filesystem cache uncontrolled, warmed by setup; disposable catalog prewritten; each discovery is an uncached catalog API call',
      fixture: { profile: fixture.profile, seed: fixture.seed, specification: fixture.specification, counts: fixture.counts },
      machine,
      sourceHashes,
      iterations: options.iterations,
      metrics: Object.fromEntries(Object.entries(samples).map(([key, value]) => [key, summarize(value)])),
      independence: { statusHeldIterations: heldStatusChecks, method: 'Sibling readStatus held at GitRunner boundary until selected readBranch returns', limitation: 'Does not exercise a saturated subprocess scheduler; see scheduler tests' },
      gitCalls: { scope: 'GitRunner call duration, including scheduler queue and passive-config audit; not isolated subprocess time', byLaneAndCommand: Object.fromEntries([...commandSamples].map(([key, values]) => [key, summarize(values)])) },
      gitProcesses: { scope: 'Actual Git subprocess telemetry from Git.onCommand; queueMs precedes dispatch, durationMs covers process launch through close', count: processTraces.length, available: processTraces.length > 0, traces: processTraces },
      resources: { scope: 'Self CPU/RSS/IO fields cover benchmark Node only; waited-child CPU and sampled process-tree memory are listed separately. Electron excluded.', cpuMicroseconds: process.cpuUsage(cpuBefore), waitedChildCpuMicroseconds: childCpuDelta(childCpuBefore, childCpuAfter), rssBeforeBytes: memoryBefore.rss, rssAfterBytes: process.memoryUsage().rss, maxRssKiB: resourcesAfter.maxRSS, filesystemReadBlocks: resourcesAfter.fsRead - resourcesBefore.fsRead, filesystemWriteBlocks: resourcesAfter.fsWrite - resourcesBefore.fsWrite, processTree },
      releaseEvidence: false,
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.json) await writeFile(path.resolve(options.json), json, { flag: 'wx' });
    console.log(json);
  } finally {
    await sampler.stop();
    rawGit.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
