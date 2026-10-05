import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { json, pin, prepared, root } from './upstream-lib.mjs';

// Conservative source audit, deliberately not a substitute for a compiled module graph.
// Type-only imports may be included. Dynamic computed imports and external packages
// require the separate packaging/runtime gate described in docs/FORK.md.
function imports(source) {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)['"]([^'"]+)['"]/gm)].map(match => match[1]);
}

try {
  if (process.argv.slice(2).some(arg => arg !== '--release')) throw new Error('Usage: node scripts/upstream-audit.mjs [--release]');
  const marker = json(resolve(prepared, '.minv-prepared.json'));
  if (!marker.complete || marker.commit !== pin.commit) throw new Error('Prepared source is incomplete or uses a different upstream revision.');
  const policy = json(resolve(root, 'product/contributions.json'));
  const extensionPolicy = json(resolve(root, 'product/extensions.json'));
  const product = json(resolve(prepared, 'product.json'));
  const expectedProduct = json(resolve(root, 'product/product.json'));
  if (JSON.stringify(product) !== JSON.stringify(expectedProduct)) throw new Error('Prepared product identity has drifted.');

  for (const [file, rule] of Object.entries(policy.entrypoints)) {
    const actual = [...readFileSync(resolve(prepared, file), 'utf8').matchAll(/^import '([^']+)';$/gm)].map(match => match[1]);
    if (JSON.stringify(actual) !== JSON.stringify(rule.keepImports)) throw new Error(`Entrypoint differs from exact import allowlist: ${file}`);
  }
  const extensionNames = readdirSync(resolve(prepared, 'extensions'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  if (JSON.stringify(extensionNames) !== JSON.stringify([...extensionPolicy.allow].sort())) throw new Error('Bundled extension directories differ from allowlist.');
  for (const name of extensionNames) {
    const manifest = json(resolve(prepared, 'extensions', name, 'package.json'));
    if (manifest.main || manifest.browser || manifest.activationEvents || manifest.extensionDependencies || manifest.extensionPack) throw new Error(`Executable extension activation remains: ${name}`);
    if (Object.keys(manifest.contributes ?? {}).some(key => !extensionPolicy.allowedContributionKeys.includes(key))) throw new Error(`Unreviewed extension contribution: ${name}`);
  }

  const entrypoints = [
    'src/main.ts',
    'src/vs/workbench/workbench.desktop.main.ts',
    'src/vs/code/electron-main/main.ts',
    'src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts',
    'src/vs/workbench/api/node/extensionHostProcess.ts',
  ];
  const queue = entrypoints.map(file => ({ file, via: null }));
  const visited = new Set();
  const excludedImports = [];
  const unresolvedSourceImports = [];
  for (let i = 0; i < queue.length; i++) {
    const { file, via } = queue[i];
    if (visited.has(file)) continue;
    visited.add(file);
    const area = policy.auditExcludedAreas.find(area => file.split('/').includes(area));
    if (area) excludedImports.push({ file, via, area });
    const source = readFileSync(resolve(prepared, file), 'utf8');
    for (const specifier of imports(source)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('vs/')) continue;
      const target = specifier.startsWith('vs/') ? resolve(prepared, 'src', specifier) : resolve(prepared, dirname(file), specifier);
      // Match upstream ESM .js imports to the TypeScript source they compile from.
      const candidate = [target.replace(/\.js$/, '.ts'), target, `${target}.ts`].find(path => /\.(ts|js)$/.test(path) && existsSync(path));
      if (candidate) queue.push({ file: relative(prepared, candidate), via: file });
      else if (/\.(js|ts)$/.test(specifier)) unresolvedSourceImports.push({ file, specifier });
    }
  }
  const report = {
    upstream: pin.commit,
    preparedChecksPassed: true,
    releaseReady: false,
    roots: entrypoints,
    scannedSourceFiles: visited.size,
    removedDirectImports: Object.values(marker.removedImports).reduce((total, list) => total + list.length, 0),
    retainedDeclarativeExtensions: extensionNames.length,
    removedExtensionDirectories: marker.removedExtensions.length,
    excludedImports,
    unresolvedSourceImports,
    releaseBlockers: policy.releaseBlockers,
  };
  const output = resolve(prepared, '.minv-audit.json');
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Preparation checks passed. ${report.removedDirectImports} direct imports removed; ${extensionNames.length} declarative extensions retained.\nSource graph: ${visited.size} files, ${excludedImports.length} excluded-area files still reachable.\nReport: ${output}\nRelease gate: BLOCKED. Source preparation alone does not satisfy AT-11.`);
  if (process.argv.includes('--release')) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
