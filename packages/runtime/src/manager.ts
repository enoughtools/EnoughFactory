import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { MacRuntime } from './mac.ts';
import { LinuxRuntime } from './linux.ts';
import type { ContainerRuntimeStatus, DockerRuntimeEndpoint, RuntimeOptions, RuntimeProgress } from './types.ts';

export interface ManagedRuntimeManagerOptions {
  dataDir: string; resourcesDirectory?: string;
  onStatus?: (status: ContainerRuntimeStatus) => void;
}
export class ManagedRuntimeManager {
  readonly endpoint: DockerRuntimeEndpoint;
  readonly dataDirectory: string;
  private readonly assetsDirectory: string;
  private backend: MacRuntime | LinuxRuntime;
  private limits = { cpus: 4, memoryGiB: 4, diskGiB: 40 };
  private loaded?: Promise<void>;
  private settingsError?: string;
  private starting?: Promise<DockerRuntimeEndpoint>;
  constructor(private readonly options: ManagedRuntimeManagerOptions) {
    this.dataDirectory = resolve(options.dataDir);
    const source = resolve(process.env.ENOUGHFACTORY_REPO ?? process.cwd());
    this.assetsDirectory = resolve(options.resourcesDirectory ?? process.env.ENOUGHFACTORY_CONTAINER_ASSETS ?? (process.env.ENOUGHFACTORY_RESOURCES ? join(process.env.ENOUGHFACTORY_RESOURCES, 'runtime/container') : join(source, '.cache/container-runtime', `${process.platform}-${process.arch}`)));
    this.backend = this.makeBackend(); this.endpoint = this.backend.endpoint();
  }
  private makeBackend(): MacRuntime | LinuxRuntime {
    const options: RuntimeOptions = { stateDirectory: this.dataDirectory, assetsDirectory: this.assetsDirectory, cpuCount: this.limits.cpus, memoryGiB: this.limits.memoryGiB, diskGiB: this.limits.diskGiB, onProgress: progress => this.options.onStatus?.(this.publicProgress(progress)) };
    if (process.platform === 'darwin') return new MacRuntime(options);
    if (process.platform === 'linux') return new LinuxRuntime(options);
    throw new Error('EnoughFactory’s managed container runtime currently supports Mac and Linux.');
  }
  private async load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      if (process.platform !== 'darwin') return;
      try { const saved = JSON.parse(await readFile(join(this.dataDirectory, 'container/settings.json'), 'utf8')); this.validate(saved); this.limits = saved; this.backend = this.makeBackend(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.settingsError = `Runtime resource settings could not be read: ${error instanceof Error ? error.message : String(error)}. Save valid resource settings in Settings to repair this configuration.`; }
    })();
    await this.loaded;
  }
  private publicProgress(progress: RuntimeProgress): ContainerRuntimeStatus {
    const states: Record<RuntimeProgress['phase'], ContainerRuntimeStatus['state']> = { missing: 'unavailable', unsupported: 'unavailable', stopped: 'stopped', starting: 'starting', ready: 'ready', stopping: 'stopping', error: 'failed' };
    return { kind: process.platform === 'darwin' ? 'lima' : 'rootless', state: states[progress.phase], socketPath: this.endpoint.host.slice(7), stateDirectory: this.dataDirectory, dataDirectory: this.backend instanceof MacRuntime ? this.backend.storageDirectory() : join(this.dataDirectory, 'docker/data'), phase: progress.message,
      ...(process.platform === 'darwin' ? this.limits : {}), artifactFsSupported: process.platform === 'darwin' };
  }
  async status(): Promise<ContainerRuntimeStatus> {
    await this.load();
    if (this.settingsError) return { ...this.publicProgress({ phase: 'error', message: 'Runtime resource settings need repair' }), error: this.settingsError, requiredActions: [{ label: 'Repair runtime resources', detail: this.settingsError }] };
    const status = await this.backend.status();
    return { ...this.publicProgress(status), version: process.platform === 'darwin' ? '2.2.1' : '29.8.2', dockerVersion: status.version, error: status.error,
      requiredActions: status.prerequisites?.map(detail => ({ label: 'Complete container runtime setup', detail,
        ...(status.phase === 'missing' && !process.env.ENOUGHFACTORY_RESOURCES ? { command: 'pnpm runtime:prepare' } : {}) })) };
  }
  async start(): Promise<DockerRuntimeEndpoint> {
    if (this.starting) return this.starting;
    this.starting = (async () => { await this.load(); if (this.settingsError) throw new Error(this.settingsError); return await this.backend.start(); })();
    try { return await this.starting; } finally { this.starting = undefined; }
  }
  async ensureReady(): Promise<DockerRuntimeEndpoint> { return await this.start(); }
  async stop(): Promise<void> { if (this.starting) await this.starting.catch(() => {}); await this.load(); await this.backend.stop(); }
  async prepareWorkspace(path: string): Promise<void> {
    const inside = relative(this.dataDirectory, resolve(path));
    if (inside === '..' || inside.startsWith('../') || inside.startsWith('/')) throw new Error('Container bind inputs must live in EnoughFactory’s private application workspace directory.');
    await this.ensureReady(); if ('prepareWorkspace' in this.backend) await this.backend.prepareWorkspace(path);
  }
  async configure(limits: { cpus: number; memoryGiB: number; diskGiB: number }): Promise<ContainerRuntimeStatus> {
    if (process.platform !== 'darwin') throw new Error('Linux runs its own rootless engine directly. VM resource limits apply only to the Mac runtime; goal concurrency remains configurable on Linux.');
    await this.load(); this.validate(limits);
    const status = await this.status(); if (status.state === 'ready' || status.state === 'starting' || status.state === 'stopping') throw new Error('Stop the private container runtime before changing its resources.');
    await (this.backend as MacRuntime).configure({ cpuCount: limits.cpus, memoryGiB: limits.memoryGiB, diskGiB: limits.diskGiB });
    await mkdir(join(this.dataDirectory, 'container'), { recursive: true, mode: 0o700 });
    const pending = join(this.dataDirectory, `container/settings.${process.pid}.pending`);
    await writeFile(pending, `${JSON.stringify(limits)}\n`, { mode: 0o600 }); await rename(pending, join(this.dataDirectory, 'container/settings.json'));
    this.limits = { ...limits }; this.settingsError = undefined;
    return await this.status();
  }
  private validate(value: { cpus: number; memoryGiB: number; diskGiB: number }) {
    if (!Number.isInteger(value.cpus) || value.cpus < 1 || value.cpus > 64 || !Number.isInteger(value.memoryGiB) || value.memoryGiB < 2 || value.memoryGiB > 512 || !Number.isInteger(value.diskGiB) || value.diskGiB < 20 || value.diskGiB > 4096) throw new Error('Choose 1–64 CPUs, 2–512 GiB memory and 20–4096 GiB disk.');
  }
  /** Guest Docker's host-gateway is the VM, so Lima supplies its host gateway. */
  bridgeHostAddress(): string | undefined { return process.platform === 'darwin' ? '192.168.5.2' : '10.0.2.1'; }
}
