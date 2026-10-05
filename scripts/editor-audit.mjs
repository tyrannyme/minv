import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { json, pin, root } from './upstream-lib.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const output = resolve(root, 'desktop/editor/generated');

try {
  const policy = json(resolve(root, 'product/editor-scope.json'));
  const graph = json(resolve(output, 'metafile.json'));
  const provenance = json(resolve(output, 'provenance.json'));
  if (provenance.upstream.commit !== pin.commit || policy.upstream !== pin.commit) throw new Error('Editor source revision does not match pin.');
  if (provenance.policyHash !== hash(readFileSync(resolve(root, 'product/editor-scope.json')))) throw new Error('Editor source policy changed after build.');
  const compiledInputs = Object.keys(graph.inputs);
  const expected = json(resolve(root, 'product/editor-inputs.json'));
  if (JSON.stringify([...compiledInputs].sort()) !== JSON.stringify([...expected.inputs].sort())) throw new Error('Compiled editor closure differs from the reviewed exact input allowlist.');
  const excludedInputs = compiledInputs.filter(file => {
    const source = file.replace(/^\.upstream\/vscode\//, '');
    return policy.forbiddenSourcePrefixes.some(prefix => source.startsWith(prefix)) || policy.forbiddenSourceFiles.includes(source);
  });
  if (excludedInputs.length) throw new Error(`Excluded runtime input: ${excludedInputs.join(', ')}`);
  const externalImports = Object.values(graph.outputs).flatMap(output => output.imports).filter(item => item.external);
  if (externalImports.length) throw new Error(`Unbundled runtime import: ${JSON.stringify(externalImports)}`);
  for (const [file, digest] of Object.entries(provenance.inputs)) {
    if (!existsSync(resolve(root, file)) || hash(readFileSync(resolve(root, file))) !== digest) throw new Error(`Source changed after build: ${file}`);
  }
  for (const [file, digest] of Object.entries(provenance.outputHashes)) {
    if (hash(readFileSync(resolve(output, file))) !== digest) throw new Error(`Built asset changed: ${file}`);
  }
  const report = {
    passed: true,
    upstream: pin.commit,
    compiledInputs: compiledInputs.length,
    emittedInputs: new Set(Object.values(graph.outputs).flatMap(item => Object.entries(item.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path))).size,
    excludedInputs,
    externalImports,
    policyHash: provenance.policyHash,
    inputAllowlistHash: hash(readFileSync(resolve(root, 'product/editor-inputs.json'))),
    compiledOutputHashes: provenance.outputHashes,
    inertCompatibilityServices: [
      'StandaloneTelemetryService: TelemetryLevel.NONE; logging methods are empty.',
      'StandaloneDefaultAccountService: null account/entitlements; signIn/refresh return null; no provider implementation.',
      'StandaloneTreeSitterLibraryService: language support false; no parser or remote model loading.',
    ],
    scope: 'Source-built editor closure only. Desktop runtime, packaging, network and product acceptance gates are separate.',
  };
  writeFileSync(resolve(output, 'audit.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Editor closure PASS: ${report.compiledInputs} inputs (${report.emittedInputs} emit bytes); no excluded source or external imports.\nVerified ${Object.keys(provenance.outputHashes).length} local asset hashes.\n${relative(root, resolve(output, 'audit.json'))}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
