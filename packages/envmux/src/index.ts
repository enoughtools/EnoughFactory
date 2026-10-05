import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { isIP } from 'node:net';

export const ENVMUX_REVISION = '38914dd0fb49682a062dc17eb3427f6b4f27c5fe';

export interface EnvmuxState {
  project: string; session: string; branch: string; base: string; image: string;
  address: string; instanceName: string; workdir: string; shell: string; domain: string;
  port: number; phase: string; ready: boolean; failed?: string; startedAt: string;
  editor?: string; editorAttach: string; browserPort: number;
  routes: { name: string; port: number; url: string; hostname: string; portal: boolean }[];
  tasks: { name: string; command: string; status: string; state: string; kind: string;
    internal: boolean; runs: number; startedAt?: string; lastLine: string }[];
  services: { name: string; type: string; image: string; host: string; port: number; persist: boolean }[];
  tools: string[];
  log: { at: string; level: string; message: string }[];
}

export interface EnvmuxReady {
  type: 'ready'; version: 1; endpoint: string; token: string; proxy?: string;
  project: string; session: string; instance: string; workdir: string; user: string; branch: string;
  dockerHost: string;
}
export interface EnvmuxLifecycleEvent {
  type: string; version: number; phase?: string; error?: string; exitCode?: number;
  branch?: string; head?: string; commitsAhead?: number; dirtyFiles?: number;
}
export interface DiscoveredSession {
  project: string; session: string; directory: string; branch: string; instance: string; running: boolean;
}
export interface RepositoryStatus {
  branch: string; head: string; base: string;
  entries: { path: string; originalPath?: string; indexStatus: string; workingTreeStatus: string }[];
}
export interface RepositoryDiff { path?: string; staged: boolean; diff: string; truncated: boolean }
export interface DockerRuntimeEndpoint { host: string; cliPath: string; configDirectory: string }
export interface EngineOptions {
  binary?: string; dotnet?: string; dll?: string; workspaceRoot?: string;
  dockerRuntime?: DockerRuntimeEndpoint;
  containerHostAddress?: string;
}
export interface StartOptions {
  projectPath: string; name: string; signal?: AbortSignal;
  workspace?: { bindSource: string; stateVolume: string };
  onEvent?: (event: EnvmuxLifecycleEvent) => void;
  onLog?: (line: string) => void;
  startupTimeoutMs?: number;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function boundedText(text: string, added: string): string { return (text + added).slice(-32_768); }

async function command(program: string, args: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((accept, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${program} did not answer within 30 seconds`)); }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 8 * 1024 * 1024) { child.kill('SIGTERM'); reject(new Error('Envmux command output exceeded its size limit')); }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = boundedText(stderr, chunk.toString()); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); accept({ code: code ?? 1, stdout, stderr }); });
  });
}

/** SSE reader shared by state and task output. It preserves multiline data and cancellation. */
async function* sse(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error('Envmux returned a stream without a body');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let pending = ''; let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
        if (line === '') { if (data.length) { yield data.join('\n'); data = []; } }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (pending.length > 8 * 1024 * 1024) throw new Error('Envmux stream frame exceeded its size limit');
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** The credentials and native endpoint of this object belong only in the device service. */
export class EnvmuxSession {
  readonly id: string;
  readonly name: string;
  readonly projectPath: string;
  readonly ready: EnvmuxReady;
  readonly process?: ChildProcess;
  readonly pid?: number;
  private readonly ended: Promise<number>;

  constructor(options: { ready: EnvmuxReady; projectPath: string; process?: ChildProcess; pid?: number; ended?: Promise<number> }) {
    this.ready = options.ready; this.name = options.ready.session; this.id = options.ready.instance;
    this.projectPath = options.projectPath; this.process = options.process;
    this.pid = options.pid ?? options.process?.pid;
    this.ended = options.ended ?? Promise.resolve(0);
  }

  private redact(text: string): string {
    let clean = text;
    for (const value of [this.ready.token, this.ready.proxy].filter((value): value is string => Boolean(value))) {
      clean = clean.split(value).join('[private]');
    }
    return clean;
  }

  private cleanState(state: EnvmuxState): EnvmuxState {
    return { ...state,
      routes: state.routes.map(route => ({ ...route, url: route.portal ? this.ready.endpoint + '/' : route.url })),
      log: state.log.map(line => ({ ...line, message: this.redact(line.message) })),
    };
  }

  /** Request the pinned engine's API; callers may use additional upstream agent routes. */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith('/api/')) throw new Error('Only engine API routes may be requested');
    const headers = new Headers(init.headers);
    if (this.ready.token) headers.set('authorization', `Bearer ${this.ready.token}`);
    const response = await fetch(new URL(path, this.ready.endpoint), { ...init, headers });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2_048);
      throw new Error(`Envmux ${response.status}: ${this.redact(detail || response.statusText)}`);
    }
    return response;
  }

  async state(): Promise<EnvmuxState> { return this.cleanState(await (await this.request('/api/state')).json() as EnvmuxState); }
  async *events(signal?: AbortSignal): AsyncGenerator<EnvmuxState> {
    for await (const data of sse(await this.request('/api/events', { signal }))) {
      yield this.cleanState(JSON.parse(data) as EnvmuxState);
    }
  }
  async task(name: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
    await this.request(`/api/tasks/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
  }
  async *output(name: string, signal?: AbortSignal): AsyncGenerator<string> {
    for await (const line of sse(await this.request(`/api/tasks/${encodeURIComponent(name)}/output`, { signal }))) yield this.redact(line);
  }
  async logs(name: string): Promise<string> { return this.redact(await (await this.request(`/api/tasks/${encodeURIComponent(name)}/log`)).text()); }
  async repositoryStatus(): Promise<RepositoryStatus> { return await (await this.request('/api/repository/status')).json() as RepositoryStatus; }
  async repositoryDiff(path?: string, staged = false): Promise<RepositoryDiff> {
    const query = new URLSearchParams({ staged: String(staged) }); if (path) query.set('path', path);
    return await (await this.request(`/api/repository/diff?${query}`)).json() as RepositoryDiff;
  }
  async restart(): Promise<void> { await this.request('/api/restart', { method: 'POST' }); }
  async stop(): Promise<void> {
    await this.request('/api/stop', { method: 'POST' });
    if (this.process) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { const code=await Promise.race([this.ended, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Envmux is still returning work; session stop has not finished')), 120_000);
      })]); if(code!==0)throw new Error(`Envmux could not finish returning work (exit ${code}); inspect the retained environment before retrying.`); } finally { if (timer) clearTimeout(timer); }
    } else if (this.pid) {
      // The portal is released before harvesting Git, so a refused connection
      // cannot prove shutdown completed. Reattached sessions retain their PID.
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        try { process.kill(this.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
          throw error;
        }
        await new Promise(accept => setTimeout(accept, 250));
      }
      throw new Error('Envmux is still returning work; session stop has not finished');
    }
  }
  /** For an authenticated service-side WebSocket proxy, never sent to the UI. */
  shellUrl(terminalId: string, tool?: string): string {
    const url = new URL('/api/shell', this.ready.endpoint); url.protocol = 'ws:';
    url.searchParams.set('terminal', terminalId);
    // The engine accepts a bearer header for service clients. This URL contains
    // no token; pass shellHeaders() to the service's WebSocket implementation.
    if (tool) url.searchParams.set('tool', tool);
    return url.toString();
  }
  shellHeaders(): Record<string, string> { return { Authorization: `Bearer ${this.ready.token}` }; }
}

export class EnvmuxEngine {
  private readonly program: string;
  private readonly prefix: string[];
  readonly dockerRuntime?: DockerRuntimeEndpoint;
  private readonly containerHostAddress?: string;
  private capabilityCheck?: Promise<void>;

  constructor(options: EngineOptions = {}) {
    if (options.containerHostAddress && !isIP(options.containerHostAddress)) {
      throw new Error('The managed container bridge requires an explicit IP address');
    }
    this.containerHostAddress = options.containerHostAddress;
    if (options.dockerRuntime) {
      const { host, cliPath, configDirectory } = options.dockerRuntime;
      const socket = host.startsWith('unix://') ? host.slice('unix://'.length) : '';
      if (!socket.startsWith('/') || socket === '/' || socket.split('/').some(part => part === '.' || part === '..')
        || /[\x00-\x1f\x7f]/.test(socket) || !isAbsolute(cliPath) || !isAbsolute(configDirectory)) {
        throw new Error('EnoughFactory requires an explicit managed Unix socket and absolute bundled CLI/config paths');
      }
      this.dockerRuntime = { host, cliPath, configDirectory };
    }
    const root = options.workspaceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const platform = process.platform === 'darwin' ? 'osx' : process.platform;
    const native = join(root, 'artifacts', 'envmux', `${platform}-${process.arch}`, 'envmux');
    const binary = options.binary ?? process.env.ENOUGHFACTORY_ENVMUX_BINARY ?? (existsSync(native) ? native : undefined);
    if (binary) { this.program = binary; this.prefix = []; return; }
    const localDotnet = join(homedir(), '.local/share/enoughfactory/dotnet/dotnet');
    this.program = options.dotnet ?? process.env.ENOUGHFACTORY_DOTNET ?? (existsSync(localDotnet) ? localDotnet : 'dotnet');
    this.prefix = [options.dll ?? process.env.ENOUGHFACTORY_ENVMUX_DLL ?? join(root, 'vendor/envmux/src/Envmux/bin/Release/net10.0/envmux.dll')];
  }

  private requireRuntime(): DockerRuntimeEndpoint {
    if (!this.dockerRuntime) throw new Error('EnoughFactory managed container runtime is not configured');
    return this.dockerRuntime;
  }

  private environment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const name of ['DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION']) delete env[name];
    env.ENVMUX_MANAGED_DOCKER = '1';
    env.ENVMUX_DOCKER_HOST = this.dockerRuntime?.host ?? '';
    env.DOCKER_HOST = this.dockerRuntime?.host ?? '';
    env.DOCKER_CONFIG = this.dockerRuntime?.configDirectory ?? '';
    env.ENVMUX_DOCKER_BRIDGE_HOST = this.containerHostAddress ?? '';
    if (this.dockerRuntime) env.PATH = `${dirname(this.dockerRuntime.cliPath)}${delimiter}${env.PATH ?? ''}`;
    return env;
  }

  private verifyEngineCapability(): Promise<void> {
    this.capabilityCheck ??= (async () => {
      const result = await command(this.program, [...this.prefix, '--factory-capabilities'], undefined, this.environment());
      if (result.code) throw new Error('This Envmux build does not support EnoughFactory managed runtime isolation; install the bundled engine');
      const capabilities = JSON.parse(result.stdout) as { protocolVersion?: number; managedDocker?: boolean };
      if (capabilities.protocolVersion !== 1 || capabilities.managedDocker !== true) {
        throw new Error('This Envmux build does not support EnoughFactory managed runtime isolation');
      }
    })();
    const check = this.capabilityCheck;
    return check.catch(error => {
      if (this.capabilityCheck === check) this.capabilityCheck = undefined;
      throw error;
    });
  }

  async detect(): Promise<{ available: boolean; version?: string; error?: string; docker: { available: boolean; version?: string; error?: string } }> {
    const [engine, docker] = await Promise.allSettled([
      (async () => { await this.verifyEngineCapability(); return await command(this.program, [...this.prefix, '--version'], undefined, this.environment()); })(),
      this.dockerRuntime
        ? command(this.dockerRuntime.cliPath, ['--host', this.dockerRuntime.host, '--config', this.dockerRuntime.configDirectory,
          'info', '--format', '{{.ServerVersion}}'], undefined, this.environment())
        : Promise.reject(new Error('EnoughFactory managed container runtime is not configured')),
    ]);
    const availability = (result: PromiseSettledResult<Awaited<ReturnType<typeof command>>>) => result.status === 'rejected'
      ? { available: false, error: message(result.reason) }
      : result.value.code === 0 ? { available: true, version: result.value.stdout.trim() }
      : { available: false, error: result.value.stderr.trim() || result.value.stdout.trim() };
    return { ...availability(engine), docker: availability(docker) };
  }

  async validate(projectPath: string): Promise<{ valid: boolean; error?: string }> {
    try {
      await this.verifyEngineCapability();
      const result = await command(this.program, [...this.prefix, '-C', projectPath, 'config', 'validate'], undefined, this.environment());
      return result.code === 0 ? { valid: true } : { valid: false, error: result.stderr.trim() || result.stdout.trim() };
    } catch (error) { return { valid: false, error: message(error) }; }
  }
  async discover(projectPath: string): Promise<DiscoveredSession[]> {
    this.requireRuntime();
    await this.verifyEngineCapability();
    const result = await command(this.program, [...this.prefix, '-C', projectPath, 'sessions', '--backend', 'docker'], undefined, this.environment());
    if (result.code) throw new Error(result.stderr.trim() || 'Envmux session discovery failed');
    return JSON.parse(result.stdout) as DiscoveredSession[];
  }

  /** Reconnect to an engine owned by this service before a daemon restart. */
  async attach(options: { ready: EnvmuxReady; projectPath: string; pid?: number }): Promise<EnvmuxSession> {
    const runtime = this.requireRuntime();
    if (options.ready.dockerHost !== runtime.host) {
      throw new Error('Saved Envmux session belongs to a different container runtime; its status remains unknown');
    }
    if (options.pid) {
      try { process.kill(options.pid, 0); }
      catch (error) { throw new Error(`The owning Envmux process is unavailable: ${message(error)}`); }
    }
    const session = new EnvmuxSession({ ready: options.ready, projectPath: options.projectPath, pid: options.pid });
    const state = await session.state();
    if (state.instanceName !== options.ready.instance || state.session !== options.ready.session) {
      throw new Error('Envmux endpoint no longer belongs to the saved session');
    }
    return session;
  }

  async start(options: StartOptions): Promise<EnvmuxSession> {
    const runtime = this.requireRuntime();
    await this.verifyEngineCapability();
    if (options.signal?.aborted) throw new Error('Session startup was canceled');
    if (options.workspace) {
      const identity = /^\/var\/lib\/enoughfactory\/workspaces\/([A-Za-z0-9_-]{1,80})\/repo$/.exec(options.workspace.bindSource)?.[1];
      if (!identity || options.workspace.stateVolume !== `enoughfactory-afs-${identity}`) {
        throw new Error('ArtifactFS workspaces must use a trusted manager-owned mount and matching state volume');
      }
    }
    const child = spawn(this.program, [...this.prefix, '-C', options.projectPath, options.name, '--headless', '--backend', 'docker'], {
      cwd: options.projectPath, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...this.environment(), ENVMUX_BOOTSTRAP_FD: '3',
        ENVMUX_WORKSPACE_BIND: options.workspace?.bindSource ?? '',
        ENVMUX_ARTIFACT_STATE_VOLUME: options.workspace?.stateVolume ?? '',
      },
    });
    const lines = createInterface({ input: child.stdio[3] as Readable });
    let stderr = ''; let ready = false;
    const ended = new Promise<number>(accept => child.once('exit', code => accept(code ?? 1)));
    const forward = (stream: Readable | null) => {
      if (!stream) return;
      createInterface({ input: stream }).on('line', line => {
        stderr = boundedText(stderr, line + '\n'); options.onLog?.(line);
      });
    };
    forward(child.stdout); forward(child.stderr);
    const cancel = () => { child.kill('SIGINT'); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.once('exit', () => options.signal?.removeEventListener('abort', cancel));
    return await new Promise<EnvmuxSession>((accept, reject) => {
      const timer = setTimeout(() => { cancel(); reject(new Error('Envmux startup did not finish before its deadline')); }, options.startupTimeoutMs ?? 30 * 60_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', code => { if (!ready) fail(new Error(stderr.trim() || `Envmux exited during startup (${code ?? 'signal'})`)); });
      lines.on('line', line => {
        try {
          const event = JSON.parse(line) as EnvmuxLifecycleEvent | EnvmuxReady;
          if (event.type === 'ready') {
            if ((event as EnvmuxReady).dockerHost !== runtime.host) {
              cancel(); fail(new Error('Envmux connected to a container runtime outside its managed endpoint')); return;
            }
            const endpoint = new URL((event as EnvmuxReady).endpoint);
            if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:' || !endpoint.port || endpoint.port === '0') {
              cancel(); fail(new Error('Envmux requires its authenticated loopback portal to be enabled')); return;
            }
            ready = true; clearTimeout(timer);
            accept(new EnvmuxSession({ ready: event as EnvmuxReady, projectPath: options.projectPath, process: child, ended }));
          } else {
            options.onEvent?.(event as EnvmuxLifecycleEvent);
            if (event.type === 'error' && !ready) fail(new Error((event as EnvmuxLifecycleEvent).error ?? 'Envmux startup failed'));
          }
        } catch (error) { cancel(); fail(new Error(`Invalid Envmux bootstrap: ${message(error)}`)); }
      });
    });
  }
}
