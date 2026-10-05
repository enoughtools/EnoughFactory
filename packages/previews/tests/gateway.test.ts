import assert from "node:assert/strict";
import http, { type IncomingMessage } from "node:http";
import net from "node:net";
import { type AddressInfo } from "node:net";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import test from "node:test";
import { PreviewGateway } from "../src/index.ts";

test("scoped desktop and browser previews carry HTTP, CONNECT and WebSockets through authenticated SOCKS", async () => {
  const seen: Array<{ host: string; port: number }> = [];
  const receivedHeaders: http.IncomingHttpHeaders[] = [];
  const app = http.createServer((request, response) => {
    receivedHeaders.push(request.headers);
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `http://localhost:${portOf(app)}/done`, "set-cookie": "app=present; Domain=localhost; Path=/" });
      return response.end();
    }
    response.end(`container ${request.url}`);
  });
  const upgrades = new Set<Duplex>();
  app.on("upgrade", (request, socket) => {
    upgrades.add(socket);
    socket.on("close", () => upgrades.delete(socket));
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let data = Buffer.alloc(0);
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 6 || data.length < 6 + (data[1] & 0x7f)) return;
      const length = data[1] & 0x7f, mask = data.subarray(2, 6), payload = Buffer.alloc(length);
      for (let index = 0; index < length; index++) payload[index] = data[6 + index] ^ mask[index % 4];
      socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]));
      data = data.subarray(6 + length);
    });
  });
  await listen(app);
  const socks = fakeSocks(seen);
  await listen(socks);
  const gateway = new PreviewGateway({ getSession: id => id === "test-session" ? { proxyUrl: `socks5h://test-session:private-engine-password@127.0.0.1:${portOf(socks)}` } : undefined });
  try {
    const target = `http://localhost:${portOf(app)}`;
    const desktop = await gateway.createDesktop("test-session", target);
    const proxy = new URL(desktop.proxyUrl);
    const authorization = `Basic ${Buffer.from(`${desktop.proxyAuth.username}:${desktop.proxyAuth.password}`).toString("base64")}`;
    assert.equal((await request({ hostname: proxy.hostname, port: proxy.port, path: `${target}/unauthorized` })).status, 407);
    const result = await request({ hostname: proxy.hostname, port: proxy.port, path: `${target}/hello`, headers: { "proxy-authorization": authorization } });
    assert.equal(result.body, "container /hello");
    assert.equal(receivedHeaders.at(-1)?.["proxy-authorization"], undefined);
    const tunneled = await connectGet(proxy, `localhost:${portOf(app)}`, authorization);
    assert.match(tunneled, /container \/tunnel/);
    const upgraded = await proxyWebSocket(proxy, `${target}/socket`, authorization);
    assert.equal(await echoRaw(upgraded), "desktop-stream");
    upgraded.destroy();

    const browser = await gateway.createBrowser("test-session", `${target}/start`);
    const preview = new URL(browser.url);
    const base = { hostname: "127.0.0.1", port: preview.port, headers: { host: preview.host } };
    assert.equal((await request({ ...base, path: "/" })).status, 403);
    assert.equal((await request({ ...base, path: preview.pathname, headers: { host: "unpaired.example" } })).status, 403);
    const bootstrap = await request({ ...base, path: preview.pathname });
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.location, "/start");
    const cookie = bootstrap.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    assert.ok(cookie);
    const headers = { host: preview.host, cookie };
    const redirect = await request({ ...base, headers, path: "/redirect" });
    assert.equal(redirect.headers.location, `${browser.origin}/done`);
    assert.equal(redirect.headers["set-cookie"]?.[0], "app=present; Path=/");
    assert.equal(receivedHeaders.at(-1)?.cookie, undefined);
    assert.equal(receivedHeaders.at(-1)?.["x-forwarded-host"], preview.host);
    const browserSocket = await proxyWebSocket(new URL(`http://127.0.0.1:${preview.port}`), "/socket", undefined, headers);
    assert.equal(await echoRaw(browserSocket), "desktop-stream");
    browserSocket.destroy();
    assert.ok(seen.length >= 5);
    assert.ok(seen.every(route => route.host === "localhost" && route.port === portOf(app)));
    await gateway.closeSession("test-session");
    await assert.rejects(request({ ...base, headers, path: "/after-close" }));
  } finally {
    await gateway.close();
    for (const socket of upgrades) socket.destroy();
    app.closeAllConnections();
    await close(app);
    await close(socks);
  }
});

test("hosted preview listener isolates grants by HTTPS hostname", async () => {
  const app = http.createServer((_request, response) => response.end("hosted container"));
  await listen(app);
  const available = net.createServer();
  await listen(available);
  const hostedPort = portOf(available);
  await close(available);
  const gateway = new PreviewGateway({
    getSession: () => undefined,
    connectPeer: async (_session, target) => {
      const stream = net.connect({ host: "127.0.0.1", port: target.port });
      await once(stream, "connect");
      return stream;
    },
    publicBrowserGateway: { originTemplate: "https://{id}.preview.example.org", port: hostedPort },
  });
  try {
    const first = await gateway.createBrowser("first-session", `http://localhost:${portOf(app)}`);
    const second = await gateway.createBrowser("second-session", `http://localhost:${portOf(app)}`);
    const firstUrl = new URL(first.url), secondUrl = new URL(second.url);
    const base = { hostname: "127.0.0.1", port: hostedPort };
    const bootstrap = await request({ ...base, path: firstUrl.pathname, headers: { host: firstUrl.host } });
    assert.equal(bootstrap.status, 303);
    assert.match(bootstrap.headers["set-cookie"]?.[0] ?? "", /HttpOnly; Secure; SameSite=None/);
    const cookie = bootstrap.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    assert.equal((await request({ ...base, path: "/", headers: { host: firstUrl.host, cookie } })).body, "hosted container");
    assert.equal((await request({ ...base, path: "/", headers: { host: secondUrl.host, cookie } })).status, 403);
    assert.equal((await request({ ...base, path: "/", headers: { host: "factory.example.org", cookie } })).status, 404);
    await gateway.closePreview(first.id);
    assert.equal((await request({ ...base, path: "/", headers: { host: firstUrl.host, cookie } })).status, 404);
  } finally {
    await gateway.close();
    app.closeAllConnections();
    await close(app);
  }
});

function portOf(server: http.Server | net.Server) { return (server.address() as AddressInfo).port; }
async function listen(server: http.Server | net.Server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
async function close(server: http.Server | net.Server) { await new Promise<void>(resolve => server.close(() => resolve())); }
function request(options: http.RequestOptions): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.get(options, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: response.headers }));
    });
    outgoing.on("error", reject);
  });
}
function connectGet(proxy: URL, authority: string, authorization: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: authority, headers: { "proxy-authorization": authorization } });
    outgoing.on("connect", (response, socket) => {
      assert.equal(response.statusCode, 200);
      let data = "";
      socket.on("data", chunk => data += chunk.toString());
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      socket.write(`GET /tunnel HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}
async function proxyWebSocket(proxy: URL, target: string, authorization?: string, extraHeaders: http.OutgoingHttpHeaders = {}): Promise<Duplex> {
  const outgoing = http.request({ hostname: proxy.hostname, port: proxy.port, path: target, headers: {
    ...(authorization ? { "proxy-authorization": authorization } : {}), ...extraHeaders,
    connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  } });
  const result = new Promise<Duplex>((resolve, reject) => {
    outgoing.on("upgrade", (response, socket, head) => {
      assert.equal(response.statusCode, 101);
      assert.equal(response.headers["sec-websocket-accept"], "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    outgoing.on("error", reject);
  });
  outgoing.end();
  return result;
}
function echoRaw(socket: Duplex): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length < 2 || response.length < 2 + (response[1] & 0x7f)) return;
      socket.off("data", read);
      assert.equal(response[0], 0x81);
      resolve(response.subarray(2).toString());
    };
    socket.on("data", read);
    socket.once("error", reject);
    const payload = Buffer.from("desktop-stream"), mask = Buffer.from([1, 2, 3, 4]);
    const frame = Buffer.alloc(6 + payload.length);
    frame[0] = 0x81; frame[1] = 0x80 | payload.length; mask.copy(frame, 2);
    for (let index = 0; index < payload.length; index++) frame[6 + index] = payload[index] ^ mask[index % 4];
    socket.write(frame);
  });
}
function fakeSocks(seen: Array<{ host: string; port: number }>) {
  return net.createServer(client => {
    let data = Buffer.alloc(0);
    let state = "greeting";
    const read = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      while (true) {
        if (state === "greeting") {
          if (data.length < 2 || data.length < 2 + data[1]) return;
          assert.equal(data[0], 5);
          data = data.subarray(2 + data[1]); state = "auth"; client.write(Buffer.from([5, 2]));
        } else if (state === "auth") {
          if (data.length < 2 || data.length < 3 + data[1]) return;
          const userLength = data[1], passwordLength = data[2 + userLength];
          if (data.length < 3 + userLength + passwordLength) return;
          assert.equal(data.subarray(2, 2 + userLength).toString(), "test-session");
          assert.equal(data.subarray(3 + userLength, 3 + userLength + passwordLength).toString(), "private-engine-password");
          data = data.subarray(3 + userLength + passwordLength); state = "connect"; client.write(Buffer.from([1, 0]));
        } else if (state === "connect") {
          if (data.length < 5) return;
          assert.equal(data[3], 3);
          const hostLength = data[4];
          if (data.length < 7 + hostLength) return;
          const host = data.subarray(5, 5 + hostLength).toString(), port = data.readUInt16BE(5 + hostLength);
          data = data.subarray(7 + hostLength);
          seen.push({ host, port }); state = "stream";
          client.off("data", read);
          client.pause();
          const upstream = net.connect({ host: "127.0.0.1", port }, () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            if (data.length) upstream.write(data);
            client.pipe(upstream); upstream.pipe(client); client.resume();
          });
          client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
          upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
          return;
        } else return;
      }
    };
    client.on("data", read);
  });
}
