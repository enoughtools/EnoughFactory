import { createHash, randomInt, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ArtifactStore } from '@enoughfactory/workspaces';
import { dockerInvocation, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { prepareBrowserImage, verifyBrowserImage, browserMcpArguments, BROWSER_PROBE_ENVIRONMENT, type PreparedBrowserImage } from './image.ts';
import { MCP_FETCH_SCRIPT, runBrowserDocker, type BrowserDockerRunner } from './docker.ts';
import { retainBrowserResult } from './evidence.ts';
import { BrowserInspectionError, validateBrowserViewport, type BrowserCallOptions, type BrowserLease, type BrowserObservation, type BrowserSessionIdentity, type BrowserToolDefinition, type BrowserToolResult } from './types.ts';

interface Container { Id: string; Name: string; State: { Running: boolean }; Config: { Labels?: Record<string, string>; Image?: string }; HostConfig?: { NetworkMode?: string; PortBindings?: unknown }; Image?: string; }
interface RpcResponse { status: number; sessionId?: string; errorText?: string; message?: { id?: number; result?: unknown; error?: { code: number; message: string } }; }
const labels = { managed: 'enoughfactory.managed', owner: 'enoughfactory.owner', kind: 'enoughfactory.browser.kind', id: 'enoughfactory.browser.id', author: 'enoughfactory.browser.author', identity: 'enoughfactory.browser.identity', recipe: 'enoughfactory.browser.recipe' } as const;
const safeId = (value: string) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value)) throw new BrowserInspectionError('Invalid browser session identity.', 'INVALID_IDENTITY'); return value; };
const fullId = (value: string) => /^[a-f0-9]{64}$/.test(value);
const now = () => new Date().toISOString();
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const readOnlyTool = (tool: string, args: Record<string, unknown>) => ['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests'].includes(tool) || tool === 'browser_tabs' && args.action === 'list';

export interface BrowserInspectionOptions {
  endpoint: DockerRuntimeEndpoint;
  /** A private app-owned directory. Browser binaries are shared images, never stored here. */
  dataDir: string;
  artifacts?: Pick<ArtifactStore, 'put'>;
  onRecord?: (record: BrowserLease) => void | Promise<void>;
  idleTimeoutMs?: number;
  /** Explicit seams for focused ownership and recovery tests. */
  runDocker?: BrowserDockerRunner;
  prepareImage?: (endpoint: DockerRuntimeEndpoint, options: { signal?: AbortSignal; onProgress?: (message: string) => void }) => Promise<PreparedBrowserImage>;
  verifyImage?: (endpoint: DockerRuntimeEndpoint, image: PreparedBrowserImage) => Promise<PreparedBrowserImage>;
}

/** Service-owned browser sessions. No Electron or host GUI is involved. */
export class BrowserInspectionManager {
  private readonly root: string;
  private readonly endpoint: DockerRuntimeEndpoint;
  private readonly run: BrowserDockerRunner;
  private readonly owner: string;
  private readonly artifacts: Pick<ArtifactStore, 'put'>;
  private preparations = new Map<string, { identity: string; work: Promise<BrowserLease>; controller: AbortController }>();
  private retirements = new Map<string, Promise<BrowserLease>>();
  private actions = new Map<string, AbortController>();
  private writes = new Map<string, Promise<void>>();
  private sequence = 0;
  constructor(private readonly options: BrowserInspectionOptions) {
    dockerInvocation(options.endpoint, []);
    this.endpoint = Object.freeze({ ...options.endpoint }); this.root = resolve(options.dataDir);
    this.run = options.runDocker ?? runBrowserDocker;
    this.owner = createHash('sha256').update(resolve(dirname(dirname(this.endpoint.configDirectory)))).digest('hex').slice(0, 24);
    this.artifacts = options.artifacts ?? new ArtifactStore(join(this.root, 'artifacts'), 'browser-local');
  }
  private async storage(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entry = await lstat(this.root);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) throw new BrowserInspectionError('Browser state requires a private owned directory.', 'INVALID_STORAGE');
  }
  private filename(id: string) { return join(this.root, `${safeId(id)}.json`); }
  private validateIdentity(identity: BrowserSessionIdentity) {
    validateBrowserViewport(identity.viewport);
    for (const id of [identity.id, identity.sessionId, identity.attemptId, identity.goalId, identity.taskId].filter((value): value is string => value !== undefined)) safeId(id);
    safeId(identity.authorContainerId);
    if (!Number.isSafeInteger(identity.authorityGeneration) || identity.authorityGeneration < 1) throw new BrowserInspectionError('A positive authority generation is required.', 'INVALID_IDENTITY');
    if (identity.source?.commit && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(identity.source.commit) || identity.source?.snapshotSha256 && !/^[a-f0-9]{64}$/.test(identity.source.snapshotSha256)) throw new BrowserInspectionError('Browser source identity is invalid.', 'INVALID_IDENTITY');
  }
  private identity(record: BrowserSessionIdentity) { return { id: record.id, sessionId: record.sessionId, attemptId: record.attemptId, goalId: record.goalId, taskId: record.taskId, authorContainerId: record.authorContainerId, authorityGeneration: record.authorityGeneration, ...(record.viewport ? { viewport: record.viewport } : {}) }; }
  private identityHash(record: BrowserSessionIdentity) { return createHash('sha256').update(JSON.stringify(this.identity(record))).digest('hex'); }
  private async save(record: BrowserLease, expected?: { states: BrowserLease['state'][]; operationId?: string }): Promise<BrowserLease> {
    const previous = this.writes.get(record.id) ?? Promise.resolve();
    const work = previous.then(async () => {
      await this.storage();
      if (expected) {
        const current = await this.get(record.id);
        if (!expected.states.includes(current.state) || expected.operationId !== undefined && current.operation?.id !== expected.operationId) throw new BrowserInspectionError('The browser action lost its active lease.', 'LEASE_RETIRED', true);
      }
      record = { ...record, updatedAt: now() };
      const temporary = join(this.root, `.lease-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      const file = await open(temporary, 'r'); try { await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.filename(record.id));
      const directory = await open(this.root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      await this.options.onRecord?.(structuredClone(record)); return record;
    });
    const tail = work.then(() => {}, () => {}); this.writes.set(record.id, tail);
    try { return await work; } finally { if (this.writes.get(record.id) === tail) this.writes.delete(record.id); }
  }
  async get(id: string): Promise<BrowserLease> {
    const record = JSON.parse(await readFile(this.filename(id), 'utf8')) as BrowserLease;
    this.validateIdentity(record);
    if (record.version !== 1 || record.id !== id || !fullId(record.authorContainerId) || record.containerId !== undefined && !fullId(record.containerId) || record.name !== `enough-browser-${createHash('sha256').update(record.id).digest('hex').slice(0, 24)}` || !Number.isInteger(record.port) || record.port < 20000 || record.port > 39999 || record.endpoint !== `http://127.0.0.1:${record.port}/mcp`) throw new BrowserInspectionError('Browser lease identity changed.', 'INVALID_LEASE');
    return record;
  }
  private async ownedRuntime(): Promise<void> {
    const result = await this.run(this.endpoint, ['info', '--format', '{{json .}}']);
    if (result.code) throw new BrowserInspectionError('EnoughFactory’s private container runtime is unavailable.', 'RUNTIME_UNAVAILABLE');
    const info = JSON.parse(result.stdout);
    if (info.OSType !== 'linux' || !info.Labels?.includes('enoughfactory.managed=true') || !info.Labels.includes(`enoughfactory.owner=${this.owner}`)) throw new BrowserInspectionError('Browser sessions require this installation’s private container runtime.', 'RUNTIME_OWNERSHIP');
  }
  private async inspect(reference: string): Promise<Container | undefined> {
    safeId(reference);
    const result = await this.run(this.endpoint, ['inspect', '--type', 'container', reference]);
    if (result.code) { if (/no such (object|container)/i.test(result.stderr)) return undefined; throw new BrowserInspectionError('The owned browser container could not be inspected.', 'INSPECTION_FAILED'); }
    const values: Container[] = JSON.parse(result.stdout);
    if (!Array.isArray(values) || values.length !== 1 || !fullId(values[0]!.Id)) throw new BrowserInspectionError('Container identity is ambiguous.', 'INSPECTION_FAILED');
    return values[0];
  }
  private assertSidecar(container: Container, lease: BrowserLease): void {
    const actual = container.Config.Labels;
    const expected = { [labels.managed]: 'true', [labels.owner]: this.owner, [labels.kind]: 'session', [labels.id]: lease.id, [labels.author]: lease.authorContainerId, [labels.identity]: this.identityHash(lease), [labels.recipe]: lease.image.recipeSha256 };
    if (container.Name !== `/${lease.name}` || lease.containerId && container.Id !== lease.containerId || container.HostConfig?.NetworkMode !== `container:${lease.authorContainerId}` || Object.keys(container.HostConfig?.PortBindings ?? {}).length || container.Image !== lease.image.image || !Object.entries(expected).every(([key, value]) => actual?.[key] === value)) throw new BrowserInspectionError('The browser container no longer matches its private lease.', 'CONTAINER_OWNERSHIP');
  }
  private async assertReady(lease: BrowserLease): Promise<void> {
    await this.ownedRuntime();
    const [author, browser] = await Promise.all([this.inspect(lease.authorContainerId), this.inspect(lease.containerId ?? lease.name)]);
    if (!author?.State.Running) throw new BrowserInspectionError('The author environment is unavailable; browser state is retained.', 'AUTHOR_UNAVAILABLE');
    if (!browser) throw new BrowserInspectionError('The browser session is missing; its saved evidence remains available.', 'BROWSER_MISSING');
    this.assertSidecar(browser, lease);
    if (!browser.State.Running) throw new BrowserInspectionError('The browser session stopped; inspect its retained state before replacing it.', 'BROWSER_STOPPED');
  }
  async prepare(identity: BrowserSessionIdentity, options: { signal?: AbortSignal; onProgress?: (message: string) => void; assertCurrent?: () => void } = {}): Promise<BrowserLease> {
    const viewport = validateBrowserViewport(identity.viewport);
    identity = { ...identity, ...(viewport ? { viewport } : {}) };
    this.validateIdentity(identity); options.signal?.throwIfAborted(); options.assertCurrent?.();
    const active = this.preparations.get(identity.id);
    if (active) {
      if (active.identity !== this.identityHash(identity)) throw new BrowserInspectionError('Browser identity belongs to another concurrent attempt.', 'IDENTITY_REUSED');
      const ready = await active.work; options.signal?.throwIfAborted(); options.assertCurrent?.(); return ready;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const work = this.prepareOwned(identity, { ...options, signal: controller.signal });
    const preparation = { identity: this.identityHash(identity), work, controller }; this.preparations.set(identity.id, preparation);
    try { return await work; } finally {
      options.signal?.removeEventListener('abort', abort);
      if (this.preparations.get(identity.id) === preparation) this.preparations.delete(identity.id);
    }
  }
  private async prepareOwned(identity: BrowserSessionIdentity, options: { signal?: AbortSignal; onProgress?: (message: string) => void; assertCurrent?: () => void }): Promise<BrowserLease> {
    await this.ownedRuntime();
    const author = await this.inspect(identity.authorContainerId);
    if (!author?.State.Running || author.Config.Labels?.['envmux.schema'] !== '2' || author.Config.Labels?.['envmux.kind'] !== 'session') throw new BrowserInspectionError('Browser inspection requires the actual running author environment.', 'AUTHOR_UNAVAILABLE');
    identity = { ...identity, authorContainerId: author.Id };
    try {
      const previous = await this.get(identity.id);
      if (this.identityHash(previous) !== this.identityHash(identity)) throw new BrowserInspectionError('Browser identity belongs to another attempt or source generation.', 'IDENTITY_REUSED');
      if (previous.state === 'retired' || previous.state === 'failed') throw new BrowserInspectionError('This browser was retired. Start an explicit new session; the previous profile is unavailable.', 'BROWSER_RETIRED');
      const prepared = await (this.options.verifyImage ?? verifyBrowserImage)(this.endpoint, previous.image);
      if (prepared.image !== previous.image.image) throw new BrowserInspectionError('The prepared browser image changed.', 'IMAGE_CHANGED');
      await this.assertReady(previous);
      if (previous.state === 'busy' && !this.actions.has(previous.id)) return this.save({ ...previous, state: 'unknown', reason: 'The service restarted during a browser action. Observe the current page before continuing.' });
      return previous;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    options.onProgress?.('Preparing shared browser tools');
    let image: PreparedBrowserImage;
    try {
      image = await (this.options.prepareImage ?? prepareBrowserImage)(this.endpoint, options);
      options.signal?.throwIfAborted(); options.assertCurrent?.();
    } catch (error) {
      // This phase cannot allocate the session sidecar. Shared image/probe
      // ownership is separate and remains with its preparation service.
      const failure = new BrowserInspectionError(`Browser tools were not ready before sidecar allocation: ${(error as Error).message}`, 'BROWSER_NOT_ALLOCATED');
      failure.cause = error; throw failure;
    }
    const createdAt = now(), port = randomInt(20000, 40000);
    let lease: BrowserLease = { ...identity, version: 1, name: `enough-browser-${createHash('sha256').update(identity.id).digest('hex').slice(0, 24)}`, image, port, endpoint: `http://127.0.0.1:${port}/mcp`, state: 'preparing', createdAt, updatedAt: createdAt, lastUsedAt: createdAt, idleDeadline: new Date(Date.now() + (this.options.idleTimeoutMs ?? 15 * 60_000)).toISOString(), artifacts: [] };
    lease = await this.save(lease);
    const tag = { [labels.managed]: 'true', [labels.owner]: this.owner, [labels.kind]: 'session', [labels.id]: lease.id, [labels.author]: lease.authorContainerId, [labels.identity]: this.identityHash(lease), [labels.recipe]: image.recipeSha256 };
    options.onProgress?.('Starting an isolated browser');
    try {
      const started = await this.run(this.endpoint, ['run', '-d', '--init', '--name', lease.name, '--network', `container:${lease.authorContainerId}`, '--shm-size', '256m', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', ...Object.entries(BROWSER_PROBE_ENVIRONMENT).flatMap(([key,value])=>['--env',`${key}=${value}`]), '--memory', '768m', '--cpus', '1', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', ...Object.entries(tag).flatMap(([key, value]) => ['--label', `${key}=${value}`]), image.image, ...browserMcpArguments(port, lease.viewport), '--output-max-size', String(64 * 1024 ** 2)], { signal: options.signal, timeoutMs: 30_000 });
      if (started.code) throw new BrowserInspectionError('The isolated browser could not start.', 'BROWSER_START_FAILED');
      const containerId = started.stdout.trim();
      if (!fullId(containerId)) throw new BrowserInspectionError('Browser startup did not confirm its process identity.', 'BROWSER_START_UNKNOWN', true);
      lease = await this.save({ ...lease, containerId });
      let failure: unknown;
      for (let attempt = 0; attempt < 30; attempt++) {
        options.signal?.throwIfAborted(); options.assertCurrent?.();
        try {
          const response = await this.rpc(lease, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'enoughfactory-browser', version: '0.1.0' } }, { signal: options.signal, timeoutMs: 2000 });
          const result = response.message?.result as { protocolVersion?: string } | undefined;
          lease = await this.save({ ...lease, mcpSessionId: response.sessionId, protocolVersion: result?.protocolVersion });
          await this.rpc(lease, 'notifications/initialized', undefined, { signal: options.signal, timeoutMs: 2000 });
          await this.assertReady(lease); options.assertCurrent?.();
          return this.save({ ...lease, state: 'ready', reason: undefined });
        } catch (error) { failure = error; await pause(200); }
      }
      throw failure ?? new BrowserInspectionError('The browser did not become ready.', 'BROWSER_NOT_READY');
    } catch (error) {
      let inspected = false, container: Container | undefined;
      try { container = await this.inspect(lease.containerId ?? lease.name); inspected = true; } catch { /* An unavailable daemon cannot prove that startup had no effect. */ }
      if (container) { this.assertSidecar(container, lease); lease = { ...lease, containerId: container.Id }; }
      await this.save({ ...lease, state: container || !inspected ? 'unknown' : 'failed', reason: 'Browser preparation did not finish. Its owned resources require reconciliation.' });
      if (options.signal?.aborted && container) await this.retireOwned(lease.id).catch(() => {});
      throw error;
    }
  }
  private async rpc(lease: BrowserLease, method: string, params: unknown, options: BrowserCallOptions): Promise<RpcResponse> {
    const timeoutMs = Math.min(120_000, Math.max(500, options.timeoutMs ?? 30_000));
    const request = { jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id: ++this.sequence }), method, ...(params !== undefined ? { params } : {}) };
    const response = await this.run(this.endpoint, ['exec', '-i', '--user', '0', lease.authorContainerId, '/opt/enoughfactory/node/bin/node', '--input-type=module', '-e', MCP_FETCH_SCRIPT], { signal: options.signal, timeoutMs: timeoutMs + 3000, input: JSON.stringify({ url: lease.endpoint, sessionId: lease.mcpSessionId, timeoutMs, request }) });
    if (response.code) throw new BrowserInspectionError('The browser connection ended without confirming the action result.', 'MCP_TRANSPORT_FAILED', true);
    let decoded: RpcResponse;
    try { decoded = JSON.parse(response.stdout); } catch { throw new BrowserInspectionError('The browser returned an invalid response.', 'MCP_INVALID_RESPONSE', true); }
    if (decoded.status < 200 || decoded.status >= 300 || decoded.message?.error) throw new BrowserInspectionError(decoded.message?.error?.message ?? decoded.errorText ?? `Browser MCP returned HTTP ${decoded.status}.`, 'MCP_REQUEST_FAILED', true);
    if (!method.startsWith('notifications/') && decoded.message?.id !== request.id) throw new BrowserInspectionError('The browser response belongs to another action.', 'MCP_IDENTITY_MISMATCH', true);
    return decoded;
  }
  async listTools(id: string, options: BrowserCallOptions = {}): Promise<BrowserToolDefinition[]> {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    const lease = await this.get(id); await this.assertReady(lease);
    const response = await this.rpc(lease, 'tools/list', {}, options);
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    const tools = (response.message?.result as { tools?: BrowserToolDefinition[] })?.tools;
    if (!Array.isArray(tools) || tools.length > 128) throw new BrowserInspectionError('The browser tool catalog is invalid.', 'MCP_INVALID_CATALOG');
    return tools;
  }
  async call(id: string, tool: string, args: Record<string, unknown> = {}, options: BrowserCallOptions = {}): Promise<BrowserObservation> {
    if (!/^browser_[a-z0-9_]{1,64}$/.test(tool)) throw new BrowserInspectionError('Only managed browser tools are supported.', 'INVALID_TOOL');
    if (this.actions.has(id)) throw new BrowserInspectionError('This browser already has an action in progress.', 'BROWSER_BUSY');
    const controller = new AbortController(); this.actions.set(id, controller);
    const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    let lease: BrowserLease | undefined, started = false;
    try {
      lease = await this.get(id);
      controller.signal.throwIfAborted(); options.assertCurrent?.();
      if (options.source) { this.validateIdentity({ ...lease, source: options.source }); lease = { ...lease, source: options.source }; }
      if (lease.state !== 'ready' && !(lease.state === 'unknown' && readOnlyTool(tool, args))) throw new BrowserInspectionError(lease.state === 'unknown' ? 'Observe the current page before taking another action; the previous outcome is uncertain.' : 'This browser session is not ready.', 'BROWSER_NOT_READY');
      await this.assertReady(lease); options.assertCurrent?.(); controller.signal.throwIfAborted();
      const operation = { id: randomUUID(), tool, startedAt: now() };
      lease = await this.save({ ...lease, state: 'busy', operation }, { states: [lease.state] }); started = true;
      const response = await this.rpc(lease, 'tools/call', { name: tool, arguments: args }, { ...options, signal: controller.signal });
      options.assertCurrent?.(); controller.signal.throwIfAborted();
      const latest = await this.get(id);
      if (latest.state !== 'busy' || latest.operation?.id !== operation.id) throw new BrowserInspectionError('The browser action lost its active lease.', 'LEASE_RETIRED', true);
      const result = response.message?.result as BrowserToolResult;
      if (!result || !Array.isArray(result.content)) throw new BrowserInspectionError('Browser tool returned invalid content.', 'MCP_INVALID_CONTENT', true);
      const retained = await retainBrowserResult(result, lease, operation.id, tool, this.artifacts, () => { options.assertCurrent?.(); controller.signal.throwIfAborted(); });
      options.assertCurrent?.();
      const timestamp = now();
      lease = await this.save({ ...lease, state: 'ready', operation: undefined, reason: undefined, artifacts: [...lease.artifacts, ...retained.artifacts], lastUsedAt: timestamp, idleDeadline: new Date(Date.now() + (this.options.idleTimeoutMs ?? 15 * 60_000)).toISOString() }, { states: ['busy'], operationId: operation.id });
      options.assertCurrent?.(); controller.signal.throwIfAborted();
      return { lease, result, ...retained };
    } catch (error) {
      if (started && lease) {
        const latest = await this.get(id);
        if (latest.state === 'busy' && latest.operation?.id === lease.operation?.id || latest.state === 'ready' && lease.state === 'ready') {
          try { await this.save({ ...latest, state: 'unknown', reason: 'The browser action outcome is unconfirmed. Observe the current page before continuing.' }, { states: [latest.state], operationId: latest.operation?.id }); }
          catch (writeError) { if (!(writeError instanceof BrowserInspectionError) || writeError.code !== 'LEASE_RETIRED') throw writeError; }
        }
      }
      throw error;
    } finally { options.signal?.removeEventListener('abort', abort); if (this.actions.get(id) === controller) this.actions.delete(id); }
  }
  /** Restart reconciliation never repeats the interrupted browser action. */
  async reconcile(id?: string): Promise<BrowserLease[]> {
    await this.storage(); await this.ownedRuntime();
    const ids = id ? [safeId(id)] : (await readdir(this.root)).filter(name => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}\.json$/.test(name)).map(name => name.slice(0,-5));
    const records: BrowserLease[] = [];
    for (const identity of ids) {
      let lease = await this.get(identity);
      if (lease.state === 'retired' || lease.state === 'failed') { records.push(lease); continue; }
      if (lease.state === 'retiring') { records.push(await this.retire(lease.id)); continue; }
      const container = await this.inspect(lease.containerId ?? lease.name);
      if (!container) lease = await this.save({ ...lease, state: 'unknown', reason: 'The browser process is missing. Do not assume its previous action failed or silently replace its profile.' }, { states: [lease.state], operationId: lease.operation?.id }).catch(error => {
        if (error instanceof BrowserInspectionError && error.code === 'LEASE_RETIRED') return this.get(lease.id);
        throw error;
      });
      else {
        this.assertSidecar(container, lease);
        if (!container.State.Running || lease.state === 'preparing' || lease.state === 'busy' && !this.actions.has(lease.id)) lease = await this.save({ ...lease, containerId: container.Id, state: 'unknown', reason: 'Browser execution was interrupted. Observe retained state before continuing.' }, { states: [lease.state], operationId: lease.operation?.id }).catch(error => {
          if (error instanceof BrowserInspectionError && error.code === 'LEASE_RETIRED') return this.get(lease.id);
          throw error;
        });
      }
      records.push(lease);
    }
    return records;
  }
  /** Explicit cancellation tears down only this browser; the author remains running. */
  async cancel(id: string): Promise<BrowserLease> { return this.retire(id); }
  async retire(id: string): Promise<BrowserLease> {
    const previous = this.retirements.get(id); if (previous) return previous;
    const work = (async () => {
      this.actions.get(id)?.abort();
      const preparation = this.preparations.get(id);
      let rejectedPreparation = false;
      if (preparation) { preparation.controller.abort(); await preparation.work.catch(() => { rejectedPreparation = true; }); }
      try { return await this.retireOwned(id); }
      catch (error) {
        // Sidecar allocation is strictly after the durable lease write. Only a
        // joined, rejected preparation can prove that this absent journal means
        // cancellation occurred before allocation rather than lost ownership.
        if (rejectedPreparation && (error as NodeJS.ErrnoException).code === 'ENOENT') throw new BrowserInspectionError('Browser preparation was canceled before any sidecar was allocated.', 'BROWSER_NOT_ALLOCATED');
        throw error;
      }
    })();
    this.retirements.set(id, work);
    try { return await work; } finally { if (this.retirements.get(id) === work) this.retirements.delete(id); }
  }
  private async retireOwned(id: string): Promise<BrowserLease> {
    let lease = await this.get(id);
    if (lease.state === 'retired') return lease;
    await this.ownedRuntime();
    this.actions.get(id)?.abort();
    const container = await this.inspect(lease.containerId ?? lease.name);
    if (!container) {
      if (lease.state !== 'retiring') return this.save({ ...lease, state: 'unknown', reason: 'Browser removal was not recorded before the process disappeared.' });
      return this.save({ ...lease, state: 'retired', operation: undefined, reason: 'The browser profile was retired; retained screenshots remain available.' });
    }
    this.assertSidecar(container, lease);
    lease = await this.save({ ...lease, containerId: container.Id, state: 'retiring' });
    const removed = await this.run(this.endpoint, ['rm', '--force', container.Id], { timeoutMs: 30_000 });
    if (removed.code || await this.inspect(container.Id)) { await this.save({ ...lease, state: 'unknown', reason: 'Browser cancellation is unconfirmed. Its reservation remains owned.' }); throw new BrowserInspectionError('Browser removal could not be confirmed.', 'CANCELLATION_UNKNOWN', true); }
    return this.save({ ...lease, state: 'retired', operation: undefined, reason: 'The browser profile was retired; retained screenshots remain available.' });
  }
  async retireIdle(): Promise<BrowserLease[]> {
    const records = await this.reconcile(), retired: BrowserLease[] = [];
    for (const lease of records) if (lease.state === 'ready' && !this.actions.has(lease.id) && Date.parse(lease.idleDeadline) <= Date.now()) retired.push(await this.retire(lease.id));
    return retired;
  }
}
