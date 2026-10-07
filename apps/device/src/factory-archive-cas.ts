import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync, gunzipSync } from 'node:zlib';

const CHUNK_SIZE = 1024 ** 2, RAW_LIMIT = 64 * 1024 ** 3;
const MANIFEST_LIMIT = 32 * 1024 ** 2, SEGMENT_LIMIT = 200_000, INLINE_LIMIT = 4096;
const COMPRESSED_CHUNK_LIMIT = CHUNK_SIZE + 64 * 1024;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
type InlineSegment = { type: 'inline'; data: string };
type BlobSegment = { type: 'blob'; sha256: string; size: number; compressedSha256: string; compressedSize: number };
export interface TarCasManifest {
  version: 1; storage: 'cas-tar-v1'; chunkSize: number; rawSha256: string; rawSize: number;
  entries: number; compressedSize: number; uniqueCompressedSize: number;
  segments: (InlineSegment | BlobSegment)[];
}
export interface TarCasDigest {
  storage: 'cas-tar-v1'; sha256: string; size: number; rawSha256: string; rawSize: number;
  entries: number; compressedSize: number; uniqueCompressedSize: number; blobCount: number;
}

async function privateDirectory(anchor: string, directory: string): Promise<void> {
  const relative = path.relative(anchor, directory), uid = process.getuid?.();
  if (uid === undefined || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Archive storage is outside its private data directory.');
  let current = anchor;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let created = false;
    try { await mkdir(current, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const entry = await lstat(current);
    if (entry.uid !== uid || !entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error('Archive storage requires private owned directories.');
    if (created && current !== anchor) await syncDirectory(path.dirname(current));
  }
  if (await realpath(directory) !== path.join(await realpath(anchor), relative)) throw new Error('Archive storage changed ownership.');
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function privateFile(filename: string, limit: number): Promise<Buffer> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0 || entry.size < 1 || entry.size > limit) throw new Error('Archive content is not a bounded private owned file.');
    const bytes = await handle.readFile();
    if (bytes.length !== entry.size) throw new Error('Archive content changed while being read.');
    return bytes;
  } finally { await handle.close(); }
}
function blobPath(dataDir: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Archive blob identity is invalid.');
  return path.join(dataDir, 'provider-history', 'blobs', 'sha256', hash.slice(0, 2), `${hash}.gz`);
}
function decodeBlob(bytes: Buffer, segment: BlobSegment): Buffer {
  if (bytes.length !== segment.compressedSize || sha256(bytes) !== segment.compressedSha256) throw new Error('Archive blob compressed content changed.');
  let raw: Buffer;
  try { raw = gunzipSync(bytes, { maxOutputLength: CHUNK_SIZE }); }
  catch { throw new Error('Archive blob cannot reproduce its bounded original content.'); }
  if (raw.length !== segment.size || sha256(raw) !== segment.sha256) throw new Error('Archive blob original content changed.');
  return raw;
}
async function readBlob(dataDir: string, segment: BlobSegment): Promise<Buffer> {
  const filename = blobPath(dataDir, segment.sha256);
  await privateDirectory(dataDir, path.dirname(filename));
  return decodeBlob(await privateFile(filename, COMPRESSED_CHUNK_LIMIT), segment);
}

/** Publish immutable, private blobs without replacing another capture's bytes. */
async function saveBlob(dataDir: string, bytes: Buffer, assertSpace: () => void): Promise<{ segment: BlobSegment; created: number }> {
  const hash = sha256(bytes), filename = blobPath(dataDir, hash), directory = path.dirname(filename);
  await privateDirectory(dataDir, directory);
  try {
    const stored = await privateFile(filename, COMPRESSED_CHUNK_LIMIT);
    const segment: BlobSegment = { type: 'blob', sha256: hash, size: bytes.length, compressedSha256: sha256(stored), compressedSize: stored.length };
    decodeBlob(stored, segment);
    return { segment, created: 0 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  assertSpace();
  const compressed = gzipSync(bytes, { level: 6 });
  if (compressed.length > COMPRESSED_CHUNK_LIMIT) throw new Error('Archive compressed blob exceeds its storage bound.');
  const temporary = path.join(directory, `.${hash}-${randomUUID()}.tmp`);
  let created = 0;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { assertSpace(); await handle.writeFile(compressed); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temporary, filename); created = compressed.length; await syncDirectory(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await rm(temporary, { force: true }); }
  const stored = await privateFile(filename, COMPRESSED_CHUNK_LIMIT);
  const segment: BlobSegment = { type: 'blob', sha256: hash, size: bytes.length, compressedSha256: sha256(stored), compressedSize: stored.length };
  decodeBlob(stored, segment);
  return { segment, created };
}

class InputBytes {
  private readonly iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  private done = false;
  constructor(input: Readable) { this.iterator = input[Symbol.asyncIterator]() as AsyncIterator<Buffer>; }
  private async fill(): Promise<void> {
    while (!this.pending.length && !this.done) {
      const item = await this.iterator.next();
      if (item.done) { this.done = true; return; }
      if (!Buffer.isBuffer(item.value)) throw new Error('Archive input must contain bytes.');
      this.pending = item.value;
    }
  }
  async take(size: number, allowEnd = false): Promise<Buffer | undefined> {
    await this.fill();
    if (!this.pending.length) { if (allowEnd) return undefined; throw new Error('Archive tar stream is incomplete.'); }
    if (this.pending.length >= size) {
      const value = this.pending.subarray(0, size); this.pending = this.pending.subarray(size); return value;
    }
    const result = Buffer.allocUnsafe(size); let offset = 0;
    while (offset < size) {
      await this.fill();
      if (!this.pending.length) throw new Error('Archive tar stream is incomplete.');
      const count = Math.min(size - offset, this.pending.length);
      this.pending.copy(result, offset, 0, count); this.pending = this.pending.subarray(count); offset += count;
    }
    return result;
  }
  async remainder(): Promise<Buffer | undefined> {
    await this.fill();
    if (!this.pending.length) return undefined;
    const value = this.pending.subarray(0, INLINE_LIMIT); this.pending = this.pending.subarray(value.length); return value;
  }
}
function tarNumber(bytes: Buffer): number {
  let result: number;
  if (bytes[0]! & 0x80) {
    if (bytes[0]! & 0x40) throw new Error('Archive tar size is negative.');
    let number = BigInt(bytes[0]! & 0x7f);
    for (const byte of bytes.subarray(1)) number = number * 256n + BigInt(byte);
    result = Number(number);
  } else {
    const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
    if (!/^[0-7]*$/.test(text)) throw new Error('Archive tar number is malformed.');
    result = text ? Number.parseInt(text, 8) : 0;
  }
  if (!Number.isSafeInteger(result) || result < 0 || result > RAW_LIMIT) throw new Error('Archive tar number exceeds its preservation bound.');
  return result;
}
function paxSize(bytes: Buffer): number | undefined {
  let size: number | undefined;
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset), lengthText = bytes.subarray(offset, space).toString('ascii');
    if (space < offset || space - offset > 12 || !/^[1-9][0-9]*$/.test(lengthText)) throw new Error('Archive PAX record is malformed.');
    const length = Number(lengthText), end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || end <= space + 1 || bytes[end - 1] !== 10) throw new Error('Archive PAX record is incomplete.');
    const text = bytes.subarray(space + 1, end - 1).toString('utf8'), equals = text.indexOf('=');
    if (equals < 1) throw new Error('Archive PAX record is malformed.');
    if (text.slice(0, equals) === 'size') {
      const value = text.slice(equals + 1);
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > RAW_LIMIT) throw new Error('Archive PAX size is invalid.');
      size = Number(value);
    }
    offset = end;
  }
  return size;
}

/** Preserve tar bytes exactly, resetting content chunks at every entry body. */
export async function captureTarCas(input: Readable, manifestFilename: string, dataDir: string, assertSpace: () => void): Promise<TarCasDigest> {
  await privateDirectory(dataDir, path.dirname(manifestFilename)); assertSpace();
  const stream = new InputBytes(input), segments: TarCasManifest['segments'] = [], rawHash = createHash('sha256');
  let rawSize = 0, entries = 0, compressedSize = 0, uniqueCompressedSize = 0, manifestBudget = 512, nextSize: number | undefined;
  const admitted = (bytes: Buffer): void => {
    rawSize += bytes.length;
    if (rawSize > RAW_LIMIT) throw new Error('Archive tar exceeds its preservation bound.');
    rawHash.update(bytes);
  };
  const addSegment = (segment: InlineSegment | BlobSegment): void => {
    manifestBudget += JSON.stringify(segment).length + 1;
    if (segments.length >= SEGMENT_LIMIT || manifestBudget > MANIFEST_LIMIT) throw new Error('Archive manifest exceeds its bounded storage limit.');
    segments.push(segment);
  };
  const inline = (bytes: Buffer): void => {
    admitted(bytes);
    for (let offset = 0; offset < bytes.length; offset += INLINE_LIMIT) addSegment({ type: 'inline', data: bytes.subarray(offset, offset + INLINE_LIMIT).toString('base64') });
  };
  try {
    for (;;) {
      const header = await stream.take(512);
      if (!header) throw new Error('Archive tar stream is incomplete.');
      if (header.every(byte => byte === 0)) {
        if (nextSize !== undefined) throw new Error('Archive PAX metadata has no following entry.');
        inline(header);
        const second = await stream.take(512);
        if (!second || second.some(byte => byte !== 0)) throw new Error('Archive tar end marker is incomplete.');
        inline(second);
        for (;;) {
          const remainder = await stream.remainder();
          if (!remainder) break;
          if (remainder.some(byte => byte !== 0)) throw new Error('Archive tar contains data after its end marker.');
          inline(remainder);
        }
        break;
      }
      const expected = tarNumber(header.subarray(148, 156)); let sum = 0;
      for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]!;
      if (sum !== expected) throw new Error('Archive tar entry checksum is invalid.');
      const type = String.fromCharCode(header[156]!), metadata = ['x', 'g', 'L', 'K'].includes(type);
      const size = metadata ? tarNumber(header.subarray(124, 136)) : nextSize ?? tarNumber(header.subarray(124, 136));
      if (metadata && size > CHUNK_SIZE) throw new Error('Archive extended metadata exceeds its bounded storage limit.');
      if (!metadata) nextSize = undefined;
      entries++; inline(header);
      const extended: Buffer[] = [];
      for (let remaining = size; remaining > 0;) {
        const bytes = await stream.take(Math.min(CHUNK_SIZE, remaining));
        if (!bytes) throw new Error('Archive tar body is incomplete.');
        admitted(bytes); assertSpace();
        const saved = await saveBlob(dataDir, bytes, assertSpace);
        addSegment(saved.segment); compressedSize += saved.segment.compressedSize; uniqueCompressedSize += saved.created;
        if (type === 'x' || type === 'g') extended.push(Buffer.from(bytes));
        remaining -= bytes.length;
      }
      const padding = (512 - size % 512) % 512;
      if (padding) inline((await stream.take(padding))!);
      if (type === 'x' || type === 'g') {
        const override = paxSize(Buffer.concat(extended));
        if (type === 'g' && override !== undefined) throw new Error('Global archive size metadata cannot be retained safely.');
        if (type === 'x' && override !== undefined) nextSize = override;
      }
    }
    if (!entries) throw new Error('Archive tar contains no retained entries.');
    const manifest: TarCasManifest = { version: 1, storage: 'cas-tar-v1', chunkSize: CHUNK_SIZE, rawSha256: rawHash.digest('hex'), rawSize, entries, compressedSize, uniqueCompressedSize, segments };
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > MANIFEST_LIMIT) throw new Error('Archive manifest exceeds its bounded storage limit.');
    assertSpace(); const handle = await open(manifestFilename, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(path.dirname(manifestFilename));
    return digest(manifest, bytes);
  } catch (error) { input.destroy(); throw error; }
}

function validCount(value: unknown, maximum: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
async function loadManifest(filename: string, dataDir: string): Promise<{ manifest: TarCasManifest; bytes: Buffer }> {
  await privateDirectory(dataDir, path.dirname(filename));
  const bytes = await privateFile(filename, MANIFEST_LIMIT), manifest = JSON.parse(bytes.toString('utf8')) as TarCasManifest;
  if (manifest.version !== 1 || manifest.storage !== 'cas-tar-v1' || manifest.chunkSize !== CHUNK_SIZE || !/^[a-f0-9]{64}$/.test(manifest.rawSha256)
    || !validCount(manifest.rawSize, RAW_LIMIT) || !validCount(manifest.entries, SEGMENT_LIMIT) || !manifest.entries
    || !validCount(manifest.compressedSize, RAW_LIMIT * 2) || !validCount(manifest.uniqueCompressedSize, manifest.compressedSize)
    || !Array.isArray(manifest.segments) || !manifest.segments.length || manifest.segments.length > SEGMENT_LIMIT) throw new Error('Archive CAS manifest is invalid.');
  let rawSize = 0, compressedSize = 0;
  for (const segment of manifest.segments) {
    if (segment?.type === 'inline') {
      if (typeof segment.data !== 'string' || !segment.data.length || segment.data.length > Math.ceil(INLINE_LIMIT / 3) * 4) throw new Error('Archive inline segment is invalid.');
      const decoded = Buffer.from(segment.data, 'base64');
      if (decoded.length > INLINE_LIMIT || decoded.toString('base64') !== segment.data) throw new Error('Archive inline segment is malformed.');
      rawSize += decoded.length;
    } else if (segment?.type === 'blob') {
      if (!/^[a-f0-9]{64}$/.test(segment.sha256) || !/^[a-f0-9]{64}$/.test(segment.compressedSha256)
        || !validCount(segment.size, CHUNK_SIZE) || !segment.size || !validCount(segment.compressedSize, COMPRESSED_CHUNK_LIMIT) || segment.compressedSize < 20) throw new Error('Archive blob segment is invalid.');
      rawSize += segment.size; compressedSize += segment.compressedSize;
    } else throw new Error('Archive CAS segment is unsupported.');
  }
  if (rawSize !== manifest.rawSize || compressedSize !== manifest.compressedSize) throw new Error('Archive CAS manifest byte counts changed.');
  return { manifest, bytes };
}
function digest(manifest: TarCasManifest, bytes: Buffer): TarCasDigest {
  return { storage: 'cas-tar-v1', sha256: sha256(bytes), size: bytes.length, rawSha256: manifest.rawSha256, rawSize: manifest.rawSize,
    entries: manifest.entries, compressedSize: manifest.compressedSize, uniqueCompressedSize: manifest.uniqueCompressedSize,
    blobCount: manifest.segments.filter(segment => segment.type === 'blob').length };
}
async function* reconstruct(manifest: TarCasManifest, dataDir: string): AsyncGenerator<Buffer> {
  const hash = createHash('sha256'); let size = 0;
  for (const segment of manifest.segments) {
    const bytes = segment.type === 'inline' ? Buffer.from(segment.data, 'base64') : await readBlob(dataDir, segment);
    hash.update(bytes); size += bytes.length; yield bytes;
  }
  if (size !== manifest.rawSize || hash.digest('hex') !== manifest.rawSha256) throw new Error('Archive CAS content does not reproduce its exact tar bytes.');
}

/** Validate every required blob and the complete tar digest before callers write a destination. */
export async function validateTarCasArchive(filename: string, dataDir: string): Promise<TarCasDigest> {
  const { manifest, bytes } = await loadManifest(filename, dataDir);
  for await (const _part of reconstruct(manifest, dataDir)) { /* bounded validation, no extraction */ }
  return digest(manifest, bytes);
}
export async function validatedTarCasReadable(filename: string, dataDir: string): Promise<Readable> {
  const { manifest } = await loadManifest(filename, dataDir);
  for await (const _part of reconstruct(manifest, dataDir)) { /* complete validation before creating a writable restore stream */ }
  return Readable.from(reconstruct(manifest, dataDir));
}
