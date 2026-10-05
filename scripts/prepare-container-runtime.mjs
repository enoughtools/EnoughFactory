import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, rm, chmod, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function sourceEngine(arch, version) {
  const kit = join(root, 'runtime/container/relink-kit');
  const build = resolve(process.env.ENOUGHFACTORY_CONTAINER_BUILD_DIR ?? join(root, '.cache/container-engine-build'));
  const nativePins = JSON.parse(await readFile(join(kit, 'native-pins.json'), 'utf8'));
  const goPins = JSON.parse(await readFile(join(kit, 'sources.json'), 'utf8'));
  let goManifest, nativeManifest;
  try {
    goManifest = JSON.parse(await readFile(join(build, 'go-engine-provenance.json'), 'utf8'));
    nativeManifest = JSON.parse(await readFile(join(build, 'native-build-manifest.json'), 'utf8'));
  } catch { /* Build the verified pinned source below. */ }
  if (!nativeManifest?.builds?.some(row => (row.architecture ?? row.arch) === arch)) {
    execFileSync('python3', [join(kit, 'build-native.py'), '--arch', arch, '--jobs', '4', '--work', join(root, '.cache/container-engine-work', arch), '--cache', join(root, '.cache/container-engine-sources'), '--output', build], { cwd: root, stdio: 'inherit' });
    nativeManifest = JSON.parse(await readFile(join(build, 'native-build-manifest.json'), 'utf8'));
  }
  if (!goManifest?.artifacts?.some(row => row.platform === `linux-${arch}` && row.name === 'dockerd')) {
    execFileSync(process.execPath, [join(kit, 'build-go-engine.mjs'), '--architecture', arch, '--jobs', '4', '--go', join(nativeManifest.toolchains.go.directory, 'bin/go'), '--cache', join(root, '.cache/container-engine-sources'), '--output', build], { cwd: root, stdio: 'inherit' });
    goManifest = JSON.parse(await readFile(join(build, 'go-engine-provenance.json'), 'utf8'));
  }
  if (goManifest.source?.revision !== goPins.moby.revision || goManifest.source?.sha256 !== goPins.moby.sha256 || goManifest.daemonBuild?.cgoEnabled !== false || nativeManifest.inputs?.runc?.sha256 !== nativePins.runc.sha256 || nativeManifest.inputs?.libseccomp?.sha256 !== nativePins.libseccomp.sha256 || nativeManifest.inputs?.tini?.sha256 !== nativePins.tini.sha256) throw new Error('Container source-build inputs do not match the pinned release recipes');
  const native = nativeManifest.builds.find(row => (row.architecture ?? row.arch) === arch);
  const components = [];
  for (const name of ['dockerd', 'docker-proxy', 'runc', 'docker-init']) {
    const file = join(build, arch, name); const digest = hash(await readFile(file));
    const expected = ['dockerd', 'docker-proxy'].includes(name) ? goManifest.artifacts.find(row => row.name === name && row.platform === `linux-${arch}`)?.sha256 : native.binaries?.[name]?.sha256;
    if (!expected || digest !== expected) throw new Error(`Container source-built ${name} digest does not match its retained build manifest`);
    components.push({ name, sha256: digest, source: name === 'runc' ? 'runc/libseccomp' : name === 'docker-init' ? 'tini' : 'moby', buildMode: ['dockerd', 'docker-proxy'].includes(name) ? 'CGO_ENABLED=0' : name === 'runc' ? 'static musl, seccomp enabled' : 'static musl' });
  }
  const sourceArtifact = resolve(process.env.ENOUGHFACTORY_CONTAINER_SOURCE_ARTIFACT ?? join(build, `EnoughFactory-${version}-container-sources.tar.gz`));
  let receipt;
  try { receipt = JSON.parse(await readFile(`${sourceArtifact}.json`, 'utf8')); } catch { /* Assemble exact source and retained relink objects below. */ }
  const covers = () => Array.isArray(receipt?.artifacts) && components.every(component => receipt.artifacts.some(row => row.name === component.name && row.platform === `linux-${arch}` && row.sha256 === component.sha256));
  if (!covers()) {
    execFileSync(process.execPath, [join(kit, 'create-source-artifact.mjs'), '--build-output', build, '--cache', join(root, '.cache/container-source-companion'), '--output', sourceArtifact], { cwd: root, stdio: 'inherit' });
    receipt = JSON.parse(await readFile(`${sourceArtifact}.json`, 'utf8'));
  }
  const sourceHash = hash(await readFile(sourceArtifact));
  if (!covers() || sourceHash !== receipt.archiveSha256) throw new Error('The container source/relink companion does not cover the actual packaged binaries');
  return { build, components, sources: { moby: goPins.moby, runc: nativePins.runc, libseccomp: nativePins.libseccomp, tini: nativePins.tini }, differences: goPins.daemonBuild.differencesFromUpstreamStatic, sourceArtifact, sourceHash };
}

/** Pinned OSS tools only. This never invokes or installs a host Docker engine. */
export async function prepareContainerRuntime(platform, arch, destination) {
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported managed container runtime target');
  const pins = JSON.parse(await readFile(join(root, 'runtime/container/pins.json'), 'utf8'));
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('A valid product version is required for runtime source companions');
  const built = await sourceEngine(arch, version);
  const cache = join(root, '.cache/container-archives');
  await mkdir(cache, { recursive: true });
  await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true });
  const selected = [`docker-${platform}-${arch}`, ...(platform === 'darwin' ? [`lima-darwin-${arch}`, `docker-linux-${arch}`] : [`rootless-linux-${arch}`])];
  const archives = [];
  for (const key of selected) {
    const pin = pins.archives[key]; const archive = join(cache, `${key}-${pin.sha256.slice(0, 16)}.tgz`);
    let bytes; try { bytes = await readFile(archive); } catch {
      const response = await fetch(pin.url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`Failed to fetch bundled ${key}: ${response.status}`);
      if (Number(response.headers.get('content-length')) > 200 * 1024 * 1024) throw new Error('Managed runtime archive exceeds expected size');
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) { await rm(archive, { force: true }); throw new Error(`Managed runtime checksum mismatch: ${key}`); }
    await writeFile(archive, bytes);
    if (platform === 'darwin' && key.startsWith('docker-linux-')) {
      const staging = join(cache, `${key}-source-built`); await rm(staging, { recursive: true, force: true }); await mkdir(staging);
      execFileSync('tar', ['-xzf', archive, '-C', staging]);
      for (const component of built.components) await cp(join(built.build, arch, component.name), join(staging, 'docker', component.name));
      execFileSync('tar', ['-czf', join(destination, 'docker/guest-engine.tgz'), '-C', staging, 'docker']);
      await rm(staging, { recursive: true, force: true });
    } else {
      const staging = join(cache, `${key}-unpacked`); await rm(staging, { recursive: true, force: true }); await mkdir(staging);
      execFileSync('tar', ['-xzf', archive, '-C', staging]);
      if (key.startsWith('lima-')) {
        // Keep upstream signed host binaries, guest agents, helpers and notices.
        await cp(staging, join(destination, 'lima'), { recursive: true, dereference: true });
      } else {
        const folder = key.startsWith('rootless-') ? 'docker-rootless-extras' : 'docker';
        await mkdir(join(destination, 'docker/bin'), { recursive: true });
        for (const file of await readdir(join(staging, folder))) { await cp(join(staging, folder, file), join(destination, 'docker/bin', file)); await chmod(join(destination, 'docker/bin', file), 0o755); }
      }
      await rm(staging, { recursive: true, force: true });
    }
    archives.push({ component: key, ...pin });
  }
  if (platform === 'linux') for (const component of built.components) { await cp(join(built.build, arch, component.name), join(destination, 'docker/bin', component.name)); await chmod(join(destination, 'docker/bin', component.name), 0o755); }
  if (platform === 'darwin') {
    const image = pins.images[arch]; const file = join(cache, `ubuntu-24.04-${arch}-${image.sha256.slice(0, 16)}.img`);
    let bytes; try { bytes = await readFile(file); } catch {
      console.log('Preparing the pinned Linux guest image for the desktop bundle.');
      const response = await fetch(image.url, { signal: AbortSignal.timeout(600_000) });
      if (!response.ok) throw new Error(`Failed to fetch bundled Linux guest: ${response.status}`);
      if (Number(response.headers.get('content-length')) > 2_000_000_000) throw new Error('Guest image exceeds its expected size');
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) { await rm(file, { force: true }); throw new Error('Bundled Linux guest image checksum mismatch'); }
    await writeFile(file, bytes); await mkdir(join(destination, 'images'), { recursive: true }); await cp(file, join(destination, 'images/guest.img'));
  }
  const sourceFile = `sources/EnoughFactory-${version}-${platform}-${arch}-container-sources.tar.gz`;
  const sourceCompanion = { file: sourceFile, sha256: built.sourceHash, receiptFile: `${sourceFile}.json` };
  await mkdir(join(destination, 'sources'), { recursive: true }); await cp(built.sourceArtifact, join(destination, sourceCompanion.file)); await cp(`${built.sourceArtifact}.json`, join(destination, sourceCompanion.receiptFile));
  const engineProvenance = { formatVersion: 1, architecture: arch, version: pins.dockerVersion, sources: built.sources, components: built.components, differences: built.differences, sourceCompanion };
  await writeFile(join(destination, 'engine-provenance.json'), `${JSON.stringify(engineProvenance, null, 2)}\n`);
  const engineSourceBuild = { file: 'engine-provenance.json', sha256: hash(await readFile(join(destination, 'engine-provenance.json'))) };
  const engineArchive = platform === 'darwin' ? { file: 'docker/guest-engine.tgz', sha256: hash(await readFile(join(destination, 'docker/guest-engine.tgz'))) } : undefined;
  await writeFile(join(destination, 'provenance.json'), `${JSON.stringify({ product: 'EnoughFactory managed container runtime', platform, arch, dockerVersion: pins.dockerVersion, limaVersion: platform === 'darwin' ? pins.limaVersion : undefined, archives, engineSourceBuild, engineArchive, sourceCompanion, guestImage: platform === 'darwin' ? { ...pins.images[arch], bundled: true, path: 'images/guest.img' } : undefined }, null, 2)}\n`);
  await cp(join(root, 'runtime/container/pins.json'), join(destination, 'pins.json'));
  console.log(`Prepared EnoughFactory's private ${platform}/${arch} container runtime.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform = process.platform, arch = process.arch, destination = join(root, '.cache/container-runtime', `${platform}-${arch}`)] = process.argv.slice(2);
  await prepareContainerRuntime(platform, arch, resolve(destination));
}
