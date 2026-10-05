#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, lstat, writeFile, chmod, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const forward = value => value.split(path.sep).join('/');
const forbidden = /(?:^|\/)(?:node_modules|extensions|extensionHost|extension-host|chat|debug|debugger|terminal|ptyHost|pty-host|providers|agent|agents|server|code-server|remote)(?:\/|\.|$)/i;
const appAllowed = /^(?:package\.json|design-tokens\.(?:json|css)|main\.cjs|preload\.cjs|bootstrap\.js|index\.html|native\/(?:minv-git-sandbox|rg|notices\/[A-Za-z0-9_./-]+\.(?:txt|md|json|lock))|renderer\/dist\/[A-Za-z0-9_./-]+\.js|renderer\/styles\/[A-Za-z0-9_./-]+\.css|(?:renderer\/assets|assets|media|brand)\/[A-Za-z0-9_./@-]+\.(?:woff2?|ttf|otf|svg|png|webp|jpe?g|txt|json)|editor\/[A-Za-z0-9_./@-]+)$/i;
const electronAllowed = new Set([
  'electron', 'LICENSE', 'LICENSES.chromium.html', 'chrome-sandbox', 'chrome_crashpad_handler',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'icudtl.dat', 'libEGL.so', 'libGLESv2.so',
  'libffmpeg.so', 'libvk_swiftshader.so', 'libvulkan.so.1', 'resources.pak', 'snapshot_blob.bin',
  'v8_context_snapshot.bin', 'vk_swiftshader_icd.json', 'version',
]);

async function files(directory) {
  const found = [];
  async function visit(current, prefix = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not permitted in the release: ${relative}`);
      if (entry.isDirectory()) await visit(path.join(current, entry.name), `${relative}/`);
      else if (entry.isFile()) found.push(relative);
      else throw new Error(`Unsupported release entry: ${relative}`);
    }
  }
  await visit(directory);
  return found;
}

async function verifyEditor(app) {
  const editor = path.join(app, 'editor');
  const provenance = await json(path.join(editor, 'provenance.json'));
  const audit = await json(path.join(editor, 'audit.json'));
  if (!/^[a-f0-9]{40}$/.test(provenance.upstream?.commit ?? '')) throw new Error('Editor upstream revision is missing or unpinned.');
  if (!Object.keys(provenance.inputs ?? {}).length) throw new Error('Editor source provenance is empty.');
  if (audit.passed !== true && audit.ok !== true) throw new Error('The editor source-removal audit has not passed.');
  if ((audit.excludedInputs?.length ?? 0) || (audit.externalImports?.length ?? 0)) throw new Error('The editor audit contains excluded implementations or external imports.');
  const outputs = audit.compiledOutputHashes;
  if (!outputs || !Object.keys(outputs).length) throw new Error('The editor audit must record compiledOutputHashes.');
  for (const [file, expected] of Object.entries(outputs)) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error(`Invalid editor audited output path: ${file}`);
    if (await hash(path.join(editor, file)) !== expected) throw new Error(`Editor differs from its audited build: ${file}`);
  }
  for (const file of await files(editor)) {
    if (!(file in outputs) && !['audit.json', 'provenance.json', 'smoke.json'].includes(file)) throw new Error(`Unaudited editor output: ${file}`);
  }
  for (const file of ['CODE-OSS-LICENSE.txt', 'CODE-OSS-ThirdPartyNotices.txt']) {
    if (!existsSync(path.join(editor, 'notices', file))) throw new Error(`Missing upstream notice: ${file}`);
  }
  return { provenance, audit };
}

async function auditBundleGraph() {
  const filename = path.join(root, 'build/desktop/bundle-meta.json');
  if (!existsSync(filename)) throw new Error('Desktop build must emit build/desktop/bundle-meta.json for the removal audit.');
  const metadata = await json(filename);
  const records = metadata.inputs ? [metadata] : Object.values(metadata);
  const sources = {};
  const externalImports = new Set();
  const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`), 'electron']);
  for (const record of records) {
    if (!record?.inputs || !record?.outputs) throw new Error('Desktop bundle metadata must contain esbuild input and output graphs.');
    for (const source of Object.keys(record.inputs)) {
      const normalized = forward(source);
      if (forbidden.test(normalized) || /(?:^|\/)src\/(?:extension|controller|ui)(?:\.|\/)/.test(normalized)) {
        throw new Error(`Excluded implementation in desktop graph: ${source}`);
      }
      if (!/^(?:src\/core\/|desktop\/(?:main|preload|renderer|editor|shared)\/)/.test(normalized)) {
        throw new Error(`Desktop source is outside the reviewed allowlist: ${source}`);
      }
      sources[normalized] = await hash(path.join(root, source));
    }
    for (const output of Object.values(record.outputs)) {
      for (const dependency of output.imports ?? []) {
        if (dependency.external) {
          if (!builtins.has(dependency.path)) throw new Error(`Unbundled runtime dependency: ${dependency.path}`);
          externalImports.add(dependency.path);
        }
      }
    }
  }
  return { sources, externalImports: [...externalImports].sort() };
}

async function verifyDesktopBuild(app) {
  const provenance = await json(path.join(root, 'build/desktop/build-provenance.json'));
  for (const [source, expected] of Object.entries(provenance.sourceHashes ?? {})) {
    if (path.isAbsolute(source) || source.split(/[\\/]/).includes('..')) throw new Error(`Invalid build source path: ${source}`);
    if (await hash(path.join(root, source)) !== expected) throw new Error(`Source changed after desktop build: ${source}`);
  }
  const outputs = provenance.outputHashes ?? {};
  const appFiles = await files(app);
  if (!Object.keys(outputs).length || appFiles.length !== Object.keys(outputs).length) throw new Error('Desktop output inventory differs from its build provenance.');
  for (const file of appFiles) {
    if (await hash(path.join(app, file)) !== outputs[file]) throw new Error(`Desktop output changed after build: ${file}`);
  }
  return provenance;
}

async function auditRelease(directory, verifyManifest = true) {
  const listing = await files(directory);
  const violations = [];
  const allowedExecutable = new Set(['minv', 'bin/minv', 'chrome-sandbox', 'chrome_crashpad_handler', 'resources/app/native/minv-git-sandbox', 'resources/app/native/rg']);
  const releaseMetadata = new Set(['minv', 'electron-LICENSE.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'dependencies.json', 'source-provenance.json', 'package-audit.json', 'SHA256SUMS']);
  for (const file of listing) {
    if (forbidden.test(file)) violations.push(`Excluded path: ${file}`);
    const appRelative = file.startsWith('resources/app/') ? file.slice('resources/app/'.length) : undefined;
    if (appRelative !== undefined && !appAllowed.test(appRelative)) violations.push(`Unexpected app artifact: ${file}`);
    if (appRelative === undefined && !electronAllowed.has(file) && !releaseMetadata.has(file) &&
        !/^locales\/[A-Za-z0-9-]+\.pak$/.test(file) &&
        !/^(?:bin\/minv|resources\/cli\/(?:minv\.mjs|cli\.cjs)|share\/applications\/minv\.desktop|share\/icons\/hicolor\/scalable\/apps\/minv\.svg)$/.test(file)) {
      violations.push(`Unexpected release artifact: ${file}`);
    }
    if (appRelative !== undefined && (/\.map$/.test(appRelative) || /(?:^|\/)(?:test|tests|mock|mocks|fixtures)(?:\/|\.|$)/.test(appRelative))) violations.push(`Development artifact: ${file}`);
    const info = await lstat(path.join(directory, file));
    // Shared libraries may retain executable bits, but arbitrary application executables may not.
    if ((info.mode & 0o111) && !allowedExecutable.has(file) && !/^lib[^/]+\.so(?:\.\d+)*$/.test(file)) {
      violations.push(`Unexpected executable: ${file}`);
    }
  }
  if (violations.length) throw new Error(violations.join('\n'));
  const { provenance, audit } = await verifyEditor(path.join(directory, 'resources/app'));
  const product = await json(path.join(directory, 'resources/app/package.json'));
  if (product.name !== 'minv' || product.main !== 'main.cjs') throw new Error('Packaged product must identify as minv with main.cjs.');
  for (const required of ['minv', 'bin/minv', 'resources/cli/minv.mjs', 'resources/cli/cli.cjs', 'LICENSE', 'LICENSES.chromium.html', 'THIRD_PARTY_NOTICES.md', 'dependencies.json', 'source-provenance.json']) {
    if (!listing.includes(required)) throw new Error(`Required release artifact is missing: ${required}`);
  }
  if (verifyManifest) {
    const manifest = (await readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    const entries = new Map();
    for (const line of manifest) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      if (!match || path.isAbsolute(match[2]) || match[2].split('/').includes('..') || entries.has(match[2])) throw new Error('Invalid release hash manifest.');
      entries.set(match[2], match[1]);
    }
    for (const file of listing.filter(name => name !== 'SHA256SUMS')) {
      if (entries.get(file) !== await hash(path.join(directory, file))) throw new Error(`Release hash verification failed: ${file}`);
      entries.delete(file);
    }
    if (entries.size) throw new Error('Hash manifest references absent release files.');
  }
  return {
    passed: true, platform: 'linux', arch: 'x64', upstreamCommit: provenance.upstream.commit,
    editorAudit: audit.passed ?? audit.ok, fileCount: listing.length,
    exclusions: ['stock workbench', 'extension host', 'extension marketplace', 'chat/AI/agent runtime', 'debug adapters', 'integrated terminal/PTY host', 'remote server', 'provider integrations'],
    permittedExecutables: [...allowedExecutable],
    note: 'Chromium sandbox/crashpad helpers are required Electron infrastructure. minv-git-sandbox is a source-audited Linux confinement wrapper around passive Git reads; rg is the pinned local text-search binary; Git is an explicit user-installed external executable. This audit does not replace runtime network or accessibility checks.',
  };
}

async function packageDesktop() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Only Linux x64 is packaged by this release target.');
  const product = await json(path.join(root, 'package.json'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(product.version)) throw new Error('Unsafe package version.');
  const app = path.join(root, 'build/desktop/app');
  await verifyEditor(app);
  const buildProvenance = await verifyDesktopBuild(app);
  const graph = await auditBundleGraph();
  const appFiles = await files(app);
  for (const file of appFiles) {
    if (!appAllowed.test(file) || forbidden.test(file)) throw new Error(`Unexpected application build artifact: ${file}`);
  }
  const electron = path.dirname(require('electron'));
  const releases = path.join(root, 'build/release');
  const name = `minv-${product.version}-linux-x64`;
  const staging = path.join(releases, `${name}.staging`);
  const target = path.join(releases, name);
  await mkdir(releases, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  try {
    for (const file of await files(electron)) {
      if (file.startsWith('resources/')) {
        if (file !== 'resources/default_app.asar') throw new Error(`Unreviewed Electron resource: ${file}`);
        continue;
      }
      if (!electronAllowed.has(file) && !/^locales\/[a-zA-Z0-9-]+\.pak$/.test(file)) throw new Error(`Unreviewed Electron artifact: ${file}`);
      const destination = file === 'electron' ? 'minv' : file === 'LICENSE' ? 'electron-LICENSE.txt' : file;
      await mkdir(path.dirname(path.join(staging, destination)), { recursive: true });
      await cp(path.join(electron, file), path.join(staging, destination));
      await chmod(path.join(staging, destination), ['minv', 'chrome-sandbox', 'chrome_crashpad_handler'].includes(destination) ? 0o755 : 0o644);
    }
    await mkdir(path.join(staging, 'resources'), { recursive: true });
    await cp(app, path.join(staging, 'resources/app'), { recursive: true });
    for (const file of appFiles) await chmod(path.join(staging, 'resources/app', file), ['native/minv-git-sandbox', 'native/rg'].includes(file) ? 0o755 : 0o644);
    await mkdir(path.join(staging, 'resources/cli'), { recursive: true });
    await cp(path.join(root, 'scripts/minv.mjs'), path.join(staging, 'resources/cli/minv.mjs'));
    const { build } = require('esbuild');
    const cliBuild = await build({ entryPoints: [path.join(root, 'src/core/cli.ts')], outfile: path.join(staging, 'resources/cli/cli.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', metafile: true, sourcemap: false });
    const cliSource = Object.keys(cliBuild.metafile.inputs);
    const expectedCliSources = new Set(['src/core/cli.ts', 'src/core/update-lease.ts']);
    if (cliSource.length !== expectedCliSources.size || cliSource.some(source => !expectedCliSources.has(forward(source)))) throw new Error('CLI bundle unexpectedly includes dependencies.');
    await mkdir(path.join(staging, 'bin'), { recursive: true });
    await writeFile(path.join(staging, 'bin/minv'), '#!/bin/sh\nset -eu\nSELF=$(readlink -f -- "$0")\nROOT=$(dirname -- "$(dirname -- "$SELF")")\nexec env ELECTRON_RUN_AS_NODE=1 "$ROOT/minv" "$ROOT/resources/cli/minv.mjs" "$@"\n', { mode: 0o755 });
    await cp(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'));
    const icon = path.join(root, 'media/brand/minv.svg');
    if (!existsSync(icon)) throw new Error('The authoritative Minv product icon is required at media/brand/minv.svg.');
    await mkdir(path.join(staging, 'share/icons/hicolor/scalable/apps'), { recursive: true });
    await cp(icon, path.join(staging, 'share/icons/hicolor/scalable/apps/minv.svg'));
    await mkdir(path.join(staging, 'share/applications'), { recursive: true });
    await writeFile(path.join(staging, 'share/applications/minv.desktop'), '[Desktop Entry]\nName=Minv\nComment=Browse. Review. Commit.\nExec=env MINV_DESKTOP_LAUNCH=1 minv %F\nTryExec=minv\nIcon=minv\nType=Application\nTerminal=false\nCategories=Development;RevisionControl;TextEditor;\nStartupWMClass=minv\nMimeType=text/plain;inode/directory;\n');
    const lock = await json(path.join(root, 'package-lock.json'));
    const rendererLock = await json(path.join(root, 'desktop/renderer/package-lock.json'));
    const dependencyNames = ['electron', '@vscode/codicons', 'vscode-oniguruma', 'vscode-textmate', '@vscode/ripgrep-universal'];
    const dependency = (name, entry) => {
      if (!entry?.version || !entry?.integrity) throw new Error(`Missing locked runtime dependency: ${name}`);
      return { name, version: entry.version, license: entry.license, resolved: entry.resolved, integrity: entry.integrity };
    };
    const dependencies = dependencyNames.map(name => dependency(name, lock.packages[`node_modules/${name}`]));
    for (const [key, value] of Object.entries(rendererLock.packages ?? {})) {
      if (key.startsWith('node_modules/@fontsource')) dependencies.push(dependency(key.slice('node_modules/'.length), value));
    }
    for (const [name, source, pattern, license] of [
      ['dompurify', 'src/vs/base/browser/dompurify/dompurify.js', /DOMPurify ([0-9.]+)/, 'Apache-2.0 OR MPL-2.0'],
      ['marked', 'src/vs/base/common/marked/marked.js', /marked v([0-9.]+)/, 'MIT'],
    ]) {
      const version = pattern.exec(await readFile(path.join(root, '.upstream/vscode', source), 'utf8'))?.[1];
      if (!version) throw new Error(`Could not determine vendored ${name} dependency version.`);
      dependencies.push({ name, version, license, source: `pinned Code-OSS: ${source}` });
    }
    await writeFile(path.join(staging, 'dependencies.json'), JSON.stringify({ runtime: dependencies, externalRequirements: ['Git', 'Linux desktop system libraries'], bundledEngine: 'Electron includes Chromium, Node.js and their third-party dependencies; see LICENSES.chromium.html.' }, null, 2) + '\n');
    await writeFile(path.join(staging, 'source-provenance.json'), JSON.stringify({
      ...graph,
      desktopBuild: buildProvenance,
      cliSources: { 'src/core/cli.ts': await hash(path.join(root, 'src/core/cli.ts')), 'src/core/update-lease.ts': await hash(path.join(root, 'src/core/update-lease.ts')), 'scripts/minv.mjs': await hash(path.join(root, 'scripts/minv.mjs')) },
      passiveGitConfinement: { source: 'scripts/sandbox-launcher.c', sourceSha256: await hash(path.join(root, 'scripts/sandbox-launcher.c')), binarySha256: await hash(path.join(staging, 'resources/app/native/minv-git-sandbox')) },
      ripgrep: { package: '@vscode/ripgrep-universal@1.18.0', binarySha256: await hash(path.join(staging, 'resources/app/native/rg')), notices: 'resources/app/native/notices/ripgrep/sources.json' },
      editor: 'resources/app/editor/provenance.json', editorAudit: 'resources/app/editor/audit.json',
      electron: { version: require('electron/package.json').version, binarySha256: await hash(path.join(staging, 'minv')), npmIntegrity: lock.packages['node_modules/electron']?.integrity },
    }, null, 2) + '\n');
    await writeFile(path.join(staging, 'THIRD_PARTY_NOTICES.md'), `# Minv dependency notices\n\nMinv: LICENSE. Electron: electron-LICENSE.txt. Chromium, Node.js and Electron's bundled dependencies: LICENSES.chromium.html.\n\nCode-OSS and editor dependencies: resources/app/editor/notices/. Exact source revision, transformations and source hashes: resources/app/editor/provenance.json.\n\nLocal search uses ripgrep 15.0.0 from @vscode/ripgrep-universal 1.18.0, with PCRE2 10.45. Their notices and a conservative locked Rust dependency license inventory are in resources/app/native/notices/. Only the Linux x64 search binary ships.\n\nFont license texts are retained alongside the renderer font assets. Exact packaged dependency versions are in dependencies.json. Git is not bundled.\n\nThis distribution does not use Microsoft's branded VS Code binaries or the Microsoft Marketplace. SHA-256 manifests detect corruption but are not a cryptographic signature or a publisher identity guarantee. Release signing and name clearance remain separate release decisions.\n`);
    const report = await auditRelease(staging, false);
    await writeFile(path.join(staging, 'package-audit.json'), JSON.stringify(report, null, 2) + '\n');
    const checksums = [];
    for (const file of await files(staging)) checksums.push(`${await hash(path.join(staging, file))}  ${file}`);
    await writeFile(path.join(staging, 'SHA256SUMS'), checksums.join('\n') + '\n');
    await auditRelease(staging);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    const epoch = process.env.SOURCE_DATE_EPOCH ?? '0';
    if (!/^\d+$/.test(epoch)) throw new Error('SOURCE_DATE_EPOCH must be a nonnegative integer.');
    const archive = path.join(releases, `${name}.tar.gz`);
    const tar = spawnSync('tar', ['--format=pax', '--pax-option=delete=atime,delete=ctime', '--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '-czf', `${archive}.tmp`, '-C', releases, name], { stdio: 'inherit', shell: false });
    if (tar.error || tar.status !== 0) throw tar.error ?? new Error(`tar exited with ${tar.status}`);
    await rename(`${archive}.tmp`, archive);
    await writeFile(`${archive}.sha256`, `${await hash(archive)}  ${path.basename(archive)}\n`);
    console.log(`Packaged ${target}\nArchive ${archive}\nAudited ${report.fileCount} files; Code-OSS ${report.upstreamCommit}.`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

try {
  const args = process.argv.slice(2);
  if (args[0] === '--audit' && args.length === 2) console.log(JSON.stringify(await auditRelease(path.resolve(args[1])), null, 2));
  else if (args.length) throw new Error('Usage: node scripts/package-desktop.mjs [--audit release-directory]');
  else await packageDesktop();
} catch (error) { console.error(`Packaging failed: ${error.message}`); process.exitCode = 1; }
