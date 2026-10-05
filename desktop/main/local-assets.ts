import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const APP_URL = 'minv-app://app/index.html';
export const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
/** Only shipped UI resources, never arbitrary application/main code or workspace files. */
export async function localAsset(directory: string, value: string): Promise<{ file: string; type: string }> {
  const url = new URL(value);
  if (url.protocol !== 'minv-app:' || url.hostname !== 'app' || url.port || url.username || url.password) throw new Error('Unapproved asset origin.');
  const decoded = decodeURIComponent(url.pathname);
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) throw new Error('Invalid asset path.');
  const relative = decoded.slice(1);
  if (!['index.html', 'bootstrap.js', 'design-tokens.json', 'design-tokens.css'].includes(relative) && !['renderer/', 'editor/', 'media/'].some(prefix => relative.startsWith(prefix))) throw new Error('Resource is not public.');
  const type = mime[path.extname(relative)];
  if (!type) throw new Error('Unsupported resource type.');
  const root = await realpath(directory);
  const file = await realpath(path.resolve(root, relative));
  if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) throw new Error('Resource outside application.');
  return { file, type };
}
