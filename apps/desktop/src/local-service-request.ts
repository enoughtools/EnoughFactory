import { request } from 'node:http';
import { Readable } from 'node:stream';

/** Local JSON control requests, independent of Electron's bundled Undici socket implementation. */
export const requestLocalService: typeof fetch = async (input, init = {}) => {
  if (typeof input !== 'string' && !(input instanceof URL)) throw new TypeError('The device request requires a local service address.');
  const url = new URL(input);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new TypeError('The desktop device service must use a loopback HTTP address.');
  }
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new TypeError('The device request body must be JSON text.');
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
  const body = init.body as string | undefined | null;
  if (body !== undefined && body !== null && !Object.hasOwn(headers, 'content-length')) headers['content-length'] = String(Buffer.byteLength(body));

  return new Promise<Response>((resolve, reject) => {
    const fail = (error: unknown) => reject(signal?.aborted ? signal.reason : error);
    // Never route a device token through Chromium/system proxies or redirect it.
    // A fresh connection also leaves no reusable socket tied to a retired daemon.
    const outgoing = request(url, {
      hostname: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname === '[::1]' ? '::1' : url.hostname,
      method: init.method ?? 'GET', headers, agent: false, signal,
    }, incoming => {
      incoming.once('error', fail);
      try {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        const status = incoming.statusCode ?? 500;
        const empty = init.method?.toUpperCase() === 'HEAD' || [204, 205, 304].includes(status);
        const responseBody = empty ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        if (responseBody) {
          // Keep cancellation attached through body consumption, with its actual
          // caller reason. Stream cancellation itself destroys IncomingMessage.
          const abortBody = () => { incoming.destroy(signal!.reason); };
          signal?.addEventListener('abort', abortBody, { once: true });
          incoming.once('close', () => signal?.removeEventListener('abort', abortBody));
          if (signal?.aborted) { abortBody(); fail(signal.reason); return; }
        } else incoming.resume();
        // Shutdown ownership depends on headers, even if its body is still pending.
        resolve(new Response(responseBody, { status, statusText: incoming.statusMessage, headers: responseHeaders }));
      } catch (error) { incoming.destroy(); fail(error); }
    });
    outgoing.once('error', fail);
    outgoing.end(body);
  });
};
