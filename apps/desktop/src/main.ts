import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, WebContentsView, type IpcMainInvokeEvent, type Rectangle } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectExistingService, probeDeviceConnection, type DeviceConnection } from './service-connection.ts';
import { finishIdleServiceHandoff, prepareServiceUpdate, type ServiceUpdateStatus } from './service-update.ts';

type Connection = DeviceConnection;
interface PreviewOptions { sessionId: string; url: string; bounds?: Rectangle }
interface PreviewGrant { id: string; proxyUrl: string; url: string; proxyAuth?: { username: string; password: string } }
interface Preview { view: WebContentsView; grant: PreviewGrant; window?: BrowserWindow; owner: BrowserWindow; sessionId: string; popups: Set<BrowserWindow> }

const repository = resolve(__dirname, '../../..');
const dataDirectory = resolve(process.env.ENOUGHFACTORY_HOME ?? join(homedir(), '.enoughfactory'));
const resources = app.isPackaged ? process.resourcesPath : repository;
const development = process.argv.includes('--dev') || Boolean(process.env.ENOUGHFACTORY_DEV_URL);
const developmentUrl = process.env.ENOUGHFACTORY_DEV_URL ?? 'http://127.0.0.1:4318';
const uiFile = app.isPackaged ? join(resources, 'web/index.html') : join(repository, 'apps/web/dist/index.html');
const expectedServiceVersion = (() => {
  if (!app.isPackaged) return JSON.parse(readFileSync(join(repository, 'apps/device/package.json'), 'utf8')).version as string;
  const provenance = JSON.parse(readFileSync(join(resources, 'bundle-provenance.json'), 'utf8')) as { version: string; localUpdate?: { serviceVersion?: string } };
  return provenance.localUpdate?.serviceVersion ?? provenance.version;
})();
const trustedUi = development ? new URL(developmentUrl).origin : pathToFileURL(uiFile).href;
const executablePath = [...new Set([
  ...(process.env.PATH ?? '').split(delimiter),
  join(homedir(), '.local/bin'), join(homedir(), '.docker/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
].filter(Boolean))].join(delimiter);
let mainWindow: BrowserWindow | undefined;
let connectionPromise: Promise<Connection> | undefined;
let updateJob: Promise<void> | undefined;
let updateTimer: ReturnType<typeof setTimeout> | undefined;
let handoffJob: Promise<Connection | undefined> | undefined;
let stoppingDesktop = false;
let preview: Preview | undefined;
let previewGeneration = 0;
let proxyConfiguration: Promise<unknown> = Promise.resolve();
let previewCleanup: Promise<void> = Promise.resolve();
const previewContents = new Map<number, PreviewGrant>();

app.setName('EnoughFactory');
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
app.setPath('userData', join(dataDirectory, 'desktop'));

function readConnection(): Connection | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDirectory, 'connection.json'), 'utf8'));
    if (!value || typeof value !== 'object') return;
    const candidate = value as Connection;
    const address = new URL(candidate.url);
    if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) || typeof candidate.token !== 'string' || candidate.token.length < 16) return;
    return candidate;
  } catch { return; }
}

async function availableConnection(requireManagedRuntime = true): Promise<Connection | undefined> {
  const candidate = readConnection();
  if (!candidate) return;
  return probeDeviceConnection(candidate, { serviceVersion: expectedServiceVersion, stateDirectory: dataDirectory, requireManagedRuntime });
}

function existingService(): Promise<Connection | undefined> {
  return connectExistingService({ readConnection, probe: candidate => probeDeviceConnection(candidate, { serviceVersion: expectedServiceVersion, stateDirectory: dataDirectory }), portOpen: servicePortOpen });
}

async function serviceResources(): Promise<string> {
  if (!app.isPackaged) return resources;
  // AppImage mounts disappear when the GUI exits. Every on-demand daemon gets
  // stable resources, even when the user has not enabled login startup.
  const provenance = await readFile(join(resources, 'bundle-provenance.json'));
  const identity = createHash('sha256').update(provenance).digest('hex').slice(0, 24);
  const directory = join(dataDirectory, 'runtime');
  const destination = join(directory, `${app.getVersion()}-${identity}`);
  try { await access(join(destination, '.ready')); return destination; } catch { /* Prepare this installed bundle once. */ }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(directory, '.prepare-'));
  try {
    for (const folder of ['runtime', 'device', 'envmux', 'web', 'workspaces', 'agents', 'notices', 'install']) await cp(join(resources, folder), join(staging, folder), { recursive: true });
    await cp(join(resources, 'bundle-provenance.json'), join(staging, 'bundle-provenance.json'));
    await writeFile(join(staging, '.ready'), `${identity}\n`, { mode: 0o600 });
    await rename(staging, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return destination;
}

async function startOrConnectService(preparedResources?: string): Promise<Connection> {
  const running = await existingService();
  if (running) return running;
  const durable = preparedResources ?? await serviceResources();
  // Another opener or a waking service may become ready while its resources copy.
  const recovered = await existingService();
  if (recovered) return recovered;
  const node = app.isPackaged ? join(durable, 'runtime/node') : (process.env.ENOUGHFACTORY_NODE ?? 'node');
  const device = app.isPackaged ? join(durable, 'device/service.cjs') : join(repository, 'apps/device/dist/service.cjs');
  if (!existsSync(device)) throw new Error('The device service is missing. Build the workspace before opening EnoughFactory.');
  const logPath = join(dataDirectory, 'device.log');
  const log = openSync(logPath, 'a', 0o600);
  let launchError: Error | undefined;
  try {
    const child = spawn(node, [device], {
      cwd: dataDirectory, detached: true, stdio: ['ignore', log, log],
      env: {
        ...process.env,
        PATH: executablePath,
        ENOUGHFACTORY_HOME: dataDirectory,
        ENOUGHFACTORY_PORT: process.env.ENOUGHFACTORY_PORT ?? '4317',
        ENOUGHFACTORY_RESOURCES: app.isPackaged ? durable : undefined,
        ENOUGHFACTORY_REPO: app.isPackaged ? undefined : repository,
        ENOUGHFACTORY_CONTAINER_ASSETS: app.isPackaged ? join(durable, 'runtime/container')
          : (process.env.ENOUGHFACTORY_CONTAINER_ASSETS ?? join(repository, '.cache/container-runtime', `${process.platform}-${process.arch}`)),
        ENOUGHFACTORY_WEB_PATH: app.isPackaged ? join(durable, 'web') : join(repository, 'apps/web/dist'),
        ENOUGHFACTORY_ENVMUX_PATH: app.isPackaged ? join(durable, 'envmux/envmux')
          : (process.env.ENOUGHFACTORY_ENVMUX_PATH ?? join(repository, 'artifacts/envmux', `${process.platform === 'darwin' ? 'osx' : 'linux'}-${process.arch}`, 'envmux')),
      },
    });
    child.once('error', error => { launchError = error; });
    child.unref();
  } finally { closeSync(log); }
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (launchError) throw new Error(`The device service could not start: ${launchError.message}`);
    const ready = await availableConnection();
    if (ready) return ready;
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(`The device service did not become ready. Its startup details are in ${logPath}.`);
}

function getConnection(): Promise<Connection> {
  if (handoffJob) return handoffJob.then(connection => connection ?? startOrConnectService());
  connectionPromise ??= startOrConnectService().then(connection => { scheduleServiceUpdate(connection); return connection; }).finally(() => { connectionPromise = undefined; });
  return connectionPromise;
}

async function servicePortOpen(connection: Connection): Promise<boolean> {
  const url = new URL(connection.url);
  return await new Promise<boolean>(resolveOpen => {
    const socket = createConnection({ host: url.hostname === '[::1]' ? '::1' : url.hostname, port: Number(url.port || 80) });
    let finished = false;
    const finish = (open: boolean) => { if (finished) return; finished = true; socket.destroy(); resolveOpen(open); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(700, () => finish(true));
  });
}

async function idleUpdateStatus(connection: Connection): Promise<ServiceUpdateStatus | undefined> {
  const response = await fetch(`${connection.url}/api/service/update-status`, {
    headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(2_000),
  });
  if (response.status === 404 || response.status === 405) return undefined;
  if (!response.ok) throw new Error('The device service could not confirm whether its current work has finished.');
  const status = await response.json() as ServiceUpdateStatus;
  return status.idleShutdown === true && typeof status.canUpdate === 'boolean' ? status : undefined;
}

async function replaceIdleService(existing: Connection, durable: string): Promise<Connection | undefined> {
  if (stoppingDesktop) return undefined;
  handoffJob = finishIdleServiceHandoff({
    async shutdown() {
      let response: Response;
      try {
        response = await fetch(`${existing.url}/api/service/shutdown`, {
          method: 'POST', headers: { Authorization: `Bearer ${existing.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ onlyIfIdle: true, expectedVersion: existing.version }), signal: AbortSignal.timeout(5_000),
        });
      } catch { return 'unknown'; }
      if (response.status === 409) return 'busy';
      if (!response.ok) throw new Error('The device service did not accept its safe automatic update. Current work was left connected.');
      return 'accepted';
    },
    portOpen: () => servicePortOpen(existing), current: () => availableConnection(), closePreview,
    start: () => startOrConnectService(durable),
  });
  try { return await handoffJob; } finally { handoffJob = undefined; }
}

function scheduleServiceUpdate(connection: Connection, delay = 0): void {
  if (stoppingDesktop || updateJob || updateTimer) return;
  updateTimer = setTimeout(() => {
    updateTimer = undefined;
    let preparedResources: string | undefined;
    updateJob = prepareServiceUpdate(connection, {
      targetVersion: expectedServiceVersion,
      stage: async () => { preparedResources = await serviceResources(); return preparedResources; },
      current: async () => {
        const running = await existingService();
        // An accepted shutdown can lose its HTTP response. Once its saved port
        // is confirmed closed, recover by launching the staged independent daemon.
        return running ?? (stoppingDesktop ? undefined : await startOrConnectService(preparedResources));
      },
      inspect: idleUpdateStatus, replace: replaceIdleService,
    }).then(result => {
      const changed = result.connection && (result.state === 'updated' || result.connection.version !== connection.version || result.connection.url !== connection.url || result.connection.token !== connection.token);
      if (changed && result.connection && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('factory:connection-changed', { ...result.connection, appVersion: app.getVersion() });
      if (result.state === 'busy' || (result.state === 'deferred' && !result.connection)) scheduleServiceUpdateAfterJob(result.connection ?? connection);
    }).catch(error => {
      // Keep the workspace connected and retry later; update errors never stop workers.
      if (process.env.ENOUGHFACTORY_DEBUG) console.error('Device service update deferred:', error instanceof Error ? error.message : String(error));
      scheduleServiceUpdateAfterJob(connection);
    }).finally(() => { updateJob = undefined; });
  }, delay);
  updateTimer.unref();
}

function scheduleServiceUpdateAfterJob(connection: Connection): void {
  if (stoppingDesktop || updateTimer) return;
  updateTimer = setTimeout(() => { updateTimer = undefined; scheduleServiceUpdate(connection); }, 15_000);
  updateTimer.unref();
}

async function restartDeviceService(): Promise<Connection> {
  // Opening/reloading the UI never authorizes terminating a live daemon.
  const connection = await getConnection();
  scheduleServiceUpdate(connection);
  return connection;
}

function assertFactorySender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('This operation belongs to the EnoughFactory workbench.');
  const address = event.senderFrame?.url;
  const trusted = address && (development ? new URL(address).origin === trustedUi : address.split('#')[0].split('?')[0] === trustedUi);
  if (!trusted) throw new Error('The workbench connection is unavailable.');
}

function webUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a valid web address.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS address without embedded credentials.');
  return url.href;
}

function previewBounds(value: unknown, owner: BrowserWindow): Rectangle {
  if (!value || typeof value !== 'object') throw new Error('The preview position is missing.');
  const bounds = value as Rectangle;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(number => typeof number === 'number' && Number.isFinite(number))) throw new Error('The preview position is invalid.');
  const [width, height] = owner.getContentSize();
  const x = Math.max(0, Math.min(width, Math.round(bounds.x)));
  const y = Math.max(0, Math.min(height, Math.round(bounds.y)));
  return { x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width))), height: Math.max(0, Math.min(height - y, Math.round(bounds.height))) };
}

async function deviceRequest<T>(path: string, method: string, body?: unknown, timeout = 15_000): Promise<T> {
  const connection = path === '/api/service/shutdown' ? await availableConnection(false)
    : method === 'DELETE' && path.startsWith('/api/previews/') ? readConnection() : await getConnection();
  if (!connection) throw new Error('The device service is unavailable.');
  const response = await fetch(`${connection.url}${path}`, {
    method, headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    const text = await response.text();
    let reason = text;
    try { reason = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* Keep a useful upstream message. */ }
    throw new Error(reason || `The device returned ${response.status}.`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

async function closePreview(invalidate = true): Promise<void> {
  if (invalidate) previewGeneration++;
  const current = preview;
  preview = undefined;
  if (!current) { await previewCleanup; return; }
  previewContents.delete(current.view.webContents.id);
  for (const popup of current.popups) if (!popup.isDestroyed()) { previewContents.delete(popup.webContents.id); popup.destroy(); }
  if (!current.owner.isDestroyed()) current.owner.contentView.removeChildView(current.view);
  if (!current.view.webContents.isDestroyed()) current.view.webContents.close();
  if (current.window && !current.window.isDestroyed()) current.window.destroy();
  previewCleanup = Promise.all([
    previewCleanup,
    deviceRequest(`/api/previews/${encodeURIComponent(current.grant.id)}`, 'DELETE', undefined, 3_000).catch(() => undefined),
  ]).then(() => undefined);
  await previewCleanup;
}

async function openPreview(options: PreviewOptions): Promise<void> {
  if (!mainWindow || typeof options?.sessionId !== 'string' || !options.sessionId) throw new Error('Choose a running session for this preview.');
  const url = webUrl(options.url);
  if (options.bounds) previewBounds(options.bounds, mainWindow);
  const generation = ++previewGeneration;
  await closePreview(false);
  const grant = await deviceRequest<PreviewGrant>(`/api/sessions/${encodeURIComponent(options.sessionId)}/desktop-preview`, 'POST', { url });
  if (generation !== previewGeneration || !mainWindow || mainWindow.isDestroyed()) {
    await deviceRequest(`/api/previews/${encodeURIComponent(grant.id)}`, 'DELETE').catch(() => undefined);
    return;
  }
  const proxy = new URL(grant.proxyUrl);
  if (proxy.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(proxy.hostname)) throw new Error('The session preview proxy is unavailable.');
  const partition = `persist:preview-${createHash('sha256').update(options.sessionId).digest('hex').slice(0, 24)}`;
  const isolated = session.fromPartition(partition);
  // Chromium proxy changes are asynchronous. Serialize them so an older
  // navigation cannot leave a newer preview pointing at its retired grant.
  const configured = proxyConfiguration.catch(() => undefined).then(async () => {
    if (generation !== previewGeneration) return false;
    await isolated.setProxy({ mode: 'fixed_servers', proxyRules: grant.proxyUrl, proxyBypassRules: '<-loopback>' });
    await isolated.closeAllConnections();
    return generation === previewGeneration && Boolean(mainWindow && !mainWindow.isDestroyed());
  });
  proxyConfiguration = configured;
  if (!await configured) {
    await deviceRequest(`/api/previews/${encodeURIComponent(grant.id)}`, 'DELETE').catch(() => undefined);
    return;
  }
  isolated.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  const view = new WebContentsView({ webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  view.webContents.setWindowOpenHandler(({ url: destination }) => {
    try { webUrl(destination); } catch { return { action: 'deny' }; }
    return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: undefined } } };
  });
  view.webContents.on('will-navigate', (event, destination) => {
    try { webUrl(destination); } catch { event.preventDefault(); }
  });
  view.webContents.on('did-fail-load', (_event, code, description, destination, isMainFrame) => {
    if (isMainFrame && code !== -3) mainWindow?.webContents.send('factory:preview-status', { sessionId: options.sessionId, status: 'failed', error: description, url: destination });
  });
  view.webContents.on('did-finish-load', () => mainWindow?.webContents.send('factory:preview-status', { sessionId: options.sessionId, status: 'ready', url: view.webContents.getURL() }));
  let owner = mainWindow;
  let separate: BrowserWindow | undefined;
  if (!options.bounds) {
    separate = new BrowserWindow({ width: 1120, height: 760, title: 'EnoughFactory — Preview', parent: mainWindow, backgroundColor: '#f7f5f0', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    owner = separate;
  }
  owner.contentView.addChildView(view);
  const current: Preview = { view, grant, owner, window: separate, sessionId: options.sessionId, popups: new Set() };
  preview = current;
  previewContents.set(view.webContents.id, grant);
  view.webContents.on('did-create-window', popup => {
    current.popups.add(popup);
    const popupId = popup.webContents.id;
    previewContents.set(popupId, grant);
    popup.on('closed', () => { current.popups.delete(popup); previewContents.delete(popupId); });
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.on('will-navigate', (event, destination) => { try { webUrl(destination); } catch { event.preventDefault(); } });
  });
  view.setBounds(options.bounds ? previewBounds(options.bounds, owner) : { x: 0, y: 0, width: owner.getContentSize()[0], height: owner.getContentSize()[1] });
  if (separate) {
    separate.on('resize', () => { const [width, height] = separate!.getContentSize(); view.setBounds({ x: 0, y: 0, width, height }); });
    separate.on('closed', () => { if (preview === current) void closePreview(); });
  }
  try { await view.webContents.loadURL(webUrl(grant.url ?? url)); }
  catch (error) {
    if (preview === current) { await closePreview(); throw error; }
    // Closing or replacing a preview aborts its navigation intentionally.
  }
}

app.on('login', (event, contents, _details, authentication, respond) => {
  const grant = contents ? previewContents.get(contents.id) : undefined;
  if (!grant || !authentication.isProxy || !grant.proxyAuth) return;
  const proxy = new URL(grant.proxyUrl);
  if (authentication.host !== proxy.hostname || authentication.port !== Number(proxy.port)) return;
  event.preventDefault();
  respond(grant.proxyAuth.username, grant.proxyAuth.password);
});

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); return; }
  mainWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 980, minHeight: 650,
    title: 'EnoughFactory', backgroundColor: '#f7f5f0', show: false,
    icon: app.isPackaged ? join(resources, 'icon.png') : join(repository, 'apps/desktop/assets/icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (app.commandLine.hasSwitch('enoughfactory-verify-desktop')) {
      const window = mainWindow!;
      void verifyNativeWindow(window).catch(error => { console.error('Desktop verification failed:', error); app.exit(1); });
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { try { void shell.openExternal(webUrl(url)); } catch { /* Ignore unsupported URL schemes. */ } return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (event, destination) => {
    const allowed = development ? new URL(destination).origin === trustedUi : destination.split('#')[0].split('?')[0] === trustedUi;
    if (!allowed) { event.preventDefault(); try { void shell.openExternal(webUrl(destination)); } catch { /* Keep the workbench on its own origin. */ } }
  });
  mainWindow.on('closed', () => { void closePreview(); mainWindow = undefined; });
  if (development) void mainWindow.loadURL(developmentUrl);
  else void mainWindow.loadFile(uiFile).catch(error => dialog.showErrorBox('EnoughFactory could not open', `${error.message}\nBuild the shared web app before opening the desktop bundle.`));
}

async function verifyNativeWindow(window: BrowserWindow): Promise<void> {
  const output = process.env.ENOUGHFACTORY_GUI_VERIFICATION_RECEIPT;
  if (!app.isPackaged || !output || app.commandLine.hasSwitch('no-sandbox') || app.commandLine.hasSwitch('disable-sandbox')) throw new Error('Native desktop verification requires a packaged application with Chromium sandbox enabled.');
  await getConnection();
  await new Promise(resolveWait => setTimeout(resolveWait, 3_000));
  if (window.isDestroyed() || !window.isVisible() || window.webContents.isDestroyed()) throw new Error('The native workbench did not render.');
  const contentDeadline = Date.now() + 10_000;
  while (!await window.webContents.executeJavaScript("Boolean(document.querySelector('#root main'))")) {
    if (Date.now() >= contentDeadline) throw new Error('The shared workbench did not mount in the native renderer.');
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  const rendererPid = window.webContents.getOSProcessId();
  let rendererSandbox: { enabled: true; seccomp?: number; noNewPrivileges?: true };
  if (process.platform === 'linux') {
    const status = await readFile(`/proc/${rendererPid}/status`, 'utf8');
    if (!/^Seccomp:\s+2$/m.test(status) || !/^NoNewPrivs:\s+1$/m.test(status)) throw new Error('The rendered workbench process lacks the Chromium seccomp sandbox.');
    rendererSandbox = { enabled: true, seccomp: 2, noNewPrivileges: true };
  } else {
    if (!app.getAppMetrics().some(metric => metric.pid === rendererPid && metric.sandboxed === true)) throw new Error('The rendered workbench process lacks its OS sandbox.');
    rendererSandbox = { enabled: true };
  }
  const screenshot = (await window.webContents.capturePage()).toPNG();
  if (!screenshot.length) throw new Error('The native workbench produced no rendered frame.');
  const provenanceBytes = await readFile(join(resources, 'bundle-provenance.json'));
  const provenance = JSON.parse(provenanceBytes.toString('utf8')) as { sourceCommit: string };
  await writeFile(`${output}.png`, screenshot);
  await writeFile(output, `${JSON.stringify({ formatVersion: 1, product: 'EnoughFactory', suite: 'desktop-gui', status: 'passed', platform: process.platform, arch: process.arch, sourceCommit: provenance.sourceCommit, bundleProvenanceSha256: createHash('sha256').update(provenanceBytes).digest('hex'), rendererSandbox, screenshotSha256: createHash('sha256').update(screenshot).digest('hex'), checks: ['packaged Electron starts with Chromium sandbox enabled', 'shared workbench mounts in the isolated native renderer', 'isolated native workbench renders a visible frame', 'bundled independent device service answers authenticated health'] }, null, 2)}\n`);
  app.quit();
}

function installBridge(): void {
  ipcMain.handle('factory:connection', async event => { assertFactorySender(event); const { url, token, version } = await getConnection(); return { url, token, version, appVersion: app.getVersion() }; });
  ipcMain.handle('factory:service-restart', async event => { assertFactorySender(event); const { url, token, version } = await restartDeviceService(); return { url, token, version, appVersion: app.getVersion() }; });
  ipcMain.handle('factory:directory', async event => {
    assertFactorySender(event);
    const result = await dialog.showOpenDialog(mainWindow!, { title: 'Choose a project repository', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('factory:external', async (event, url) => { assertFactorySender(event); await shell.openExternal(webUrl(url)); });
  ipcMain.handle('factory:preview-open', async (event, options) => { assertFactorySender(event); await openPreview(options as PreviewOptions); });
  ipcMain.handle('factory:preview-close', async event => { assertFactorySender(event); await closePreview(); });
  ipcMain.handle('factory:preview-bounds', (event, bounds) => { assertFactorySender(event); if (preview && !preview.window) preview.view.setBounds(previewBounds(bounds, preview.owner)); });
  ipcMain.handle('factory:preview-navigation', (event, action) => {
    assertFactorySender(event);
    if (!preview) return;
    if (action === 'back' && preview.view.webContents.navigationHistory.canGoBack()) preview.view.webContents.navigationHistory.goBack();
    if (action === 'forward' && preview.view.webContents.navigationHistory.canGoForward()) preview.view.webContents.navigationHistory.goForward();
    if (action === 'reload') preview.view.webContents.reload();
  });
  ipcMain.handle('factory:service-shutdown', async event => {
    assertFactorySender(event);
    await closePreview();
    await deviceRequest('/api/service/shutdown', 'POST');
    connectionPromise = undefined;
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { void app.whenReady().then(createWindow); });
  app.whenReady().then(() => {
    installBridge();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: 'EnoughFactory', submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }] : []),
      { label: 'File', submenu: [{ label: 'Open workbench', accelerator: 'CmdOrCtrl+N', click: createWindow }, { type: 'separator' }, { role: 'close' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
      { role: 'help', submenu: [{ label: 'EnoughFactory', click: () => { void shell.openExternal('https://factory.enoughtools.com'); } }, { label: 'Open device logs', click: () => { void shell.openPath(dataDirectory); } }] },
    ]));
    createWindow();
  }).catch(error => { dialog.showErrorBox('EnoughFactory could not open', error instanceof Error ? error.message : String(error)); app.quit(); });
  app.on('activate', createWindow);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  let quitting = false;
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stoppingDesktop = true;
    if (updateTimer) { clearTimeout(updateTimer); updateTimer = undefined; }
    // Once an idle handoff is accepted, finish launching its independent daemon
    // before this process exits. Staging or waiting never keeps the desktop open.
    void (async () => { if (handoffJob) await handoffJob.catch(() => {}); await closePreview(); })().finally(() => app.quit());
  });
}
