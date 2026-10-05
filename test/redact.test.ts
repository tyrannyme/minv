import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveText, safeErrorMessage } from '../src/core/redact';
import { RequestError } from '../desktop/main/protocol';

test('credential-bearing URLs and authorization text are redacted before error display', () => {
  const message = 'fatal: https://user:password@example.invalid/repo?access%5Ftoken=secret&api_key=keyvalue&branch=main\nAuthorization: Bearer abcdef\nAuthorization: Basic dXNlcjpwYXNz';
  const safe = redactSensitiveText(message);
  for (const secret of ['user:password', '=secret', '=keyvalue', 'abcdef', 'dXNlcjpwYXNz']) assert.ok(!safe.includes(secret), secret);
  assert.match(safe, /https:\/\/\[redacted\]@example\.invalid\/repo/);
  assert.match(safe, /branch=main/);
  assert.equal(safeErrorMessage(new Error(message)), safe);
  assert.equal(new RequestError('git', message).message, safe);
  assert.equal(redactSensitiveText('https://user:pa@ss@host.invalid/repo'), 'https://[redacted]@host.invalid/repo');
  assert.equal(redactSensitiveText('https://user:pa%2Fss@host.invalid/repo'), 'https://[redacted]@host.invalid/repo');
});

test('ordinary SSH remotes and noncredential diagnostics remain useful', () => {
  const message = 'git@example.invalid:team/repo — index.lock exists; https://example.invalid/code?branch=main';
  assert.equal(redactSensitiveText(message), message);
  assert.equal(redactSensitiveText('ghp_abcdefghijklmnopqrstuvwxyz1234567890'), '[redacted]');
});
