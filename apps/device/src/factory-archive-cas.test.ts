import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { captureTarCas, validatedTarCasReadable, validateTarCasArchive, type TarCasManifest } from './factory-archive-cas.ts';

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function header(name: string, size: number, type = '0', mtime = 1, link = ''): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write(name, 0, 100); bytes.write('0000644\0', 100, 8); bytes.write('0000000\0', 108, 8); bytes.write('0000000\0', 116, 8);
  bytes.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12); bytes.write(`${mtime.toString(8).padStart(11, '0')}\0`, 136, 12);
  bytes.fill(32, 148, 156); bytes.write(type, 156, 1); bytes.write(link, 157, 100); bytes.write('ustar\0', 257, 6); bytes.write('00', 263, 2);
  const checksum = bytes.reduce((sum, byte) => sum + byte, 0);
  bytes.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return bytes;
}
function record(name: string, body = Buffer.alloc(0), type = '0', mtime = 1, link = '', paddingByte = 0): Buffer {
  return Buffer.concat([header(name, body.length, type, mtime, link), body, Buffer.alloc((512 - body.length % 512) % 512, paddingByte)]);
}
function paxRecord(key: string, value: string): Buffer {
  const text = `${key}=${value}\n`; let length = Buffer.byteLength(text) + 2;
  while (length !== Buffer.byteLength(`${length} ${text}`)) length = Buffer.byteLength(`${length} ${text}`);
  return Buffer.from(`${length} ${text}`);
}
function fragmented(bytes: Buffer): Readable {
  return Readable.from((async function* () {
    for (let offset = 0; offset < bytes.length; offset += 37_113) yield bytes.subarray(offset, offset + 37_113);
  })());
}
async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'enough-archive-cas-')); await chmod(dataDir, 0o700);
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const capture = (bytes: Buffer, name: string) => captureTarCas(fragmented(bytes), path.join(dataDir, name), dataDir, () => {});
  return { dataDir, capture };
}
async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = []; for await (const part of stream) parts.push(part as Buffer); return Buffer.concat(parts);
}

test('per-entry CAS reuses identical ignored file contents across different tar metadata and restores every original byte', async t => {
  const f = await fixture(t), payload = Buffer.alloc(2 * 1024 ** 2 + 313);
  for (let index = 0; index < payload.length; index++) payload[index] = (index * 17 + Math.floor(index / 997)) % 256;
  const archive = (mtime: number) => Buffer.concat([
    record('work/', Buffer.alloc(0), '5', mtime),
    record('work/.gitignore', Buffer.from('ignored/\n'), '0', mtime),
    record('work/ignored/new-design.bin', payload, '0', mtime, '', 37),
    record('work/design-link', Buffer.alloc(0), '1', mtime, 'work/ignored/new-design.bin'),
    record('work/design-symlink', Buffer.alloc(0), '2', mtime, 'ignored/new-design.bin'),
    Buffer.alloc(1536),
  ]);
  const first = archive(12), second = archive(99), a = await f.capture(first, 'first.tar.cas.json'), b = await f.capture(second, 'second.tar.cas.json');
  assert.equal(a.rawSha256, hash(first)); assert.equal(b.rawSha256, hash(second)); assert.notEqual(a.rawSha256, b.rawSha256);
  assert(a.uniqueCompressedSize > 0); assert.equal(b.uniqueCompressedSize, 0, 'Different tar metadata does not duplicate identical file bodies');
  assert.equal(a.compressedSize, b.compressedSize); assert.equal(a.blobCount, 4); assert.equal(a.entries, 5);
  assert.deepEqual(await collect(await validatedTarCasReadable(path.join(f.dataDir, 'first.tar.cas.json'), f.dataDir)), first);
  assert.deepEqual(await collect(await validatedTarCasReadable(path.join(f.dataDir, 'second.tar.cas.json'), f.dataDir)), second);
  assert.deepEqual(await validateTarCasArchive(path.join(f.dataDir, 'second.tar.cas.json'), f.dataDir), b);
  assert.equal((await lstat(path.join(f.dataDir, 'first.tar.cas.json'))).mode & 0o077, 0);
});

test('PAX size overrides and GNU name metadata retain exact headers, payloads, padding and metadata entry counts', async t => {
  const f = await fixture(t), content = Buffer.from('actual retained bytes\n');
  const longName = `${'long/'.repeat(25)}artifact.txt`, pax = Buffer.concat([paxRecord('path', longName), paxRecord('size', String(content.length)), paxRecord('mtime', '12.000000123')]);
  const bytes = Buffer.concat([
    record('work/', Buffer.alloc(0), '5'),
    record('PaxHeader', pax, 'x'),
    header('work/placeholder', 0), content, Buffer.alloc((512 - content.length % 512) % 512, 17),
    record('LongName', Buffer.from(`${longName}\0`), 'L'), record('work/gnu-placeholder', Buffer.from('other retained work\n')),
    Buffer.alloc(1024),
  ]);
  const receipt = await f.capture(bytes, 'extended.tar.cas.json');
  assert.equal(receipt.entries, 5, 'Physical extended metadata headers count as retained entries');
  assert.deepEqual(await collect(await validatedTarCasReadable(path.join(f.dataDir, 'extended.tar.cas.json'), f.dataDir)), bytes);
});

test('missing, corrupted and non-private blobs fail validation before exposing a restore stream', async t => {
  const f = await fixture(t), bytes = Buffer.concat([record('work/retained', Buffer.from('keep this work\n')), Buffer.alloc(1024)]);
  await f.capture(bytes, 'private.tar.cas.json');
  const manifestPath = path.join(f.dataDir, 'private.tar.cas.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as TarCasManifest;
  const blob = manifest.segments.find(segment => segment.type === 'blob'); assert(blob && blob.type === 'blob');
  const filename = path.join(f.dataDir, 'provider-history', 'blobs', 'sha256', blob.sha256.slice(0, 2), `${blob.sha256}.gz`), original = await readFile(filename);
  await chmod(filename, 0o644); await assert.rejects(validatedTarCasReadable(manifestPath, f.dataDir), /private owned file/);
  await chmod(filename, 0o600); await writeFile(filename, Buffer.alloc(original.length));
  await assert.rejects(validatedTarCasReadable(manifestPath, f.dataDir), /compressed content changed/);
  await rm(filename); await assert.rejects(validatedTarCasReadable(manifestPath, f.dataDir), /ENOENT/);
  const target = path.join(f.dataDir, 'foreign.gz'); await writeFile(target, original, { mode: 0o600 }); await symlink(target, filename);
  await assert.rejects(validatedTarCasReadable(manifestPath, f.dataDir), /ELOOP/);
});

test('incomplete tar, malformed size metadata and storage admission failure never publish a preservation manifest', async t => {
  const f = await fixture(t), valid = Buffer.concat([record('work/user-file', Buffer.from('user work\n')), Buffer.alloc(1024)]);
  await assert.rejects(f.capture(valid.subarray(0, valid.length - 1), 'truncated.tar.cas.json'), /incomplete/);
  await assert.rejects(readFile(path.join(f.dataDir, 'truncated.tar.cas.json')), /ENOENT/);
  const invalidPax = Buffer.concat([record('pax', Buffer.from('99 size=100\n'), 'x'), Buffer.alloc(1024)]);
  await assert.rejects(f.capture(invalidPax, 'malformed.tar.cas.json'), /PAX record/);
  await assert.rejects(captureTarCas(fragmented(valid), path.join(f.dataDir, 'no-space.tar.cas.json'), f.dataDir, () => { throw new Error('Keep host reserve'); }), /Keep host reserve/);
  await assert.rejects(readFile(path.join(f.dataDir, 'no-space.tar.cas.json')), /ENOENT/);
});
