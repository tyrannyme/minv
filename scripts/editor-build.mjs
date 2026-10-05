import * as esbuild from 'esbuild';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { json, pin, root, upstream, verifyPin } from './upstream-lib.mjs';

const output = resolve(root, 'desktop/editor/generated');
const policy = json(resolve(root, 'product/editor-scope.json'));
const hash = data => createHash('sha256').update(data).digest('hex');
const trackedInputs = new Map();
const transformations = [];
const jsonWrite = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function copyAsset(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  trackedInputs.set(relative(root, source), hash(readFileSync(source)));
}

async function run() {
  verifyPin();
  if (policy.upstream !== pin.commit) throw new Error('Editor allowlist and source pin differ.');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const plugin = {
    name: 'minv-codeoss-source',
    setup(build) {
      build.onResolve({ filter: /^@codeoss\// }, args => ({ path: resolve(upstream, 'src/vs', args.path.slice('@codeoss/'.length).replace(/\.js$/, '.ts')) }));
      build.onResolve({ filter: /codicon\.ttf$/ }, () => ({ path: resolve(root, 'node_modules/@vscode/codicons/dist/codicon.ttf') }));
      build.onLoad({ filter: /\.(?:ts|js|css)$/ }, args => {
        if (!args.path.startsWith(upstream + '/')) return;
        const file = relative(upstream, args.path);
        if (policy.forbiddenSourcePrefixes.some(prefix => file.startsWith(prefix)) || policy.forbiddenSourceFiles.includes(file)) {
          throw new Error(`Excluded Code-OSS runtime module reached: ${file}`);
        }
        let contents = readFileSync(args.path, 'utf8');
        const sourceHash = hash(contents);
        trackedInputs.set(relative(root, args.path), sourceHash);
        for (const transform of policy.sourceTransforms.filter(item => item.file === file)) {
          if (sourceHash !== transform.sha256 || !contents.includes(transform.removeExact)) throw new Error(`Unreviewed source transform: ${file}`);
          contents = contents.replace(transform.removeExact, transform.replaceWith ?? '');
          transformations.push({ file, sourceHash, resultHash: hash(contents), reason: transform.reason });
        }
        return { contents, loader: args.path.endsWith('.css') ? 'css' : args.path.endsWith('.ts') ? 'ts' : 'js', resolveDir: dirname(args.path) };
      });
    },
  };
  const entryImports = policy.contributions.map(file => `import ${JSON.stringify(resolve(upstream, file))};`).join('\n');
  const virtualEntry = resolve(root, '.upstream/minv-editor-entry.ts');
  writeFileSync(virtualEntry, `${entryImports}\nexport * from ${JSON.stringify(resolve(root, 'desktop/editor/entry.ts'))};\n`);
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: { editor: virtualEntry, 'editor.worker': resolve(upstream, 'src/vs/editor/common/services/editorWebWorkerMain.ts') },
    outdir: output,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    metafile: true,
    legalComments: 'external',
    splitting: false,
    treeShaking: true,
    assetNames: 'assets/[name]-[hash]',
    loader: { '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    plugins: [plugin],
    logLevel: 'info',
  });
  const languagePolicy = json(resolve(root, 'product/extensions.json'));
  const languages = new Map();
  const grammars = [];
  for (const extension of languagePolicy.allow) {
    const folder = resolve(upstream, 'extensions', extension);
    const manifest = json(resolve(folder, 'package.json'));
    trackedInputs.set(relative(root, resolve(folder, 'package.json')), hash(readFileSync(resolve(folder, 'package.json'))));
    for (const language of manifest.contributes?.languages ?? []) {
      if (!language.id) continue;
      const record = { ...language };
      if (language.configuration) {
        const file = resolve(folder, language.configuration);
        if (!file.startsWith(folder + '/')) throw new Error('Syntax asset escapes audited extension.');
        const destination = `${extension}/${language.configuration.replace(/^\.\//, '')}`;
        const text = readFileSync(file, 'utf8');
        const parsed = ts.parseConfigFileTextToJson(file, text);
        if (parsed.error) throw new Error(`Invalid language configuration: ${file}`);
        mkdirSync(dirname(resolve(output, 'syntax', destination)), { recursive: true });
        jsonWrite(resolve(output, 'syntax', destination), parsed.config);
        trackedInputs.set(relative(root, file), hash(text));
        record.configuration = destination;
      }
      languages.set(language.id, { ...languages.get(language.id), ...record });
    }
    for (const grammar of manifest.contributes?.grammars ?? []) {
      const file = resolve(folder, grammar.path);
      if (!file.startsWith(folder + '/')) throw new Error('Grammar asset escapes audited extension.');
      const destination = `${extension}/${grammar.path.replace(/^\.\//, '')}`;
      copyAsset(file, resolve(output, 'syntax', destination));
      grammars.push({ scopeName: grammar.scopeName, language: grammar.language, injectTo: grammar.injectTo, file: destination });
    }
  }
  jsonWrite(resolve(output, 'syntax/manifest.json'), { languages: [...languages.values()], grammars });
  copyAsset(resolve(root, 'node_modules/vscode-oniguruma/release/onig.wasm'), resolve(output, 'onig.wasm'));
  for (const [source, name] of [
    [resolve(upstream, 'LICENSE.txt'), 'CODE-OSS-LICENSE.txt'],
    [resolve(upstream, 'ThirdPartyNotices.txt'), 'CODE-OSS-ThirdPartyNotices.txt'],
    [resolve(upstream, 'src/vs/base/common/marked/marked.license.txt'), 'marked-LICENSE.txt'],
    [resolve(upstream, 'src/vs/base/browser/dompurify/dompurify.license.txt'), 'dompurify-LICENSE.txt'],
    [resolve(root, 'node_modules/@vscode/codicons/LICENSE'), 'codicons-LICENSE.txt'],
    [resolve(root, 'node_modules/vscode-textmate/LICENSE.md'), 'textmate-LICENSE.txt'],
    [resolve(root, 'node_modules/vscode-oniguruma/LICENSE.txt'), 'oniguruma-LICENSE.txt'],
  ]) {
    if (!existsSync(source)) throw new Error(`Missing required bundled notice: ${source}`);
    copyAsset(source, resolve(output, 'notices', name));
  }
  jsonWrite(resolve(output, 'metafile.json'), result.metafile);
  for (const file of Object.keys(result.metafile.inputs)) {
    const source = resolve(root, file);
    if (existsSync(source)) trackedInputs.set(file, hash(readFileSync(source)));
  }
  const packagedFiles = readdirSync(output, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => resolve(entry.parentPath, entry.name));
  jsonWrite(resolve(output, 'provenance.json'), {
    upstream: pin,
    builder: { esbuild: esbuild.version, node: process.version },
    contributions: policy.contributions,
    transformations,
    inputs: Object.fromEntries([...trackedInputs].sort(([a], [b]) => a.localeCompare(b))),
    languages: languages.size,
    grammars: grammars.length,
    excludesWorkbench: true,
    policyHash: hash(readFileSync(resolve(root, 'product/editor-scope.json'))),
    outputHashes: Object.fromEntries(packagedFiles.map(file => [relative(output, file), hash(readFileSync(file))]).sort(([a], [b]) => a.localeCompare(b))),
  });
  console.log(`Built pinned Code-OSS editor: ${Object.keys(result.metafile.inputs).length} compiled inputs, ${languages.size} local languages, ${grammars.length} local grammars.`);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
