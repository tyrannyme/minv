import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux') throw new Error('Minv passive Git confinement currently supports Linux only.');
const output = path.join(root, 'dist', 'native', 'minv-git-sandbox');
mkdirSync(path.dirname(output), { recursive: true });
execFileSync(process.env.CC || 'cc', [
  '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=3',
  '-fstack-protector-strong', '-Wl,-z,relro,-z,now',
  path.join(root, 'scripts', 'sandbox-launcher.c'), '-o', output,
], { stdio: 'inherit' });
console.log(`Built Linux Git confinement: ${output}`);
