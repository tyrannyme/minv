/** Unified diff model for the review surface and hunk staging. Pure; no DOM. */

export interface DiffLine { kind: ' ' | '+' | '-' | '\\'; text: string; oldNo?: number; newNo?: number }
export interface Hunk { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; section: string; lines: DiffLine[] }
export interface FileDiff { header: string[]; oldPath?: string; newPath?: string; binary: boolean; hunks: Hunk[] }

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function stripPrefix(path: string): string | undefined {
  if (path === '/dev/null') return undefined;
  return path.replace(/^[ab]\//, '').replace(/\t.*$/, '');
}

/** Parses `git diff` output. Multiple files are returned in order. Throws on malformed hunks. */
export function parseDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldNo = 0, newNo = 0, oldLeft = 0, newLeft = 0;
  for (const line of lines) {
    if (line.startsWith('diff ')) { file = { header: [line], binary: false, hunks: [] }; files.push(file); hunk = undefined; continue; }
    if (!file) { file = { header: [], binary: false, hunks: [] }; files.push(file); }
    const match = hunkHeader.exec(line);
    if (match && (!hunk || (oldLeft <= 0 && newLeft <= 0))) {
      hunk = { header: line, oldStart: +match[1]!, oldLines: match[2] === undefined ? 1 : +match[2], newStart: +match[3]!, newLines: match[4] === undefined ? 1 : +match[4], section: match[5] ?? '', lines: [] };
      file.hunks.push(hunk);
      oldNo = hunk.oldStart; newNo = hunk.newStart; oldLeft = hunk.oldLines; newLeft = hunk.newLines;
      continue;
    }
    if (!hunk) {
      file.header.push(line);
      if (line.startsWith('--- ')) file.oldPath = stripPrefix(line.slice(4));
      else if (line.startsWith('+++ ')) file.newPath = stripPrefix(line.slice(4));
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
      continue;
    }
    const kind = line[0] ?? ' ';
    const body = line.slice(1);
    if (kind === ' ' || line === '') { hunk.lines.push({ kind: ' ', text: body, oldNo: oldNo++, newNo: newNo++ }); oldLeft--; newLeft--; }
    else if (kind === '-') { hunk.lines.push({ kind: '-', text: body, oldNo: oldNo++ }); oldLeft--; }
    else if (kind === '+') { hunk.lines.push({ kind: '+', text: body, newNo: newNo++ }); newLeft--; }
    else if (kind === '\\') hunk.lines.push({ kind: '\\', text: body });
    else { hunk = undefined; file.header.push(line); }
  }
  return files;
}

export interface SplitRow { left?: DiffLine; right?: DiffLine }

/** Pairs deletions with following additions for side-by-side review. */
export function splitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  const lines = hunk.lines.filter(line => line.kind !== '\\');
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === ' ') { rows.push({ left: line, right: line }); i++; continue; }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === '-') removed.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === '+') added.push(lines[i++]!);
    for (let j = 0; j < Math.max(removed.length, added.length); j++) rows.push({ left: removed[j], right: added[j] });
  }
  return rows;
}

/** Character range that differs between two paired lines (common prefix/suffix trim). */
export function changedRange(before: string, after: string): { before: [number, number]; after: [number, number] } | undefined {
  if (before === after) return undefined;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length, endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  // A highlight covering nearly the whole line is noise; only mark focused edits.
  const span = Math.max(endBefore - start, endAfter - start);
  if (span > Math.max(before.length, after.length) * 0.7) return undefined;
  return { before: [start, endBefore], after: [start, endAfter] };
}

/** Pairs for intraline highlighting in inline mode: index of '-' line → matching '+' line. */
export function inlinePairs(hunk: Hunk): Map<DiffLine, DiffLine> {
  const pairs = new Map<DiffLine, DiffLine>();
  for (const row of splitRows(hunk)) if (row.left && row.right && row.left.kind === '-' && row.right.kind === '+') { pairs.set(row.left, row.right); pairs.set(row.right, row.left); }
  return pairs;
}

export function stats(file: FileDiff): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const hunk of file.hunks) for (const line of hunk.lines) { if (line.kind === '+') added++; else if (line.kind === '-') removed++; }
  return { added, removed };
}
