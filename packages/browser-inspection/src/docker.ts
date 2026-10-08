import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { dockerInvocation, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { BrowserInspectionError } from './types.ts';

export interface BrowserDockerResult { code: number; stdout: string; stderr: string; }
export interface BrowserDockerOptions { signal?: AbortSignal; timeoutMs?: number; input?: string; maxOutputBytes?: number; }
export type BrowserDockerRunner = (endpoint: DockerRuntimeEndpoint, args: readonly string[], options?: BrowserDockerOptions) => Promise<BrowserDockerResult>;

/** All commands use the app-owned endpoint; no user's Docker context or socket fallback. */
export const runBrowserDocker: BrowserDockerRunner = async (endpoint, args, options = {}) => {
  options.signal?.throwIfAborted();
  const invocation = dockerInvocation(endpoint, args);
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', outputBytes = 0, failure: Error | undefined;
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error; child.stdin.destroy(); child.kill('SIGTERM');
      force = setTimeout(() => child.kill('SIGKILL'), 2000); force.unref();
    };
    const abort = () => stop(new BrowserInspectionError('Browser transport was interrupted; its action may have executed.', 'TRANSPORT_INTERRUPTED', true));
    const timer = setTimeout(() => stop(new BrowserInspectionError('Browser transport exceeded its deadline; its action may have executed.', 'TRANSPORT_TIMEOUT', true)), options.timeoutMs ?? 30_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > (options.maxOutputBytes ?? 40 * 1024 ** 2)) stop(new BrowserInspectionError('Browser response exceeded its transfer limit.', 'RESPONSE_TOO_LARGE', true));
      else stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + stderrDecoder.write(chunk)).slice(-8192); });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
    const clean = () => { clearTimeout(timer); if (force) clearTimeout(force); options.signal?.removeEventListener('abort', abort); };
    child.once('error', error => { clean(); reject(failure ?? error); });
    child.once('close', code => { clean(); stdout += stdoutDecoder.end(); stderr = (stderr + stderrDecoder.end()).slice(-8192); if (failure) reject(failure); else resolve({ code: code ?? 1, stdout, stderr }); });
  });
};

/** Fixed container-side transport. Request JSON is stdin, never interpolated shell code. */
export const MCP_FETCH_SCRIPT = `
const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk);
const input=JSON.parse(Buffer.concat(chunks).toString());
const target=new URL(input.url);
if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||Number(target.port)<20000||Number(target.port)>39999||target.pathname!=='/mcp'||target.search||target.hash||target.username||target.password) throw Error('Invalid private browser endpoint');
const headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'};
if(input.sessionId) headers['Mcp-Session-Id']=input.sessionId;
const response=await fetch(input.url,{method:'POST',headers,body:JSON.stringify(input.request),signal:AbortSignal.timeout(input.timeoutMs)});
let bytes=0, body=''; const decoder=new TextDecoder(); if(response.body) for await(const chunk of response.body){bytes+=chunk.length;if(bytes>32*1024*1024)throw Error('Browser response exceeds its transfer limit');body+=decoder.decode(chunk,{stream:true});} body+=decoder.decode();
let message;
if(response.ok&&body.trim()){
 if((response.headers.get('content-type')||'').includes('text/event-stream')){
  for(const event of body.split(/\\r?\\n\\r?\\n/)){const data=event.split(/\\r?\\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\\n');if(data){const value=JSON.parse(data);if(value.id===input.request.id)message=value;}}
 }else message=JSON.parse(body);
}
process.stdout.write(JSON.stringify({status:response.status,sessionId:response.headers.get('mcp-session-id')||undefined,message,errorText:response.ok?undefined:body.slice(0,2048)}));
`;
