import type { Branch, Change, Freshness, Observation, RepositoryRow, RepositoryStatus } from './contract.js';

export function relativeTime(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return 'never';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function shortOid(oid: string | undefined): string { return oid ? oid.slice(0, 7) : ''; }

/** The branch answer as text. Undefined means no value has ever been read. */
export function branchText(branch: Observation<Branch>): string | undefined {
  const value = branch.value;
  if (!value) return undefined;
  if (value.kind === 'branch') return value.name ?? 'unnamed branch';
  if (value.kind === 'detached') return `detached ${shortOid(value.oid)}`;
  return `${value.name ?? 'main'} (no commits)`;
}

/** Values we may show but must not present as verified. */
export function unverified(state: Freshness): boolean { return state === 'cached' || state === 'stale'; }

export const freshnessWord: Record<Freshness, string> = {
  unknown: 'Not checked', cached: 'Unverified', refreshing: 'Checking', observed: 'Verified', stale: 'Out of date', error: 'Failed',
};

export function branchSentence(row: RepositoryRow, now = Date.now()): string {
  const b = row.branch;
  if (!row.available) return row.error ?? 'Checkout is unavailable';
  switch (b.state) {
    case 'unknown': return 'Branch not checked yet';
    case 'cached': return 'Branch from last session, not yet verified';
    case 'refreshing': return b.value ? 'Rechecking branch' : 'Checking branch';
    case 'observed': return `Branch checked ${relativeTime(b.observedAt, now)}`;
    case 'stale': return `Branch may have changed · last checked ${relativeTime(b.observedAt, now)}`;
    case 'error': return b.error ?? 'Branch could not be read';
  }
}

export function statusSentence(row: RepositoryRow, now = Date.now()): string {
  const s = row.status;
  if (!row.available) return '';
  switch (s.state) {
    case 'unknown': return 'Changes not checked yet';
    case 'cached': return 'Changes from last session, not verified';
    case 'refreshing': return s.value ? 'Rechecking changes' : 'Checking changes';
    case 'observed': return s.value?.complete === false ? `Partial · untracked files pending · ${relativeTime(s.observedAt, now)}` : `Changes checked ${relativeTime(s.observedAt, now)}`;
    case 'stale': return `Changes may be out of date · last checked ${relativeTime(s.observedAt, now)}`;
    case 'error': return s.error ?? 'Changes could not be read';
  }
}

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict' | 'submodule' | 'ignored';
export interface ChangeEntry { change: Change; kind: ChangeKind; letter: string; side: 'staged' | 'unstaged' }
export interface ChangeGroups { conflicts: ChangeEntry[]; staged: ChangeEntry[]; unstaged: ChangeEntry[]; untracked: ChangeEntry[]; pointers: ChangeEntry[] }

const conflictPairs = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
function kindOf(code: string): ChangeKind {
  switch (code) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': case 'C': return 'renamed';
    default: return 'modified';
  }
}
const letters: Record<ChangeKind, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: '!', submodule: 'S', ignored: 'I' };

/** Splits porcelain v2 records into the review groups. A file can be in both staged and unstaged. */
export function groupChanges(status: RepositoryStatus | undefined): ChangeGroups {
  const groups: ChangeGroups = { conflicts: [], staged: [], unstaged: [], untracked: [], pointers: [] };
  for (const change of status?.changes ?? []) {
    const xy = change.index + change.workingTree;
    if (change.index === '?') { groups.untracked.push({ change, kind: 'untracked', letter: 'U', side: 'unstaged' }); continue; }
    if (change.index === '!') continue;
    if (conflictPairs.has(xy)) { groups.conflicts.push({ change, kind: 'conflict', letter: '!', side: 'unstaged' }); continue; }
    if (change.submodule && change.submodule.startsWith('S')) {
      if (change.index !== '.') groups.pointers.push({ change, kind: 'submodule', letter: 'S', side: 'staged' });
      if (change.workingTree !== '.') groups.pointers.push({ change, kind: 'submodule', letter: 'S', side: 'unstaged' });
      continue;
    }
    if (change.index !== '.') { const kind = kindOf(change.index); groups.staged.push({ change, kind, letter: letters[kind], side: 'staged' }); }
    if (change.workingTree !== '.') { const kind = kindOf(change.workingTree); groups.unstaged.push({ change, kind, letter: letters[kind], side: 'unstaged' }); }
  }
  const byPath = (a: ChangeEntry, b: ChangeEntry) => a.change.path.localeCompare(b.change.path);
  for (const list of Object.values(groups)) list.sort(byPath);
  return groups;
}

/** Distinct changed paths; one file staged and unstaged counts once. */
export function changeCount(status: RepositoryStatus | undefined): number {
  return new Set(status?.changes.filter(c => c.index !== '!').map(c => c.path)).size;
}

/** Human description of a submodule pointer record (porcelain v2 "S<c><m><u>"). */
export function pointerSentence(entry: ChangeEntry): string {
  const s = entry.change.submodule ?? '';
  const parts: string[] = [];
  if (s[1] === 'C') parts.push(entry.side === 'staged' ? 'new commit recorded' : 'checked-out commit differs from recorded');
  if (s[2] === 'M') parts.push('child has tracked changes');
  if (s[3] === 'U') parts.push('child has untracked files');
  return parts.join(' · ') || (entry.side === 'staged' ? 'pointer staged' : 'pointer changed');
}

export function splitPath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { dir: '', base: path } : { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
}

export function plural(n: number, one: string, many = `${one}s`): string { return `${n} ${n === 1 ? one : many}`; }

export function languageOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', css: 'css', html: 'html', sh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'toml', java: 'java', kt: 'kotlin', rs: 'rust', py: 'python', gradle: 'groovy', svg: 'xml', xml: 'xml' };
  return map[ext] ?? 'plaintext';
}
export const languageName: Record<string, string> = { typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON', markdown: 'Markdown', css: 'CSS', html: 'HTML', shell: 'Shell', yaml: 'YAML', toml: 'TOML', java: 'Java', kotlin: 'Kotlin', rust: 'Rust', python: 'Python', groovy: 'Groovy', xml: 'XML', plaintext: 'Plain text' };
