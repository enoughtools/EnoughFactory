import { Transform, type TransformCallback } from 'node:stream';

export class FactoryArchiveDependencyError extends Error {
  constructor() { super('A retained user file shares its contents with an excluded cache.'); }
}

// Docker cp emits a tar stream. Keep it streaming while dropping only the
// explicitly reproducible cache trees; never unpack agent-controlled paths.
export class FactoryArchiveFilter extends Transform {
  private buffered = Buffer.alloc(0);
  private remaining = 0;
  private padding = 0;
  private keep = true;
  private metadata?: { header: Buffer; chunks: Buffer[]; size: number; type: string };
  private pending: Buffer[] = [];
  private nextPath?: string;
  private nextLink?: string;
  private nextSize?: number;
  private ended = false;
  private zeroBlocks = 0;
  constructor(private readonly root: string, private readonly exclusions: readonly string[]) { super(); }

  private number(bytes: Buffer): number {
    let value: number;
    if (bytes[0]! & 0x80) {
      if (bytes[0]! & 0x40) throw new Error('Negative archive entry sizes are invalid.');
      let parsed = BigInt(bytes[0]! & 0x7f);
      for (const byte of bytes.subarray(1)) parsed = parsed * 256n + BigInt(byte);
      value = Number(parsed);
    } else {
      const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
      if (!/^[0-7]*$/.test(text)) throw new Error('Archive entry size is malformed.');
      value = text ? Number.parseInt(text, 8) : 0;
    }
    if (!Number.isSafeInteger(value) || value < 0 || value > 64 * 1024 ** 3) throw new Error('Archive entry exceeds its retained size limit.');
    return value;
  }
  private text(bytes: Buffer): string { return bytes.toString('utf8').replace(/\0.*$/, ''); }
  private pax(bytes: Buffer): Map<string, string> {
    const result = new Map<string, string>();
    for (let offset = 0; offset < bytes.length;) {
      const space = bytes.indexOf(32, offset);
      if (space < offset || space - offset > 12) throw new Error('Archive extended metadata is malformed.');
      const lengthText = bytes.subarray(offset, space).toString('ascii');
      if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error('Archive extended metadata length is malformed.');
      const length = Number(lengthText), end = offset + length;
      if (end > bytes.length || end <= space + 1 || bytes[end - 1] !== 10) throw new Error('Archive extended metadata is incomplete.');
      const record = bytes.subarray(space + 1, end - 1).toString('utf8'), equals = record.indexOf('=');
      if (equals < 1) throw new Error('Archive extended metadata is invalid.');
      result.set(record.slice(0, equals), record.slice(equals + 1)); offset = end;
    }
    return result;
  }
  private finishMetadata(): void {
    const meta = this.metadata!, bytes = Buffer.concat(meta.chunks).subarray(0, meta.size);
    const complete = Buffer.concat([meta.header, ...meta.chunks]);
    if (meta.type === 'g') {
      const fields = this.pax(bytes);
      if (fields.has('path') || fields.has('linkpath') || fields.has('size')) throw new Error('Global archive paths or sizes cannot be preserved safely.');
      this.push(complete);
    } else {
      this.pending.push(complete);
      if (meta.type === 'L') this.nextPath = this.text(bytes).replace(/\n$/, '');
      if (meta.type === 'K') this.nextLink = this.text(bytes).replace(/\n$/, '');
      if (meta.type === 'x') {
        const fields = this.pax(bytes);
        if (fields.has('path')) this.nextPath = fields.get('path');
        if (fields.has('linkpath')) this.nextLink = fields.get('linkpath');
        if (fields.has('size')) {
          const value = fields.get('size')!;
          if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 64 * 1024 ** 3) throw new Error('Extended archive entry size is invalid.');
          this.nextSize = Number(value);
        }
      }
    }
    this.metadata = undefined;
  }
  private header(header: Buffer): void {
    if (header.every(byte => byte === 0)) {
      if (this.pending.length) throw new Error('Archive extended metadata has no file.');
      this.zeroBlocks++; this.push(header); this.ended = this.zeroBlocks >= 2; return;
    }
    if (this.zeroBlocks) throw new Error('Archive contains an incomplete end marker.');
    const expected = this.number(header.subarray(148, 156));
    let sum = 0;
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]!;
    if (sum !== expected) throw new Error('Archive entry checksum is invalid.');
    const type = String.fromCharCode(header[156]!), size = this.number(header.subarray(124, 136));
    const extended = ['x', 'g', 'L', 'K'].includes(type);
    if (extended) {
      if (size > 1024 ** 2 || this.pending.reduce((total, item) => total + item.length, 0) > 4 * 1024 ** 2) throw new Error('Archive extended metadata exceeds its storage limit.');
      this.metadata = { header, chunks: [], size, type }; this.remaining = size;
    } else {
      const prefix = this.text(header.subarray(345, 500));
      const name = this.nextPath ?? `${prefix ? `${prefix}/` : ''}${this.text(header.subarray(0, 100))}`;
      const normalized = name.replace(/^\.\//, '').replace(/\/+$/, '');
      if (!normalized || normalized.includes('\0') || normalized.split('/').includes('..') || !(normalized === this.root || normalized.startsWith(`${this.root}/`))) throw new Error('Archive entry is outside its expected source.');
      this.keep = !this.exclusions.some(excluded => normalized === excluded || normalized.startsWith(`${excluded}/`));
      if (type === '1' && this.keep) {
        const target = (this.nextLink ?? this.text(header.subarray(157, 257))).replace(/^\.\//, '').replace(/\/+$/, '');
        if (target.split('/').includes('..') || !(target === this.root || target.startsWith(`${this.root}/`))) throw new Error('A retained archive hardlink is outside its expected source.');
        if (this.exclusions.some(excluded => target === excluded || target.startsWith(`${excluded}/`))) throw new FactoryArchiveDependencyError();
      }
      if (this.keep) { for (const entry of this.pending) this.push(entry); this.push(header); }
      this.pending = []; this.nextPath = undefined; this.nextLink = undefined;
      this.remaining = this.nextSize ?? size; this.nextSize = undefined;
    }
    this.padding = (512 - this.remaining % 512) % 512;
    if (!this.remaining && !this.padding && this.metadata) this.finishMetadata();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      let bytes = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
      this.buffered = Buffer.alloc(0);
      while (bytes.length) {
        if (this.ended) {
          if (bytes.some(byte => byte !== 0)) throw new Error('Archive has content after its end marker.');
          this.push(bytes); break;
        }
        if (!this.remaining && !this.padding) {
          if (bytes.length < 512) { this.buffered = Buffer.from(bytes); break; }
          this.header(Buffer.from(bytes.subarray(0, 512))); bytes = bytes.subarray(512); continue;
        }
        const count = Math.min(bytes.length, this.remaining || this.padding), part = bytes.subarray(0, count);
        if (this.metadata) this.metadata.chunks.push(Buffer.from(part)); else if (this.keep) this.push(part);
        if (this.remaining) this.remaining -= count; else this.padding -= count;
        bytes = bytes.subarray(count);
        if (!this.remaining && !this.padding && this.metadata) this.finishMetadata();
      }
      callback();
    } catch (error) { callback(error as Error); }
  }
  override _flush(callback: TransformCallback): void {
    callback(this.buffered.length || this.remaining || this.padding || this.pending.length || !this.ended ? new Error('Archive stream is incomplete.') : undefined);
  }
}
