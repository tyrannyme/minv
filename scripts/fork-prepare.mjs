#!/usr/bin/env node
// Turns the pinned Code-OSS checkout into Minv: a pristine worktree at .upstream/build, then Minv's changes
// from fork/. Safe to rerun; every run starts again from the pinned upstream files (installed node_modules
// and compiled output are kept). The first run fetches the pinned commit.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fork = join(root, 'fork');
const pin = JSON.parse(readFileSync(join(fork, 'upstream.json'), 'utf8'));
const build = join(root, '.upstream/build');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

// A shallow fetch of exactly the pinned commit. No tags, history or other branches.
if (!existsSync(build)) {
  mkdirSync(build, { recursive: true });
  git(build, 'init', '--quiet');
  git(build, 'remote', 'add', 'origin', pin.repository);
  git(build, 'fetch', '--quiet', '--depth=1', 'origin', pin.commit);
}
git(build, 'checkout', '--quiet', '--detach', '--force', pin.commit);
git(build, 'reset', '--hard', '--quiet', pin.commit);
git(build, 'clean', '-fdq');

// 1. Workbench features Minv does not register.
for (const [file, contributions] of Object.entries(json(join(fork, 'strip.json')))) {
  if (file.startsWith('$')) continue;
  let source = readFileSync(join(build, file), 'utf8');
  for (const contribution of contributions) {
    const line = `import './contrib/${contribution}';\n`;
    if (!source.includes(line)) throw new Error(`Upstream no longer imports ${contribution} in ${file}; review fork/strip.json.`);
    source = source.replace(line, '');
  }
  writeFileSync(join(build, file), source);
}

// 2. Built-in extensions Minv does not ship.
for (const name of json(join(fork, 'extensions-remove.json'))) {
  if (!existsSync(join(build, 'extensions', name))) throw new Error(`Upstream has no extension ${name}; review fork/extensions-remove.json.`);
  rmSync(join(build, 'extensions', name), { recursive: true, force: true });
}

// Build lists name every extension to compile; drop the entries for removed ones.
const removed = json(join(fork, 'extensions-remove.json'));
for (const file of ['build/gulpfile.extensions.ts', 'build/lib/extensions.ts', 'build/npm/dirs.ts']) {
  const lines = readFileSync(join(build, file), 'utf8').split('\n');
  const kept = lines.filter(line => !(/,\s*$/.test(line) && removed.some(name => new RegExp(`['"](?:extensions/)?${name.replace(/[-.]/g, '\\$&')}(?:/|['"])`).test(line))));
  writeFileSync(join(build, file), kept.join('\n'));
}

// 3. Product identity.
const product = json(join(build, 'product.json'));
for (const [key, value] of Object.entries(json(join(fork, 'product.json')))) {
  if (key.startsWith('$')) continue;
  if (value === null) delete product[key]; else product[key] = value;
}
writeFileSync(join(build, 'product.json'), JSON.stringify(product, null, '\t') + '\n');

// 4. Minv's own built-in extensions and files.
for (const name of readdirSync(join(fork, 'extensions'))) cpSync(join(fork, 'extensions', name), join(build, 'extensions', name), { recursive: true });
if (existsSync(join(fork, 'overlay'))) cpSync(join(fork, 'overlay'), build, { recursive: true });

// 5. Source patches, in name order.
const patches = existsSync(join(fork, 'patches')) ? readdirSync(join(fork, 'patches')).filter(name => name.endsWith('.patch')).sort() : [];
for (const patch of patches) git(build, 'apply', '--whitespace=nowarn', join(fork, 'patches', patch));

console.log(`Prepared Minv from Code-OSS ${pin.tag} (${pin.commit.slice(0, 10)}): ${patches.length} patches.\n${build}`);
