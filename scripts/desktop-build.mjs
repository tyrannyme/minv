#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, rename, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'build/desktop');
const staging = path.join(output, 'app.staging');
const app = path.join(output, 'app');
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const inputs = {};
const relative = file => path.relative(root, file).split(path.sep).join('/');

function run(script, optional = false) {
  const result = spawnSync(process.execPath, [path.join(root, script)], { cwd: root, stdio: optional ? 'pipe' : 'inherit', shell: false });
  if (!optional && (result.error || result.status !== 0)) throw result.error ?? new Error(`${script} failed (${result.status}).`);
  return result.status === 0;
}

async function walk(directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Build assets cannot be symlinks: ${file}`);
    if (entry.isDirectory()) result.push(...await walk(file));
    else if (entry.isFile()) result.push(file);
    else throw new Error(`Unsupported build asset: ${file}`);
  }
  return result;
}

async function copy(source, destination, directory = false) {
  await mkdir(path.dirname(destination), { recursive: true });
  const sources = directory ? await walk(source) : [source];
  for (const file of sources) inputs[relative(file)] = await digest(file);
  await cp(source, destination, { recursive: directory });
}

const productionOnly = {
  name: 'minv-production-closure',
  setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
      if (/(?:^|\/)(?:mock|mocks|test|tests|fixtures)(?:\/|\.|$)/.test(args.path.split(path.sep).join('/'))) {
        return { errors: [{ text: `Development-only code reached the production bundle: ${args.path}. Guard fixture imports with __MINV_DESKTOP__.` }] };
      }
      return undefined;
    });
  },
};

async function bundle(source, target, platform) {
  const result = await build({
    absWorkingDir: root, entryPoints: [source], outfile: path.join(staging, target), bundle: true,
    platform, format: platform === 'node' ? 'cjs' : 'esm', target: platform === 'node' ? 'node22' : 'chrome130',
    external: platform === 'node' ? ['electron'] : [],
    define: { __MINV_DESKTOP__: 'true' }, plugins: [productionOnly],
    sourcemap: false, metafile: true, legalComments: 'inline', logLevel: 'info',
  });
  for (const source of Object.keys(result.metafile.inputs)) inputs[source] = await digest(path.resolve(root, source));
  return result.metafile;
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/desktop-build.mjs');
  for (const source of ['desktop/main/main.ts', 'desktop/preload/preload.ts', 'desktop/preload/bootstrap.ts', 'desktop/renderer/src/main.ts', 'desktop/renderer/index.html']) {
    if (!existsSync(path.join(root, source))) throw new Error(`Desktop source is not available yet: ${source}`);
  }
  if (!run('scripts/editor-audit.mjs', true)) run('scripts/editor-build.mjs');
  run('scripts/editor-audit.mjs');
  run('scripts/sandbox-build.mjs');
  run('desktop/renderer/scripts/tokens.mjs');
  await mkdir(output, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  try {
    const graphs = {};
    graphs.main = await bundle('desktop/main/main.ts', 'main.cjs', 'node');
    graphs.preload = await bundle('desktop/preload/preload.ts', 'preload.cjs', 'node');
    graphs.bootstrap = await bundle('desktop/preload/bootstrap.ts', 'bootstrap.js', 'browser');
    graphs.renderer = await bundle('desktop/renderer/src/main.ts', 'renderer/dist/main.js', 'browser');
    await copy(path.join(root, 'desktop/editor/generated'), path.join(staging, 'editor'), true);
    for (const directory of ['styles', 'assets']) await copy(path.join(root, 'desktop/renderer', directory), path.join(staging, 'renderer', directory), true);
    for (const file of ['design-tokens.json', 'design-tokens.css']) await copy(path.join(root, 'desktop', file), path.join(staging, file));
    await copy(path.join(root, 'dist/native/minv-git-sandbox'), path.join(staging, 'native/minv-git-sandbox'));
    await chmod(path.join(staging, 'native/minv-git-sandbox'), 0o755);
    await copy(path.join(root, 'node_modules/@vscode/ripgrep-universal/bin/linux-x64/rg'), path.join(staging, 'native/rg'));
    await chmod(path.join(staging, 'native/rg'), 0o755);
    await copy(path.join(root, 'product/notices/ripgrep'), path.join(staging, 'native/notices/ripgrep'), true);
    await copy(path.join(root, 'node_modules/@vscode/ripgrep-universal/LICENSE'), path.join(staging, 'native/notices/vscode-ripgrep-LICENSE.txt'));
    const htmlSource = path.join(root, 'desktop/renderer/index.html');
    inputs[relative(htmlSource)] = await digest(htmlSource);
    let html = await readFile(htmlSource, 'utf8');
    if (/<base\b/i.test(html)) throw new Error('Renderer HTML already contains a base element; update the desktop build explicitly.');
    const entries = [...html.matchAll(/<script\b[^>]*\bsrc=["'](?:\.\/)?(?:dist\/(?:main|index)\.js|src\/main\.ts)["'][^>]*>\s*<\/script>/gi)];
    if (entries.length !== 1) throw new Error('Renderer HTML must have one local main module entry.');
    html = html.replace(entries[0][0], '<script type="module" src="../bootstrap.js"></script>');
    html = html.replaceAll('../editor/generated/', '../editor/');
    // Only deployment paths and process-boundary CSP change; Claude owns all visual markup.
    const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";
    html = html.replace(/<meta\b(?=[^>]*http-equiv=["']Content-Security-Policy["'])[^>]*>/gi, '');
    html = html.replace(/<head\b[^>]*>/i, match => `${match}\n  <base href="./renderer/">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
    if (!html.includes('<base href="./renderer/">')) throw new Error('Renderer HTML is missing its head element.');
    await writeFile(path.join(staging, 'index.html'), html);
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    await writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: 'minv', productName: 'Minv', version: pkg.version, description: pkg.description, main: 'main.cjs', license: pkg.license }, null, 2) + '\n');
    inputs['package.json'] = await digest(path.join(root, 'package.json'));
    for (const source of ['package-lock.json', 'desktop/renderer/package-lock.json', 'scripts/desktop-build.mjs', 'scripts/sandbox-build.mjs', 'scripts/sandbox-launcher.c']) inputs[source] = await digest(path.join(root, source));
    const outputs = {};
    for (const file of await walk(staging)) outputs[path.relative(staging, file).split(path.sep).join('/')] = await digest(file);
    await writeFile(path.join(output, 'bundle-meta.json'), JSON.stringify(graphs, null, 2) + '\n');
    await writeFile(path.join(output, 'build-provenance.json'), JSON.stringify({ sourceHashes: inputs, outputHashes: outputs, transformations: ['Renderer HTML base is ./renderer/; root bootstrap installs the audited source editor before renderer main.', 'CSP permits local script/worker/font/assets, inline editor styles and WebAssembly compilation; no remote origins or JavaScript eval.', '__MINV_DESKTOP__ is true; development mock imports must be dead code.'], builder: { node: process.version } }, null, 2) + '\n');
    await rm(app, { recursive: true, force: true });
    await rename(staging, app);
    console.log(`Standalone Minv built: ${app}\nProduction source graphs: build/desktop/bundle-meta.json`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

main().catch(error => { console.error(`Desktop build failed: ${error.message}`); process.exitCode = 1; });
