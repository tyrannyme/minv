import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiff, splitRows, changedRange, stats } from '../dist/diff.js';
import { normalizeAppearance } from '../dist/contract.js';
import { groupChanges, changeCount } from '../dist/format.js';

const patch = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@ first
 keep
-old line
+new line
 keep
@@ -10,2 +10,3 @@ second
 ten
+added
 eleven
\\ No newline at end of file
`;

test('parses hunks, line numbers and no-newline markers', () => {
  const [file] = parseDiff(patch);
  assert.equal(file.newPath, 'a.ts');
  assert.equal(file.hunks.length, 2);
  assert.deepEqual(file.hunks[0].lines.map(l => [l.kind, l.oldNo, l.newNo]), [[' ', 1, 1], ['-', 2, undefined], ['+', undefined, 2], [' ', 3, 3]]);
  assert.equal(file.hunks[1].lines.at(-1).kind, '\\');
  assert.deepEqual(stats(file), { added: 2, removed: 1 });
});

test('a content line that looks like a hunk header stays content', () => {
  const [file] = parseDiff('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-@@ -9 +9 @@ not a header\n+@@ -8 +8 @@ still not\n ctx\n');
  assert.equal(file.hunks.length, 1);
  assert.equal(file.hunks[0].lines.length, 3);
});

test('split rows pair removals with additions', () => {
  const rows = splitRows(parseDiff(patch)[0].hunks[0]);
  assert.equal(rows[1].left.text, 'old line');
  assert.equal(rows[1].right.text, 'new line');
});

test('intraline range covers only the changed span', () => {
  assert.deepEqual(changedRange('return a + b;', 'return a - b;'), { before: [9, 10], after: [9, 10] });
  assert.equal(changedRange('abc', 'xyz'), undefined);
});

test('appearance migration maps legacy names and rejects inherited keys', () => {
  assert.equal(normalizeAppearance('ink'), 'dark');
  assert.equal(normalizeAppearance('paper-contrast'), 'light-contrast');
  assert.equal(normalizeAppearance('toString'), 'system');
  assert.equal(normalizeAppearance('constructor'), 'system');
  assert.equal(normalizeAppearance('light'), 'light');
});

test('change groups keep staged and unstaged halves and count files once', () => {
  const status = { complete: true, changes: [
    { path: 'a', index: 'M', workingTree: 'M' },
    { path: 'b', index: '?', workingTree: '?' },
    { path: 'c', index: 'U', workingTree: 'U' },
    { path: 'sub', index: '.', workingTree: 'M', submodule: 'SC..' },
  ] };
  const g = groupChanges(status);
  assert.deepEqual([g.staged.length, g.unstaged.length, g.untracked.length, g.conflicts.length, g.pointers.length], [1, 1, 1, 1, 1]);
  assert.equal(changeCount(status), 4);
});

test('desktop entry closure never reaches the preview fixture', () => {
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist');
  const seen = new Set();
  const walk = file => {
    if (seen.has(file)) return; seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)) walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(path.join(dist, 'main.js'));
  assert.ok(![...seen].some(f => f.includes(`${path.sep}mock${path.sep}`)), 'mock reachable from main.js');
});
