#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: node scripts/check-desktop-archive.mjs --artifact <dmg|zip|AppImage|tar.gz> [--receipt <path>] [--source-commit <hash>] [--runtime-receipt <path>]';
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--help') { console.log(usage); process.exit(0); }
  if (!['--artifact', '--receipt', '--source-commit', '--runtime-receipt'].includes(flag) || options[flag] !== undefined || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(usage);
  options[flag] = process.argv[++index];
}
if (!options['--artifact']) throw new Error(usage);
if (options['--source-commit'] && !/^[a-f0-9]{40}$/.test(options['--source-commit'])) throw new Error('The source commit must be a complete lowercase Git SHA-1.');
const artifactPath = resolve(options['--artifact']);
const receiptPath = resolve(options['--receipt'] ?? `${artifactPath}.verification.json`);
if (receiptPath === artifactPath || (options['--runtime-receipt'] && receiptPath === resolve(options['--runtime-receipt']))) throw new Error('Write the archive receipt separately from its artifact and runtime journey receipt.');
const filename = basename(artifactPath);
const format = /\.tar\.gz$/i.test(filename) ? 'tar.gz' : /\.appimage$/i.test(filename) ? 'AppImage' : /\.dmg$/i.test(filename) ? 'dmg' : /\.zip$/i.test(filename) ? 'zip' : undefined;
if (!format) throw new Error('Supported desktop archive formats are DMG, ZIP, AppImage and tar.gz.');
const platform = ['dmg', 'zip'].includes(format) ? 'darwin' : 'linux';
if (process.platform !== platform || !['arm64', 'x64'].includes(process.arch)) throw new Error(`Verify ${format} archives on a native ${platform} arm64/x64 worker.`);
if (!(await lstat(artifactPath)).isFile()) throw new Error('The desktop artifact must be an ordinary archive file.');

const work = await mkdtemp(join(tmpdir(), 'enoughfactory-archive-'));
const snapshot = join(work, filename);
const extracted = join(work, 'extracted');
const treeReceiptPath = join(work, 'resources.verification.json');
const mountpoint = join(work, 'mounted');
let attachAttempted = false;
let mountedDevice;
let receipt;
let failure;

async function fingerprint(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  if (bytes === 0) throw new Error('The desktop artifact is empty.');
  return { sha256: hash.digest('hex'), bytes };
}
function command(program, args, extra = {}) {
  return execFileSync(program, args, { encoding: 'utf8', cwd: work, timeout: 120_000, maxBuffer: 32 * 1024 * 1024, ...extra });
}
function contained(root, path) {
  const inside = relative(root, path);
  return inside === '' || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`));
}

// Read actual archive metadata rather than newline-based listings. Preflight all
// link chains before native extraction can write through a symlink ancestor.
const archiveMetadata = String.raw`
import json, stat, sys, tarfile, zipfile
archive, kind = sys.argv[1:]
members = []
if kind == 'zip':
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            mode = member.external_attr >> 16
            if member.is_dir():
                entry = {'path': member.filename, 'kind': 'directory'}
            elif stat.S_ISLNK(mode):
                if member.file_size > 1048576:
                    raise ValueError('Oversized archive symlink')
                entry = {'path': member.filename, 'kind': 'symlink', 'target': source.read(member).decode('utf-8')}
            elif stat.S_IFMT(mode) in (0, stat.S_IFREG):
                entry = {'path': member.filename, 'kind': 'file'}
            else:
                raise ValueError('Unsupported ZIP member type: ' + member.filename)
            members.append(entry)
else:
    with tarfile.open(archive, 'r:gz') as source:
        for member in source:
            if member.isdir(): kind = 'directory'
            elif member.isfile(): kind = 'file'
            elif member.issym(): kind = 'symlink'
            elif member.islnk(): kind = 'hardlink'
            else: raise ValueError('Unsupported TAR member type: ' + member.name)
            entry = {'path': member.name, 'kind': kind}
            if kind in ('symlink', 'hardlink'): entry['target'] = member.linkname
            members.append(entry)
print(json.dumps(members))
`;

function canonical(path, member = false) {
  if (typeof path !== 'string' || path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || (member && path.split('/').includes('..'))) throw new Error(`Unsafe archive path: ${JSON.stringify(path)}`);
  const parts = [];
  for (const component of path.split('/')) {
    if (!component || component === '.') continue;
    if (component === '..') {
      if (!parts.length) throw new Error(`Archive link escapes the extraction directory: ${JSON.stringify(path)}`);
      parts.pop();
    } else parts.push(component);
  }
  return parts.join('/');
}
function validateMembers(members) {
  if (!Array.isArray(members) || members.length === 0 || members.length > 100_000) throw new Error('Archive member inventory is missing or exceeds the release limit.');
  const inventory = new Map();
  for (const member of members) {
    const name = canonical(member.path, true);
    if (!name && member.kind === 'directory') continue;
    if (!name || !['file', 'directory', 'symlink', 'hardlink'].includes(member.kind) || inventory.has(name)) throw new Error(`Duplicate or unsupported archive member: ${member.path}`);
    inventory.set(name, { ...member, path: name });
  }
  function resolveLinks(path) {
    let pending = path.split('/');
    let components = [];
    const seen = new Set();
    while (pending.length) {
      const component = pending.shift();
      if (!component || component === '.') continue;
      if (component === '..') {
        if (!components.length) throw new Error(`Archive link escapes its extraction directory: ${path}`);
        components.pop();
        continue;
      }
      components.push(component);
      const prefix = components.join('/');
      const link = inventory.get(prefix);
      if (!link || !['symlink', 'hardlink'].includes(link.kind)) continue;
      if (seen.has(prefix) || seen.size >= 64) throw new Error(`Cyclic archive link: ${prefix}`);
      if (typeof link.target !== 'string' || !link.target || link.target.includes('\0') || link.target.includes('\\') || link.target.startsWith('/') || /^[A-Za-z]:/.test(link.target)) throw new Error(`Unsafe archive link target: ${prefix}`);
      seen.add(prefix);
      components = link.kind === 'hardlink' ? [] : components.slice(0, -1);
      // Resolve links before applying following '..' segments, matching the
      // filesystem rather than lexical path normalization.
      pending = [...link.target.split('/'), ...pending];
    }
    return components.join('/');
  }
  for (const [name, member] of inventory) {
    const resolved = resolveLinks(name);
    if (member.kind === 'hardlink' && inventory.get(resolved)?.kind !== 'file') throw new Error(`Archive hardlink must target an ordinary included file: ${name}`);
    // Extraction ordering must never replace a parent directory with a link.
    const parts = name.split('/');
    for (let count = 1; count < parts.length; count++) {
      const parent = inventory.get(parts.slice(0, count).join('/'));
      if (parent && parent.kind !== 'directory') throw new Error(`Archive member has a non-directory ancestor: ${name}`);
    }
  }
}

async function discoverResources(root) {
  const boundary = await realpath(root);
  const matches = [];
  let directories = 0;
  async function walk(directory) {
    if (++directories > 30_000) throw new Error('Desktop archive contains too many directories.');
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some(entry => entry.name === 'bundle-provenance.json' && entry.isFile())) {
      try {
        for (const name of ['device/service.cjs', 'runtime/node']) {
          const path = join(directory, name);
          if (!(await lstat(path)).isFile() || !contained(boundary, await realpath(path))) throw new Error('Resources must remain inside the archive.');
        }
        matches.push(directory);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const entry of entries) if (entry.isDirectory()) await walk(join(directory, entry.name));
  }
  await walk(boundary);
  if (matches.length !== 1) throw new Error(`The desktop archive must contain exactly one complete resource root; found ${matches.length}.`);
  return matches[0];
}

async function runTreeChecker(resources) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'check-desktop-bundle.mjs');
  const args = [script, '--resources', resources, '--receipt', treeReceiptPath];
  if (options['--source-commit']) args.push('--source-commit', options['--source-commit']);
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd: work, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`Installed resource verification failed (${signal ?? code}).`)));
  });
  const proof = JSON.parse(await readFile(treeReceiptPath, 'utf8'));
  if (proof.formatVersion !== 1 || proof.product !== 'EnoughFactory' || proof.verificationScope !== 'installed-desktop-resources' || proof.platform !== process.platform || proof.arch !== process.arch || !/^[a-f0-9]{40}$/.test(proof.sourceCommit ?? '') || proof.resources?.hashesVerified !== true || !/^[a-f0-9]{64}$/.test(proof.resources.bundleProvenanceSha256 ?? '') || !proof.resources.manifest || proof.containerRuntime?.assetsVerified !== true || proof.native?.unauthenticatedStateStatus !== 401) throw new Error('The resource checker did not emit a complete typed verification receipt.');
  const provenance = await readFile(join(resources, 'bundle-provenance.json'));
  if (createHash('sha256').update(provenance).digest('hex') !== proof.resources.bundleProvenanceSha256) throw new Error('The resource receipt belongs to different bundle provenance.');
  return proof;
}

try {
  await copyFile(artifactPath, snapshot);
  const artifact = { filename, ...await fingerprint(snapshot) };
  await mkdir(extracted);
  let root = extracted;
  if (format === 'dmg') {
    await mkdir(mountpoint);
    attachAttempted = true;
    const output = command('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint, '-plist', snapshot]);
    const attached = JSON.parse(command('python3', ['-c', 'import json,plistlib,sys; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'], { input: output }));
    const entities = attached['system-entities'];
    const mounted = Array.isArray(entities) && entities.find(entity => entity['mount-point'] && resolve(entity['mount-point']) === mountpoint);
    if (!mounted || typeof mounted['dev-entry'] !== 'string') throw new Error('The DMG did not mount at its private verification location.');
    mountedDevice = mounted['dev-entry'];
    root = mountpoint;
  } else if (format === 'AppImage') {
    const handle = await import('node:fs/promises').then(module => module.open(snapshot, 'r'));
    const header = Buffer.alloc(20);
    try { if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length) throw new Error('Incomplete AppImage ELF header.'); }
    finally { await handle.close(); }
    const machine = header.readUInt16LE(18);
    if (header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.subarray(8, 11).toString('hex') !== '414902' || machine !== (process.arch === 'arm64' ? 183 : 62)) throw new Error('The AppImage is not a type-2 release for this native Linux architecture.');
    await chmod(snapshot, 0o700);
    command(snapshot, ['--appimage-extract'], { cwd: extracted });
    root = join(extracted, 'squashfs-root');
  } else {
    const members = JSON.parse(command('python3', ['-c', archiveMetadata, snapshot, format]));
    validateMembers(members);
    if (format === 'zip') command('ditto', ['-x', '-k', '--noqtn', snapshot, extracted]);
    else command('tar', ['-xzf', snapshot, '-C', extracted, '--no-same-owner']);
  }
  const resources = await discoverResources(root);
  const proof = await runTreeChecker(resources);
  const runtimeReceiptPath = options['--runtime-receipt'];
  let runtimeJourney;
  if (runtimeReceiptPath) {
    runtimeJourney = JSON.parse(await readFile(resolve(runtimeReceiptPath), 'utf8'));
    const bundle = runtimeJourney.bundle;
    const suites = proof.platform === 'linux' ? ['private-linux-runtime'] : ['private-macos-runtime', 'private-mac-runtime'];
    if (runtimeJourney.formatVersion !== 1 || runtimeJourney.product !== 'EnoughFactory' || runtimeJourney.status !== 'passed' || !suites.includes(runtimeJourney.suite) || runtimeJourney.platform !== proof.platform || runtimeJourney.arch !== proof.arch || bundle?.platform !== proof.platform || bundle.arch !== proof.arch || bundle.version !== proof.version || bundle.sourceCommit !== proof.sourceCommit || bundle.manifestSha256 !== proof.resources.bundleProvenanceSha256 || runtimeJourney.runtimeProvenanceSha256 !== proof.resources.manifest['runtime/container/provenance.json'] || runtimeJourney.envmuxSha256 !== proof.resources.manifest['envmux/envmux'] || !Array.isArray(runtimeJourney.checks) || runtimeJourney.checks.length === 0 || typeof runtimeJourney.completedAt !== 'string') throw new Error('The actual runtime journey receipt does not match this archive’s exact resource identity and native source revision.');
  }
  const current = await fingerprint(artifactPath);
  if (current.sha256 !== artifact.sha256 || current.bytes !== artifact.bytes) throw new Error('The archive changed during verification; no receipt was written.');
  receipt = { ...proof, verificationScope: 'desktop-archive', verifiedAt: new Date().toISOString(), artifact, extraction: { format }, ...(runtimeJourney ? { runtimeJourney } : {}) };
} catch (error) { failure = error; }
finally {
  if (attachAttempted) {
    try { command('hdiutil', ['detach', mountedDevice ?? mountpoint], { timeout: 30_000 }); }
    catch (error) {
      try { command('hdiutil', ['detach', '-force', mountedDevice ?? mountpoint], { timeout: 30_000 }); }
      catch { failure ??= new Error(`Could not detach the private archive mount: ${error.message}`); }
    }
  }
  await rm(work, { recursive: true, force: true }).catch(error => { failure ??= error; });
}
if (failure) throw failure;
await mkdir(dirname(receiptPath), { recursive: true });
const stagedReceipt = `${receiptPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
try {
  await writeFile(stagedReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(stagedReceipt, receiptPath);
} finally { await rm(stagedReceipt, { force: true }); }
console.log(`EnoughFactory ${format} archive verified: ${receipt.artifact.filename}, ${receipt.artifact.bytes} bytes, SHA-256 ${receipt.artifact.sha256}. Receipt: ${receiptPath}`);
