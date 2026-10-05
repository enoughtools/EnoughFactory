#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const kit = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(await readFile(join(kit, 'sources.json'), 'utf8'));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return args[index + 1];
}
const architecture = option('--architecture', 'all');
if (!['all', 'x64', 'arm64'].includes(architecture)) throw new Error('Architecture must be x64, arm64 or all');
const cache = resolve(option('--cache', join(kit, '.cache')));
const output = resolve(option('--output', join(kit, 'output')));
const go = option('--go', 'go');
const sourceArchive = join(cache, `moby-${pins.moby.revision}.tgz`);
const source = join(cache, `moby-${pins.moby.revision}`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function command(executable, argv, options = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(executable, argv, { stdio: ['ignore', 'pipe', 'inherit'], ...options });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; if (!options.capture) process.stdout.write(chunk); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveRun(text.trim()) : reject(new Error(`${executable} exited ${code}`)));
  });
}
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
let sourceBytes;
try { sourceBytes = await readFile(sourceArchive); } catch {
  const response = await fetch(pins.moby.url);
  if (!response.ok) throw new Error(`Moby download returned ${response.status}`);
  sourceBytes = Buffer.from(await response.arrayBuffer());
  if (sourceBytes.length > 100_000_000) throw new Error('Moby source archive exceeded its limit');
}
if (hash(sourceBytes) !== pins.moby.sha256) throw new Error('Moby source digest mismatch');
await writeFile(sourceArchive, sourceBytes);
try { await access(join(source, 'go.mod')); } catch {
  await command('tar', ['-xzf', sourceArchive, '-C', cache]);
}
const env = { ...process.env, GOTOOLCHAIN: `go${pins.goVersion}`, GOMAXPROCS: option('--jobs', '4') };
const version = await command(go, ['version'], { env, capture: true });
if (!version.startsWith(`go version go${pins.goVersion} `)) throw new Error(`Expected Go ${pins.goVersion}, received ${version}`);
const buildTime = '2026-09-30T19:34:22.000000000+00:00';
const metadataPrefix = 'github.com/moby/moby/v2/dockerversion';
const ldflags = ['-s', '-w', '-buildid=', '-X', `${metadataPrefix}.Version=${pins.dockerVersion}`, '-X', `${metadataPrefix}.GitCommit=${pins.moby.revision.slice(0, 7)}`, '-X', `${metadataPrefix}.BuildTime=${buildTime}`, '-X', `"${metadataPrefix}.PlatformName=EnoughFactory Source Build"`].join(' ');
const platforms = architecture === 'all' ? ['arm64', 'x64'] : [architecture];
const manifest = { formatVersion: 1, dockerVersion: pins.dockerVersion, source: pins.moby, goVersion: pins.goVersion, sourceArchive, daemonBuild: pins.daemonBuild, artifacts: [] };
for (const target of platforms) {
  const targetOutput = join(output, target); await mkdir(targetOutput, { recursive: true });
  const buildEnv = { ...env, GOOS: 'linux', GOARCH: target === 'x64' ? 'amd64' : 'arm64', CGO_ENABLED: '0' };
  for (const name of ['dockerd', 'docker-proxy']) {
    const destination = join(targetOutput, name);
    // Moby's exact source archive includes its complete vendored dependency tree.
    const argv = ['build', '-mod=vendor', '-trimpath', `-p=${env.GOMAXPROCS}`, '-tags', pins.daemonBuild.tags.join(','), '-ldflags', ldflags, '-o', destination, `./cmd/${name}`];
    await command(go, argv, { cwd: source, env: buildEnv });
    const metadata = await command(go, ['version', '-m', destination], { env, capture: true });
    if (!metadata.includes('\tbuild\tCGO_ENABLED=0')) throw new Error(`Unexpected cgo in ${destination}`);
    await writeFile(`${destination}.go-build.txt`, `${metadata}\n`);
    manifest.artifacts.push({ name, platform: `linux-${target}`, file: destination, sha256: hash(await readFile(destination)), command: { executable: go, args: argv, environment: { GOOS: buildEnv.GOOS, GOARCH: buildEnv.GOARCH, CGO_ENABLED: '0', GOTOOLCHAIN: env.GOTOOLCHAIN } }, metadataFile: `${destination}.go-build.txt` });
  }
}
await writeFile(join(output, 'go-engine-provenance.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Source-pinned Go engine artifacts: ${output}`);
