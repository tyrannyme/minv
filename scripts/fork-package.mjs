#!/usr/bin/env node
// Packs the built app (.upstream/VSCode-linux-x64) into build/release/minv-<version>-linux-x64.tar.gz
// with a SHA-256 checksum file.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, '.upstream/VSCode-linux-x64');
if (!existsSync(join(built, 'minv'))) throw new Error('Build the app first: npm run build');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `minv-${version}-linux-x64`;
const release = join(root, 'build/release');
rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });
cpSync(built, join(release, name), { recursive: true, verbatimSymlinks: true });
cpSync(join(root, 'LICENSE'), join(release, name, 'LICENSE-minv.txt'));
const archive = join(release, `${name}.tar.gz`);
execFileSync('tar', ['--owner=0', '--group=0', '--sort=name', '-czf', archive, '-C', release, name]);
const sum = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${sum}  ${name}.tar.gz\n`);
rmSync(join(release, name), { recursive: true, force: true });
console.log(`${archive}\n${sum}`);
