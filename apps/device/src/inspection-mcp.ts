import net, { type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { dockerInvocation, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import type { AgentMcpServer } from '@enoughfactory/agents';
import { equalSecret } from './util.ts';

export interface McpRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; }
export type McpHandler = (request: McpRequest) => Promise<unknown>;
export interface InspectionMcpBridge { server: AgentMcpServer; environment: Record<string,string>; close(): Promise<void>; }
const maxRequestBytes=1024*1024;
const tokenVariable='ENOUGHFACTORY_INSPECTION_TOKEN';

// Only this client runs in a provider process. No service/master credentials,
// host ports or Docker socket are available through the bridge.
export const MCP_CLIENT_SOURCE=String.raw`
const net=require('node:net');
const socket=net.connect(process.argv[1]);
let input='',output='';
socket.on('error',error=>{process.stderr.write('Factory inspection unavailable: '+error.message+'\n');process.exitCode=1;process.stdin.destroy();});
socket.on('close',()=>process.stdin.destroy());
socket.on('data',chunk=>{output+=chunk;let end;while((end=output.indexOf('\n'))>=0){const line=output.slice(0,end);output=output.slice(end+1);if(Buffer.byteLength(line)>24*1024*1024){socket.destroy(new Error('Inspection response exceeded its limit'));return;}process.stdout.write(line+'\n');}if(output.length>24*1024*1024)socket.destroy(new Error('Inspection response exceeded its limit'));});
process.stdin.on('data',chunk=>{input+=chunk;let end;while((end=input.indexOf('\n'))>=0){const line=input.slice(0,end);input=input.slice(end+1);if(!line)continue;if(Buffer.byteLength(line)>1024*1024){socket.destroy(new Error('Inspection request exceeded its limit'));return;}let request;try{request=JSON.parse(line);}catch{continue;}socket.write(JSON.stringify({token:process.env.ENOUGHFACTORY_INSPECTION_TOKEN,request})+'\n');}if(input.length>1024*1024)socket.destroy(new Error('Inspection request exceeded its limit'));});
process.stdin.on('end',()=>socket.end());
`;

/** The service's docker-exec channel is the transport, never a published port. */
export const MCP_CONTAINER_RELAY_SOURCE=String.raw`
const net=require('node:net'),fs=require('node:fs'),readline=require('node:readline');
const socketPath=process.argv[1],connections=new Map();let next=0;
const server=net.createServer(socket=>{const connection=String(++next);connections.set(connection,socket);let pending='';socket.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(Buffer.byteLength(line)>1024*1024){socket.destroy();return;}try{process.stdout.write(JSON.stringify({...JSON.parse(line),connection})+'\n');}catch{socket.destroy();}}if(pending.length>1024*1024)socket.destroy();});socket.on('error',()=>{});socket.on('close',()=>connections.delete(connection));});
server.on('error',error=>{process.stderr.write(error.message+'\n');process.exit(1);});
server.listen(socketPath,()=>{fs.chmodSync(socketPath,0o600);process.stdout.write(JSON.stringify({ready:true})+'\n');});
readline.createInterface({input:process.stdin}).on('line',line=>{try{const packet=JSON.parse(line),socket=connections.get(packet.connection);if(socket&&!socket.destroyed)socket.write(JSON.stringify(packet.response)+'\n');}catch{}}).on('close',()=>{for(const socket of connections.values())socket.destroy();server.close(()=>{try{fs.unlinkSync(socketPath);}catch{}process.exit(0);});});
process.on('SIGTERM',()=>process.stdin.destroy());
`;

async function responseFor(token:string,packet:unknown,handler:McpHandler):Promise<unknown|undefined>{
  const envelope=packet as {token?:unknown;request?:McpRequest};
  const request=envelope?.request;
  if(!request||request.jsonrpc!=='2.0'||typeof request.method!=='string')return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid inspection request.'}};
  if(typeof envelope.token!=='string'||!equalSecret(token,envelope.token))return {jsonrpc:'2.0',id:request.id??null,error:{code:-32001,message:'This inspection authority is no longer valid.'}};
  try{
    const result=await handler(request);
    return request.id===undefined?undefined:{jsonrpc:'2.0',id:request.id,result:result??{}};
  }catch(error){return request.id===undefined?undefined:{jsonrpc:'2.0',id:request.id,error:{code:-32000,message:(error as Error).message}};}
}

function configuration(socketPath:string,token:string,node:string):Pick<InspectionMcpBridge,'server'|'environment'>{
  return {server:{command:node,args:['-e',MCP_CLIENT_SOURCE,socketPath],env:{[tokenVariable]:token},startupTimeoutSeconds:30,toolTimeoutSeconds:300},environment:{}};
}

export async function createHostInspectionBridge(token:string,handler:McpHandler,node=process.execPath):Promise<InspectionMcpBridge>{
  // Unix-domain path limits make the long application-support directory unsuitable.
  const directory=path.join('/tmp',`ef-inspection-${process.getuid?.()??'user'}`);
  await mkdir(directory,{recursive:true,mode:0o700});
  const status=await lstat(directory);
  if(!status.isDirectory()||status.isSymbolicLink()||status.uid!==process.getuid?.()||(status.mode&0o077)!==0)throw new Error('Factory inspection IPC directory is not privately owned.');
  const socketPath=path.join(directory,`${randomUUID()}.sock`),connections=new Set<Socket>();
  let closed=false;
  const server=net.createServer(socket=>{
    connections.add(socket);let pending='',chain=Promise.resolve();
    socket.on('error',()=>{});socket.on('close',()=>connections.delete(socket));
    socket.on('data',chunk=>{
      pending+=chunk.toString();let end:number;
      while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);
        if(Buffer.byteLength(line)>maxRequestBytes){socket.destroy();return;}
        chain=chain.then(async()=>{let packet:unknown;try{packet=JSON.parse(line);}catch{socket.destroy();return;}
          const response=await responseFor(closed?'':token,packet,handler);
          if(response!==undefined&&!socket.destroyed)socket.write(JSON.stringify(response)+'\n');
        }).catch(()=>{socket.destroy();});
      }
      if(Buffer.byteLength(pending)>maxRequestBytes)socket.destroy();
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  try{await chmod(socketPath,0o600);}
  catch(error){for(const socket of connections)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));throw error;}
  return {...configuration(socketPath,token,node),async close(){if(closed)return;closed=true;for(const socket of connections)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await unlink(socketPath).catch(()=>{});}};
}

export async function createContainerInspectionBridge(endpoint:DockerRuntimeEndpoint,containerId:string,token:string,handler:McpHandler):Promise<InspectionMcpBridge>{
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerId))throw new Error('Invalid author container identity.');
  const socketPath=`/tmp/ef-inspection-${randomUUID()}.sock`,node='/opt/enoughfactory/node/bin/node';
  const invocation=dockerInvocation(endpoint,['exec','-i','--user','0',containerId,node,'-e',MCP_CONTAINER_RELAY_SOURCE,socketPath]);
  const child=spawn(invocation.command,invocation.args,{env:invocation.env,stdio:'pipe'});
  let closed=false,stderr='',chain=Promise.resolve();child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});child.stdin.on('error',()=>{});
  let ready!:()=>void,fail!:(error:Error)=>void;
  const readiness=new Promise<void>((resolve,reject)=>{ready=resolve;fail=reject;});
  const exited=new Promise<void>(resolve=>{child.once('close',()=>{fail(new Error(stderr||'Inspection transport closed before becoming ready.'));resolve();});child.once('error',error=>{fail(error);resolve();});});
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{
    if(Buffer.byteLength(line)>maxRequestBytes){child.stdin.end();return;}
    let packet:{ready?:boolean;connection?:string};try{packet=JSON.parse(line);}catch{return;}
    if(packet.ready){ready();return;}
    chain=chain.then(async()=>{const response=await responseFor(closed?'':token,packet,handler);if(response!==undefined&&!child.stdin.destroyed)child.stdin.write(JSON.stringify({connection:packet.connection,response})+'\n');}).catch(()=>{child.stdin.end();});
  });
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([readiness,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Inspection transport did not become ready.')),30000);})]);}
  catch(error){closed=true;child.stdin.end();child.kill('SIGTERM');throw error;}
  finally{if(timer)clearTimeout(timer);}
  return {...configuration(socketPath,token,node),async close(){if(closed)return;closed=true;child.stdin.end();let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([exited,new Promise<void>(resolve=>{timer=setTimeout(()=>{child.kill('SIGTERM');resolve();},3000);})]);if(timer)clearTimeout(timer);lines.close();}};
}

export function inspectionMcpHandler(tools:Array<{name:string;description:string;inputSchema:Record<string,unknown>}>,call:(name:string,args:Record<string,unknown>)=>Promise<unknown>):McpHandler{
  return async request=>{
    if(request.method==='initialize')return {protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:false}},serverInfo:{name:'enoughfactory-inspection',version:'1.0.0'},instructions:'Operate your owned app, inspect screenshots and verify the resulting state. Source identities and observations are immutable; re-observe after each action.'};
    if(request.method==='notifications/initialized'||request.method==='ping')return {};
    if(request.method==='tools/list')return {tools};
    if(request.method==='tools/call'){
      const name=request.params?.name,args=request.params?.arguments===undefined?{}:request.params.arguments;
      const tool=typeof name==='string'?tools.find(tool=>tool.name===name):undefined;
      if(!tool||!args||typeof args!=='object'||Array.isArray(args))throw new Error('Unknown inspection tool or invalid arguments.');
      validateToolArguments(args,tool.inputSchema);
      return call(tool.name,args as Record<string,unknown>);
    }
    throw new Error(`Unsupported inspection method: ${request.method}`);
  };
}

/** The advertised tool subset only; opaque action/report objects remain backend-owned. */
function validateToolArguments(value:unknown,schema:Record<string,unknown>):void{
  let nodes=0;
  const fail=(path:string,reason:string):never=>{throw new Error(`Invalid inspection arguments at ${path}: ${reason}.`);};
  const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
  const visit=(value:unknown,schema:Record<string,unknown>,path:string,depth:number,declaredKey?:string):void=>{
    if(++nodes>30000||depth>32)fail(path,'argument structure exceeds its limit');
    const type=schema.type;
    const matches=(type:unknown):boolean=>type==='object'?record(value):type==='array'?Array.isArray(value)
      :type==='string'?typeof value==='string':type==='boolean'?typeof value==='boolean':type==='null'?value===null
      :type==='integer'?typeof value==='number'&&Number.isSafeInteger(value):type==='number'?typeof value==='number'&&Number.isFinite(value):false;
    if(type!==undefined&&!(Array.isArray(type)?type.some(matches):matches(type)))fail(path,'value does not match the advertised type');
    if(Array.isArray(schema.enum)&&!schema.enum.some(allowed=>JSON.stringify(allowed)===JSON.stringify(value)))fail(path,'value is not an advertised choice');
    if(typeof value==='string'){
      if(Buffer.byteLength(value)>64*1024)fail(path,'string exceeds its limit');
      if(declaredKey&&/Ids?$/.test(declaredKey)&&(value.trim().length===0||Buffer.byteLength(value)>512))fail(path,'identifier must be nonblank and at most 512 bytes');
      const length=Array.from(value).length;
      if(typeof schema.minLength==='number'&&length<schema.minLength)fail(path,'string is shorter than its advertised minimum');
      if(typeof schema.maxLength==='number'&&length>schema.maxLength)fail(path,'string is longer than its advertised maximum');
    }else if(typeof value==='number'){
      if(!Number.isFinite(value))fail(path,'number must be finite');
      if(typeof schema.minimum==='number'&&value<schema.minimum)fail(path,'number is below its advertised minimum');
      if(typeof schema.maximum==='number'&&value>schema.maximum)fail(path,'number is above its advertised maximum');
    }else if(Array.isArray(value)){
      if(typeof schema.minItems==='number'&&value.length<schema.minItems)fail(path,'array is shorter than its advertised minimum');
      if(typeof schema.maxItems==='number'&&value.length>schema.maxItems)fail(path,'array is longer than its advertised maximum');
      const items=record(schema.items)?schema.items:{};
      for(const [index,item] of value.entries())visit(item,items,`${path}[${index}]`,depth+1,record(schema.items)?declaredKey:undefined);
    }else if(record(value)){
      const properties=record(schema.properties)?schema.properties:{};
      if(Array.isArray(schema.required))for(const key of schema.required){
        if(typeof key==='string'&&!Object.hasOwn(value,key))fail(`${path}.${key}`,'required field is missing');
      }
      for(const [key,item] of Object.entries(value)){
        if(Buffer.byteLength(key)>512)fail(path,'object field name exceeds its limit');
        const declared=Object.hasOwn(properties,key);
        if(!declared&&schema.additionalProperties===false)fail(`${path}.${key}`,'field is not advertised');
        const child=declared&&record(properties[key])?properties[key]:record(schema.additionalProperties)?schema.additionalProperties:{};
        visit(item,child,`${path}.${key}`,depth+1,declared?key:undefined);
      }
    }
  };
  visit(value,schema,'arguments',0);
}
