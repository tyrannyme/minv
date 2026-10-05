// Generates desktop/design-tokens.css from desktop/design-tokens.json and vendors fonts.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.resolve(here, '..');
const desktop = path.resolve(renderer, '..');
const tokens = JSON.parse(readFileSync(path.join(desktop, 'design-tokens.json'), 'utf8'));

const kebab = s => s.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const block = (vars) => Object.entries(vars).map(([k, v]) => `  --${k}: ${v};`).join('\n');

const root = {};
for (const [k, v] of Object.entries(tokens.type)) if (typeof v === 'string') root[`font-${k}`] = v;
for (const [k, v] of Object.entries(tokens.type.size)) root[`text-${k}`] = v;
for (const [k, v] of Object.entries(tokens.type.leading)) root[`leading-${k}`] = v;
for (const [k, v] of Object.entries(tokens.space)) root[`space-${k}`] = v;
for (const [k, v] of Object.entries(tokens.radius)) root[`radius-${k}`] = v;
for (const [k, v] of Object.entries(tokens.size)) root[`size-${kebab(k)}`] = v;
for (const [k, v] of Object.entries(tokens.motion)) root[`motion-${k}`] = v;

const theme = (name) => {
  const t = tokens.themes[name];
  const vars = {};
  for (const [k, v] of Object.entries(t)) if (k !== 'base') vars[kebab(k)] = v;
  for (const [k, v] of Object.entries(tokens.syntax[name])) vars[`syntax-${k}`] = v;
  vars['color-scheme-base'] = t.base;
  return `${block(vars)}\n  color-scheme: ${t.base};`;
};

const css = `/* Generated from desktop/design-tokens.json by desktop/renderer/scripts/tokens.mjs. Do not edit. */
:root {
${block(root)}
}
:root, [data-theme="dark"] {
${theme('dark')}
}
[data-theme="light"] {
${theme('light')}
}
[data-theme="dark-contrast"] {
${theme('dark-contrast')}
}
[data-theme="light-contrast"] {
${theme('light-contrast')}
}
@media (prefers-color-scheme: light) {
  [data-theme="system"] {
${theme('light').replace(/^/gm, '  ')}
  }
}
@media (prefers-contrast: more) {
  [data-theme="system"] {
${theme('dark-contrast').replace(/^/gm, '  ')}
  }
}
@media (prefers-contrast: more) and (prefers-color-scheme: light) {
  [data-theme="system"] {
${theme('light-contrast').replace(/^/gm, '  ')}
  }
}
`;
writeFileSync(path.join(desktop, 'design-tokens.css'), css);

// Vendor the three families. Licenses travel with the files.
const fonts = path.join(renderer, 'assets', 'fonts');
mkdirSync(fonts, { recursive: true });
const vendor = [
  ['@fontsource-variable/instrument-sans', ['instrument-sans-latin-standard-normal.woff2', 'instrument-sans-latin-standard-italic.woff2'], 'InstrumentSans'],
  ['@fontsource-variable/martian-mono', ['martian-mono-latin-standard-normal.woff2'], 'MartianMono'],
  ['@fontsource/commit-mono', ['commit-mono-latin-400-normal.woff2', 'commit-mono-latin-400-italic.woff2', 'commit-mono-latin-600-normal.woff2'], 'CommitMono'],
];
const modules = path.join(renderer, 'node_modules');
for (const [pkg, files, label] of vendor) {
  const dir = path.join(modules, pkg);
  if (!existsSync(dir)) { if (existsSync(path.join(fonts, files[0]))) continue; throw new Error(`Missing ${pkg}; run npm install in desktop/renderer`); }
  for (const file of files) copyFileSync(path.join(dir, 'files', file), path.join(fonts, file));
  copyFileSync(path.join(dir, 'LICENSE'), path.join(fonts, `${label}-OFL.txt`));
}
console.log('tokens: design-tokens.css written; fonts vendored');
