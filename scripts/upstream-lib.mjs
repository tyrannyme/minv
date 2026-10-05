import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const upstream = resolve(root, '.upstream/vscode');
export const prepared = resolve(root, '.upstream/minv-source');
export const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const pin = json(resolve(root, 'product/upstream.json'));
export function git(args, cwd = upstream) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}
export function verifyPin() {
  if (git(['rev-parse', 'HEAD']) !== pin.commit) throw new Error('Upstream HEAD differs from product/upstream.json. Refusing preparation.');
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Upstream tracked files are modified. Keep source changes in patches/, not the upstream checkout.');
}
