import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSender, RequestRouter, ReviewTickets, validateRequest, type SenderIdentity } from '../desktop/main/protocol';

const allowed = { webContentsId: 42, frameId: 'frame-main' };
const sender: SenderIdentity = { ...allowed, url: 'minv-app://app/index.html' };

test('desktop requests reject wrong windows, child frames and foreign origins before dispatch', async () => {
  let calls = 0;
  const router = new RequestRouter(() => allowed, { 'repo.select': () => { calls++; } });
  for (const malicious of [
    { ...sender, webContentsId: 43 }, { ...sender, frameId: 'frame-child' },
    { ...sender, url: 'https://app/index.html' }, { ...sender, url: 'minv-app://app.evil/index.html' },
    { ...sender, url: 'minv-app://app/other.html' }, { ...sender, url: 'minv-app://user:pass@app/index.html' },
    { ...sender, url: 'file:///index.html' }, { ...sender, url: 'not a URL' },
  ]) await assert.rejects(router.dispatch(malicious, 'repo.select', { id: 'known-repository' }), /sender|origin|window|URL/i);
  assert.equal(calls, 0);
  assert.doesNotThrow(() => assertSender(sender, allowed));
  await router.dispatch(sender, 'repo.select', { id: 'known-repository' });
  assert.equal(calls, 1);
});

test('IPC rejects object-shaped enum values, prototype keys, surplus authority and malformed payloads', () => {
  const attempts: [string, unknown][] = [
    ['git.diff', { repositoryId: 'r', path: 'file', side: ['staged'] }],
    ['prefs.set', { appearance: ['ink'] }],
    ['prefs.set', { motion: ['reduce'] }],
    ['prefs.set', { density: ['compact'] }],
    ['prefs.set', JSON.parse('{"__proto__":{"trusted":true}}')],
    ['repo.select', { id: 'r', trusted: true }],
    ['git.prepare', { repositoryId: 'r', action: 'commit', root: '/outside' }],
    ['git.stage', { repositoryId: 'r', token: 'review', paths: ['file'], force: true }],
    ['git.commit', { repositoryId: 'r', token: 'review', message: 'commit', skipHooks: true }],
    ['git.history', { repositoryId: 'r', offset: NaN }],
    ['git.history', { repositoryId: 'r', offset: -1 }],
    ['fs.findPaths', { query: '', scope: ['r'], limit: Infinity }],
    ['search.start', { query: 'x', scope: ['r'], regex: 'yes', caseSensitive: false, includeIgnored: false }],
    ['git.stage', { repositoryId: 'r', token: 'review', paths: [] }],
    ['git.commit', { repositoryId: 'r', token: 'review', message: '  ' }],
    ['git.diff', { repositoryId: 'r', path: 'file\0suffix', side: 'staged' }],
    ['git.exec', { args: ['reset', '--hard'] }],
    ['window.close', { force: true }],
  ];
  for (const [method, payload] of attempts) assert.throws(() => validateRequest(method, payload), Error, method + ': ' + JSON.stringify(payload));
});

test('review handles cannot change repository/action, outlive expiry, survive workspace reset or replay', () => {
  let clock = 100;
  const tickets = new ReviewTickets<{ fingerprint: string }>(1000, () => clock);
  const token = tickets.issue('checkout-a', 'stage', { fingerprint: 'reviewed' });
  assert.throws(() => tickets.consume(token, 'checkout-b', ['stage']), /no longer valid/);
  assert.throws(() => tickets.consume(token, 'checkout-a', ['commit']), /no longer valid/);
  assert.throws(() => tickets.consume('invented', 'checkout-a', ['stage']), /no longer valid/);
  assert.equal(tickets.consume(token, 'checkout-a', ['stage']).fingerprint, 'reviewed');
  assert.throws(() => tickets.consume(token, 'checkout-a', ['stage']), /no longer valid/);
  const expired = tickets.issue('checkout-a', 'commit', { fingerprint: 'other' });
  clock = 1101;
  assert.throws(() => tickets.peek(expired, 'checkout-a', ['commit']), /no longer valid/);
  const reset = tickets.issue('checkout-a', 'stage', { fingerprint: 'third' });
  tickets.clear();
  assert.throws(() => tickets.consume(reset, 'checkout-a', ['stage']), /no longer valid/);
});

test('unknown and unavailable IPC methods do not fall through to a generic executor', async () => {
  const router = new RequestRouter(() => allowed, {});
  await assert.rejects(router.dispatch(sender, 'process.spawn', { executable: 'sh' }), /Unknown/);
  await assert.rejects(router.dispatch(sender, 'git.operation', { repositoryId: 'r' }), /not available/);
});
