#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readFixture } from './fixture.mjs';

function records(cwd, args, include = () => true) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0' });
    const child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`, ...args], { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let count = 0;
    let remaining = '';
    let error = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const entries = (remaining + chunk).split('\0');
      remaining = entries.pop();
      for (const entry of entries) if (entry && include(entry)) count++;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (error.length < 8192) error += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 && !remaining ? resolve(count) : reject(new Error(error || `Incomplete fixture audit output (${code})`)));
  });
}
async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--fixture', '--json'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/fixture-audit.mjs --fixture DIRECTORY [--json NEW_FILE]');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.fixture) throw new Error('--fixture is required');
  const root = path.resolve(options.fixture);
  const manifest = await readFixture(root);
  const count = { tracked: 0, ignored: 0, untracked: 0, modified: 0, dirtyRepositories: 0 };
  for (const repository of manifest.repositories) {
    const cwd = path.resolve(root, repository.path);
    if (!cwd.startsWith(`${root}${path.sep}`)) throw new Error('Invalid fixture repository path');
    count.tracked += await records(cwd, ['ls-files', '--stage', '-z'], entry => !entry.startsWith('160000 '));
    count.ignored += await records(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
    count.untracked += await records(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
    const changed = await records(cwd, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '-z']);
    count.modified += changed;
    count.dirtyRepositories += Number(changed > 0);
  }
  for (const [key, value] of Object.entries(count)) if (manifest.specification[key] !== value) throw new Error(`${key}: expected ${manifest.specification[key]}, observed ${value}`);
  const result = { schemaVersion: 1, timestamp: new Date().toISOString(), profile: manifest.profile, method: 'Independent streamed Git ls-files and diff enumeration; regular files exclude gitlinks', expected: manifest.specification, observed: count, pass: true };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.json) await writeFile(path.resolve(options.json), json, { flag: 'wx' });
  console.log(json);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
