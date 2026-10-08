import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MCP_FETCH_SCRIPT, runBrowserDocker } from '../src/docker.ts';

test('CLI transport preserves UTF-8 split across subprocess output chunks', async t => {
  const root=await mkdtemp(join(tmpdir(),'enough-browser-cli-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cliPath=join(root,'fixture-cli');
  await writeFile(cliPath,`#!/usr/bin/env node
const bytes=Buffer.from('✉️ 中文');process.stdout.write(bytes.subarray(0,1));process.stderr.write(bytes.subarray(0,1));setTimeout(()=>{process.stdout.write(bytes.subarray(1));process.stderr.write(bytes.subarray(1));},50);
`,{mode:0o700});
  const result=await runBrowserDocker({host:'unix://'+join(root,'fixture.sock'),cliPath,configDirectory:join(root,'config')},['fixture']);
  assert.equal(result.code,0);assert.equal(result.stdout,'✉️ 中文');assert.equal(result.stderr,'✉️ 中文');
});

async function execute(input: unknown) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve,reject) => {
    const child = spawn(process.execPath, ['--input-type=module','-e',MCP_FETCH_SCRIPT], { stdio: ['pipe','pipe','pipe'] });
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;}); child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',reject); child.once('close',code=>resolve({code:code??1,stdout,stderr}));
    child.stdin.end(JSON.stringify(input));
  });
}

test('actual transport parses MCP SSE, retains image bytes and handles split UTF-8 and empty notifications', async t => {
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);
    const rpc=JSON.parse(Buffer.concat(chunks).toString());
    if(rpc.method==='notifications/initialized'){response.writeHead(204);response.end();return;}
    assert.equal(request.headers['mcp-session-id'],'fixture-session');
    response.writeHead(200,{'Content-Type':'text/event-stream','mcp-session-id':'fixture-session'});
    const result={jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:'Mail ✉️ 中文'},{type:'image',mimeType:'image/png',data:'fixture-image-bytes'}]}};
    const bytes=Buffer.from(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',method:'notifications/progress'})}\n\nevent: message\ndata: ${JSON.stringify(result)}\n\n`);
    const split=bytes.indexOf(Buffer.from('✉'))+1;
    response.write(bytes.subarray(0,split));setImmediate(()=>response.end(bytes.subarray(split)));
  });
  let port=0;
  for(let attempt=0;attempt<20;attempt++){
    const candidate=randomInt(20000,40000);
    try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(candidate,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});port=candidate;break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error;}
  }
  assert.ok(port);
  t.after(()=>new Promise<void>(resolve=>{server.close(()=>resolve());}));
  const base={url:`http://127.0.0.1:${port}/mcp`,sessionId:'fixture-session',timeoutMs:3000};
  const response=await execute({...base,request:{jsonrpc:'2.0',id:7,method:'tools/call'}});
  assert.equal(response.code,0,response.stderr);
  const decoded=JSON.parse(response.stdout);
  assert.equal(decoded.message.id,7);assert.equal(decoded.sessionId,'fixture-session');
  assert.equal(decoded.message.result.content[0].text,'Mail ✉️ 中文');
  assert.equal(decoded.message.result.content[1].data,'fixture-image-bytes');
  const notification=await execute({...base,request:{jsonrpc:'2.0',method:'notifications/initialized'}});
  assert.equal(notification.code,0,notification.stderr);assert.equal(JSON.parse(notification.stdout).status,204);
});

test('actual transport rejects public endpoints and credential-bearing URLs before connecting', async()=>{
  for(const url of ['https://example.com/mcp','http://127.0.0.1:20001/other','http://secret@127.0.0.1:20001/mcp','http://127.0.0.1:20001/mcp?token=private','http://127.0.0.1:80/mcp']){
    const result=await execute({url,timeoutMs:100,request:{jsonrpc:'2.0',id:1,method:'initialize'}});
    assert.notEqual(result.code,0);assert.match(result.stderr,/Invalid private browser endpoint/);
  }
});
