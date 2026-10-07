import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { EphemeralContainerReceipt, PreservedContainerArchive } from './factory-container-retirement.ts';
import { restoreFactoryContainerArchives } from './factory-container-restore.ts';
import { captureTarCas } from './factory-archive-cas.ts';
import { exec } from './util.ts';

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'enough-container-restore-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const oldId = 'a'.repeat(64), freshId = 'b'.repeat(64), name = 'repository-f-123456789abc';
  const identity = {
    sessionId: 'session_restore', container: name, name, project: 'repository', sessionName: 'f-123456789abc',
    projectPath: '/private/factory/workspaces/attempt/repository', branch: 'envmux/f-123456789abc', workdir: '/work',
  };
  const directory = path.join(dataDir, 'provider-history', identity.sessionId, oldId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const originals = path.join(dataDir, 'originals'), destination = path.join(dataDir, 'fresh-container');
  await mkdir(destination);
  const files = [
    { source: '/work', filename: 'src/client.ts', content: 'retained uncommitted mail client source\n', exclusions: [] },
    { source: '/home', filename: 'agent/.config/preferences.json', content: '{"retainedPreference":true}\n', exclusions: [] },
    { source: '/root', filename: '.codex/sessions/trajectory.jsonl', content: '{"retainedConversation":true}\n', exclusions: ['root/.npm', 'root/.cache', 'root/.codex/plugins/cache'] },
    { source: '/data/shared', filename: 'notes.md', content: 'retained additional working directory\n', exclusions: [] },
  ];
  const archives: PreservedContainerArchive[] = [];
  for (const [index, entry] of files.entries()) {
    const root = path.posix.basename(entry.source), parent = path.join(originals, String(index));
    const filename = path.join(parent, root, entry.filename);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, entry.content);
    const rawPath = path.join(dataDir, `fixture-${index}.tar`);
    await exec('/usr/bin/tar', ['--format=ustar', '-cf', rawPath, '-C', parent, root], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const raw = await readFile(rawPath), compressed = gzipSync(raw);
    const archive = path.join(directory, `${String(index).padStart(2, '0')}-${root}.tar.gz`);
    await writeFile(archive, compressed, { mode: 0o600 });
    const listed = (await exec('/usr/bin/tar', ['-tzf', archive])).stdout.split('\n').filter(Boolean);
    archives.push({ source: entry.source, root, archive, exclusions: entry.exclusions, sha256: digest(compressed), size: compressed.length, rawSha256: digest(raw), rawSize: raw.length, entries: listed.length });
  }
  const primary = archives[0]!;
  const receipt: EphemeralContainerReceipt = {
    version: 2, status: 'removed', identity, containerId: oldId, fingerprint: {}, runtime: 'ephemeral', runtimeKinds: ['codex'],
    archive: primary.archive, sha256: primary.sha256, size: primary.size, rawSha256: primary.rawSha256, rawSize: primary.rawSize, entries: primary.entries,
    archives, ownedVolumes: [], exclusions: ['/root/.npm', '/root/.cache', '/root/.codex/plugins/cache', '/opt/enoughfactory/node', '/opt/enoughfactory/antigravity'],
  };
  const inspected = {
    Id: freshId, Name: `/${name}`, Created: '2026-10-07T01:00:00Z',
    State: { Running: true, Paused: false, Restarting: false, Dead: false, Pid: 42 },
    Config: { Labels: {
      'envmux.schema': '2', 'envmux.kind': 'session', 'envmux.instance': name, 'envmux.project': identity.project,
      'envmux.session': identity.sessionName, 'envmux.directory': identity.projectPath, 'envmux.branch': identity.branch, 'envmux.workdir': identity.workdir,
    } },
    Mounts: [] as { Type: string; Name?: string; Source: string; Destination: string; RW: boolean; Driver?: string }[],
  };
  const initial = { inspected, inspections: 0, replaceAfterInspection: 0, replaceAfterCopies: 0, volumeReferences: [freshId], calls: [] as string[][] };
  const statePath = path.join(dataDir, 'fake-docker-state.json'), cliPath = path.join(dataDir, 'fake-docker');
  await writeFile(statePath, JSON.stringify(initial));
  await writeFile(cliPath, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const statePath = ${JSON.stringify(statePath)}, destination = ${JSON.stringify(destination)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8')), args = process.argv.slice(2);
if (args[0] !== '--host' || args[1] !== 'unix:///private/enoughfactory-fixture.sock' || args[2] !== '--config') process.exit(90);
const command = args.slice(4); state.calls.push(command);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (command[0] === 'inspect') {
  state.inspections++; save(); const inspected = structuredClone(state.inspected);
  if (state.replaceAfterInspection && state.inspections > state.replaceAfterInspection) inspected.Id = 'c'.repeat(64);
  if (state.replaceAfterCopies && state.calls.filter(call => call[0] === 'cp').length >= state.replaceAfterCopies) inspected.Id = 'c'.repeat(64);
  process.stdout.write(JSON.stringify([inspected]));
} else if (command[0] === 'ps') {
  save(); process.stdout.write(state.volumeReferences.join('\\n') + '\\n');
} else if (command[0] === 'exec') {
  if (command[3] !== state.inspected.Id) process.exit(91);
  save();
  if (command.slice(4, 7).join(' ') === 'mkdir -p --') fs.mkdirSync(path.join(destination, command[7]), { recursive: true });
  else {
    const marker = command.indexOf('enoughfactory-clear-preserved-target');
    if (marker < 0) process.exit(95);
    const source = command[marker + 1], protectedPaths = command.slice(marker + 2);
    if (!source.startsWith('/') || source === '/' || path.posix.normalize(source) !== source) process.exit(96);
    const protectedAbsolute = protectedPaths.map(value => value.startsWith('/') ? value : '/' + value);
    const clear = containerPath => {
      if (protectedAbsolute.includes(containerPath)) return;
      const target = path.join(destination, containerPath);
      if (!fs.existsSync(target)) return;
      if (fs.lstatSync(target).isDirectory() && protectedAbsolute.some(value => value.startsWith(containerPath + '/'))) {
        for (const child of fs.readdirSync(target)) clear(path.posix.join(containerPath, child));
      } else fs.rmSync(target, { recursive: true, force: true });
    };
    const target = path.join(destination, source);
    if (fs.existsSync(target)) for (const child of fs.readdirSync(target)) clear(path.posix.join(source, child));
    fs.mkdirSync(target, { recursive: true });
  }
} else if (command[0] === 'cp') {
  if (command[1] !== '-' || !command[2].startsWith(state.inspected.Id + ':')) process.exit(92);
  save(); const parent = command[2].slice(command[2].indexOf(':') + 1);
  const result = cp.spawnSync('/usr/bin/tar', ['-xf', '-', '-C', path.join(destination, parent)], { input: fs.readFileSync(0) });
  if (result.status !== 0) process.exit(93);
} else process.exit(94);
`);
  await chmod(cliPath, 0o700);
  const endpoint = { host: 'unix:///private/enoughfactory-fixture.sock', configDirectory: path.join(dataDir, 'docker-config'), cliPath };
  const state = async () => JSON.parse(await readFile(statePath, 'utf8')) as typeof initial;
  const update = async (value: Partial<typeof initial>) => writeFile(statePath, JSON.stringify({ ...await state(), ...value }));
  const run = (overrides: Partial<Parameters<typeof restoreFactoryContainerArchives>[0]> = {}) => restoreFactoryContainerArchives({ endpoint, dataDir, receipt, identity, assertCurrent: () => {}, ...overrides });
  return { dataDir, destination, oldId, freshId, inspected, receipt, files, state, update, run };
}

test('recovery restores source, provider history, home state and additional directories only into a fresh owned container', async t => {
  const f = await fixture(t), hashes = f.receipt.archives.map(archive => archive.sha256);
  await f.run();
  for (const file of f.files) assert.equal(await readFile(path.join(f.destination, file.source, file.filename), 'utf8'), file.content);
  for (const [index, archive] of f.receipt.archives.entries()) assert.equal(digest(await readFile(archive.archive)), hashes[index], 'Restoration never alters original preserved files');
  const calls = (await f.state()).calls;
  assert.deepEqual(calls.filter(call => call[0] === 'cp').map(call => call.slice(1)), [['-', `${f.freshId}:/`], ['-', `${f.freshId}:/`], ['-', `${f.freshId}:/`], ['-', `${f.freshId}:/data`]]);
  assert.equal(calls.some(call => ['rm', 'volume', 'run'].includes(call[0]!)), false);
});

test('deduplicated preservation restores the complete environment through the same owned destination fence', async t => {
  const f = await fixture(t);
  for (const [index, archive] of f.receipt.archives.entries()) {
    const filename = archive.archive.replace(/\.tar\.gz$/, '.tar.cas.json');
    const preserved = await captureTarCas(createReadStream(path.join(f.dataDir, `fixture-${index}.tar`)), filename, f.dataDir, () => {});
    Object.assign(archive, preserved, { archive: filename });
  }
  const first = f.receipt.archives[0]!;
  Object.assign(f.receipt, { archive: first.archive, sha256: first.sha256, size: first.size, rawSha256: first.rawSha256, rawSize: first.rawSize, entries: first.entries });
  const original = await Promise.all(f.receipt.archives.map(archive => readFile(archive.archive)));
  await f.run();
  for (const file of f.files) assert.equal(await readFile(path.join(f.destination, file.source, file.filename), 'utf8'), file.content);
  for (const [index, archive] of f.receipt.archives.entries()) assert.deepEqual(await readFile(archive.archive), original[index], 'Restore does not mutate the durable CAS manifest');
  assert.equal((await f.state()).calls.filter(call => call[0] === 'cp').length, f.files.length);
});

test('every retained archive must validate before any destination write or Docker command', async t => {
  const f = await fixture(t), later = f.receipt.archives.at(-1)!;
  later.sha256 = '0'.repeat(64);
  await assert.rejects(f.run(), /does not match its preservation receipt/);
  assert.deepEqual((await f.state()).calls, [], 'A valid first archive never permits partial restoration when a later archive is invalid');
});

test('restoration reproduces deletions and Git state rather than overlaying the fresh checkout', async t => {
  const f = await fixture(t), original = await Promise.all(f.receipt.archives.map(archive => readFile(archive.archive)));
  const staleSource = path.join(f.destination, 'work', 'deleted.txt');
  const staleRef = path.join(f.destination, 'work', '.git', 'refs', 'heads', 'fresh-only');
  const cache = path.join(f.destination, 'root', '.npm', 'recreated-runtime-cache');
  for (const filename of [staleSource, staleRef, cache]) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, 'present only in the fresh environment\n');
  }
  await f.run();
  await assert.rejects(lstat(staleSource), { code: 'ENOENT' });
  await assert.rejects(lstat(staleRef), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.destination, 'work', 'src', 'client.ts'), 'utf8'), f.files[0]!.content);
  assert.equal(await readFile(cache, 'utf8'), 'present only in the fresh environment\n', 'Declared reproducible caches remain available for the fresh runtime');
  for (const [index, archive] of f.receipt.archives.entries()) assert.deepEqual(await readFile(archive.archive), original[index]);
});

test('overlapping bind, read-only, unowned, and shared named mounts cannot receive restoration writes', async t => {
  for (const variant of ['bind', 'read-only', 'shared', 'shared-reference'] as const) {
    const f = await fixture(t), inspected = structuredClone(f.inspected);
    inspected.Mounts = [{
      Type: variant === 'bind' ? 'bind' : 'volume', Name: variant === 'shared' ? 'another-session-work' : `${f.receipt.identity.name}-work`,
      Source: '/private/other-owned-data', Destination: '/work', RW: variant !== 'read-only', Driver: 'local',
    }];
    await f.update({ inspected, volumeReferences: variant === 'shared-reference' ? [f.freshId, 'd'.repeat(64)] : [f.freshId] });
    await assert.rejects(f.run(), /mount|volume|owned|read.only|shared/i);
    assert.equal((await f.state()).calls.some(call => call[0] === 'exec' || call[0] === 'cp'), false, `${variant} mount must fail before destination writes`);
  }
});

test('recovery rejects the retired container, shortened IDs, and mismatched fresh ownership before writing', async t => {
  for (const variant of ['old', 'short', 'ownership'] as const) {
    const f = await fixture(t), inspected = structuredClone(f.inspected);
    if (variant === 'old') inspected.Id = f.oldId;
    if (variant === 'short') inspected.Id = f.freshId.slice(0, 12);
    if (variant === 'ownership') inspected.Config.Labels['envmux.session'] = 'another-session';
    await f.update({ inspected });
    await assert.rejects(f.run(), /no longer has its expected owned container/);
    assert.equal((await f.state()).calls.some(call => call[0] === 'exec' || call[0] === 'cp'), false);
  }
});

test('replacement of the destination during restoration stops subsequent writes', async t => {
  const before = await fixture(t);
  await before.update({ replaceAfterInspection: 1 });
  await assert.rejects(before.run(), /changed during recovery/);
  assert.equal((await before.state()).calls.some(call => call[0] === 'exec' || call[0] === 'cp'), false);
  const after = await fixture(t);
  await after.update({ replaceAfterCopies: 1 });
  await assert.rejects(after.run(), /changed during recovery/);
  assert.equal((await after.state()).calls.filter(call => call[0] === 'cp').length, 1, 'After-copy identity loss prevents restoration of remaining archives');
});

test('canceling the launch generation before the first copy preserves all original archives', async t => {
  const f = await fixture(t), original = await Promise.all(f.receipt.archives.map(archive => readFile(archive.archive)));
  let checks = 0;
  await assert.rejects(f.run({ assertCurrent: () => { if (++checks === 4) throw new Error('Launch generation was canceled'); } }), /Launch generation was canceled/);
  assert.equal((await f.state()).calls.filter(call => call[0] === 'exec').length, 1);
  assert.equal((await f.state()).calls.some(call => call[0] === 'cp'), false);
  for (const [index, archive] of f.receipt.archives.entries()) assert.deepEqual(await readFile(archive.archive), original[index]);
});

test('conversation-only archives cannot be mistaken for a recoverable environment', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ receipt: { version: 1 } }), /conversation history only/);
  assert.deepEqual((await f.state()).calls, []);
});
