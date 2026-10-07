import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import type { FactoryState, Project, Session, Chat, Settings, Device, Diagnostics, ContainerRuntimeStatus } from '@enoughfactory/contracts';
import { ManagedRuntimeManager, SWIFT_TOOLCHAIN, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { PRODUCT } from '@enoughfactory/contracts';
import { Store } from './store.ts';
import { SessionController } from './sessions.ts';
import { validateWorkingDirectories } from '@enoughfactory/workspaces';
import { CatalogRemoval } from './catalog-removal.ts';
import { equalSecret, exec, HttpError, id, now } from './util.ts';
import { configuredWorkerCapacity, runtimeWorkerResources, validWorkerCapacity } from './worker-capacity.ts';
import { parseDevelopmentToolchain } from './development-toolchain.ts';

export interface ApiCall { method: string; url: URL; body: Record<string, unknown>; peerId?: string; }
export type Extension = (call: ApiCall) => Promise<unknown | undefined>;
const MIME: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.json':'application/json'};
export class DeviceApp {
  readonly dataDir = process.env.ENOUGHFACTORY_HOME || path.join(homedir(), '.enoughfactory');
  readonly repositoryRoot = process.env.ENOUGHFACTORY_REPO || path.resolve(process.cwd(),process.cwd().endsWith('/apps/device')?'../..':'.');
  readonly port = Number(process.env.ENOUGHFACTORY_PORT || 4317);
  readonly store = new Store(this.dataDir);
  readonly token: string;
  readonly sessions: SessionController;
  readonly removals: CatalogRemoval;
  readonly runtime: ManagedRuntimeManager;
  readonly runtimeStopHooks: Array<()=>Promise<void>> = [];
  readonly serviceActivityHooks: Array<()=>string[]> = [];
  readonly serviceHandoffHooks: Array<()=>void> = [];
  readonly server: http.Server;
  readonly extensions: Extension[] = [];
  readonly listeners = new Set<(topic:string,data:unknown)=>void>();
  readonly closers: Array<()=>void | Promise<void>> = [];
  routeRemote?: (call: ApiCall)=>Promise<unknown | undefined>;
  remoteTerminal?: (sessionId:string,url:URL,client:WebSocket)=>Promise<boolean>;
  catalog?: ()=>Partial<FactoryState>;
  device: Device;
  devices: Device[];
  diagnostics: Diagnostics = {docker:{available:false},envmux:{available:false},runtimes:[],networking:{hostedRelay:true}};
  private sse = new Set<ServerResponse>();
  private changeTimer?: ReturnType<typeof setTimeout>;
  private closing = false;
  private serviceUpdating = false;
  private activeApiOperations = 0;
  private runtimeStarting?:Promise<DockerRuntimeEndpoint>;
  private runtimeStopping = false;
  private runtimeSuspended = false;
  private runtimeOperations = new Map<string,{controller:AbortController;promise:Promise<unknown>}>();
  private socketServer = new WebSocketServer({noServer:true, maxPayload:1024*1024});
  settings: Settings;

  constructor() {
    mkdirSync(this.dataDir,{recursive:true,mode:0o700});
    const saved=this.store.get<{id:string;token:string}>('private','access');
    this.token=saved?.token || randomBytes(32).toString('base64url');
    if(!saved)this.store.set('private',{id:'access',token:this.token});
    this.settings=this.store.get<Settings & {id:string}>('settings','main') || {deviceName:hostname(),defaultRuntime:'codex',defaultApprovalMode:'approve-all'};
    this.device=this.store.get<Device>('devices','local') || {id:id('device'),name:this.settings.deviceName,platform:process.platform,arch:process.arch,online:true,lastSeen:now(),local:true,transport:'local',capacity:2};
    this.device={...this.device,name:this.settings.deviceName,online:true,lastSeen:now()};
    this.devices=[this.device];
    this.runtimeSuspended=Boolean(this.store.get<{id:string;suspended:boolean}>('private','runtime-control')?.suspended);
    this.syncRuntimeCapacity();
    this.runtime=new ManagedRuntimeManager({dataDir:this.dataDir,resourcesDirectory:process.env.ENOUGHFACTORY_CONTAINER_ASSETS||
      (process.env.ENOUGHFACTORY_RESOURCES?path.join(process.env.ENOUGHFACTORY_RESOURCES,'runtime/container'):path.join(this.repositoryRoot,'.cache/container-runtime',`${process.platform}-${process.arch}`)),onStatus:status=>this.runtimeStatus(status)});
    this.sessions=new SessionController(this.store,this.device.id,()=>this.changed(),(topic,data)=>this.emit(topic,data),{
      endpoint:this.runtime.endpoint,ensureReady:()=>this.ensureRuntimeReady(),bridgeHostAddress:()=>this.runtime.bridgeHostAddress()},path.join(this.dataDir,'workspace-data'));
    this.removals=new CatalogRemoval(this.store,this.sessions,()=>this.device.id,()=>this.changed());
    this.server=http.createServer((req,res)=>{void this.handle(req,res);});
    this.server.on('upgrade',(req,socket,head)=>{
      const url=new URL(req.url||'/',`http://127.0.0.1:${this.port}`);
      if(!this.authorized(req,url)){socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');socket.destroy();return;}
      const match=url.pathname.match(/^\/api\/sessions\/([^/]+)\/terminal$/);
      if(!match){socket.destroy();return;}
      try {
        this.socketServer.handleUpgrade(req,socket,head,client=>{void(async()=>{
          if(await this.remoteTerminal?.(match[1],url,client))return;
          const engine=this.sessions.get(match[1]); const upstreamUrl=new URL(engine.shellUrl(url.searchParams.get('terminalId')||'main'));
          for(const key of ['cols','rows']) if(url.searchParams.get(key))upstreamUrl.searchParams.set(key,url.searchParams.get(key)!);
          const upstream=new WebSocket(upstreamUrl,{headers:engine.shellHeaders()});
          const pending: Array<string | Buffer>=[];
          client.on('message',(data,binary)=>{
            const value=binary?Buffer.from(data as Buffer):data.toString();
            let message:string | Buffer=typeof value==='string'?Buffer.from(value):value;
            if(typeof value==='string'){try {const parsed=JSON.parse(value);if(parsed.type==='input')message=Buffer.from(String(parsed.data));if(parsed.type==='resize')message=JSON.stringify({resize:{cols:parsed.cols,rows:parsed.rows}});}catch{}}
            if(upstream.readyState===WebSocket.OPEN)upstream.send(message);else if(pending.length<256)pending.push(message);else client.close(1009,'Input queue full');
          });
          upstream.on('open',()=>{for(const message of pending)upstream.send(message);pending.length=0;});
          upstream.on('message',(data,binary)=>{if(client.readyState===WebSocket.OPEN)client.send(binary?data:JSON.stringify({type:'output',data:data.toString()}));});
          client.on('close',()=>upstream.close());upstream.on('close',()=>client.close());
          upstream.on('error',error=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify({type:'error',data:error.message}));client.close();});
          client.on('error',()=>upstream.close());
        })().catch(error=>{client.send(JSON.stringify({type:'error',data:error.message}));client.close();});});
      }catch {socket.write('HTTP/1.1 409 Conflict\r\n\r\n');socket.destroy();}
    });
  }
  private syncRuntimeCapacity():void {
    const state=this.diagnostics.containerRuntime?.state;
    const unavailable=this.runtimeSuspended||this.runtimeStopping||state==='stopping'||state==='unavailable'||state==='failed';
    const workerResources=runtimeWorkerResources(this.diagnostics.containerRuntime);
    this.device={...this.device,capacity:unavailable?0:configuredWorkerCapacity(this.settings,workerResources),workerResources,workspaceProviders:this.diagnostics.containerRuntime?.artifactFsSupported?['git','artifactfs']:['git']};
    this.devices=[this.device,...this.devices.filter(device=>!device.local&&device.id!==this.device.id)];
  }
  setDevice(device: Device): void {this.device=device;this.syncRuntimeCapacity();this.sessions.setDeviceId(device.id);}
  private runtimeStatus(status:ContainerRuntimeStatus):void {
    this.diagnostics={...this.diagnostics,containerRuntime:status,docker:{available:status.state==='ready',version:status.dockerVersion,error:status.error}};
    this.syncRuntimeCapacity();
    this.sessions?.runtimeProgress(status);this.emit('runtime',status);this.changed();
  }
  async refreshRuntime():Promise<ContainerRuntimeStatus>{const actual=await this.runtime.status();const status=this.runtimeStopping&&actual.state==='ready'?{...actual,state:'stopping' as const,phase:'Stopping environments and preserving their work'}:actual;this.runtimeStatus(status);return status;}
  assertServiceAvailable():void {if(this.serviceUpdating||this.closing)throw new HttpError(409,'The device service is updating. Reconnect to continue.','SERVICE_UPDATING');}
  serviceUpdateStatus():{canUpdate:boolean;idleShutdown:true;busy:string[]} {
    const busy:string[]=[];
    if(this.serviceUpdating||this.closing)busy.push('The device service is already updating or closing.');
    if(this.activeApiOperations)busy.push(`${this.activeApiOperations} API operation(s) are active.`);
    if(this.runtimeStarting||this.runtimeStopping||this.runtimeOperations.size)busy.push('Container runtime operations are active.');
    const sessions=this.sessions.serviceActivity();
    if(sessions.starting)busy.push(`${sessions.starting} environment(s) are starting.`);
    if(sessions.stopping)busy.push(`${sessions.stopping} environment(s) are stopping.`);
    const chats=this.store.list<Chat>('chats').filter(chat=>['running','waiting'].includes(chat.status)).length;
    if(chats)busy.push(`${chats} agent conversation(s) are active.`);
    for(const hook of this.serviceActivityHooks)busy.push(...hook());
    return {canUpdate:busy.length===0,idleShutdown:true,busy:[...new Set(busy)]};
  }
  scheduleServiceShutdown():void {setTimeout(()=>{void this.close().then(()=>process.exit(0));},200);}
  assertRuntimeCanRun():void {this.assertServiceAvailable();if(this.runtimeStopping||this.runtimeSuspended)throw new HttpError(409,'Start EnoughFactory’s runtime to continue.','RUNTIME_PAUSED');}
  allowRuntimeStart():void {this.assertServiceAvailable();if(this.runtimeStopping)throw new HttpError(409,'EnoughFactory is stopping its container runtime.');this.runtimeSuspended=false;this.store.set('private',{id:'runtime-control',suspended:false});this.syncRuntimeCapacity();}
  async ensureRuntimeReady():Promise<DockerRuntimeEndpoint>{
    this.assertServiceAvailable();
    if(this.runtimeStopping||this.runtimeSuspended)throw new HttpError(409,'EnoughFactory’s container runtime is stopped. Start it to continue.','RUNTIME_PAUSED');
    if(!this.runtimeStarting){
      const operation=this.runtime.ensureReady().then(async endpoint=>{await this.refreshRuntime();if(this.runtimeStopping||this.runtimeSuspended)throw new HttpError(409,'The container runtime was stopped while preparing work.','RUNTIME_PAUSED');return endpoint;})
        .catch(async error=>{await this.refreshRuntime().catch(()=>{});throw error;}).finally(()=>{if(this.runtimeStarting===operation)this.runtimeStarting=undefined;});
      this.runtimeStarting=operation;
    }
    return this.runtimeStarting;
  }
  async withRuntimeOperation<T>(operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    this.assertRuntimeCanRun();
    const operationId=id('runtime-op'),controller=new AbortController();
    const promise=operation(controller.signal).finally(()=>this.runtimeOperations.delete(operationId));
    this.runtimeOperations.set(operationId,{controller,promise});return promise;
  }
  state(includeArchived=false): FactoryState {
    const state:FactoryState={product:PRODUCT,version:'0.1.6',device:{...this.device,lastSeen:now()},devices:this.devices,projects:this.store.list<Project>('projects').filter(p=>!p.internal),sessions:this.store.list('sessions'),chats:this.store.list('chats'),approvals:this.store.list('approvals'),goals:this.store.list('goals'),tasks:this.store.list('tasks'),attempts:this.store.list('attempts'),diagnostics:this.diagnostics,settings:{...this.settings,turnCredential:undefined},...this.catalog?.()};
    if(includeArchived)return state;
    const removedProjects=new Set([...this.store.list<Project>('projects'),...state.projects].filter(project=>project.archivedAt).map(project=>project.id));
    const sessions=state.sessions.filter(session=>!session.archivedAt&&!removedProjects.has(session.projectId)),sessionIds=new Set(sessions.map(session=>session.id));
    return {...state,projects:state.projects.filter(project=>!project.archivedAt),sessions,chats:state.chats.filter(chat=>sessionIds.has(chat.sessionId))};
  }
  emit(topic: string,data: unknown): void {
    if(this.closing)return;
    const packet=`event: ${topic}\ndata: ${JSON.stringify(data)}\n\n`;
    for(const res of this.sse){if(res.writableLength>1024*1024){res.end();this.sse.delete(res);}else res.write(packet);}
    for(const listener of this.listeners)listener(topic,data);
  }
  changed(): void {if(this.closing||this.changeTimer)return;this.changeTimer=setTimeout(()=>{this.changeTimer=undefined;if(!this.closing)this.emit('state',this.state());},50);}
  async dispatch(call: ApiCall): Promise<unknown> {
    const updating=call.url.pathname==='/api/service/shutdown';
    const mutation=call.method!=='GET'&&!updating;
    if(mutation)this.assertServiceAvailable();
    if(mutation)this.activeApiOperations++;
    try{return await this.dispatchRequest(call);}
    finally{if(mutation)this.activeApiOperations--;}
  }
  private async dispatchRequest(call: ApiCall): Promise<unknown> {
    const {method,url,body}=call;const route=url.pathname;
    if(this.routeRemote){const remote=await this.routeRemote(call);if(remote!==undefined)return remote;}
    if(method==='GET' && route==='/api/health')return {ok:true,product:PRODUCT,version:'0.1.6',deviceId:this.device.id,capabilities:{idleServiceUpdate:true,workingDirectories:true,developmentToolchains:[SWIFT_TOOLCHAIN]},runtime:{kind:process.platform==='darwin'?'lima':'rootless',stateDirectory:this.runtime.dataDirectory,socketPath:this.runtime.endpoint.host.slice(7)}};
    if(method==='GET' && route==='/api/state')return this.state();
    if(method==='GET'&&route==='/api/service/update-status')return this.serviceUpdateStatus();
    if(method==='POST' && route==='/api/service/shutdown'){
      if(body.onlyIfIdle===true){
        if(body.expectedVersion!=='0.1.6')throw new HttpError(409,'The device service version changed. Check its update status again.','SERVICE_VERSION_CHANGED');
        const status=this.serviceUpdateStatus();if(!status.canUpdate)throw new HttpError(409,status.busy.join(' '),'SERVICE_BUSY');
        // No await separates the final idle check, the mutation gate and dispatch stop.
        this.serviceUpdating=true;for(const hook of this.serviceHandoffHooks)hook();
      }
      this.scheduleServiceShutdown();return {ok:true};
    }
    if(method==='GET'&&route==='/api/runtime')return this.refreshRuntime();
    if(method==='POST'&&route==='/api/runtime/start'){
      this.allowRuntimeStart();const status=await this.refreshRuntime();
      void this.ensureRuntimeReady().catch(error=>this.emit('runtime-error',{error:error.message}));
      return {...status,state:status.state==='ready'?'ready':'starting',accepted:true};
    }
    if(method==='POST'&&route==='/api/runtime/stop'){
      const active=this.store.list<Session>('sessions').filter(session=>this.sessions.needsTermination(session.id));
      const workers=this.store.list<{id:string;status:string;attempt?:{deviceId?:string}}>('factory-workers').filter(worker=>worker.attempt?.deviceId===this.device.id&&['preparing','prepared','running','unknown'].includes(worker.status));
      if((active.length||workers.length||this.runtimeOperations.size)&&body.confirmStopEnvironments!==true)throw new HttpError(409,'Environments are using EnoughFactory’s runtime. Stop them first, or explicitly confirm stopping all environments.','RUNTIME_IN_USE');
      if(this.runtimeStopping)throw new HttpError(409,'EnoughFactory is already stopping its container runtime.');
      this.runtimeStopping=true;this.runtimeSuspended=true;this.store.set('private',{id:'runtime-control',suspended:true});
      this.syncRuntimeCapacity();this.changed();
      try {
        for(const operation of this.runtimeOperations.values())operation.controller.abort();
        for(const hook of this.runtimeStopHooks)await hook();
        await Promise.allSettled([...this.runtimeOperations.values()].map(operation=>operation.promise));
        for(const session of this.store.list<Session>('sessions').filter(session=>this.sessions.needsTermination(session.id))){await this.sessions.stop(session.id);await this.sessions.waitStopped(session.id);}
        await this.runtime.stop();return await this.refreshRuntime();
      }catch(error){await this.refreshRuntime().catch(()=>{});throw new HttpError(409,`Could not confirm all work stopped: ${(error as Error).message}`,'RUNTIME_STOP_UNCONFIRMED');}
      finally{this.runtimeStopping=false;this.syncRuntimeCapacity();this.changed();}
    }
    if(method==='PATCH'&&route==='/api/runtime'){
      const status=await this.refreshRuntime();
      const limits={cpus:body.cpus===undefined?status.cpus||4:Number(body.cpus),memoryGiB:body.memoryGiB===undefined?status.memoryGiB||4:Number(body.memoryGiB),diskGiB:body.diskGiB===undefined?status.diskGiB||40:Number(body.diskGiB)};
      try {const updated=await this.runtime.configure(limits);this.runtimeStatus(updated);return updated;}catch(error){throw new HttpError(409,(error as Error).message);}
    }
    if(method==='GET' && route==='/api/diagnostics'){await this.refreshDiagnostics();return this.diagnostics;}
    if(method==='GET' && route==='/api/projects')return ['1','true'].includes(url.searchParams.get('archived')||'')?this.state(true).projects.filter(project=>project.archivedAt):this.state().projects;
    if(method==='POST' && route==='/api/projects'){
      if(typeof body.path!=='string'||!body.path.trim())throw new HttpError(400,'Choose a repository folder.');
      const projectPath=path.resolve(body.path);await exec('git',['-C',projectPath,'rev-parse','--show-toplevel']).catch(()=>{throw new HttpError(400,'This folder must contain a Git repository.');});
      const existing=this.store.list<Project>('projects').find(p=>!p.internal&&p.path===projectPath);if(existing){if((Array.isArray(body.workingDirectories)&&body.workingDirectories.length)||body.developmentToolchain!==undefined)throw new HttpError(409,'This project is already added. Update its working folders or development toolchain in Project settings.');return existing.archivedAt?this.removals.restoreProject(existing.id):existing;}
      const project:Project={id:id('project'),name:String(body.name||path.basename(projectPath)),path:projectPath,deviceId:this.device.id,createdAt:now(),runtime:['codex','antigravity','claude'].includes(String(body.runtime))?body.runtime as Project['runtime']:this.settings.defaultRuntime,approvalMode:['approve-all','rules','manual'].includes(String(body.approvalMode))?body.approvalMode as Project['approvalMode']:this.settings.defaultApprovalMode,rules:[]};
      if(body.workingDirectories!==undefined)project.workingDirectories=await validateWorkingDirectories(project.path,body.workingDirectories as never).catch(error=>{throw new HttpError(400,error.message);});
      if(body.developmentToolchain!==undefined)project.developmentToolchain=parseDevelopmentToolchain(body.developmentToolchain);
      this.store.set('projects',project);this.changed();return project;
    }
    const projectRoute=route.match(/^\/api\/projects\/([^/]+)(?:\/(validate|config|archive|restore))?$/);
    if(projectRoute){const project=this.store.get<Project>('projects',projectRoute[1]);if(!project)throw new HttpError(404,'Project not found.');
      if(method==='GET'&&!projectRoute[2])return project;
      if(method==='POST'&&projectRoute[2]==='archive')return {ok:true,project:this.removals.archiveProject(project.id)};
      if(method==='POST'&&projectRoute[2]==='restore')return this.removals.restoreProject(project.id);
      if(method==='GET'&&projectRoute[2]==='validate')return this.sessions.engine.validate(project.path);
      if(projectRoute[2]==='config'){
        const filename=path.join(project.path,'.envmux.json');
        if(method==='PUT'){
          this.sessions.assertActiveProject(project);
          if(typeof body.content!=='string')throw new HttpError(400,'Environment configuration must be JSON text.');
          let config:unknown;try{config=JSON.parse(body.content);}catch{throw new HttpError(400,'Environment configuration must contain valid JSON.');}
          if(!config||typeof config!=='object'||Array.isArray(config))throw new HttpError(400,'Environment configuration must be an object.');
          writeFileSync(filename,body.content+'\n');this.changed();
        }
        if(method==='GET'||method==='PUT'){const validation=await this.sessions.engine.validate(project.path);return {content:existsSync(filename)?readFileSync(filename,'utf8'):'{}',...validation};}
      }
      if(method==='DELETE'&&!projectRoute[2])return {ok:true,project:this.removals.archiveProject(project.id)};
      if(method==='PATCH'&&!projectRoute[2]){const next={...project};if(typeof body.name==='string')next.name=body.name;if(['codex','antigravity','claude'].includes(String(body.runtime)))next.runtime=body.runtime as Project['runtime'];if(['approve-all','rules','manual'].includes(String(body.approvalMode)))next.approvalMode=body.approvalMode as Project['approvalMode'];if(Array.isArray(body.rules))next.rules=body.rules as Project['rules'];if(body.developmentToolchain!==undefined)next.developmentToolchain=parseDevelopmentToolchain(body.developmentToolchain);if(body.workingDirectories!==undefined)next.workingDirectories=await validateWorkingDirectories(next.path,body.workingDirectories as never).catch(error=>{throw new HttpError(400,error.message);});this.store.set('projects',next);this.changed();return next;}
    }
    if(method==='GET'&&route==='/api/sessions')return ['1','true'].includes(url.searchParams.get('archived')||'')?this.state(true).sessions.filter(session=>session.archivedAt):this.state().sessions;
    if(method==='POST'&&route==='/api/sessions'){
      const project=this.store.get<Project>('projects',String(body.projectId));if(!project)throw new HttpError(404,'Project not found.');
      this.sessions.assertActiveProject(project);
      this.allowRuntimeStart();
      return this.sessions.create(project,String(body.name||`work-${Date.now().toString(36)}`));
    }
    const sessionRoute=route.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/);
    if(sessionRoute){const sid=sessionRoute[1],action=sessionRoute[2];this.sessions.record(sid);
      if(method==='DELETE'&&!action)return {ok:true,session:this.removals.archiveSession(sid)};
      if(method==='POST'&&action==='archive')return {ok:true,session:this.removals.archiveSession(sid)};
      if(method==='POST'&&action==='restore')return this.removals.restoreSession(sid);
      if(method==='POST')this.sessions.assertWorkAvailable(sid);
      if(method==='GET'&&!action)return this.sessions.record(sid);
      if(method==='GET'&&action==='state')return this.sessions.get(sid).state();
      if(method==='GET'&&action==='changes')return this.sessions.changes(sid,url.searchParams.get('path')??undefined,url.searchParams.get('root')??undefined);
      if(method==='GET'&&action==='working-directories')return this.sessions.record(sid).workingDirectories||[];
      if(method==='POST'&&action==='working-directories/capture')return this.withRuntimeOperation(()=>this.sessions.captureWorkingDirectories(sid));
      if(method==='GET'&&action==='output'){const task=url.searchParams.get('task');return task?this.sessions.get(sid).logs(task):this.sessions.output(sid);}
      if(method==='POST'&&action==='stop'){void this.sessions.stop(sid).catch(error=>this.emit('error',{sessionId:sid,error:error.message}));return {ok:true};}
      if(method==='POST'&&action==='restart'){if(this.sessions.owns(sid))this.allowRuntimeStart();await this.sessions.restart(sid);return {ok:true};}
      const service=action?.match(/^services\/([^/]+)\/(start|stop|restart)$/);
      if(method==='POST'&&service){await this.sessions.get(sid).task(decodeURIComponent(service[1]),service[2] as 'start'|'stop'|'restart');return {ok:true};}
    }
    if(method==='POST'&&route==='/api/goals')this.sessions.assertActiveProject(this.store.get<Project>('projects',String(body.projectId)));
    if(method==='POST'&&route==='/api/chats')this.sessions.assertWorkAvailable(String(body.sessionId));
    const chatRoute=route.match(/^\/api\/chats\/([^/]+)/);
    if(method!=='GET'&&chatRoute){const chat=this.store.get<Chat>('chats',chatRoute[1]);if(chat)this.sessions.assertWorkAvailable(chat.sessionId);}
    if(method==='PATCH'&&route==='/api/settings'){
      if(body.workerCapacity!==undefined&&body.workerCapacity!==null&&!validWorkerCapacity(body.workerCapacity))throw new HttpError(400,'Choose 1–32 worker slots, or use automatic capacity.','INVALID_WORKER_CAPACITY');
      for(const key of ['deviceName','signalingUrl','defaultRuntime','defaultApprovalMode','turnUrls','turnUsername','turnCredential'] as const)if(body[key]!==undefined)(this.settings as unknown as Record<string,unknown>)[key]=body[key];
      if(body.workerCapacity===null)delete this.settings.workerCapacity;
      else if(validWorkerCapacity(body.workerCapacity))this.settings.workerCapacity=body.workerCapacity;
      this.store.set('settings',{id:'main',...this.settings});this.device.name=this.settings.deviceName;this.syncRuntimeCapacity();this.changed();return this.state().settings;
    }
    for(const extension of this.extensions){const value=await extension(call);if(value!==undefined)return value;}
    throw new HttpError(404,'This operation was not found.');
  }
  private authorized(req: IncomingMessage,url:URL):boolean {const header=req.headers.authorization;const candidate=header?.startsWith('Bearer ')?header.slice(7):url.searchParams.get('token')||'';return equalSecret(candidate,this.token);}
  private cors(req:IncomingMessage,res:ServerResponse):boolean {
    const origin=req.headers.origin;if(!origin)return true;
    let allowed=false;try {const parsed=new URL(origin);allowed=['127.0.0.1','localhost','factory.enoughtools.com'].includes(parsed.hostname)||origin==='file://';}catch{allowed=origin==='null';}
    if(allowed){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');}
    return allowed;
  }
  private async handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    const url=new URL(req.url||'/',`http://127.0.0.1:${this.port}`);res.setHeader('X-Content-Type-Options','nosniff');
    if(!this.cors(req,res)){res.writeHead(403);res.end('Origin unavailable');return;}
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(!url.pathname.startsWith('/api/')){this.static(url,res);return;}
    if(!this.authorized(req,url)){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Connect to this device with its access token.'}));return;}
    if(url.pathname==='/api/events'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});res.write(`event: state\ndata: ${JSON.stringify(this.state())}\n\n`);this.sse.add(res);
      const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),20000);req.on('close',()=>{clearInterval(heartbeat);this.sse.delete(res);});return;
    }
    try {
      let body:Record<string,unknown>={};if(['POST','PATCH','PUT'].includes(req.method||'')){const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024)throw new HttpError(413,'Request too large.');chunks.push(Buffer.from(chunk));}if(size){try {body=JSON.parse(Buffer.concat(chunks).toString());}catch {throw new HttpError(400,'Request must contain valid JSON.');}if(!body||typeof body!=='object'||Array.isArray(body))throw new HttpError(400,'Request must be an object.');}}
      const result=await this.dispatch({method:req.method||'GET',url,body});res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));
    }catch(error){const e=error as Error;res.writeHead(error instanceof HttpError?error.status:500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message,code:error instanceof HttpError?error.code:undefined}));}
  }
  private static(url:URL,res:ServerResponse):void{
    const root=process.env.ENOUGHFACTORY_WEB_PATH||path.resolve(process.env.ENOUGHFACTORY_REPO||process.cwd(),'apps/web/dist');
    let target=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!target.startsWith(path.resolve(root)+path.sep)&&target!==path.resolve(root)){res.writeHead(404);res.end();return;}
    if(!existsSync(target)||url.pathname.endsWith('/'))target=path.join(root,'index.html');
    if(!existsSync(target)){res.writeHead(503,{'Content-Type':'text/plain'});res.end('EnoughFactory is starting. Build the web application or run the development server.');return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(target)]||'application/octet-stream'});const stream=createReadStream(target);stream.on('error',()=>res.end());stream.pipe(res);
  }
  async refreshDiagnostics():Promise<void>{const [info,status]=await Promise.all([this.sessions.engine.detect(),this.runtime.status()]);this.diagnostics={...this.diagnostics,envmux:{available:info.available,version:info.version,error:info.error}};this.runtimeStatus(status);}
  async listen():Promise<void>{
    await new Promise<void>((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'127.0.0.1',()=>resolve());});
    writeFileSync(path.join(this.dataDir,'connection.json'),JSON.stringify({url:`http://127.0.0.1:${this.port}`,token:this.token,pid:process.pid,version:'0.1.6'},null,2),{mode:0o600});
    void this.refreshDiagnostics();await this.sessions.recover();
  }
  async close():Promise<void>{if(this.closing)return;this.closing=true;if(this.changeTimer)clearTimeout(this.changeTimer);for(const close of this.closers)await close();this.sessions.close();for(const res of this.sse)res.end();this.socketServer.close();await new Promise<void>(resolve=>this.server.close(()=>{this.store.close();resolve();}));}
}
