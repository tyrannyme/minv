#!/usr/bin/env node
// Writes the published release's facts into the landing page before CI deploys it, so a release never needs a
// page edit. Each element marked data-release="<key>" gets its text replaced.
// Usage: node site/stamp-release.mjs <tag> <code-oss version> <patch count>
import { readFileSync, writeFileSync } from 'node:fs';

const [tag, codeOss, patches] = process.argv.slice(2);
if (!/^v\d/.test(tag ?? '') || !/^\d/.test(codeOss ?? '') || !/^\d+$/.test(patches ?? '')) {
  throw new Error('Usage: node site/stamp-release.mjs <tag> <code-oss version> <patch count>');
}
const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const values = { version: tag, 'code-oss': codeOss, patches: words[Number(patches)] ?? patches };

const file = new URL('public/index.html', import.meta.url);
let html = readFileSync(file, 'utf8');
for (const [key, value] of Object.entries(values)) {
  const marker = new RegExp(`(<span data-release="${key}">)[^<]*(</span>)`, 'g');
  if (!marker.test(html)) throw new Error(`index.html has no data-release="${key}"`);
  html = html.replace(marker, `$1${value}$2`);
}
writeFileSync(file, html);
console.log(Object.entries(values).map(([key, value]) => `${key}: ${value}`).join('\n'));
