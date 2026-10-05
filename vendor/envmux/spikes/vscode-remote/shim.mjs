#!/usr/bin/env node
// envmux docker shim — a spike for docs/vscode-remote.md.
//
// Presents a Docker-compatible API on a per-user named pipe (Windows) / unix
// socket, and translates every call the Dev Containers extension makes into an
// Incus REST call against the envmux host. The "container" is an Incus
// instance cloned from the golden snapshot; exec rides the Incus exec
// websockets and is re-framed into Docker's hijacked stream.
//
//   node shim.mjs            # serves \\.\pipe\envmux-docker, logs to shim.log
//   DOCKER_HOST=npipe:////./pipe/envmux-docker docker version

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const envmuxDir = path.join(os.homedir(), '.envmux');
const hostJson = JSON.parse(fs.readFileSync(path.join(envmuxDir, 'host.json'), 'utf8'));
const cert = fs.readFileSync(path.join(envmuxDir, 'envmux-cli.crt'));
const key = fs.readFileSync(path.join(envmuxDir, 'envmux-cli.key'));
const FINGERPRINT = hostJson.fingerprint.replace(/[: ]/g, '').toLowerCase();
const [API_HOST, API_PORT] = (() => {
  const a = hostJson.api.replace(/^https:\/\//i, '').replace(/\/$/, '');
  const i = a.lastIndexOf(':');
  return i < 0 ? [a, 8443] : [a.slice(0, i), Number(a.slice(i + 1))];
})();

const PIPE = process.platform === 'win32'
  ? '\\\\.\\pipe\\envmux-docker'
  : path.join(os.tmpdir(), 'envmux-docker.sock');
const API_VERSION = '1.47';
const ENGINE_VERSION = '27.5.1-envmux';
const GOLDEN = 'envmux-golden/base';
const NETWORK = hostJson.network || 'envmux0';
const STATE_PATH = path.join(here, 'state.json');
const LOG_PATH = path.join(here, 'shim.log');

// ---------------------------------------------------------------- logging

const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
function log(...a) {
  const line = `${new Date().toISOString().slice(11, 23)} ${a.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ---------------------------------------------------------------- incus

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// The client certificate authenticates us; the pinned fingerprint authenticates
// the host. Node only runs checkServerIdentity once chain validation passed, so
// for a self-signed daemon the pin is checked the moment the handshake completes
// and the socket destroyed before anything is written down it.
function pinned(socket) {
  socket.once('secureConnect', () => {
    const presented = socket.getPeerCertificate();
    const fp = presented && presented.raw ? sha256(presented.raw) : '';
    if (fp !== FINGERPRINT) {
      log(`TLS: ${API_HOST} presented ${fp || 'nothing'}, pinned is ${FINGERPRINT}`);
      socket.destroy(new Error('incusd presented a certificate that is not the pinned one'));
    }
  });
  return socket;
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 128 });
agent.createConnection = (options) =>
  pinned(tls.connect({ ...options, host: API_HOST, port: API_PORT, cert, key, rejectUnauthorized: false }));

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = https.request(
      {
        agent, host: API_HOST, port: API_PORT, method, path: p,
        headers: {
          accept: 'application/json',
          ...(data ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'content-length': data.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

class IncusError extends Error {
  constructor(message, code) { super(message); this.code = code; }
  get notFound() { return this.code === 404; }
}

async function incus(method, p, body) {
  const r = await request(method, p, body);
  let j;
  try { j = JSON.parse(r.body.toString('utf8')); } catch {
    throw new IncusError(`${method} ${p} answered ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`, r.status);
  }
  if (j.type === 'error' || j.error_code) throw new IncusError(j.error || `${method} ${p} failed`, j.error_code || r.status);
  return j;
}

const opId = (j) => (j.operation || '').split('/').pop();
const finished = (op) => op.status_code >= 200;

async function settle(j) {
  if (j.type !== 'async') return j.metadata;
  const id = opId(j);
  for (;;) {
    const op = (await incus('GET', `/1.0/operations/${id}/wait?timeout=20`)).metadata;
    if (!finished(op)) continue;
    if (op.status_code !== 200) throw new IncusError(op.err || `operation ended as ${op.status}`, op.status_code);
    return op;
  }
}

function dial(id, secret) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `wss://${API_HOST}:${API_PORT}/1.0/operations/${id}/websocket?secret=${encodeURIComponent(secret)}`,
      { agent },
    );
    ws.binaryType = 'nodebuffer';
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const isRoot = (u) => !u || u === 'root' || u === '0' || u === '0:0';

// One exec. tty → one bidirectional pty socket ("0") + control; otherwise
// three sockets ("0" stdin, "1" stdout, "2" stderr) + control, which is what
// makes Docker's stdout/stderr framing possible at all.
async function execStart(instance, { cmd, env = {}, user, cwd, tty, width = 80, height = 24 }) {
  const account = String(user || '').split(':')[0];
  const command = isRoot(account) ? cmd : ['runuser', '-u', account, '--', ...cmd];
  const environment = { ...env };
  if (!isRoot(account)) {
    environment.HOME ??= `/home/${account}`;
    environment.USER ??= account;
    environment.LOGNAME ??= account;
  }
  if (tty) environment.TERM ??= 'xterm-256color';
  const body = {
    command, environment, 'wait-for-websocket': true, interactive: !!tty, width, height,
    ...(cwd ? { cwd } : {}),
  };
  const j = await incus('POST', `/1.0/instances/${instance}/exec`, body);
  const id = opId(j);
  const fds = j.metadata.metadata.fds;
  const sockets = {};
  for (const k of Object.keys(fds)) sockets[k] = await dial(id, fds[k]);
  return { opId: id, sockets, tty: !!tty };
}

async function execExit(id) {
  for (;;) {
    const op = (await incus('GET', `/1.0/operations/${id}/wait?timeout=20`)).metadata;
    if (!finished(op)) continue;
    const rc = op.metadata && typeof op.metadata.return === 'number' ? op.metadata.return : null;
    return rc ?? (op.status_code === 200 ? 0 : 1);
  }
}

function closeAll(sockets) {
  for (const w of Object.values(sockets)) { try { w.close(); } catch { /* gone */ } }
}

// A one-shot command with its output collected.
async function run(instance, cmd, opts = {}) {
  const ex = await execStart(instance, { cmd, ...opts, tty: false });
  const out = []; const err = [];
  ex.sockets['1'].on('message', (d) => (d.length ? out.push(d) : ex.sockets['1'].close()));
  ex.sockets['2'].on('message', (d) => (d.length ? err.push(d) : ex.sockets['2'].close()));
  await Promise.all([
    new Promise((r) => ex.sockets['1'].once('close', r)),
    new Promise((r) => ex.sockets['2'].once('close', r)),
  ]);
  const code = await execExit(ex.opId);
  closeAll(ex.sockets);
  return { code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') };
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------- state

let state = { containers: {} };
try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { /* first run */ }
const save = () => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
const execs = new Map();

async function instances() {
  return (await incus('GET', '/1.0/instances?recursion=2')).metadata;
}

function addressOf(inst) {
  const eth = inst.state && inst.state.network && inst.state.network.eth0;
  const a = eth && eth.addresses && eth.addresses.find((x) => x.family === 'inet' && x.scope === 'global');
  return a ? a.address : '';
}

// Every instance the shim made is a container; so is every other envmux
// instance, which is what lets `attached-container+…` reach a session.
function containerFor(inst) {
  const known = Object.values(state.containers).find((c) => c.instance === inst.name);
  if (known) return { ...known, inst };
  if (!inst.config || !inst.config['user.envmux.schema']) return null;
  const labels = {};
  for (const [k, v] of Object.entries(inst.config)) if (k.startsWith('user.')) labels[k.slice(5)] = v;
  return {
    id: sha256(inst.name), name: inst.name, instance: inst.name, created: inst.created_at,
    labels, image: inst.config['image.description'] || 'envmux', cmd: null, entrypoint: null,
    env: [], user: '', workingDir: '', mounts: [], inst,
  };
}

async function containers() {
  return (await instances()).map(containerFor).filter(Boolean);
}

async function resolve(ref) {
  const all = await containers();
  const r = String(ref);
  return all.find((c) => c.id === r || c.name === r || c.instance === r)
      || all.find((c) => r.length >= 4 && c.id.startsWith(r))
      || null;
}

function inspect(c) {
  const running = c.inst.status === 'Running';
  const ip = addressOf(c.inst);
  const mac = c.inst.config['volatile.eth0.hwaddr'] || '';
  return {
    Id: c.id,
    Created: c.created,
    Path: (c.entrypoint && c.entrypoint[0]) || (c.cmd && c.cmd[0]) || '/sbin/init',
    Args: c.entrypoint ? [...c.entrypoint.slice(1), ...(c.cmd || [])] : (c.cmd || []).slice(1),
    State: {
      Status: running ? 'running' : 'exited', Running: running, Paused: false, Restarting: false,
      OOMKilled: false, Dead: false, Pid: running ? 1 : 0, ExitCode: 0, Error: '',
      StartedAt: running ? (c.inst.last_used_at || c.created) : '0001-01-01T00:00:00Z',
      FinishedAt: '0001-01-01T00:00:00Z',
    },
    Image: 'sha256:' + sha256(String(c.image)),
    ResolvConfPath: '', HostnamePath: '', HostsPath: '', LogPath: '',
    Name: '/' + c.name,
    RestartCount: 0, Driver: 'zfs', Platform: 'linux', MountLabel: '', ProcessLabel: '', AppArmorProfile: '',
    ExecIDs: [...execs.values()].filter((e) => e.containerId === c.id && e.running).map((e) => e.id),
    HostConfig: {
      Binds: [], ContainerIDFile: '', LogConfig: { Type: 'json-file', Config: {} }, NetworkMode: 'bridge',
      PortBindings: {}, RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false,
      VolumeDriver: '', VolumesFrom: null, CapAdd: null, CapDrop: null, Privileged: false,
      PublishAllPorts: false, ReadonlyRootfs: false, SecurityOpt: null, Runtime: 'runc',
      Mounts: c.mounts.map((m) => ({ Type: m.Type, Source: m.Source, Target: m.Destination })),
    },
    GraphDriver: { Name: 'zfs', Data: {} },
    Mounts: c.mounts,
    Config: {
      Hostname: c.instance, Domainname: '', User: c.user || '', AttachStdin: false, AttachStdout: false,
      AttachStderr: false, Tty: false, OpenStdin: false, StdinOnce: false, Env: c.env || [],
      Cmd: c.cmd, Image: c.image, Volumes: null, WorkingDir: c.workingDir || '', Entrypoint: c.entrypoint,
      OnBuild: null, Labels: c.labels,
    },
    NetworkSettings: {
      Bridge: '', SandboxID: '', Ports: {}, SandboxKey: '', IPAddress: ip, IPPrefixLen: 24,
      Gateway: hostJson.cidr ? hostJson.cidr.split('/')[0] : '', MacAddress: mac,
      Networks: { bridge: { IPAddress: ip, IPPrefixLen: 24, Gateway: hostJson.cidr ? hostJson.cidr.split('/')[0] : '', MacAddress: mac, NetworkID: 'envmux0' } },
    },
  };
}

function summary(c) {
  const i = inspect(c);
  return {
    Id: c.id, Names: ['/' + c.name], Image: c.image, ImageID: i.Image,
    Command: [i.Path, ...i.Args].join(' '), Created: Math.floor(new Date(c.created).getTime() / 1000),
    Ports: [], Labels: c.labels, State: i.State.Status, Status: i.State.Running ? 'Up' : 'Exited (0)',
    HostConfig: { NetworkMode: 'bridge' }, NetworkSettings: { Networks: i.NetworkSettings.Networks },
    Mounts: c.mounts,
  };
}

function matches(c, filters) {
  const f = filters || {};
  const list = (v) => (Array.isArray(v) ? v : Object.keys(v || {}));
  for (const l of list(f.label)) {
    const eq = l.indexOf('=');
    if (eq < 0 ? !(l in c.labels) : c.labels[l.slice(0, eq)] !== l.slice(eq + 1)) return false;
  }
  for (const n of list(f.name)) if (!c.name.includes(n)) return false;
  for (const id of list(f.id)) if (!c.id.startsWith(id)) return false;
  const st = list(f.status);
  if (st.length && !st.includes(inspect(c).State.Status)) return false;
  return true;
}

async function create(query, body) {
  const labels = body.Labels || {};
  const localFolder = labels['devcontainer.local_folder'] || '';
  const base = query.get('name') || (localFolder ? path.basename(localFolder.replace(/\\/g, '/')) : 'workspace');
  const slug = base.toLowerCase().replace(/^vsc-/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'workspace';
  const instance = `vsc-${slug}-${crypto.randomBytes(2).toString('hex')}`;
  const id = sha256(instance);
  const config = {
    'user.envmux.schema': '2',
    'user.envmux.project': slug,
    'user.envmux.created': String(Math.floor(Date.now() / 1000)),
    'user.envmux.docker': id,
  };
  if (localFolder) config['user.envmux.directory'] = localFolder;
  log(`  create: cloning ${GOLDEN} → ${instance}`);
  await settle(await incus('POST', '/1.0/instances', {
    name: instance,
    description: `envmux: VS Code dev container for ${localFolder || slug}`,
    source: { type: 'copy', source: GOLDEN },
    config,
    devices: { eth0: { type: 'nic', network: NETWORK, name: 'eth0' } },
    start: false,
  }));
  const mounts = [
    ...(body.HostConfig && body.HostConfig.Mounts ? body.HostConfig.Mounts : []).map((m) => ({
      Type: m.Type || 'bind', Source: m.Source || '', Destination: m.Target || '', Mode: '', RW: !m.ReadOnly, Propagation: '',
    })),
    ...(body.HostConfig && body.HostConfig.Binds ? body.HostConfig.Binds : []).map((b) => {
      // host:container[:opts] — the host half may itself carry a drive colon.
      const parts = b.split(':');
      const dest = parts.find((p, i) => i > 0 && p.startsWith('/')) || '';
      return { Type: 'bind', Source: b.slice(0, b.lastIndexOf(':' + dest)), Destination: dest, Mode: '', RW: true, Propagation: '' };
    }),
  ];
  state.containers[id] = {
    id, name: query.get('name') || instance, instance, created: new Date().toISOString(), labels,
    image: body.Image || 'envmux', cmd: body.Cmd ?? null, entrypoint: body.Entrypoint ?? null,
    env: body.Env || [], user: body.User || '', workingDir: body.WorkingDir || '', mounts,
  };
  save();
  return id;
}

async function awaitRunning(instance, ms = 60000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const st = (await incus('GET', `/1.0/instances/${instance}/state`)).metadata;
    const eth = st.network && st.network.eth0;
    const a = eth && eth.addresses && eth.addresses.find((x) => x.family === 'inet' && x.scope === 'global');
    if (st.status === 'Running' && a) return a.address;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${instance} did not come up with an address in ${ms}ms`);
}

async function start(c) {
  if (c.inst.status !== 'Running') {
    log(`  start: ${c.instance}`);
    await settle(await incus('PUT', `/1.0/instances/${c.instance}/state`, { action: 'start', timeout: 30 }));
  }
  const ip = await awaitRunning(c.instance);
  log(`  start: ${c.instance} is up at ${ip}`);
  // There are no bind mounts across this boundary (§9): the workspace lives
  // on the target. Provision what the extension asked to mount.
  for (const m of c.mounts) {
    if (!m.Destination || !m.Destination.startsWith('/workspaces/')) continue;
    const readme = `# ${path.basename(m.Destination)}\n\nThis workspace lives in the Incus instance \`${c.instance}\`, cloned from \`${GOLDEN}\`.\n`
      + `Provisioned by the envmux docker shim at ${new Date().toISOString()}.\n`
      + `The local folder the editor was opened on was \`${m.Source}\`, which is not bind-mounted (see docs/vscode-remote.md §9).\n`;
    const script = `mkdir -p ${q(m.Destination)} && [ -n "$(ls -A ${q(m.Destination)})" ] || printf '%s' ${q(readme)} > ${q(m.Destination + '/README.md')}`;
    const r = await run(c.instance, ['sh', '-c', script]);
    log(`  start: provisioned ${m.Destination} (exit ${r.code}${r.err ? ' ' + r.err.trim() : ''})`);
  }
}

async function stop(c) {
  if (c.inst.status !== 'Running') return;
  try {
    await settle(await incus('PUT', `/1.0/instances/${c.instance}/state`, { action: 'stop', timeout: 10, force: true }));
  } catch (e) {
    if (!/already stopped|not running/i.test(e.message)) throw e;
  }
}

// ---------------------------------------------------------------- docker http

const server = http.createServer();

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Api-Version': API_VERSION, ...headers });
  res.end(data);
}

const fail = (res, status, message) => json(res, status, { message });

const strip = (u) => u.replace(/^\/v\d+\.\d+/, '');

const stdcopy = (type, data) => {
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data]);
};

server.on('request', async (req, res) => {
  const url = new URL(strip(req.url), 'http://docker');
  const p = url.pathname;
  const tag = `${req.method} ${p}${url.search}`;
  try {
    // --- handshake
    if (p === '/_ping') {
      res.writeHead(200, { 'Api-Version': API_VERSION, 'Docker-Experimental': 'false', 'Ostype': 'linux', 'Builder-Version': '1', 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': req.method === 'HEAD' ? 0 : 2, 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : 'OK');
    }
    if (p === '/version') {
      log(tag);
      const details = { ApiVersion: API_VERSION, Arch: 'amd64', BuildTime: '2026-08-27T00:00:00.000000000+00:00', Experimental: 'false', GitCommit: 'envmux', GoVersion: 'go1.23', KernelVersion: '6.12-incus', MinAPIVersion: '1.24', Os: 'linux' };
      return json(res, 200, { Platform: { Name: 'envmux (Incus)' }, Components: [{ Name: 'Engine', Version: ENGINE_VERSION, Details: details }], Version: ENGINE_VERSION, ...details, Experimental: false });
    }
    if (p === '/info') {
      log(tag);
      const all = await containers();
      const running = all.filter((c) => c.inst.status === 'Running').length;
      return json(res, 200, {
        ID: 'envmux:' + FINGERPRINT.slice(0, 12), Containers: all.length, ContainersRunning: running, ContainersPaused: 0,
        ContainersStopped: all.length - running, Images: 1, Driver: 'zfs', DriverStatus: [], Plugins: { Volume: ['local'], Network: ['bridge'], Authorization: null, Log: ['json-file'] },
        MemoryLimit: true, SwapLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true, CPUShares: true, CPUSet: true, PidsLimit: true,
        IPv4Forwarding: true, BridgeNfIptables: true, BridgeNfIp6tables: true, Debug: false, NFd: 0, OomKillDisable: false, NGoroutines: 0,
        SystemTime: new Date().toISOString(), LoggingDriver: 'json-file', CgroupDriver: 'systemd', CgroupVersion: '2', NEventsListener: 0,
        KernelVersion: '6.12-incus', OperatingSystem: 'IncusOS (envmux)', OSVersion: '', OSType: 'linux', Architecture: 'x86_64',
        IndexServerAddress: 'https://index.docker.io/v1/', RegistryConfig: { IndexConfigs: {}, InsecureRegistryCIDRs: [], Mirrors: [] },
        NCPU: os.cpus().length, MemTotal: os.totalmem(), GenericResources: null, DockerRootDir: '/var/lib/incus', HttpProxy: '', HttpsProxy: '', NoProxy: '',
        Name: 'envmux', Labels: [], ExperimentalBuild: false, ServerVersion: ENGINE_VERSION, Runtimes: { runc: { path: 'runc' } }, DefaultRuntime: 'runc',
        Swarm: { NodeID: '', NodeAddr: '', LocalNodeState: 'inactive', ControlAvailable: false, Error: '', RemoteManagers: null },
        LiveRestoreEnabled: false, Isolation: '', InitBinary: 'docker-init', ContainerdCommit: { ID: '', Expected: '' }, RuncCommit: { ID: '', Expected: '' }, InitCommit: { ID: '', Expected: '' },
        SecurityOptions: [], Warnings: [],
      });
    }

    // --- events: the devcontainers CLI opens this with a `start` filter
    // before `docker run` and waits for the container's start event on it.
    if (p === '/events') {
      log(tag);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Api-Version': API_VERSION });
      res.flushHeaders();
      listeners.add(res);
      res.on('close', () => listeners.delete(res));
      return; // until the client goes away
    }

    // --- images: everything already exists, and pulling is instant
    let m;
    if ((m = p.match(/^\/images\/(.+)\/json$/))) {
      log(tag);
      const name = decodeURIComponent(m[1]);
      return json(res, 200, {
        Id: 'sha256:' + sha256(name), RepoTags: [name.includes(':') ? name : name + ':latest'], RepoDigests: [], Parent: '', Comment: 'envmux golden snapshot',
        Created: '2026-08-22T00:16:32Z', Container: '', DockerVersion: ENGINE_VERSION, Author: 'envmux', Architecture: 'amd64', Os: 'linux', Size: 0, VirtualSize: 0,
        Config: { Hostname: '', User: '', Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'], Cmd: ['/sbin/init'], Entrypoint: null, WorkingDir: '', Labels: {}, Volumes: null, Image: '' },
        GraphDriver: { Name: 'zfs', Data: {} }, RootFS: { Type: 'layers', Layers: ['sha256:' + sha256(GOLDEN)] },
      });
    }
    if (p === '/images/json') { log(tag); return json(res, 200, []); }
    if (p === '/images/create' && req.method === 'POST') {
      log(tag);
      const name = url.searchParams.get('fromImage') || 'envmux';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Api-Version': API_VERSION });
      res.write(JSON.stringify({ status: `Pulling from envmux/${name}`, id: 'latest' }) + '\r\n');
      res.write(JSON.stringify({ status: `Every image is the golden snapshot ${GOLDEN}` }) + '\r\n');
      res.write(JSON.stringify({ status: `Status: Image is up to date for ${name}` }) + '\r\n');
      return res.end();
    }
    if (p === '/build') { log(tag, '← REFUSED'); return fail(res, 400, 'envmux: targets are pre-provisioned; use an "image" in devcontainer.json rather than a Dockerfile'); }
    if (p === '/networks') { log(tag); return json(res, 200, []); }

    // --- volumes: the extension keeps a `vscode` volume for its server
    // cache. There is nothing to mount across this boundary, so a volume is a
    // name that answers; a mount of one is a directory on the target.
    state.volumes ??= {};
    const volume = (name, labels = {}) => ({ Name: name, Driver: 'local', Mountpoint: `/var/lib/envmux/volumes/${name}`, CreatedAt: new Date().toISOString(), Labels: labels, Scope: 'local', Options: {} });
    if (p === '/volumes' && req.method === 'GET') { log(tag); return json(res, 200, { Volumes: Object.entries(state.volumes).map(([n, l]) => volume(n, l)), Warnings: [] }); }
    if (p === '/volumes/create' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const name = body.Name || crypto.randomBytes(32).toString('hex');
      log(tag, name);
      state.volumes[name] = body.Labels || {}; save();
      return json(res, 201, volume(name, state.volumes[name]));
    }
    if ((m = p.match(/^\/volumes\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]);
      log(tag);
      if (req.method === 'DELETE') { delete state.volumes[name]; save(); res.writeHead(204); return res.end(); }
      return name in state.volumes ? json(res, 200, volume(name, state.volumes[name])) : fail(res, 404, `no such volume: ${name}`);
    }

    // --- containers
    if (p === '/containers/json') {
      const filters = url.searchParams.get('filters');
      const f = filters ? JSON.parse(filters) : {};
      const all = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true';
      const list = (await containers()).filter((c) => (all || c.inst.status === 'Running') && matches(c, f)).map(summary);
      log(tag, `→ ${list.length} (${list.map((c) => c.Names[0]).join(', ')})`);
      return json(res, 200, list);
    }
    if (p === '/containers/create' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      log(tag, JSON.stringify({ Image: body.Image, Labels: body.Labels, Entrypoint: body.Entrypoint, Cmd: body.Cmd, User: body.User, Mounts: (body.HostConfig || {}).Mounts, Binds: (body.HostConfig || {}).Binds }));
      const id = await create(url.searchParams, body);
      log(`  create: ${id.slice(0, 12)} → ${state.containers[id].instance}`);
      emit('create', { ...state.containers[id] });
      return json(res, 201, { Id: id, Warnings: [] });
    }
    if ((m = p.match(/^\/containers\/([^/]+)\/(json|start|stop|kill|restart|wait|top|logs|archive|exec|attach|resize|stats|changes)$/)) || (m = p.match(/^\/containers\/([^/]+)$/))) {
      const c = await resolve(decodeURIComponent(m[1]));
      if (!c) { log(tag, '← 404'); return fail(res, 404, `No such container: ${m[1]}`); }
      const op = m[2] || (req.method === 'DELETE' ? 'delete' : 'json');
      if (op !== 'json' && op !== 'archive') log(tag, `(${c.instance})`);
      switch (op) {
        case 'json': return json(res, 200, inspect(c));
        case 'start': await start(c); emit('start', c); res.writeHead(204); return res.end();
        case 'stop': case 'kill': await stop(c); emit('die', c); emit('stop', c); res.writeHead(204); return res.end();
        case 'restart': await stop(c); await start({ ...c, inst: { ...c.inst, status: 'Stopped' } }); res.writeHead(204); return res.end();
        case 'delete': {
          await stop(c);
          try { await settle(await incus('DELETE', `/1.0/instances/${c.instance}`)); } catch (e) { if (!e.notFound) throw e; }
          delete state.containers[c.id]; save();
          res.writeHead(204); return res.end();
        }
        case 'wait': {
          // Hold until the instance is no longer running.
          for (;;) {
            const st = (await incus('GET', `/1.0/instances/${c.instance}/state`)).metadata;
            if (st.status !== 'Running' || res.destroyed) break;
            await new Promise((r) => setTimeout(r, 2000));
          }
          return json(res, 200, { StatusCode: 0 });
        }
        case 'top': return json(res, 200, { Titles: ['PID', 'USER', 'COMMAND'], Processes: [['1', 'root', '/sbin/init']] });
        case 'logs': res.writeHead(200, { 'Content-Type': 'application/vnd.docker.multiplexed-stream' }); return res.end();
        case 'stats': return json(res, 200, {});
        case 'changes': return json(res, 200, []);
        case 'exec': {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const id = crypto.randomBytes(32).toString('hex');
          execs.set(id, { id, containerId: c.id, instance: c.instance, cfg: body, running: false, exitCode: null, sockets: null });
          log(`  exec ${id.slice(0, 8)}: tty=${!!body.Tty} user=${body.User || ''} cwd=${body.WorkingDir || ''} cmd=${JSON.stringify(body.Cmd).slice(0, 300)}`);
          return json(res, 201, { Id: id });
        }
        case 'archive': return archive(req, res, c, url, tag);
        default: break;
      }
    }

    // --- exec
    if ((m = p.match(/^\/exec\/([^/]+)\/(json|resize|start)$/))) {
      const ex = execs.get(m[1]);
      if (!ex) { log(tag, '← 404'); return fail(res, 404, `No such exec instance: ${m[1]}`); }
      if (m[2] === 'json') {
        return json(res, 200, {
          ID: ex.id, Running: ex.running, ExitCode: ex.exitCode, ContainerID: ex.containerId, DetachKeys: '', OpenStdin: !!ex.cfg.AttachStdin, OpenStderr: true, OpenStdout: true, CanRemove: false, Pid: 0,
          ProcessConfig: { tty: !!ex.cfg.Tty, entrypoint: (ex.cfg.Cmd || [])[0] || '', arguments: (ex.cfg.Cmd || []).slice(1), privileged: false, user: ex.cfg.User || '' },
        });
      }
      if (m[2] === 'resize') {
        const control = ex.sockets && ex.sockets.control;
        const w = url.searchParams.get('w'); const h = url.searchParams.get('h');
        if (control && control.readyState === WebSocket.OPEN) control.send(JSON.stringify({ command: 'window-resize', args: { width: String(w), height: String(h) } }));
        res.writeHead(200); return res.end();
      }
      if (m[2] === 'start') {
        // Reached only when the client did not ask to upgrade; run detached.
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        log(tag, `(no upgrade; Detach=${!!body.Detach})`);
        const started = await execStart(ex.instance, { cmd: ex.cfg.Cmd, env: envMap(ex.cfg.Env), user: ex.cfg.User, cwd: ex.cfg.WorkingDir, tty: !!ex.cfg.Tty });
        ex.sockets = started.sockets; ex.running = true;
        execExit(started.opId).then((code) => { ex.exitCode = code; ex.running = false; closeAll(started.sockets); });
        res.writeHead(200); return res.end();
      }
    }

    log(tag, '← 404 UNHANDLED');
    return fail(res, 404, `envmux shim: no handler for ${req.method} ${p}`);
  } catch (e) {
    log(tag, `← 500 ${e.stack || e.message}`);
    if (!res.headersSent) return fail(res, 500, `envmux: ${e.message}`);
    res.end();
  }
});

// Docker's event stream, for the few events anything waits on.
const listeners = new Set();
function emit(action, c) {
  const now = Date.now();
  const event = {
    status: action, id: c.id, from: c.image, Type: 'container', Action: action,
    Actor: { ID: c.id, Attributes: { ...c.labels, image: c.image, name: c.name } },
    scope: 'local', time: Math.floor(now / 1000), timeNano: now * 1e6,
  };
  log(`  event: ${action} ${c.name} → ${listeners.size} listener(s)`);
  for (const res of listeners) { try { res.write(JSON.stringify(event) + '\n'); } catch { /* gone */ } }
}

const envMap = (list) => Object.fromEntries((list || []).map((kv) => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]; }));

// --- archive: tar in and out of the instance, over a non-tty exec.
async function archive(req, res, c, url, tag) {
  const p = url.searchParams.get('path') || '/';
  const dir = path.posix.dirname(p); const base = path.posix.basename(p);
  if (req.method === 'HEAD' || req.method === 'GET') {
    const st = await run(c.instance, ['stat', '-c', '%F|%s|%a|%Y|%N', p]);
    if (st.code !== 0) { log(tag, `← 404 (${st.err.trim()})`); return fail(res, 404, `Could not find the file ${p} in container ${c.id.slice(0, 12)}`); }
    const [kind, size, mode, mtime, names] = st.out.trim().split('|');
    const link = kind.includes('symbolic link') ? (names.match(/-> '(.*)'$/) || [, ''])[1] : '';
    const gomode = parseInt(mode, 8) | (kind === 'directory' ? 0x80000000 : 0) | (link ? 0x08000000 : 0);
    const stat = Buffer.from(JSON.stringify({ name: base, size: Number(size), mode: gomode >>> 0, mtime: new Date(Number(mtime) * 1000).toISOString(), linkTarget: link })).toString('base64');
    if (req.method === 'HEAD') { log(tag, `→ ${kind} ${size}b`); res.writeHead(200, { 'X-Docker-Container-Path-Stat': stat, 'Content-Type': 'application/x-tar' }); return res.end(); }
    log(tag, `→ tar of ${kind}`);
    res.writeHead(200, { 'X-Docker-Container-Path-Stat': stat, 'Content-Type': 'application/x-tar' });
    const ex = await execStart(c.instance, { cmd: ['tar', '-C', dir, '-cf', '-', base], tty: false });
    ex.sockets['1'].on('message', (d) => { if (!d.length) return ex.sockets['1'].close(); if (!res.write(d)) { ex.sockets['1'].pause(); res.once('drain', () => ex.sockets['1'].resume()); } });
    ex.sockets['2'].on('message', (d) => log(`  tar: ${d.toString().trim()}`));
    await new Promise((r) => ex.sockets['1'].once('close', r));
    const code = await execExit(ex.opId); closeAll(ex.sockets);
    log(`  archive GET ${p}: tar exited ${code}`);
    return res.end();
  }
  if (req.method === 'PUT') {
    log(tag);
    const ex = await execStart(c.instance, { cmd: ['sh', '-c', `mkdir -p ${q(p)} && tar -C ${q(p)} -xf -`], tty: false });
    const errs = [];
    ex.sockets['2'].on('message', (d) => errs.push(d));
    let bytes = 0;
    req.on('data', (d) => { bytes += d.length; ex.sockets['0'].send(d); });
    await new Promise((r) => req.on('end', r));
    ex.sockets['0'].close();
    await new Promise((r) => ex.sockets['1'].once('close', r));
    const code = await execExit(ex.opId); closeAll(ex.sockets);
    log(`  archive PUT ${p}: ${bytes} bytes, tar exited ${code} ${Buffer.concat(errs).toString().trim()}`);
    if (code !== 0) return fail(res, 500, `tar exited ${code}: ${Buffer.concat(errs).toString()}`);
    res.writeHead(200); return res.end();
  }
  return fail(res, 405, 'method not allowed');
}

// --- hijacked streams: exec start, and attach.
function readExact(socket, head, length) {
  return new Promise((resolve) => {
    let buf = head;
    const done = () => resolve({ body: buf.subarray(0, length), rest: buf.subarray(length) });
    if (buf.length >= length) return done();
    const onData = (d) => { buf = Buffer.concat([buf, d]); if (buf.length >= length) { socket.off('data', onData); done(); } };
    socket.on('data', onData);
  });
}

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(strip(req.url), 'http://docker');
  const p = url.pathname;
  const tag = `${req.method} ${p}${url.search} [hijack]`;
  socket.setNoDelay(true);
  try {
    const { body: raw, rest } = await readExact(socket, head, Number(req.headers['content-length'] || 0));
    const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    let m;
    if ((m = p.match(/^\/exec\/([^/]+)\/start$/))) {
      const ex = execs.get(m[1]);
      if (!ex) { log(tag, '← 404'); socket.end('HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"no such exec"}'); return; }
      const tty = !!(ex.cfg.Tty || body.Tty);
      const started = await execStart(ex.instance, { cmd: ex.cfg.Cmd, env: envMap(ex.cfg.Env), user: ex.cfg.User, cwd: ex.cfg.WorkingDir, tty, width: 200, height: 50 });
      ex.sockets = started.sockets; ex.running = true;
      log(`${tag} exec ${ex.id.slice(0, 8)} started (op ${started.opId.slice(0, 8)}, tty=${tty})`);
      socket.write(`HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.${tty ? 'raw' : 'multiplexed'}-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`);
      bridge(socket, rest, ex, started);
      return;
    }
    if ((m = p.match(/^\/containers\/([^/]+)\/attach$/))) {
      const c = await resolve(decodeURIComponent(m[1]));
      if (!c) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
      log(tag, `(${c.instance}) — holding; the instance's init is its own process`);
      socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      // What the devcontainers CLI's own entrypoint would have said first.
      const echo = (c.cmd || []).join('\n').match(/echo ([^\n;]+)/);
      const line = echo ? echo[1].trim().replace(/^["']|["']$/g, '') : 'Container started';
      const ready = setInterval(async () => {
        const st = (await incus('GET', `/1.0/instances/${c.instance}/state`)).metadata;
        if (st.status === 'Running') { clearInterval(ready); socket.write(stdcopy(1, Buffer.from(line + '\n'))); log(`  attach: said "${line}"`); }
      }, 500);
      socket.on('close', () => clearInterval(ready));
      socket.on('error', () => {});
      return;
    }
    log(tag, '← 404 UNHANDLED');
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
  } catch (e) {
    log(tag, `← 500 ${e.stack || e.message}`);
    socket.end(`HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ message: e.message })}`);
  }
});

function bridge(socket, rest, ex, started) {
  const { sockets, tty } = started;
  const send = (ws, d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d); };
  const stdin = sockets['0'];
  let wrote = 0; let read = 0;

  let lastOutput = Date.now();
  const write = (chunk, ...pauseable) => {
    if (socket.destroyed || !socket.writable) return;
    wrote += chunk.length;
    lastOutput = Date.now();
    if (!socket.write(chunk)) {
      for (const w of pauseable) w.pause();
      socket.once('drain', () => { for (const w of pauseable) w.resume(); });
    }
  };

  // An empty message is Incus saying that stream has reached EOF. On a pty it
  // does not close the socket afterwards — the operation stays Running until
  // the client closes it — so EOF is answered with a close from this side.
  const onOutput = (ws, frame) => (d) => {
    if (d.length === 0) { try { ws.close(); } catch { /* gone */ } return; }
    write(frame(d), ...(tty ? [stdin] : [sockets['1'], sockets['2']]));
  };
  if (tty) {
    stdin.on('message', onOutput(stdin, (d) => d));
  } else {
    sockets['1'].on('message', onOutput(sockets['1'], (d) => stdcopy(1, d)));
    sockets['2'].on('message', onOutput(sockets['2'], (d) => stdcopy(2, d)));
  }

  if (rest.length) { read += rest.length; send(stdin, rest); }
  socket.on('data', (d) => {
    read += d.length;
    send(stdin, d);
    if (stdin.bufferedAmount > 4 * 1024 * 1024) { socket.pause(); const t = setInterval(() => { if (stdin.bufferedAmount < 1024 * 1024) { clearInterval(t); socket.resume(); } }, 20); }
  });
  // The client half-closing is stdin's EOF.
  socket.on('end', () => { if (!tty) { try { stdin.close(); } catch { /* gone */ } } });

  // Two signals for "it is over", raced: every output socket closing, and the
  // operation finishing. Incus closes the sockets when the last holder of the
  // fds lets go, which for a pty is not always the command exiting — so the
  // operation is watched too, with a moment's grace for trailing output.
  const outputs = tty ? [stdin] : [sockets['1'], sockets['2']];
  let open = outputs.length;
  let ended = false;
  const finish = async (why) => {
    if (ended) return;
    ended = true;
    ex.exitCode = await execExit(started.opId);
    ex.running = false;
    log(`  exec ${ex.id.slice(0, 8)} exited ${ex.exitCode} (${wrote}b out, ${read}b in; ${why})`);
    closeAll(sockets);
    socket.end();
  };
  for (const w of outputs) w.once('close', () => { if (--open === 0) finish('streams closed'); });
  // Incus finishes the operation when the command exits, which can be well
  // before its output has drained — so once finished, end only after the
  // output has been quiet for a while, and let the closes above win if they can.
  execExit(started.opId).then(() => {
    const tick = () => {
      if (ended) return;
      if (Date.now() - lastOutput >= 2000) finish('operation finished, output idle');
      else setTimeout(tick, 250);
    };
    tick();
  });
  socket.on('close', () => { if (ex.running) { log(`  exec ${ex.id.slice(0, 8)}: client went away`); closeAll(sockets); } });
  socket.on('error', (e) => log(`  exec ${ex.id.slice(0, 8)}: socket ${e.message}`));
}

server.on('clientError', (e, socket) => { log(`clientError ${e.message}`); socket.destroy(); });

// ---------------------------------------------------------------- transport
//
// On Windows the public pipe belongs to relay/ (message mode, so the docker
// CLI's CloseWrite works — see relay/Program.cs). It forwards here over a
// byte-mode pipe with a 4-byte length prefix upstream; a zero length is the
// client's half-close, which becomes 'end' on a duplex the http server is
// handed as if it were a socket. Downstream is raw bytes.

class Framed extends Duplex {
  constructor(inner) {
    super({ allowHalfOpen: true });
    this.inner = inner; this.buf = Buffer.alloc(0); this.eof = false;
    this.remoteAddress = 'npipe'; this.remotePort = 0;
    inner.on('data', (d) => this.ingest(d));
    inner.on('end', () => this.finishRead());
    inner.on('error', (e) => this.destroy(e));
    inner.on('close', () => { this.finishRead(); this.destroy(); });
  }
  finishRead() { if (!this.eof) { this.eof = true; this.push(null); } }
  ingest(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (n === 0) { this.buf = this.buf.subarray(4); this.finishRead(); continue; }
      if (this.buf.length < 4 + n) break;
      const chunk = Buffer.from(this.buf.subarray(4, 4 + n));
      this.buf = this.buf.subarray(4 + n);
      if (!this.push(chunk)) this.inner.pause();
    }
  }
  _read() { this.inner.resume(); }
  _write(chunk, _enc, cb) { this.inner.write(chunk, cb); }
  _final(cb) { this.inner.end(cb); }
  _destroy(err, cb) { this.inner.destroy(); cb(err); }
  setTimeout() { return this; } setNoDelay() { return this; } setKeepAlive() { return this; }
  destroySoon() { this.end(); }
  ref() { return this; } unref() { return this; }
}

if (process.platform === 'win32') {
  const INNER = '\\\\.\\pipe\\envmux-docker-inner';
  net.createServer((inner) => server.emit('connection', new Framed(inner))).listen(INNER, () => {
    log(`envmux docker shim listening on ${INNER} (behind relay on ${PIPE}) → https://${API_HOST}:${API_PORT} (pinned ${FINGERPRINT.slice(0, 12)}…)`);
    log('DOCKER_HOST=npipe:////./pipe/envmux-docker');
  });
} else {
  server.listen(PIPE, () => {
    log(`envmux docker shim listening on ${PIPE} → https://${API_HOST}:${API_PORT} (pinned ${FINGERPRINT.slice(0, 12)}…)`);
    log(`DOCKER_HOST=unix://${PIPE}`);
  });
}
