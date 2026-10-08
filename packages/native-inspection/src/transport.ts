import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { NativeInspectionError } from './types.js';

interface Pending { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; }
export class HelperTransport {
  readonly process: ChildProcessWithoutNullStreams;
  readonly pending = new Map<string, Pending>();
  stderr = '';
  constructor(executable: string, readonly timeoutMs = 30_000) {
    this.process = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stderr.on('data', bytes => { this.stderr = (this.stderr + String(bytes)).slice(-32_768); });
    createInterface({ input: this.process.stdout }).on('line', line => {
      let result: any; try { result = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(result.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(result.id);
      if (result.ok) pending.resolve(result.value);
      else pending.reject(new NativeInspectionError(result.error?.code ?? 'native-error', result.error?.message ?? 'Native helper failed.'));
    });
    const exited = () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new NativeInspectionError('helper-disconnected', 'Native helper disconnected; reconcile its owned application before replacing the session.')); }
      this.pending.clear();
    };
    this.process.on('exit', exited); this.process.on('error', exited);
    this.process.stdin.on('error', exited);
  }
  call(request: Record<string, unknown>): Promise<any> {
    if (this.process.exitCode !== null || this.process.signalCode !== null || this.process.killed || this.process.stdin.destroyed || this.process.stdin.writableEnded) return Promise.reject(new NativeInspectionError('helper-disconnected', 'Native helper is not connected.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new NativeInspectionError('action-unknown', 'Native operation did not confirm its outcome; observe/reconcile before repeating it.')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ ...request, id }) + '\n');
    });
  }
  close(): void { this.process.stdin.end(); }
}

/** Loopback transport consumed only by the owned XCUITest runner. Token never enters URL/logs. */
export class IOSCommandBroker {
  readonly token = randomUUID() + randomUUID();
  readonly server: Server;
  url = '';
  private queue: Record<string, unknown>[] = [];
  private pending = new Map<string, Pending>();
  private readyResolve!: () => void;
  private readyPromise = new Promise<void>(resolve => { this.readyResolve = resolve; });
  readyIdentity?: Record<string, unknown>;
  constructor(readonly sessionId: string, readonly timeoutMs = 30_000) {
    this.server = createServer(async (req, res) => {
      const supplied = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${this.token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401); res.end(); return; }
      if (req.method === 'GET' && req.url === '/v1/command') {
        const command = this.queue.shift(); if (!command) { res.writeHead(204); res.end(); return; }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(command)); return;
      }
      if (req.method !== 'POST' || !['/v1/result', '/v1/ready'].includes(req.url ?? '')) { res.writeHead(404); res.end(); return; }
      let size = 0; const chunks: Buffer[] = [];
      try {
        for await (const chunk of req) { size += chunk.length; if (size > 24 * 1024 * 1024) throw new Error('Result too large'); chunks.push(chunk); }
        const result = JSON.parse(Buffer.concat(chunks).toString());
        if (result.sessionId !== this.sessionId) throw new Error('Session mismatch');
        if (req.url === '/v1/ready') { this.readyIdentity = result; this.readyResolve(); }
        else {
          const pending = this.pending.get(result.id);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(result.id); result.ok ? pending.resolve(result.value) : pending.reject(new NativeInspectionError(result.error?.code ?? 'native-error', result.error?.message ?? 'iOS inspection failed.')); }
        }
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('No broker address');
    this.url = `http://127.0.0.1:${address.port}`;
  }
  async ready(timeoutMs = 120_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.readyPromise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NativeInspectionError('runner-not-ready', 'The owned iOS UI runner did not become ready.')), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  call(action: Record<string, unknown>): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.queue = this.queue.filter(item => item.id !== id); reject(new NativeInspectionError('action-unknown', 'The iOS operation did not confirm its outcome; reconcile before repeating it.')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.queue.push({ id, sessionId: this.sessionId, action });
    });
  }
  close(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new NativeInspectionError('session-closed', 'The iOS inspection transport closed.')); }
    this.pending.clear(); this.queue = []; this.server.close();
  }
}
