import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_MANIFEST = 16 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_RELEASES = 32;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export interface ReleaseFile { path: string; size: number; sha256: string; executable: boolean }
export interface ReleaseManifest {
  schema: 1; product: 'minv'; version: string; sequence: number; platform: 'linux-x64';
  artifact: { name: string; size: number; sha256: string; format: 'tar.gz' };
  files: ReleaseFile[];
}
export interface SignedRelease { payload: string; signature: string }
export interface RetainedRelease { id: string; version: string; sequence: number; current: boolean }
export interface UpdateSafety { applicationRunning: boolean; dirtyBuffers: number; activeWrites: number }
export interface UpdateStoreOptions { directory: string; publisherPublicKey: string | Buffer; currentVersion: string; platform: 'linux-x64' }

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid update metadata object.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) throw new Error('Unexpected update metadata fields.');
  return row;
}
function string(value: unknown): string { if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid update metadata string.'); return value; }
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error('Invalid update metadata number.');
  return value as number;
}
function digest(value: unknown): string { const result = string(value); if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('Invalid release SHA-256.'); return result; }
function relative(value: unknown): string {
  const result = string(value);
  if (!result || result.length > 4096 || result.startsWith('/') || result.includes('\\') || result.split('/').some(segment => !segment || segment === '.' || segment === '..') || /^[a-z]:/i.test(result)) throw new Error('Invalid release entry path.');
  return result;
}
function version(value: unknown): string {
  const result = string(value);
  if (result.length > 128 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(result)) throw new Error('Invalid release version.');
  const base = result.split('+')[0]!; const separator = base.indexOf('-');
  const core = separator < 0 ? base : base.slice(0, separator); const prerelease = separator < 0 ? undefined : base.slice(separator + 1);
  for (const number of core.split('.')) integer(Number(number));
  if (prerelease?.split('.').some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) throw new Error('Invalid prerelease version.');
  return result;
}
export function compareVersions(left: string, right: string): number {
  const parts = (input: string): { core: number[]; pre?: string[] } => {
    const canonical = version(input).split('+')[0]!;
    const separator = canonical.indexOf('-');
    return { core: (separator < 0 ? canonical : canonical.slice(0, separator)).split('.').map(Number), ...(separator < 0 ? {} : { pre: canonical.slice(separator + 1).split('.') }) };
  };
  const a = parts(left); const b = parts(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]! ? 1 : -1;
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]; const y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function manifest(value: unknown): ReleaseManifest {
  const row = object(value, ['schema', 'product', 'version', 'sequence', 'platform', 'artifact', 'files']);
  if (row.schema !== 1 || row.product !== 'minv' || row.platform !== 'linux-x64') throw new Error('Unsupported release product, schema, or platform.');
  const releaseVersion = version(row.version);
  const artifact = object(row.artifact, ['name', 'size', 'sha256', 'format']);
  if (artifact.format !== 'tar.gz' || artifact.name !== `minv-${releaseVersion}-linux-x64.tar.gz`) throw new Error('Release artifact identity does not match its version/platform.');
  if (!Array.isArray(row.files) || !row.files.length || row.files.length > MAX_FILES) throw new Error('Invalid release file inventory.');
  let previous = ''; let total = 0; const seen = new Set<string>();
  const files = row.files.map(value => {
    const file = object(value, ['path', 'size', 'sha256', 'executable']);
    const name = relative(file.path); const size = integer(file.size, 0, MAX_BYTES);
    if (name <= previous || typeof file.executable !== 'boolean') throw new Error('Release inventory must have unique, sorted paths and explicit modes.');
    const segments = name.split('/'); segments.pop();
    while (segments.length) { if (seen.has(segments.join('/'))) throw new Error('Release file conflicts with a directory.'); segments.pop(); }
    seen.add(name); previous = name; total += size;
    if (total > MAX_BYTES) throw new Error('Expanded release exceeds the installation limit.');
    return { path: name, size, sha256: digest(file.sha256), executable: file.executable };
  });
  if (!files.some(file => file.path === 'minv' && file.executable) || !files.some(file => file.path === 'resources/app/package.json' && file.size <= 65536)) throw new Error('Release inventory lacks the application executable or product identity.');
  return { schema: 1, product: 'minv', version: releaseVersion, sequence: integer(row.sequence, 1), platform: 'linux-x64',
    artifact: { name: artifact.name as string, size: integer(artifact.size, 1, MAX_BYTES), sha256: digest(artifact.sha256), format: 'tar.gz' }, files };
}

function publisherKey(value: string | Buffer, privateKey = false): KeyObject {
  if (!value || !value.length) throw new Error('A configured publisher Ed25519 key is required; unsigned releases are never accepted.');
  const key = privateKey ? createPrivateKey(value) : createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Publisher release keys must use Ed25519.');
  return key;
}
export function signReleaseManifest(value: ReleaseManifest, privateKey: string | Buffer): SignedRelease {
  const payload = JSON.stringify(manifest(value));
  if (Buffer.byteLength(payload) > MAX_MANIFEST) throw new Error('Release manifest exceeds the limit.');
  return { payload, signature: sign(null, Buffer.from(payload), publisherKey(privateKey, true)).toString('base64') };
}
export function verifyReleaseManifest(value: unknown, publicKey: string | Buffer, platform: 'linux-x64'): ReleaseManifest {
  const envelope = object(value, ['payload', 'signature']);
  const payload = string(envelope.payload); const signature = string(envelope.signature);
  if (Buffer.byteLength(payload) > MAX_MANIFEST || signature.length > 128) throw new Error('Signed release exceeds the metadata limit.');
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature || !verify(null, Buffer.from(payload), publisherKey(publicKey), bytes)) throw new Error('Release signature verification failed.');
  const result = manifest(JSON.parse(payload));
  if (result.platform !== platform || JSON.stringify(result) !== payload) throw new Error('Noncanonical or wrong-platform release manifest.');
  return result;
}

async function fileDigest(file: string, expectedSize?: number): Promise<{ size: number; sha256: string; executable: boolean }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_BYTES || (expectedSize !== undefined && before.size !== expectedSize)) throw new Error('Release file size/type verification failed.');
    const checksum = createHash('sha256'); let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; if (size > MAX_BYTES || size > before.size) throw new Error('Release file changed during verification.'); checksum.update(chunk); }
    const after = await handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Release file changed during verification.');
    return { size, sha256: checksum.digest('hex'), executable: Boolean(before.mode & 0o111) };
  } finally { await handle.close(); }
}
async function inventory(directory: string): Promise<ReleaseFile[]> {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Release source must be a real directory.');
  const result: ReleaseFile[] = [];
  async function visit(current: string, prefix: string, depth: number): Promise<void> {
    if (depth > 64) throw new Error('Release directory nesting exceeds the limit.');
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = relative(prefix + entry.name); const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute, `${name}/`, depth + 1);
      else if (entry.isFile()) { if (result.length >= MAX_FILES) throw new Error('Release inventory exceeds the limit.'); result.push({ path: name, ...await fileDigest(absolute) }); }
      else throw new Error('Release trees must not contain symlinks or special files.');
    }
  }
  await visit(directory, '', 0); return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function createReleaseManifest(directory: string, artifactPath: string, options: { version: string; sequence: number }): Promise<ReleaseManifest> {
  const artifact = await fileDigest(artifactPath);
  const result = manifest({ schema: 1, product: 'minv', version: options.version, sequence: options.sequence, platform: 'linux-x64',
    artifact: { name: path.basename(artifactPath), size: artifact.size, sha256: artifact.sha256, format: 'tar.gz' }, files: await inventory(directory) });
  await verifyProduct(directory, result); return result;
}
async function verifyProduct(directory: string, value: ReleaseManifest): Promise<void> {
  const product = JSON.parse(await readFile(path.join(directory, 'resources/app/package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  if (product.name !== 'minv' || product.version !== value.version) throw new Error('Packaged product version differs from the signed release.');
}

interface Ledger { schema: 1; publisher: string; highestSequence: number; highestVersion: string; releases: string[] }
function releaseId(value: ReleaseManifest): string { return `${value.version}-${hash(JSON.stringify(value)).slice(0, 24)}`; }
function validateId(value: string): string { if (!/^[0-9A-Za-z.+-]{1,128}-[a-f0-9]{24}$/.test(value)) throw new Error('Invalid retained release id.'); return value; }
async function syncDirectory(directory: string): Promise<void> { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file); await syncDirectory(path.dirname(file));
  } finally { await rm(temporary, { force: true }); }
}
async function removePrivateStaging(directory: string): Promise<void> {
  try {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await removePrivateStaging(path.join(directory, entry.name));
    await rm(directory, { recursive: true, force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function sealTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await sealTree(path.join(directory, entry.name));
  await chmod(directory, 0o555); await syncDirectory(directory);
}

/** Offline installation mechanisms. This class never downloads, extracts, executes, or restarts an application. */
export class UpdateStore {
  private readonly directory: string;
  private readonly keyFingerprint: string;
  constructor(private readonly options: UpdateStoreOptions) {
    this.directory = path.resolve(options.directory); version(options.currentVersion);
    if (options.platform !== 'linux-x64' || process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Only Linux x64 release installation is supported.');
    this.keyFingerprint = hash(publisherKey(options.publisherPublicKey).export({ format: 'der', type: 'spki' }));
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await lstat(this.directory);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077)) throw new Error('Update storage must be a private, user-owned directory.');
    const lock = path.join(this.directory, '.update-lock');
    try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another update operation holds the installation lock.'); throw error; }
    try { return await action(); } finally { await rm(lock, { recursive: true }); }
  }
  private async ledger(): Promise<Ledger> {
    try {
      const file = path.join(this.directory, 'state.json');
      const info = await lstat(file); if (!info.isFile() || info.size > MAX_MANIFEST) throw new Error('Invalid update state storage.');
      const value = object(JSON.parse(await readFile(file, 'utf8')), ['schema', 'publisher', 'highestSequence', 'highestVersion', 'releases']);
      if (value.schema !== 1 || value.publisher !== this.keyFingerprint || !Array.isArray(value.releases) || value.releases.length > MAX_RELEASES) throw new Error('Update state or publisher identity changed.');
      const releases = value.releases.map(value => validateId(string(value)));
      if (new Set(releases).size !== releases.length) throw new Error('Invalid retained-release inventory.');
      return { schema: 1, publisher: this.keyFingerprint, highestSequence: integer(value.highestSequence), highestVersion: version(value.highestVersion), releases };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if ((await readdir(this.directory)).some(name => name !== '.update-lock')) throw new Error('Update state is missing from an existing installation; restore its trusted ledger before continuing.');
      return { schema: 1, publisher: this.keyFingerprint, highestSequence: 0, highestVersion: this.options.currentVersion, releases: [] };
    }
  }
  private async currentId(): Promise<string | undefined> {
    try {
      const target = await readlink(path.join(this.directory, 'current'));
      const match = /^releases\/([^/]+)\/payload$/.exec(target);
      if (!match) throw new Error('Invalid current-release pointer.'); return validateId(match[1]!);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async verified(id: string): Promise<ReleaseManifest> {
    const directory = path.join(this.directory, 'releases', validateId(id));
    if (!(await lstat(directory)).isDirectory()) throw new Error('Retained release directory is unavailable.');
    const receipt = path.join(directory, 'receipt.json'); const info = await lstat(receipt);
    if (!info.isFile() || info.size > MAX_MANIFEST * 2) throw new Error('Invalid retained release receipt.');
    const value = verifyReleaseManifest(JSON.parse(await readFile(receipt, 'utf8')), this.options.publisherPublicKey, this.options.platform);
    if (releaseId(value) !== id) throw new Error('Retained release identity changed.');
    const files = await inventory(path.join(directory, 'payload'));
    if (JSON.stringify(files) !== JSON.stringify(value.files)) throw new Error('Retained release files differ from their signed inventory.');
    await verifyProduct(path.join(directory, 'payload'), value);
    for (const file of value.files) {
      const info = await lstat(path.join(directory, 'payload', file.path));
      if ((info.mode & 0o777) !== (file.executable ? 0o555 : 0o444) || info.nlink !== 1) throw new Error('Retained release permissions or links changed.');
    }
    return value;
  }
  async stage(envelope: SignedRelease, artifactPath: string, sourceDirectory: string): Promise<RetainedRelease> {
    const value = verifyReleaseManifest(envelope, this.options.publisherPublicKey, this.options.platform);
    return this.locked(async () => {
      const state = await this.ledger();
      const baseline = compareVersions(state.highestVersion, this.options.currentVersion) >= 0 ? state.highestVersion : this.options.currentVersion;
      if (value.sequence <= state.highestSequence || compareVersions(value.version, baseline) <= 0) throw new Error('Replayed or downgraded release rejected.');
      if (state.releases.length >= MAX_RELEASES) throw new Error('Retained release limit reached; manage older verified installations explicitly.');
      const artifact = await fileDigest(artifactPath, value.artifact.size);
      if (path.basename(artifactPath) !== value.artifact.name || artifact.sha256 !== value.artifact.sha256) throw new Error('Release artifact hash or identity verification failed.');
      if (JSON.stringify(await inventory(sourceDirectory)) !== JSON.stringify(value.files)) throw new Error('Extracted release does not match the signed file inventory.');
      await verifyProduct(sourceDirectory, value);
      await atomicJson(path.join(this.directory, 'state.json'), state);
      const releases = path.join(this.directory, 'releases'); await mkdir(releases, { mode: 0o700, recursive: true });
      if (!(await lstat(releases)).isDirectory()) throw new Error('Invalid release storage.');
      const id = releaseId(value); const target = path.join(releases, id); const staging = path.join(this.directory, `.stage-${randomUUID()}`);
      try { await lstat(target); throw new Error('A release with this identity already exists.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await mkdir(path.join(staging, 'payload'), { recursive: true, mode: 0o700 });
      try {
        for (const file of value.files) {
          const destination = path.join(staging, 'payload', file.path); await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          const input = await open(path.join(sourceDirectory, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
          const output = await open(destination, 'wx', 0o600); const checksum = createHash('sha256'); let size = 0;
          try {
            for await (const chunk of input.createReadStream({ autoClose: false })) { size += chunk.length; if (size > file.size) throw new Error('Release source changed while staging.'); checksum.update(chunk); await output.writeFile(chunk); }
            if (size !== file.size || checksum.digest('hex') !== file.sha256) throw new Error('Release source changed while staging.');
            await output.chmod(file.executable ? 0o555 : 0o444); await output.sync();
          } finally { await input.close(); await output.close(); }
        }
        const receipt = await open(path.join(staging, 'receipt.json'), 'wx', 0o444);
        try { await receipt.writeFile(JSON.stringify(envelope)); await receipt.sync(); } finally { await receipt.close(); }
        await sealTree(path.join(staging, 'payload')); await syncDirectory(staging);
        await rename(staging, target); await chmod(target, 0o555); await syncDirectory(target); await syncDirectory(releases);
        await atomicJson(path.join(this.directory, 'state.json'), { ...state, highestSequence: value.sequence, highestVersion: value.version, releases: [...state.releases, id] });
        return { id, version: value.version, sequence: value.sequence, current: false };
      } finally { await removePrivateStaging(staging); }
    });
  }
  async list(): Promise<RetainedRelease[]> {
    return this.locked(async () => {
      const state = await this.ledger(); const current = await this.currentId(); const result: RetainedRelease[] = [];
      if (current && !state.releases.includes(current)) throw new Error('Current release is not in the verified registry.');
      for (const id of state.releases) { const value = await this.verified(id); result.push({ id, version: value.version, sequence: value.sequence, current: current === id }); }
      return result;
    });
  }
  async activate(id: string, safety: () => Promise<UpdateSafety>): Promise<void> { await this.switch(id, safety, false); }
  async rollback(id: string, safety: () => Promise<UpdateSafety>, confirmed: true): Promise<void> {
    if (confirmed !== true) throw new Error('Rollback requires explicit confirmation.'); await this.switch(id, safety, true);
  }
  private async switch(id: string, safety: () => Promise<UpdateSafety>, rollback: boolean): Promise<void> {
    const assertIdle = async (): Promise<void> => {
      const state = await safety();
      if (state.applicationRunning !== false || state.dirtyBuffers !== 0 || state.activeWrites !== 0) throw new Error('Close Minv normally after resolving dirty buffers and Git writes before changing the installed release.');
    };
    await assertIdle();
    await this.locked(async () => {
      const state = await this.ledger(); if (!state.releases.includes(validateId(id))) throw new Error('Release was not previously verified and retained.');
      const target = await this.verified(id); const currentId = await this.currentId();
      if (currentId && !state.releases.includes(currentId)) throw new Error('Current release is not in the verified registry.');
      const current = currentId ? await this.verified(currentId) : undefined;
      if (rollback) {
        if (!current || compareVersions(target.version, current.version) >= 0) throw new Error('Rollback must select an older retained, verified release.');
      } else if (target.sequence !== state.highestSequence || compareVersions(target.version, current?.version ?? this.options.currentVersion) <= 0) throw new Error('Only the latest verified upgrade can be activated.');
      await assertIdle();
      const temporary = path.join(this.directory, `.current-${randomUUID()}`);
      try { await symlink(`releases/${id}/payload`, temporary); await rename(temporary, path.join(this.directory, 'current')); await syncDirectory(this.directory); }
      finally { await rm(temporary, { force: true }); }
    });
  }
}
