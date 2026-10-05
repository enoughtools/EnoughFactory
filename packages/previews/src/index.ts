import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { type AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { SocksClient } from "socks";

export interface PreviewTarget { host: string; port: number }
export interface PreviewSession { proxyUrl: string }
export interface PreviewGatewayOptions {
  /** Private engine readiness credentials. Never return these to a renderer. */
  getSession(sessionId: string): Promise<PreviewSession | undefined> | PreviewSession | undefined;
  /** A paired peer may supply a backpressured TCP stream over its transport. */
  connectPeer?(sessionId: string, target: PreviewTarget): Promise<Duplex | undefined>;
  /** TLS reverse proxy must forward wildcard preview hosts to this listener. */
  publicBrowserGateway?: { originTemplate: string; port: number; listenHost?: string };
}
export interface DesktopPreview {
  id: string; sessionId: string; proxyUrl: string; url: string;
  /** Main-process-only credentials for Electron's proxy authentication callback. */
  proxyAuth: { username: string; password: string };
}
export interface BrowserPreview {
  id: string; sessionId: string; url: string; origin: string; targetUrl: string;
}
type PreviewServer = { sessionId: string; server: http.Server; sockets: Set<Duplex>; responses: Set<ServerResponse> };
const grantCookie = "__enough_preview";
const bootstrapPath = "/_enough_preview/bootstrap/";

/**
 * Session browsers use a fixed authenticated HTTP proxy, preserving the actual
 * localhost URL and cookies. Ordinary browsers use an isolated origin gateway.
 * Both routes dial through authenticated envmux SOCKS or a paired device tunnel.
 */
export class PreviewGateway {
  private readonly previews = new Map<string, PreviewServer>();
  private readonly hostedRoutes = new Map<string, string>();
  private hostedServer?: Promise<http.Server>;
  private readonly hostedSockets = new Set<Duplex>();
  constructor(private readonly options: PreviewGatewayOptions) {}

  async createDesktop(sessionId: string, url = "http://localhost:3000"): Promise<DesktopPreview> {
    parseTarget(url);
    const id = randomBytes(12).toString("hex");
    const proxyAuth = { username: `preview-${id}`, password: randomBytes(32).toString("base64url") };
    const expected = `Basic ${Buffer.from(`${proxyAuth.username}:${proxyAuth.password}`).toString("base64")}`;
    const authorized = (request: IncomingMessage) => equalSecret(request.headers["proxy-authorization"], expected);
    const server = http.createServer((request, response) => {
      if (!authorized(request)) return challenge(response);
      try {
        const target = parseTarget(request.url ?? "");
        this.forward(sessionId, request, response, target);
      } catch { fail(response, 400, "A preview proxy request requires an HTTP URL."); }
    });
    const entry = this.track(id, sessionId, server);
    server.on("connect", (request, client, head) => {
      if (!authorized(request)) return rawChallenge(client);
      let target: PreviewTarget;
      try { target = connectTarget(request.url ?? ""); }
      catch { return rawFailure(client, 400, "Invalid CONNECT target"); }
      void this.connect(sessionId, target).then(upstream => {
        this.trackSocket(entry, upstream);
        if (client.destroyed) return upstream.destroy();
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        pipeBoth(client, upstream);
      }).catch(() => rawFailure(client, 502, "Session preview is unavailable"));
    });
    server.on("upgrade", (request, client, head) => {
      if (!authorized(request)) return rawChallenge(client);
      try {
        this.forwardUpgrade(entry, request, client, head, parseTarget(request.url ?? ""));
      } catch { rawFailure(client, 400, "Invalid WebSocket preview target"); }
    });
    const port = await listen(server);
    return { id, sessionId, proxyUrl: `http://127.0.0.1:${port}`, url, proxyAuth };
  }

  async createBrowser(sessionId: string, targetUrl: string): Promise<BrowserPreview> {
    const target = parseTarget(targetUrl);
    const id = randomBytes(12).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const host = `p${id}.localhost`;
    let origin = "";
    const authorized = (request: IncomingMessage) => equalSecret(cookieValue(request.headers.cookie, grantCookie), secret);
    const server = http.createServer((request, response) => {
      if (request.headers.host !== new URL(origin).host) return fail(response, 403, "Unexpected preview origin.");
      let incoming: URL;
      try { incoming = new URL(request.url ?? "/", origin); }
      catch { return fail(response, 400, "Invalid preview URL."); }
      if (incoming.pathname.startsWith(bootstrapPath)) {
        if (!equalSecret(incoming.pathname.slice(bootstrapPath.length), secret)) return fail(response, 403, "Invalid preview grant.");
        response.writeHead(303, {
          location: `${target.pathname}${target.search}${target.hash}`,
          "set-cookie": `${grantCookie}=${secret}; Path=/; HttpOnly; ${origin.startsWith("https:") ? "Secure; SameSite=None" : "SameSite=Lax"}`,
          "cache-control": "no-store", "referrer-policy": "no-referrer",
        });
        return response.end();
      }
      if (!authorized(request)) return fail(response, 403, "Open this preview from EnoughFactory to authorize access.");
      const upstream = new URL(`${incoming.pathname}${incoming.search}`, target.origin);
      this.forward(sessionId, request, response, upstream, origin);
    });
    const entry = this.track(id, sessionId, server);
    server.on("upgrade", (request, client, head) => {
      if (request.headers.host !== new URL(origin).host || !authorized(request)) return rawFailure(client, 403, "Unauthorized preview");
      try {
        const incoming = new URL(request.url ?? "/", origin);
        this.forwardUpgrade(entry, request, client, head, new URL(`${incoming.pathname}${incoming.search}`, target.origin), origin);
      } catch { rawFailure(client, 400, "Invalid preview URL"); }
    });
    const port = await listen(server);
    origin = `http://${host}:${port}`;
    if (this.options.publicBrowserGateway) {
      const template = this.options.publicBrowserGateway.originTemplate;
      if (!template.includes("{id}")) { await this.closePreview(id); throw new Error("Public previews require an {id} origin template"); }
      const publicUrl = new URL(template.replaceAll("{id}", `p${id}`));
      if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
        await this.closePreview(id); throw new Error("Public previews require isolated HTTPS origins");
      }
      try { await this.ensureHostedServer(); }
      catch (error) { await this.closePreview(id); throw error; }
      origin = publicUrl.origin;
      this.hostedRoutes.set(publicUrl.host, id);
    }
    return { id, sessionId, origin, targetUrl: target.href, url: `${origin}${bootstrapPath}${secret}` };
  }

  async closePreview(id: string): Promise<void> {
    const preview = this.previews.get(id);
    if (!preview) return;
    this.previews.delete(id);
    for (const [host, previewId] of this.hostedRoutes) if (previewId === id) this.hostedRoutes.delete(host);
    for (const socket of preview.sockets) socket.destroy();
    for (const response of preview.responses) response.destroy();
    preview.server.closeAllConnections();
    await new Promise<void>(resolve => preview.server.close(() => resolve()));
  }
  async closeSession(sessionId: string): Promise<void> {
    await Promise.all([...this.previews].filter(([, entry]) => entry.sessionId === sessionId).map(([id]) => this.closePreview(id)));
  }
  async close(): Promise<void> {
    await Promise.all([...this.previews.keys()].map(id => this.closePreview(id)));
    if (this.hostedServer) {
      const server = await this.hostedServer.catch(() => undefined);
      for (const socket of this.hostedSockets) socket.destroy();
      if (server) await new Promise<void>(resolve => server.close(() => resolve()));
      this.hostedServer = undefined;
    }
  }

  private ensureHostedServer(): Promise<http.Server> {
    if (this.hostedServer) return this.hostedServer;
    const config = this.options.publicBrowserGateway!;
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) return Promise.reject(new Error("Public preview gateway port must be configured"));
    const server = http.createServer((request, response) => {
      const id = this.hostedRoutes.get(request.headers.host ?? "");
      const preview = id && this.previews.get(id);
      if (!preview) return fail(response, 404, "This preview is unavailable.");
      preview.responses.add(response);
      response.on("close", () => preview.responses.delete(response));
      preview.server.emit("request", request, response);
    });
    server.on("upgrade", (request, socket, head) => {
      const id = this.hostedRoutes.get(request.headers.host ?? "");
      const preview = id && this.previews.get(id);
      if (!preview) return rawFailure(socket, 404, "This preview is unavailable");
      this.trackSocket(preview, socket);
      preview.server.emit("upgrade", request, socket, head);
    });
    server.on("connection", socket => {
      this.hostedSockets.add(socket);
      socket.on("close", () => this.hostedSockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => rawFailure(socket, 400, "Invalid preview request"));
    this.hostedServer = new Promise<http.Server>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.listenHost ?? "127.0.0.1", () => { server.off("error", reject); resolve(server); });
    }).catch(error => { this.hostedServer = undefined; throw error; });
    return this.hostedServer;
  }

  private track(id: string, sessionId: string, server: http.Server): PreviewServer {
    const entry: PreviewServer = { sessionId, server, sockets: new Set(), responses: new Set() };
    server.on("connection", socket => this.trackSocket(entry, socket));
    server.on("clientError", (_error, socket) => rawFailure(socket, 400, "Invalid preview request"));
    this.previews.set(id, entry);
    return entry;
  }
  private trackSocket(entry: PreviewServer, socket: Duplex) {
    if (entry.sockets.has(socket)) return;
    entry.sockets.add(socket);
    socket.on("close", () => entry.sockets.delete(socket));
  }
  private async connect(sessionId: string, target: PreviewTarget): Promise<Duplex> {
    const peer = await this.options.connectPeer?.(sessionId, target);
    if (peer) return peer;
    const session = await this.options.getSession(sessionId);
    if (!session) throw new Error("Session preview is unavailable");
    return connectSessionProxy(session.proxyUrl, target);
  }
  private agent(sessionId: string, target: URL): http.Agent | https.Agent {
    const secure = target.protocol === "https:";
    const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
    // Node's agent callback lets a remote RTC Duplex be used without buffering
    // request bodies or replacing Node's HTTP parser and backpressure behavior.
    agent.createConnection = (_options, callback) => {
      void this.connect(sessionId, { host: target.hostname.replace(/^\[|\]$/g, ""), port: portOf(target) }).then(stream => {
        if (!secure) return callback?.(null, stream);
        const socket = tls.connect({ socket: stream as import("node:net").Socket, servername: target.hostname.replace(/^\[|\]$/g, "") });
        const failed = (error: Error) => callback?.(error, socket);
        socket.once("secureConnect", () => { socket.off("error", failed); callback?.(null, socket); });
        socket.once("error", failed);
      }).catch(error => callback?.(error, undefined as never));
      return undefined as never;
    };
    return agent;
  }
  private forward(sessionId: string, incoming: IncomingMessage, response: ServerResponse, target: URL, origin?: string) {
    const agent = this.agent(sessionId, target);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(target, {
      method: incoming.method, headers: requestHeaders(incoming, target, origin), agent,
    }, upstream => {
      const headers = responseHeaders(upstream.headers, target, origin);
      response.writeHead(upstream.statusCode ?? 502, headers);
      upstream.pipe(response);
      upstream.on("error", () => response.destroy());
    });
    request.on("error", () => fail(response, 502, "The session preview is unavailable. Check that its device and service are running."));
    incoming.on("aborted", () => request.destroy());
    response.on("close", () => { request.destroy(); agent.destroy(); });
    incoming.pipe(request);
  }
  private forwardUpgrade(entry: PreviewServer, incoming: IncomingMessage, client: Duplex, head: Buffer, target: URL, origin?: string) {
    const agent = this.agent(entry.sessionId, target);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(target, {
      method: incoming.method, headers: requestHeaders(incoming, target, origin, true), agent,
    });
    request.on("upgrade", (response, upstream, upstreamHead) => {
      this.trackSocket(entry, upstream);
      if (client.destroyed) return upstream.destroy();
      const headers = responseHeaders(response.headers, target, origin, true);
      client.write(`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n${headerLines(headers)}\r\n`);
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) upstream.write(head);
      pipeBoth(client, upstream);
    });
    request.on("response", response => {
      const headers = responseHeaders(response.headers, target, origin);
      headers.connection = "close";
      client.write(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? "Preview response"}\r\n${headerLines(headers)}\r\n`);
      response.pipe(client);
    });
    request.on("error", () => rawFailure(client, 502, "Session preview is unavailable"));
    client.on("close", () => { request.destroy(); agent.destroy(); });
    request.end();
  }
}

/** Owner-side RTC preview dialing uses this route, never the host's raw TCP. */
export async function connectSessionProxy(proxyUrl: string, target: PreviewTarget): Promise<Duplex> {
  if (!target.host || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error("Invalid preview destination");
  const proxy = new URL(proxyUrl);
  if (!["socks5:", "socks5h:"].includes(proxy.protocol) || !proxy.username || !proxy.password) {
    throw new Error("The environment has no authenticated preview proxy");
  }
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: proxy.hostname, port: Number(proxy.port), type: 5,
      userId: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password),
    },
    destination: target, command: "connect", timeout: 15_000,
  });
  return socket;
}

function parseTarget(value: string): URL {
  const url = new URL(value.replace(/^ws:/, "http:").replace(/^wss:/, "https:"));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Preview requires an HTTP or HTTPS URL without embedded credentials");
  return url;
}
function portOf(url: URL) { return Number(url.port || (url.protocol === "https:" ? 443 : 80)); }
function connectTarget(authority: string): PreviewTarget {
  const url = new URL(`tcp://${authority}`);
  if (!url.port || url.pathname || url.username || url.password || url.search || url.hash || Number(url.port) < 1) throw new Error("Invalid CONNECT target");
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) };
}
function equalSecret(actual: string | string[] | undefined, expected: string) {
  if (typeof actual !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(actual).digest(), createHash("sha256").update(expected).digest());
}
function cookieValue(cookie: string | undefined, name: string) {
  return cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function requestHeaders(incoming: IncomingMessage, target: URL, origin?: string, upgrade = false): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...incoming.headers, host: target.host };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  if (!upgrade) removeHopByHop(headers);
  else { headers.connection = "Upgrade"; headers.upgrade = incoming.headers.upgrade ?? "websocket"; }
  if (origin) {
    headers.cookie = incoming.headers.cookie?.split(";").filter(part => part.trim().split("=", 1)[0] !== grantCookie).join(";");
    if (!headers.cookie) delete headers.cookie;
    if (incoming.headers.origin === origin) headers.origin = target.origin;
    if (incoming.headers.referer?.startsWith(`${origin}/`)) headers.referer = target.origin + incoming.headers.referer.slice(origin.length);
    headers["x-forwarded-host"] = new URL(origin).host;
    headers["x-forwarded-proto"] = new URL(origin).protocol.slice(0, -1);
    headers["x-forwarded-prefix"] = "/";
  }
  return headers;
}
function responseHeaders(incoming: http.IncomingHttpHeaders, target: URL, origin?: string, upgrade = false): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...incoming };
  if (!upgrade) removeHopByHop(headers);
  if (origin) {
    if (typeof headers.location === "string") {
      try {
        const location = new URL(headers.location, target);
        if (location.origin === target.origin) headers.location = `${origin}${location.pathname}${location.search}${location.hash}`;
      } catch { /* Preserve invalid upstream locations without crashing the device service. */ }
    }
    if (headers["set-cookie"]) headers["set-cookie"] = (Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [String(headers["set-cookie"])])
      .filter(value => value.split("=", 1)[0].trim() !== grantCookie)
      .map(value => value.replace(/;\s*Domain=[^;]*/gi, ""));
  }
  return headers;
}
function removeHopByHop(headers: http.OutgoingHttpHeaders) {
  for (const name of String(headers.connection ?? "").split(",")) delete headers[name.trim().toLowerCase()];
  for (const name of ["connection", "proxy-connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]) delete headers[name];
}
function headerLines(headers: http.OutgoingHttpHeaders) {
  return Object.entries(headers).flatMap(([name, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}\r\n`)).join("");
}
function fail(response: ServerResponse, status: number, text: string) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(text);
}
function challenge(response: ServerResponse) {
  response.writeHead(407, { "proxy-authenticate": 'Basic realm="EnoughFactory session preview"', "cache-control": "no-store" });
  response.end("This session preview requires its scoped proxy credentials.");
}
function rawChallenge(socket: Duplex) { rawFailure(socket, 407, "Proxy Authentication Required", 'Proxy-Authenticate: Basic realm="EnoughFactory session preview"\r\n'); }
function rawFailure(socket: Duplex, status: number, text: string, extraHeaders = "") {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\n${extraHeaders}Connection: close\r\nContent-Length: 0\r\n\r\n`);
}
function pipeBoth(left: Duplex, right: Duplex) {
  left.on("error", () => right.destroy()); right.on("error", () => left.destroy());
  left.on("close", () => right.destroy()); right.on("close", () => left.destroy());
  left.pipe(right); right.pipe(left);
}
async function listen(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return (server.address() as AddressInfo).port;
}
