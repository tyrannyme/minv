import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRequest } from '../desktop/main/protocol';
import type { HostMethods } from '../desktop/renderer/src/contract';

const hash = '1'.repeat(40);
const scoped = { repositoryId: 'checkout', path: 'src/file.ts' };
const content = { ...scoped, text: '', encoding: 'utf8' as const, bom: false, baseVersion: 'disk-version' };
const mutation = { repositoryId: 'checkout', token: 'review-token' };
const selected = { ...mutation, paths: ['src/file.ts'] };
const target = { name: 'main', ref: 'refs/heads/main', oid: hash, remote: false, current: true };
const entry = { selector: 'stash@{0}', oid: hash, subject: '', date: '2026-01-01T00:00:00Z' };
const remote = { name: 'origin', fetchUrl: 'https://example.invalid/code', pushUrl: 'https://example.invalid/code', fingerprint: '2'.repeat(64) };
const network = { ...mutation, remote };
const query = { query: '', scope: ['checkout'] };
const session = { version: 1 as const, workspaceId: 'a'.repeat(24), selectedId: 'b'.repeat(24), order: ['b'.repeat(24)], pins: [], layout: 'flat' as const, collapsed: [], tab: 'files' as const, sheets: [{ id: 's1', kind: 'settings' as const }], activeSheet: 's1', focusedPane: 'main' as const, plane: 'sheet' as const, focus: false, indexScrollTop: 0, expandedDirectories: [], commitDrafts: [] };

// New methods and changed required contract fields require an explicit fixture.
const requests: { [M in keyof HostMethods]: HostMethods[M][0] } = {
  'workspace.get': undefined, 'workspace.open': {}, 'workspace.recent': undefined, 'workspace.close': undefined, 'workspace.trust': { trusted: false },
  'workspace.closeReady': { requestId: 'close-request', allow: true },
  'session.get': undefined, 'session.save': session,
  'repo.select': { id: 'checkout' }, 'repo.refresh': { all: true },
  'fs.list': { repositoryId: 'checkout', dir: '' }, 'fs.read': scoped, 'fs.write': content,
  'fs.findPaths': { ...query, limit: 100 }, 'fs.createFile': scoped, 'fs.createDirectory': scoped,
  'fs.prepareTransfer': { ...scoped, mode: 'move', targetRepositoryId: 'other', targetPath: 'next.ts' },
  'fs.transfer': { token: 'transfer-plan', confirmed: false }, 'fs.delete': { ...scoped, version: 'disk-version' },
  'fs.backups': undefined, 'fs.restore': { backupId: 'backup' }, 'fs.recover': { ...content, documentId: 'document' },
  'fs.removeBackup': { backupId: 'backup' },
  'fs.recoveries': undefined, 'fs.readRef': { ref: 'authorized-reference' }, 'fs.readRecovery': { documentId: 'document' }, 'fs.removeRecovery': { documentId: 'document' },
  'git.diff': { ...scoped, side: 'unstaged' }, 'git.hunks': { ...scoped, side: 'staged' },
  'git.applyHunks': { repositoryId: 'checkout', reviewId: 'review', ids: ['hunk'] },
  'git.prepare': { repositoryId: 'checkout', action: 'stage', paths: ['src/file.ts'], basis: { kind: 'status', generation: 1 } },
  'git.stage': selected, 'git.unstage': selected, 'git.discard': { ...selected, confirmed: true },
  'git.commit': { ...mutation, message: 'commit' }, 'git.history': { repositoryId: 'checkout', offset: 0 },
  'git.show': { repositoryId: 'checkout', oid: hash }, 'git.revisionDiff': { repositoryId: 'checkout', from: 'HEAD~1', to: 'HEAD' },
  'git.operation': { repositoryId: 'checkout' }, 'git.branches': { repositoryId: 'checkout' },
  'git.createBranch': { ...mutation, name: 'feature', start: target, switchTo: true }, 'git.switchBranch': { ...mutation, target },
  'git.stashes': { repositoryId: 'checkout' }, 'git.stash': { ...selected, message: '', includeUntracked: true },
  'git.applyStash': { ...mutation, entry, restoreIndex: false }, 'git.dropStash': { ...mutation, entry, confirmed: true },
  'git.remotes': { repositoryId: 'checkout' }, 'git.fetch': network, 'git.pull': { ...network, branch: 'main' }, 'git.push': { ...network, branch: 'main' },
  'git.cancel': { repositoryId: 'checkout' },
  'search.start': { ...query, regex: false, caseSensitive: false, includeIgnored: false }, 'search.cancel': { searchId: 'search' },
  'shell.openTerminal': { repositoryId: 'checkout' }, 'shell.reveal': scoped, 'diagnostics.open': undefined,
  'prefs.get': undefined, 'prefs.set': { appearance: 'system', motion: 'reduce', density: 'compact', editorFontSize: 14, tabSize: 4, wordWrap: true, renderWhitespace: false, gitPath: '/usr/bin/git', terminal: '', browseExclude: ['generated/**'], searchExclude: ['**/lockfile'] },
  'window.minimize': undefined, 'window.toggleMaximize': undefined, 'window.close': undefined, 'cli.released': { wait: 'wait-handle' },
  'window.ready': undefined,
};

test('every v2 desktop request has a strict valid payload schema', () => {
  for (const [method, params] of Object.entries(requests)) assert.deepEqual(validateRequest(method, params), { method, params }, method);
});

test('nested authority, legacy force flags and malformed scalar types never reach handlers', () => {
  const attempts: [string, unknown][] = [
    ['session.save', { ...session, __proto__: { elevated: true } }],
    ['session.save', { ...session, sheets: [{ ...session.sheets[0], path: '../secret' }] }],
    ['git.switchBranch', { ...mutation, target: { ...target, force: true } }],
    ['git.switchBranch', { ...mutation, target: { ...target, remote: 'false' } }],
    ['git.switchBranch', { ...mutation, target: JSON.parse('{"__proto__":{"force":true}}') }],
    ['git.applyStash', { ...mutation, entry: { ...entry, drop: true }, restoreIndex: false }],
    ['git.push', { ...network, remote: { ...remote, executable: 'sh' }, branch: 'main' }],
    ['fs.read', { ...scoped, force: true }], ['fs.write', { ...content, overwrite: true }],
    ['fs.write', { ...content, encoding: 'latin1' }], ['fs.write', { ...content, bom: 'yes' }],
    ['git.history', { repositoryId: 'checkout', skip: 0 }], ['git.applyPatch', { ...mutation, patch: 'arbitrary' }],
    ['git.discard', { ...selected, confirmed: false }], ['git.dropStash', { ...mutation, entry, confirmed: false }],
    ['git.show', { repositoryId: 'checkout', oid: '1'.repeat(41) }],
    ['prefs.set', { editorFontSize: 14.5 }], ['prefs.set', { tabSize: 0 }], ['prefs.set', { gitPath: '' }],
    ['prefs.set', { searchExclude: ['one', 'one'] }], ['prefs.set', { wordWrap: 'true' }],
    ['git.stage', { ...selected, paths: ['../outside'] }], ['fs.read', { ...scoped, path: '/etc/passwd' }],
    ['fs.read', { ...scoped, path: '.git/config' }], ['fs.read', { ...scoped, path: 'C:/outside' }],
    ['git.stage', { ...selected, paths: new Array(1) }],
    ['git.stage', { ...selected, paths: Object.assign(['src/file.ts'], { force: true }) }],
  ];
  for (const [method, params] of attempts) assert.throws(() => validateRequest(method, params), Error, method);
});

test('write preparation requires the exact action scope and a valid displayed basis', () => {
  for (const params of [
    { repositoryId: 'checkout' },
    { repositoryId: 'checkout', action: 'commit' },
    { repositoryId: 'checkout', action: 'stage', basis: { kind: 'status', generation: 1 } },
    { repositoryId: 'checkout', action: 'stage', paths: ['file'], basis: { kind: 'none' } },
    { repositoryId: 'checkout', action: 'commit', paths: ['file'], basis: { kind: 'status', generation: 1 } },
    { repositoryId: 'checkout', action: 'fetch', basis: { kind: 'none', bypass: true } },
    { repositoryId: 'checkout', action: 'commit', basis: { kind: 'status', generation: NaN } },
    { repositoryId: 'checkout', action: 'commit', basis: { kind: 'review', reviewId: '' } },
  ]) assert.throws(() => validateRequest('git.prepare', params));
  assert.doesNotThrow(() => validateRequest('git.prepare', { repositoryId: 'checkout', action: 'fetch', basis: { kind: 'none' } }));
});

test('validation returns detached values and rejects accessors before evaluating them', () => {
  const params = { ...mutation, target: { ...target } };
  const result = validateRequest('git.switchBranch', params).params as typeof params;
  params.target.name = 'changed'; assert.equal(result.target.name, 'main');
  let read = false;
  const malicious = { repositoryId: 'checkout', get path() { read = true; return 'file'; } };
  assert.throws(() => validateRequest('fs.read', malicious)); assert.equal(read, false);
});
