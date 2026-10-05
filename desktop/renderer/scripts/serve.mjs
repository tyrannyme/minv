// Local preview server for the renderer (no caching, loopback only). Serves the Minv project root.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const port = Number(process.env.PORT ?? 4319);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8' };
createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404, { 'cache-control': 'no-store' }).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Minv preview: http://127.0.0.1:${port}/desktop/renderer/preview.html`));
