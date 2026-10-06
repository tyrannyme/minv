#!/usr/bin/env node
// Packs the built app (.upstream/VSCode-linux-x64) into build/release: minv-linux-x64.tar.gz, .deb and .rpm, plus
// SHA256SUMS. Asset names carry no version, so https://github.com/tyrannyme/minv/releases/latest/download/<asset>
// always points at the newest release. Pass formats to build only some: node scripts/fork-package.mjs tar rpm
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '.upstream/build');
const built = join(root, '.upstream/VSCode-linux-x64');
if (!existsSync(join(built, 'minv'))) throw new Error('Build the app first: npm run build');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const formats = process.argv.slice(2).length ? process.argv.slice(2) : ['tar', 'deb', 'rpm'];
const release = join(root, 'build/release');
rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });
cpSync(join(root, 'LICENSE'), join(built, 'LICENSE-minv.txt'));

const gulp = task => execFileSync('npm', ['run', '--silent', 'gulp', task], { cwd: source, stdio: 'inherit', env: { ...process.env, MINV_VERSION: version } });
const only = dir => {
  const files = readdirSync(dir).filter(name => /\.(deb|rpm)$/.test(name));
  if (files.length !== 1) throw new Error(`Expected one package in ${dir}, found: ${files.join(', ') || 'none'}`);
  return join(dir, files[0]);
};

for (const format of formats) {
  const out = join(release, `minv-linux-x64.${format === 'tar' ? 'tar.gz' : format}`);
  if (format === 'tar') {
    // Reproducible: sorted, root-owned, stamped with the commit time, and gzip without a name or timestamp.
    const mtime = execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' }).trim();
    execSync(`set -o pipefail; tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@${mtime} --transform='flags=r;s|^VSCode-linux-x64|minv-linux-x64|' -cf - -C .upstream VSCode-linux-x64 | gzip -9n > ${JSON.stringify(out)}`, { cwd: root, shell: '/bin/bash' });
  } else if (format === 'deb') {
    gulp('vscode-linux-x64-prepare-deb');
    gulp('vscode-linux-x64-build-deb');
    copyFileSync(only(join(source, '.build/linux/deb/amd64/deb')), out);
  } else if (format === 'rpm') {
    gulp('vscode-linux-x64-prepare-rpm');
    gulp('vscode-linux-x64-build-rpm');
    copyFileSync(only(join(source, '.build/linux/rpm/x86_64')), out);
  } else {
    throw new Error(`Unknown format ${format}; use tar, deb or rpm.`);
  }
}

const sums = readdirSync(release).sort().map(name => `${createHash('sha256').update(readFileSync(join(release, name))).digest('hex')}  ${name}`);
writeFileSync(join(release, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log(`Minv ${version}\n${sums.join('\n')}`);
