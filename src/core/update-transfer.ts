import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { type ReleaseManifest, type SignedRelease, verifyReleaseManifest } from './update';

const MAX_METADATA = 16 * 1024 * 1024;
const MAX_EXPANDED = 4 * 1024 * 1024 * 1024;
const block = 512;
function archivePath(value: string): string {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.split('/').some(part => part === '..' || part === '.')) throw new Error('Archive contains an unsafe path.');
  return value.replace(/\/$/, '');
}
async function response(url: URL, fetcher: typeof fetch): Promise<Response> {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Release URLs must be HTTPS without credentials or fragments.');
  const result = await fetcher(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10 * 60_000) });
  if (!result.ok || !result.body || result.redirected || result.url !== url.href) throw new Error('Release endpoint failed or redirected.');
  return result;
}
async function bytes(result: Response, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of result.body!) { size += chunk.length; if (size > maximum) throw new Error('Release metadata exceeds the limit.'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
/** Explicit HTTPS fetch; the archive URL is derived from the signed exact filename. */
export async function downloadSignedRelease(feed: string, publicKey: string | Buffer, destination: string, fetcher: typeof fetch = fetch): Promise<{ signed: SignedRelease; manifest: ReleaseManifest; artifact: string }> {
  const feedUrl = new URL(feed);
  const signed = JSON.parse((await bytes(await response(feedUrl, fetcher), MAX_METADATA)).toString('utf8')) as SignedRelease;
  const manifest = verifyReleaseManifest(signed, publicKey, 'linux-x64');
  const artifactUrl = new URL(manifest.artifact.name, feedUrl);
  if (artifactUrl.origin !== feedUrl.origin) throw new Error('Release artifact must use the feed origin.');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const artifact = path.join(destination, manifest.artifact.name);
  const handle = await open(artifact, 'wx', 0o600); const checksum = createHash('sha256'); let size = 0;
  try {
    const downloaded = await response(artifactUrl, fetcher);
    const length = downloaded.headers.get('content-length');
    if (length !== null && Number(length) !== manifest.artifact.size) throw new Error('Release archive length differs from its signature.');
    for await (const chunk of downloaded.body!) {
      size += chunk.length;
      if (size > manifest.artifact.size) throw new Error('Release archive exceeds its signed size.');
      checksum.update(chunk); await handle.writeFile(chunk);
    }
    if (size !== manifest.artifact.size || checksum.digest('hex') !== manifest.artifact.sha256) throw new Error('Release archive hash or length differs from its signature.');
    await handle.sync();
  } catch (error) { await handle.close(); await rm(artifact, { force: true }); throw error; }
  await handle.close(); return { signed, manifest, artifact };
}

function field(header: Buffer, start: number, length: number): string { return header.subarray(start, start + length).toString('utf8').split('\0')[0]!; }
function numberField(header: Buffer, start: number, length: number): number {
  const value = field(header, start, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('Unsupported archive number encoding.');
  const result = parseInt(value, 8);
  if (!Number.isSafeInteger(result)) throw new Error('Archive number exceeds the limit.'); return result;
}
function pax(data: Buffer): Map<string, string> {
  const result = new Map<string, string>(); let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset); if (space < 0) throw new Error('Malformed archive extension.');
    const length = Number(data.subarray(offset, space).toString('ascii'));
    if (!Number.isSafeInteger(length) || length < 4 || offset + length > data.length || data[offset + length - 1] !== 10) throw new Error('Malformed archive extension.');
    const entry = data.subarray(space + 1, offset + length - 1).toString('utf8'); const equals = entry.indexOf('=');
    if (equals < 1) throw new Error('Malformed archive extension.'); result.set(entry.slice(0, equals), entry.slice(equals + 1)); offset += length;
  }
  return result;
}

/** Extracts only signed regular files from a GNU tar.gz into a new private directory. */
export async function extractSignedArchive(artifact: string, destination: string, manifest: ReleaseManifest): Promise<void> {
  await mkdir(destination, { mode: 0o700 }); // Exclusive: never extract into an existing tree.
  const input = await open(artifact, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = input.createReadStream().pipe(createGunzip());
  const iterator = stream[Symbol.asyncIterator](); let buffered = Buffer.alloc(0); let expanded = 0;
  const take = async (count: number): Promise<Buffer> => {
    while (buffered.length < count) {
      const next = await iterator.next(); if (next.done) throw new Error('Truncated release archive.');
      buffered = Buffer.concat([buffered, next.value]);
      if (buffered.length > 1024 * 1024) throw new Error('Archive streaming buffer exceeded.');
    }
    const value = buffered.subarray(0, count); buffered = buffered.subarray(count); expanded += count;
    if (expanded > MAX_EXPANDED + manifest.files.length * 2048 + 1024 * 1024) throw new Error('Expanded archive exceeds the limit.');
    return value;
  };
  const files = new Map(manifest.files.map(file => [file.path, file])); const seen = new Set<string>();
  const prefix = `minv-${manifest.version}-linux-x64/`; let extension = new Map<string, string>(); let global = new Map<string, string>();
  try {
    for (;;) {
      const header = await take(block);
      if (header.every(byte => byte === 0)) { const tail = await take(block); if (!tail.every(byte => byte === 0)) throw new Error('Malformed archive terminator.'); break; }
      const recorded = numberField(header, 148, 8); let sum = 0;
      for (let i = 0; i < block; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
      if (sum !== recorded) throw new Error('Archive header checksum failed.');
      const size = numberField(header, 124, 12); if (size > MAX_EXPANDED) throw new Error('Archive entry exceeds the limit.');
      const type = String.fromCharCode(header[156]!);
      const name = field(header, 0, 100); const parent = field(header, 345, 155);
      const entry = type === 'x' || type === 'g' ? '' : archivePath(extension.get('path') ?? global.get('path') ?? (parent ? `${parent}/${name}` : name));
      extension = new Map();
      if (type === 'x' || type === 'g') {
        if (size > 65536) throw new Error('Archive extension exceeds the limit.');
        const metadata = pax((await take(size)));
        if (type === 'x') extension = metadata; else global = metadata;
      } else if (type === '5') {
        if (size !== 0 || entry !== prefix.slice(0, -1) && !entry.startsWith(prefix)) throw new Error('Unexpected archive directory.');
      } else if (type === '0' || type === '\0') {
        if (!entry.startsWith(prefix)) throw new Error('Archive file lies outside the release root.');
        const relative = entry.slice(prefix.length); const expected = files.get(relative);
        if (!expected || seen.has(relative) || size !== expected.size) throw new Error('Archive files differ from the signed inventory.');
        seen.add(relative); const target = path.join(destination, relative);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const output = await open(target, 'wx', expected.executable ? 0o755 : 0o644); const checksum = createHash('sha256');
        try {
          let remaining = size;
          while (remaining) { const chunk = await take(Math.min(remaining, 64 * 1024)); checksum.update(chunk); await output.writeFile(chunk); remaining -= chunk.length; }
          if (checksum.digest('hex') !== expected.sha256) throw new Error('Archive file hash differs from its signature.');
          await output.sync();
        } finally { await output.close(); }
      } else throw new Error('Archive contains a link, device, or unsupported entry.');
      if (type !== '0' && type !== '\0' && type !== 'x' && type !== 'g' && size) await take(size);
      const padding = (block - size % block) % block; if (padding) await take(padding);
    }
    if (seen.size !== files.size) throw new Error('Archive is missing signed files.');
    if (buffered.some(byte => byte !== 0)) throw new Error('Archive contains trailing payload.');
    for await (const trailing of iterator) if ((trailing as Buffer).some((byte: number) => byte !== 0)) throw new Error('Archive contains trailing payload.');
  } catch (error) { stream.destroy(); await rm(destination, { recursive: true, force: true }); throw error; }
}
