#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const directories = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--output');
if (!directories.length) throw new Error('Pass one or more engine binary directories');
const outputIndex = args.indexOf('--output');
const output = outputIndex < 0 ? undefined : args[outputIndex + 1];
const names = new Set(['docker', 'dockerd', 'docker-proxy', 'docker-init', 'runc', 'containerd', 'containerd-shim-runc-v2', 'ctr', 'rootlesskit']);
const rows = [];
for (const directory of directories) {
  for (const entry of await readdir(resolve(directory), { withFileTypes: true })) {
    if (!entry.isFile() || !names.has(entry.name)) continue;
    const file = join(resolve(directory), entry.name); const data = await readFile(file);
    const row = { file, name: entry.name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    if (data.subarray(0, 4).toString('hex') !== '7f454c46') { rows.push({ ...row, format: 'Non-ELF host tool' }); continue; }
    if (data[4] !== 2 || data[5] !== 1) throw new Error(`Expected little-endian ELF64: ${file}`);
    const phoff = Number(data.readBigUInt64LE(32)); const phsize = data.readUInt16LE(54); const phcount = data.readUInt16LE(56);
    let interpreter;
    for (let index = 0; index < phcount; index++) {
      const offset = phoff + index * phsize;
      if (data.readUInt32LE(offset) === 3) {
        const start = Number(data.readBigUInt64LE(offset + 8)); const size = Number(data.readBigUInt64LE(offset + 32));
        interpreter = data.subarray(start, start + size).toString().replace(/\0.*$/s, '');
      }
    }
    const shoff = Number(data.readBigUInt64LE(40)); const shsize = data.readUInt16LE(58); const shcount = data.readUInt16LE(60);
    const sections = [];
    for (let index = 0; index < shcount; index++) {
      const offset = shoff + index * shsize;
      sections.push({ type: data.readUInt32LE(offset + 4), address: Number(data.readBigUInt64LE(offset + 16)), offset: Number(data.readBigUInt64LE(offset + 24)), bytes: Number(data.readBigUInt64LE(offset + 32)), link: data.readUInt32LE(offset + 40), entryBytes: Number(data.readBigUInt64LE(offset + 56)) });
    }
    const readString = (bytes, offset) => bytes.subarray(offset, bytes.indexOf(0, offset) < 0 ? bytes.length : bytes.indexOf(0, offset)).toString();
    const symbolEvidence = {}; const neededLibraries = [];
    for (const section of sections) {
      if ([2, 11].includes(section.type)) {
        const stringsSection = sections[section.link]; const strings = data.subarray(stringsSection.offset, stringsSection.offset + stringsSection.bytes);
        for (let offset = section.offset; offset < section.offset + section.bytes; offset += section.entryBytes) {
          const name = readString(strings, data.readUInt32LE(offset));
          if (!['__nptl_version', 'library_version'].includes(name)) continue;
          const containing = sections[data.readUInt16LE(offset + 6)]; if (!containing || containing.type === 8) continue;
          const address = Number(data.readBigUInt64LE(offset + 8)); const start = containing.offset + address - containing.address;
          if (name === '__nptl_version') symbolEvidence.glibcNptlVersion = readString(data, start);
          if (name === 'library_version' && entry.name === 'runc') symbolEvidence.libseccompVersion = [0, 4, 8].map(delta => data.readUInt32LE(start + delta)).join('.');
        }
      }
      if (section.type === 6) {
        const stringsSection = sections[section.link]; const strings = data.subarray(stringsSection.offset, stringsSection.offset + stringsSection.bytes);
        for (let offset = section.offset; offset < section.offset + section.bytes; offset += 16) {
          if (data.readBigUInt64LE(offset) === 1n) neededLibraries.push(readString(strings, Number(data.readBigUInt64LE(offset + 8))));
        }
      }
    }
    const glibcLoaderMarkers = ['GLIBC_PRIVATE', 'GLIBC_TUNABLES', 'GLIBC_ABI_DT_RELR'].filter(marker => data.includes(Buffer.from(marker)));
    rows.push({ ...row, format: 'ELF64', architecture: ({ 62: 'x64', 183: 'arm64' })[data.readUInt16LE(18)] ?? data.readUInt16LE(18), interpreter: interpreter ?? null, neededLibraries, linkage: !interpreter && !neededLibraries.length ? 'static' : 'dynamic', symbolEvidence, glibcLoaderMarkers });
  }
}
if (output) await writeFile(resolve(output), `${JSON.stringify({ formatVersion: 1, binaries: rows }, null, 2)}\n`);
else console.log(JSON.stringify({ formatVersion: 1, binaries: rows }, null, 2));
if (args.includes('--deny-glibc') && rows.some(row => row.symbolEvidence?.glibcNptlVersion || row.glibcLoaderMarkers?.length)) process.exitCode = 1;
