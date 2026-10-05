import { randomBytes } from 'node:crypto';
import type { HostMethods } from '../renderer/src/contract';
import { redactSensitiveText } from '../../src/core/redact';
import { SessionStateError, validateRendererSession } from './session-state';

export interface SenderIdentity { webContentsId: number; frameId: string; url: string }
export interface AllowedSender { webContentsId: number; frameId: string }
export class RequestError extends Error {
  constructor(public readonly code: string, message: string) { super(redactSensitiveText(message)); }
}
const fail = (message: string): never => { throw new RequestError('invalid-request', message); };
type Validator = (value: unknown) => unknown;
const text = (name: string, maximum = 4096, allowEmpty = false): Validator => value => {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!allowEmpty && !value.length)) fail(`Invalid ${name}.`);
  return value;
};
const optional = (validate: Validator): Validator => value => value === undefined ? undefined : validate(value);
const boolean: Validator = value => typeof value === 'boolean' ? value : fail('Expected a boolean.');
const confirmed: Validator = value => value === true ? true : fail('Explicit confirmation is required.');
const integer = (name: string, minimum: number, maximum: number): Validator => value => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(`Invalid ${name}.`);
  return value;
};
const choice = (name: string, values: readonly string[]): Validator => value => {
  if (typeof value !== 'string' || !values.includes(value)) fail(`Invalid ${name}.`);
  return value;
};
const list = (validate: Validator, minimum = 0, maximum = 4096): Validator => value => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return fail('Invalid list length.');
  if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) fail('Invalid list object.');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key !== 'length' && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || descriptor.get || descriptor.set)) fail('Invalid list property.');
  }
  const entries = Array.from(value, validate);
  if (new Set(entries).size !== entries.length) fail('Duplicate list entries are not allowed.');
  return entries;
};
function object(fields: Record<string, Validator>): Validator {
  return value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected a request object.');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('Invalid request object prototype.');
    if (Object.getOwnPropertySymbols(value).length) fail('Invalid request key.');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !Object.hasOwn(fields, key)) fail('Unknown request parameter.');
      if (descriptor.get || descriptor.set || !descriptor.enumerable) fail('Invalid request property.');
    }
    const result: Record<string, unknown> = {};
    for (const [key, validate] of Object.entries(fields)) {
      const normalized = validate(descriptors[key]?.value);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  };
}
const noParams: Validator = value => value === undefined || value === null ? undefined : fail('This request has no parameters.');
const repositoryId = text('repository id', 256);
const token = text('review token', 128);
const pathText = (directory = false): Validator => value => {
  const result = text(directory ? 'directory' : 'file path', 4096, directory)(value) as string;
  if (result.startsWith('/') || result.startsWith('\\') || /^[A-Za-z]:/.test(result)
    || result.split('/').some(part => part === '..' || part === '.git') || (!directory && result === '.')) fail('Expected a repository-relative path.');
  return result;
};
const file = pathText();
const paths = list(file, 1);
const oid: Validator = value => {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(text('object id', 64)(value) as string)) fail('Invalid object id.');
  return value;
};
const side = choice('diff side', ['staged', 'unstaged']);
const revision = text('revision', 2048);
const encoding = choice('text encoding', ['utf8', 'utf16le', 'utf16be']);
const actions = ['stage', 'unstage', 'discard', 'commit', 'createBranch', 'switchBranch', 'stash', 'applyStash', 'dropStash', 'fetch', 'pull', 'push'];
const branchTarget = object({ name: text('branch name', 1024), ref: text('branch ref', 2048), oid, remote: boolean, current: boolean, upstream: optional(text('upstream ref', 2048)) });
const stashEntry = object({ selector: text('stash selector', 128), oid, subject: text('stash subject', 65536, true), date: text('stash date', 128) });
const remoteTarget = object({ name: text('remote name', 1024), fetchUrl: text('fetch URL', 16384, true), pushUrl: text('push URL', 16384, true), fingerprint: text('remote fingerprint', 128), lastFetchedAt: optional(integer('fetch time', 0, Number.MAX_SAFE_INTEGER)) });
const scoped = { repositoryId, path: file };
const content = { ...scoped, text: text('file text', 32 * 1024 * 1024, true), encoding, bom: boolean, baseVersion: text('disk version', 1024) };
const mutation = { repositoryId, token };
const selectedMutation = { ...mutation, paths };
const networkMutation = { ...mutation, remote: remoteTarget };
const branchMutation = { ...networkMutation, branch: text('branch name', 1024) };
const query = { query: text('query', 65536, true), scope: list(repositoryId) };
const documentId = text('document id', 1024);
const writeBasis: Validator = value => {
  const kind = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'kind')?.value : undefined;
  if (kind === 'review') return object({ kind: choice('write basis', ['review']), reviewId: token })(value);
  if (kind === 'status') return object({ kind: choice('write basis', ['status']), generation: integer('status generation', 0, Number.MAX_SAFE_INTEGER) })(value);
  if (kind === 'none') return object({ kind: choice('write basis', ['none']) })(value);
  return fail('Invalid write basis.');
};
const preferences = object({
  appearance: optional(choice('appearance', ['system', 'light', 'dark', 'light-contrast', 'dark-contrast'])),
  motion: optional(choice('motion', ['system', 'reduce'])), density: optional(choice('density', ['compact', 'comfortable'])),
  editorFontSize: optional(integer('editor font size', 8, 40)), tabSize: optional(integer('tab size', 1, 16)),
  wordWrap: optional(boolean), renderWhitespace: optional(boolean), gitPath: optional(text('Git executable', 4096)),
  terminal: optional(text('terminal command', 4096, true)), browseExclude: optional(list(text('browse glob', 4096), 0, 256)),
  searchExclude: optional(list(text('search glob', 4096), 0, 256)),
});

// The mapped type makes omitted/new contract methods a compile error. Every
// object schema rejects unknown keys recursively and returns a detached value.
const validators: { [M in keyof HostMethods]: Validator } = {
  'workspace.get': noParams, 'workspace.open': object({ recentId: optional(text('recent workspace id', 256)) }),
  'workspace.recent': noParams, 'workspace.close': noParams, 'workspace.trust': object({ trusted: boolean }),
  'workspace.closeReady': object({ requestId: text('close request id', 128), allow: boolean }),
  'session.get': noParams,
  'session.save': value => {
    try { return validateRendererSession(value); }
    catch (error) { if (error instanceof SessionStateError) throw new RequestError(error.code, error.message); throw error; }
  },
  'repo.select': object({ id: repositoryId }), 'repo.refresh': object({ id: optional(repositoryId), all: optional(boolean) }),
  'fs.list': object({ repositoryId, dir: pathText(true) }), 'fs.read': object(scoped), 'fs.write': object(content),
  'fs.findPaths': object({ ...query, limit: integer('path limit', 1, 10000) }),
  'fs.createFile': object(scoped), 'fs.createDirectory': object(scoped),
  'fs.prepareTransfer': object({ ...scoped, mode: choice('transfer mode', ['copy', 'move']), targetRepositoryId: repositoryId, targetPath: file }),
  'fs.transfer': object({ token, confirmed: boolean }), 'fs.delete': object({ ...scoped, version: text('disk version', 1024) }),
  'fs.backups': noParams, 'fs.restore': object({ backupId: text('backup id', 1024) }),
  'fs.removeBackup': object({ backupId: text('backup id', 1024) }),
  'fs.recover': object({ ...content, documentId }), 'fs.recoveries': noParams,
  'fs.readRef': object({ ref: text('authorized file reference', 128) }),
  'fs.readRecovery': object({ documentId }), 'fs.removeRecovery': object({ documentId }),
  'git.diff': object({ ...scoped, side, ignoreWhitespace: optional(boolean) }), 'git.hunks': object({ ...scoped, side }),
  'git.applyHunks': object({ repositoryId, reviewId: token, ids: list(text('hunk id', 128), 1) }),
  'git.prepare': value => {
    const result = object({ repositoryId, action: choice('write action', actions), paths: optional(list(file)), basis: writeBasis })(value) as Record<string, unknown>;
    const pathCount = (result.paths as string[] | undefined)?.length ?? 0;
    if (['stage', 'unstage', 'discard', 'stash'].includes(result.action as string)) {
      if (!pathCount) fail('Choose explicit paths for this operation.');
    } else if (pathCount) fail('This operation does not accept file paths.');
    if ((result.basis as { kind: string }).kind === 'none' && !['fetch', 'createBranch', 'switchBranch', 'applyStash', 'dropStash'].includes(result.action as string)) fail('This action requires the content or status the user reviewed.');
    return result;
  },
  'git.stage': object(selectedMutation), 'git.unstage': object(selectedMutation),
  'git.discard': object({ ...selectedMutation, confirmed }),
  'git.commit': object({ ...mutation, message: value => {
    const message = text('commit message', 65536)(value) as string;
    if (!message.trim()) fail('Enter a commit message.'); return message;
  } }),
  'git.history': object({ repositoryId, offset: integer('history offset', 0, 10000000), revision: optional(revision), path: optional(file) }),
  'git.show': object({ repositoryId, oid }), 'git.revisionDiff': object({ repositoryId, from: revision, to: revision, path: optional(file) }),
  'git.operation': object({ repositoryId }), 'git.branches': object({ repositoryId }),
  'git.createBranch': object({ ...mutation, name: text('branch name', 1024), start: branchTarget, switchTo: boolean }),
  'git.switchBranch': object({ ...mutation, target: branchTarget }), 'git.stashes': object({ repositoryId }),
  'git.stash': object({ ...selectedMutation, message: text('stash message', 65536, true), includeUntracked: boolean }),
  'git.applyStash': object({ ...mutation, entry: stashEntry, restoreIndex: boolean }),
  'git.dropStash': object({ ...mutation, entry: stashEntry, confirmed }), 'git.remotes': object({ repositoryId }),
  'git.fetch': object(networkMutation), 'git.pull': object(branchMutation), 'git.push': object(branchMutation),
  'git.cancel': object({ repositoryId }),
  'search.start': object({ ...query, regex: boolean, caseSensitive: boolean, includeIgnored: boolean }),
  'search.cancel': object({ searchId: text('search id', 128) }),
  'shell.openTerminal': object({ repositoryId }), 'shell.reveal': object({ repositoryId, path: optional(file) }),
  'diagnostics.open': noParams, 'prefs.get': noParams, 'prefs.set': preferences,
  'window.minimize': noParams, 'window.toggleMaximize': noParams, 'window.close': noParams,
  'window.ready': noParams,
  'cli.released': object({ wait: text('CLI wait handle', 128) }),
};

export function assertSender(sender: SenderIdentity, allowed: AllowedSender): void {
  if (sender.webContentsId !== allowed.webContentsId || sender.frameId !== allowed.frameId) fail('Only the main Minv window can make requests.');
  let url: URL;
  try { url = new URL(sender.url); } catch { return fail('Invalid sender URL.'); }
  if (url.protocol !== 'minv-app:' || url.hostname !== 'app' || url.pathname !== '/index.html' || url.username || url.password || url.port || url.search || url.hash) fail('Unapproved sender origin.');
}

export function validateRequest(method: unknown, value: unknown): { method: keyof HostMethods; params: unknown } {
  if (typeof method !== 'string' || !Object.hasOwn(validators, method)) return fail('Unknown Minv request.');
  const known = method as keyof HostMethods;
  return { method: known, params: validators[known](value) };
}

/** Main-only single-use handles bind reviewed state to one repository/action. */
export class ReviewTickets<T> {
  private values = new Map<string, { repositoryId: string; action: string; value: T; expires: number }>();
  constructor(private readonly ttlMs = 10 * 60 * 1000, private readonly now = Date.now) {}
  issue(repositoryId: string, action: string, value: T): string {
    for (const [token, ticket] of this.values) if (ticket.expires < this.now()) this.values.delete(token);
    if (this.values.size >= 256) throw new RequestError('unavailable', 'Too many open reviews. Close an older review and try again.');
    const token = randomBytes(24).toString('hex');
    this.values.set(token, { repositoryId, action, value, expires: this.now() + this.ttlMs });
    return token;
  }
  peek(token: string, repositoryId: string, actions: readonly string[]): T {
    const ticket = this.values.get(token);
    if (!ticket || ticket.expires < this.now() || ticket.repositoryId !== repositoryId || !actions.includes(ticket.action)) throw new RequestError('stale-review', 'The review is no longer valid for this operation. Refresh and review it again.');
    return ticket.value;
  }
  consume(token: string, repositoryId: string, actions: readonly string[]): T {
    const value = this.peek(token, repositoryId, actions); this.values.delete(token); return value;
  }
  clear(): void { this.values.clear(); }
}

export type Handlers = Partial<{ [M in keyof HostMethods]: (params: HostMethods[M][0]) => Promise<HostMethods[M][1]> | HostMethods[M][1] }>;
export class RequestRouter {
  constructor(private readonly sender: () => AllowedSender, private readonly handlers: Handlers) {}
  async dispatch(sender: SenderIdentity, method: unknown, value: unknown): Promise<unknown> {
    assertSender(sender, this.sender());
    const request = validateRequest(method, value);
    const handler = this.handlers[request.method];
    if (!handler) throw new RequestError('unavailable', 'This operation is not available.');
    return (handler as (input: unknown) => unknown)(request.params);
  }
}
