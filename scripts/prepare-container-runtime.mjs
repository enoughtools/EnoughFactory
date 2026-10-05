import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, rm, chmod, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Pinned OSS tools only. This never invokes or installs a host Docker engine. */
export async function prepareContainerRuntime(platform, arch, destination) {
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported managed container runtime target');
  const pins = JSON.parse(await readFile(join(root, 'runtime/container/pins.json'), 'utf8'));
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
      await cp(archive, join(destination, 'docker/guest-engine.tgz'));
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
  await writeFile(join(destination, 'provenance.json'), `${JSON.stringify({ product: 'EnoughFactory managed container runtime', platform, arch, dockerVersion: pins.dockerVersion, limaVersion: platform === 'darwin' ? pins.limaVersion : undefined, archives, guestImage: platform === 'darwin' ? { ...pins.images[arch], bundled: true, path: 'images/guest.img' } : undefined }, null, 2)}\n`);
  await cp(join(root, 'runtime/container/pins.json'), join(destination, 'pins.json'));
  console.log(`Prepared EnoughFactory's private ${platform}/${arch} container runtime.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform = process.platform, arch = process.arch, destination = join(root, '.cache/container-runtime', `${platform}-${arch}`)] = process.argv.slice(2);
  await prepareContainerRuntime(platform, arch, resolve(destination));
}
