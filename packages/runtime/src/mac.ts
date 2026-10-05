import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, realpath, lstat, chmod } from 'node:fs/promises';
import { join, resolve, relative, delimiter } from 'node:path';
import { dockerInfo } from './docker.ts';
import type { DockerRuntimeEndpoint, RuntimeOptions, RuntimeStatus, RuntimeProgress } from './types.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Apple Virtualization.framework, using only the application's Lima home. */
export class MacRuntime {
  private readonly home: string;
  private readonly owner: string;
  private phase?: RuntimeProgress;
  private starting?: Promise<DockerRuntimeEndpoint>;
  constructor(private options: RuntimeOptions) {
    this.options = { ...options, stateDirectory: resolve(options.stateDirectory), assetsDirectory: resolve(options.assetsDirectory) };
    this.owner = createHash('sha256').update(this.options.stateDirectory).digest('hex').slice(0, 24);
    const normal = join(this.options.stateDirectory, 'container', 'lima');
    // macOS Unix sockets are short; Lima resolves symlinks, so a symlink alias
    // cannot solve this. A private persistent directory keeps VM disks intact.
    this.home = Buffer.byteLength(join(normal, 'factory/sock/docker.sock')) <= 100 ? normal : join('/Users/Shared', `.enoughfactory-runtime-${process.getuid?.() ?? 501}-${this.owner}`, 'lima');
  }
  storageDirectory(): string { return this.home; }
  endpoint(): DockerRuntimeEndpoint { return { host: `unix://${join(this.home, 'factory/sock/docker.sock')}`, cliPath: join(this.options.assetsDirectory, 'docker/bin/docker'), configDirectory: join(this.options.stateDirectory, 'docker/config') }; }
  private progress(phase: RuntimeProgress['phase'], message: string) { this.phase = { phase, message }; this.options.onProgress?.(this.phase); }
  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, LIMA_HOME: this.home, LIMA_INSTANCE: 'factory' };
    delete env.DOCKER_CONTEXT; delete env.DOCKER_HOST; delete env.LIMA_SSH_PORT;
    env.PATH = `${join(this.options.assetsDirectory, 'lima/bin')}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`;
    return env;
  }
  private async command(args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return await new Promise((accept, reject) => {
      const child = spawn(join(this.options.assetsDirectory, 'lima/bin/limactl'), args, { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Private container runtime did not finish before its deadline; inspect runtime diagnostics.')); }, timeoutMs);
      child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-100_000); });
      child.stderr.on('data', chunk => {
        const text = chunk.toString(); stderr = (stderr + text).slice(-20_000);
        if (args[0] === 'start') {
          const description = /download/i.test(text) ? 'Preparing the verified Linux runtime image' : /Waiting|ready|boot/i.test(text) ? 'Starting EnoughFactory’s private Linux runtime' : 'Preparing the private container engine';
          this.progress('starting', description);
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); accept({ code: code ?? 1, stdout, stderr }); });
    });
  }
  async status(): Promise<RuntimeStatus> {
    const base = { kind: 'lima-vz' as const, managed: true as const, endpoint: this.endpoint() };
    if (!existsSync(this.endpoint().cliPath) || !existsSync(join(this.options.assetsDirectory, 'lima/bin/limactl')) || !existsSync(join(this.options.assetsDirectory, 'docker/guest-engine.tgz')) || !existsSync(join(this.options.assetsDirectory, 'images/guest.img'))) {
      return { ...base, phase: 'missing', message: 'The bundled container runtime is missing', prerequisites: ['Prepare the verified EnoughFactory runtime assets, or reinstall the desktop bundle.'] };
    }
    try {
      const info = await dockerInfo(this.endpoint());
      if (!info.Labels?.includes(`enoughfactory.owner=${this.owner}`) || !info.Labels.includes('enoughfactory.managed=true')) {
        return { ...base, phase: 'error', message: 'The runtime socket does not belong to this EnoughFactory installation', error: 'Docker ownership labels did not match. No containers were accessed.' };
      }
      return { ...base, phase: 'ready', message: 'EnoughFactory’s private container engine is ready', version: info.ServerVersion };
    } catch { /* A stopped daemon's forwarded socket may still exist. */ }
    if (this.starting || this.phase?.phase === 'stopping') return { ...base, ...this.phase! };
    const result = await this.command(['list', '--json', 'factory'], 10_000).catch(() => undefined);
    const vm = result?.code === 0 ? result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(item => item.name === 'factory') : undefined;
    if (vm?.status === 'Running') return { ...base, phase: 'error', message: 'The private VM is running but its container engine is unavailable', error: this.phase?.phase === 'error' ? this.phase.message : 'Docker did not answer on the app-owned socket. Restart the runtime or inspect its guest logs.' };
    return { ...base, phase: this.phase?.phase === 'error' ? 'error' : 'stopped', message: this.phase?.phase === 'error' ? this.phase.message : 'EnoughFactory’s private container engine is stopped', error: this.phase?.phase === 'error' ? this.phase.message : undefined };
  }
  async start(): Promise<DockerRuntimeEndpoint> {
    if (this.starting) return this.starting;
    this.starting = this.startOwned();
    try { return await this.starting; } finally { this.starting = undefined; }
  }
  private async startOwned(): Promise<DockerRuntimeEndpoint> {
    const status = await this.status(); if (status.phase === 'ready') return this.endpoint();
    if (status.message.includes('socket does not belong')) throw new Error(status.error ?? status.message);
    if (status.phase === 'missing') throw new Error(status.message);
    this.progress('starting', 'Preparing EnoughFactory’s private container runtime');
    try {
      if (this.home.startsWith('/Users/Shared/')) {
        const parent = resolve(this.home, '..'); await mkdir(parent, { recursive: true, mode: 0o700 });
        const metadata = await lstat(parent);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw new Error('The short runtime directory is not owned by this user. It was left untouched.');
        await chmod(parent, 0o700);
      }
      await mkdir(this.home, { recursive: true, mode: 0o700 }); await mkdir(this.endpoint().configDirectory, { recursive: true, mode: 0o700 });
      await mkdir(join(this.options.stateDirectory, 'container'), { recursive: true, mode: 0o700 });
      await writeFile(join(this.options.stateDirectory, 'container/runtime-location.json'), `${JSON.stringify({ kind: 'lima', directory: this.home })}\n`, { mode: 0o600 });
      for (const path of this.sharedDirectories()) await mkdir(path, { recursive: true, mode: 0o700 });
      const configuration = join(this.home, 'factory/lima.yaml');
      if (!existsSync(configuration)) {
        const template = join(this.options.stateDirectory, 'container/factory.yaml');
        await writeFile(template, `${JSON.stringify(await this.configuration(), null, 2)}\n`, { mode: 0o600 });
        const created = await this.command(['create', '--tty=false', '--name=factory', template], 180_000);
        if (created.code) throw new Error(created.stderr || 'The private Linux VM could not be created');
      } else {
        const listed = await this.command(['list', '--json', 'factory'], 10_000);
        const vm = listed.code === 0 ? listed.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(item => item.name === 'factory') : undefined;
        if (vm?.status !== 'Running') {
          // A stopped VM adopts the installed bundle's owned assets on its next
          // boot. Running work is never restarted merely by opening a new app.
          const next = await this.configuration();
          const expression = `.mounts = ${JSON.stringify(next.mounts)} | .provision = ${JSON.stringify(next.provision)} | .probes = ${JSON.stringify(next.probes)}`;
          const edited = await this.command(['edit', '--tty=false', '--set', expression, 'factory']);
          if (edited.code) throw new Error(edited.stderr || 'The private runtime could not adopt its updated bundled resources');
        }
      }
      const result = await this.command(['start', '--tty=false', 'factory'], 15 * 60_000);
      if (result.code) throw new Error(result.stderr || 'The private Linux VM could not start');
      const deadline = Date.now() + 30_000;
      do { const result = await this.status(); if (result.phase === 'ready') { this.progress('ready', result.message); return this.endpoint(); } await sleep(250); } while (Date.now() < deadline);
      throw new Error('The private VM started but its owned Docker socket did not become ready');
    } catch (error) { this.progress('error', error instanceof Error ? error.message : String(error)); throw error; }
  }
  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {});
    const status = await this.status(); if (status.phase === 'stopped' || status.phase === 'missing') return;
    this.progress('stopping', 'Stopping EnoughFactory’s private container runtime');
    const result = await this.command(['stop', '--tty=false', 'factory'], 120_000);
    if (result.code) { this.progress('error', result.stderr || 'Private runtime stop failed'); throw new Error(result.stderr || 'Private runtime stop failed'); }
    this.progress('stopped', 'EnoughFactory’s private container engine is stopped');
  }
  async prepareWorkspace(path: string): Promise<void> {
    const directory = await realpath(path);
    const roots = await Promise.all(this.sharedDirectories().map(root => realpath(root)));
    if (!roots.some(root => { const inside = relative(root, directory); return inside !== '..' && !inside.startsWith('../') && !inside.startsWith('/'); })) throw new Error('Container bind inputs must live in EnoughFactory’s private workspace-data, worker-source or container/shared directory.');
  }
  private sharedDirectories(): string[] { return ['workspace-data', 'worker-source', 'container/shared'].map(path => join(this.options.stateDirectory, path)); }
  async configure(limits: { cpuCount: number; memoryGiB: number; diskGiB: number }): Promise<void> {
    const status = await this.status(); if (status.phase === 'ready' || this.starting) throw new Error('Stop the private runtime before changing its resources.');
    if (limits.diskGiB < (this.options.diskGiB ?? 40)) throw new Error('The private runtime disk can be expanded but cannot be shrunk.');
    this.options = { ...this.options, ...limits };
    if (existsSync(join(this.home, 'factory/lima.yaml'))) {
      const expression = `.cpus = ${limits.cpuCount} | .memory = "${limits.memoryGiB}GiB" | .disk = "${limits.diskGiB}GiB"`;
      const edited = await this.command(['edit', '--tty=false', '--set', expression, 'factory']);
      if (edited.code) throw new Error(edited.stderr || 'Private runtime resource settings could not be saved');
    }
  }
  private async configuration(): Promise<Record<string, unknown>> {
    const pins = JSON.parse(await readFile(join(this.options.assetsDirectory, 'pins.json'), 'utf8'));
    const image = pins.images[process.arch]; if (!image) throw new Error('This Mac architecture does not have a bundled private runtime');
    const engine = quote(join(this.options.assetsDirectory, 'docker/guest-engine.tgz'));
    const daemon = { hosts: ['unix:///run/enoughfactory/docker.sock'], 'data-root': '/var/lib/enoughfactory/docker', 'exec-root': '/run/enoughfactory/docker', pidfile: '/run/enoughfactory/docker.pid', group: 'enoughfactory', labels: ['enoughfactory.managed=true', `enoughfactory.owner=${this.owner}`], features: { 'containerd-snapshotter': false } };
    const script = `#!/bin/bash\nset -eu\nmkdir -p /usr/local/lib/enoughfactory/docker /etc/enoughfactory /var/lib/enoughfactory/docker\nsystemctl stop enoughfactory-docker.service 2>/dev/null || true\ntar -xzf ${engine} -C /usr/local/lib/enoughfactory\ncp /usr/local/lib/enoughfactory/docker/* /usr/local/bin/\nmodprobe fuse\nif ! command -v iptables >/dev/null; then export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y iptables; fi\ncat >/etc/enoughfactory/docker.json <<'ENOUGHFACTORY_DOCKER'\n${JSON.stringify(daemon)}\nENOUGHFACTORY_DOCKER\ncat >/etc/systemd/system/enoughfactory-docker.service <<'ENOUGHFACTORY_UNIT'\n[Unit]\nDescription=EnoughFactory private container engine\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=notify\nRuntimeDirectory=enoughfactory\nExecStart=/usr/local/bin/dockerd --config-file /etc/enoughfactory/docker.json\nRestart=always\nDelegate=yes\nKillMode=process\nLimitNOFILE=1048576\nTasksMax=infinity\n[Install]\nWantedBy=multi-user.target\nENOUGHFACTORY_UNIT\nsystemctl daemon-reload\nsystemctl enable --now enoughfactory-docker.service\n`;
    return {
      minimumLimaVersion: '2.2.1', vmType: 'vz', mountType: 'virtiofs', arch: image.arch,
      images: [{ location: join(this.options.assetsDirectory, 'images/guest.img'), arch: image.arch, digest: `sha256:${image.sha256}` }],
      cpus: this.options.cpuCount ?? 4, memory: `${this.options.memoryGiB ?? 4}GiB`, disk: `${this.options.diskGiB ?? 40}GiB`,
      containerd: { system: false, user: false }, user: { name: 'enoughfactory', uid: process.getuid?.() ?? 501 },
      mounts: [...this.sharedDirectories().map(location => ({ location, writable: true })), { location: this.options.assetsDirectory, writable: false }],
      provision: [{ mode: 'system', script }],
      probes: [{ mode: 'readiness', script: '#!/bin/sh\nset -eu\n/usr/local/bin/docker --host unix:///run/enoughfactory/docker.sock info >/dev/null\n', hint: 'The bundled container engine must start before EnoughFactory creates an environment.' }],
      hostResolver: { enabled: true, hosts: { 'host.docker.internal': 'host.lima.internal' } },
      portForwards: [{ guestSocket: '/run/enoughfactory/docker.sock', hostSocket: '{{.Dir}}/sock/docker.sock' }],
      message: 'EnoughFactory private runtime is ready. No Docker context was created or changed.',
    };
  }
}
