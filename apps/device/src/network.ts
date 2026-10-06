import { StringDecoder } from 'node:string_decoder';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { PeerManager, bridgePeerStreams, type PeerStream, type StreamOptions, type IceServer } from '@enoughfactory/peers';
import { PreviewGateway, connectSessionProxy, type PreviewTarget } from '@enoughfactory/previews';
import type { Approval, Attempt, Chat, Device, FactoryState, FactoryTask, Goal, Project, RpcRequest, RpcResponse, Session, Settings } from '@enoughfactory/contracts';
import { DeviceApp, type ApiCall } from './app.ts';
import { HttpError, now } from './util.ts';
import { parseWorkerResources } from './worker-capacity.ts';

type Catalog = Pick<FactoryState,'projects'|'sessions'|'chats'|'goals'|'tasks'|'attempts'> & { id: string; updatedAt: string; capacity?: number; workerResources?: Device['workerResources']; workspaceProviders?: Device['workspaceProviders'] };
type Packet = Record<string,unknown>;
const maxStreamBuffer = 1024 * 1024;

function object(value: unknown): Record<string,unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
}
function records<T>(value: unknown, predicate: (item: Record<string,unknown>)=>boolean): T[] {
  return Array.isArray(value) ? value.filter(item=>predicate(object(item))).slice(0,10000) as T[] : [];
}
function publicCatalog(app: DeviceApp): Catalog {
  // Keep removed identities in peer metadata for owner-aware restore and historical reads.
  // DeviceApp.state filters the merged catalog only after this raw catalog is collected.
  return { id:app.device.id,updatedAt:now(),capacity:app.device.capacity,workerResources:app.device.workerResources,workspaceProviders:app.device.workspaceProviders,projects:app.store.list<Project>('projects').filter(project=>!project.internal),
    sessions:app.store.list<Session>('sessions').map(({enginePid,...session})=>session),
    chats:app.store.list<Chat>('chats').map(({threadId,...chat})=>chat),
    goals:app.store.list<Goal>('goals').filter(goal=>goal.coordinatorId===app.device.id),
    tasks:app.store.list<FactoryTask>('tasks'),attempts:app.store.list<Attempt>('attempts') };
}
function receiveCatalog(peerId: string, value: unknown): Catalog {
  const data=object(value);const local=(item:Record<string,unknown>)=>typeof item.id==='string'&&item.deviceId===peerId;
  const projects=records<Project>(data.projects,local);
  const sessions=records<Session>(data.sessions,item=>local(item)&&typeof item.projectId==='string')
    .map(({enginePid,...session})=>session);
  const sessionIds=new Set(sessions.map(session=>session.id));
  const chats=records<Chat>(data.chats,item=>local(item)&&sessionIds.has(String(item.sessionId)))
    .map(({threadId,...chat})=>chat);
  const goals=records<Goal>(data.goals,item=>typeof item.id==='string'&&item.coordinatorId===peerId);
  const goalIds=new Set(goals.map(goal=>goal.id));
  const tasks=records<FactoryTask>(data.tasks,item=>typeof item.id==='string'&&goalIds.has(String(item.goalId)));
  const taskIds=new Set(tasks.map(task=>task.id));
  const attempts=records<Attempt>(data.attempts,item=>typeof item.id==='string'&&taskIds.has(String(item.taskId)));
  const capacity=Number(data.capacity??object(data.device).capacity);
  const workerResources=parseWorkerResources(data.workerResources??object(data.device).workerResources);
  const providers=data.workspaceProviders??object(data.device).workspaceProviders;
  const workspaceProviders=Array.isArray(providers)?providers.filter((provider):provider is 'git'|'artifactfs'=>provider==='git'||provider==='artifactfs'):undefined;
  return {id:peerId,updatedAt:now(),...(Number.isInteger(capacity)&&capacity>=0&&capacity<=64?{capacity}:{}),workerResources,workspaceProviders,projects,sessions,chats,goals,tasks,attempts};
}
function iceServers(settings: Settings): IceServer[] {
  return settings.turnUrls?.length ? [{urls:settings.turnUrls,username:settings.turnUsername,credential:settings.turnCredential}] : [];
}
function requireOnline(app:DeviceApp,deviceId:string):void {
  const device=app.devices.find(device=>device.id===deviceId);
  if(!device?.online)throw new HttpError(409,`${device?.name||'The owning device'} is offline. Its chats and live tools will return when it reconnects.`,'DEVICE_OFFLINE');
}
function rpcBody(response: RpcResponse): unknown {
  if(response.status>=400){const body=object(response.body);throw new HttpError(response.status,typeof body.error==='string'?body.error:'The remote operation failed.',typeof body.code==='string'?body.code:undefined);}
  return response.body;
}
function parsePackets(stream:PeerStream,accept:(packet:Packet)=>void):()=>void {
  let pending='';const decoder=new StringDecoder('utf8');
  const receive=(chunk:Buffer)=>{
    pending+=decoder.write(chunk);
    if(Buffer.byteLength(pending)>maxStreamBuffer){stream.close('Stream frame exceeded its limit');return;}
    let end:number;
    while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line)continue;
      try{accept(object(JSON.parse(line)));}catch(error){stream.close((error as Error).message);return;}}
  };
  stream.on('data',receive);return ()=>stream.off('data',receive);
}
const sendPacket=(stream:PeerStream,packet:Packet)=>stream.send(JSON.stringify(packet)+'\n');

/** TCP is framed with application acknowledgments, so a slow HTTP consumer also
 * backpressures its peer rather than merely moving an unbounded queue to RTC. */
function tcpDuplex(stream: PeerStream): Duplex {
  let sequence=0;let readBlocked=false;const deferredAcks:number[]=[];
  const pending=new Map<number,{resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  const duplex=new Duplex({readableHighWaterMark:64*1024,writableHighWaterMark:64*1024,
    read(){readBlocked=false;for(const id of deferredAcks.splice(0))void sendPacket(stream,{kind:'ack',id}).catch(error=>duplex.destroy(error));},
    write(chunk:Buffer|string,_encoding,done){void(async()=>{
      const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      for(let offset=0;offset<data.length;offset+=16*1024){const part=data.subarray(offset,offset+16*1024);const id=++sequence;
        const accepted=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Remote preview stopped accepting data'));},30000);timer.unref();pending.set(id,{resolve,reject,timer});});
        try{await sendPacket(stream,{kind:'data',id,data:part.toString('base64')});await accepted;}
        catch(error){const entry=pending.get(id);if(entry){clearTimeout(entry.timer);entry.reject(error as Error);pending.delete(id);}await accepted.catch(()=>{});throw error;}
      }
    })().then(()=>done(),error=>done(error));},
    final(done){void sendPacket(stream,{kind:'eof'}).then(()=>done(),error=>done(error));},
    destroy(error,done){for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error||new Error('Preview stream closed'));}pending.clear();stream.close(error?.message);detach();done(error);}
  });
  const detach=parsePackets(stream,packet=>{
    if(packet.kind==='ack'){const entry=pending.get(Number(packet.id));if(entry){clearTimeout(entry.timer);pending.delete(Number(packet.id));entry.resolve();}}
    else if(packet.kind==='data'){
      if(typeof packet.data!=='string'||packet.data.length>32*1024||!Number.isSafeInteger(packet.id))throw new Error('Invalid preview data frame');
      const data=Buffer.from(packet.data,'base64');if(data.length>16*1024)throw new Error('Preview chunk exceeded its limit');
      if(duplex.readableLength+data.length>maxStreamBuffer)throw new Error('Preview receiver queue is full');
      if(!duplex.push(data))readBlocked=true;
      if(readBlocked)deferredAcks.push(Number(packet.id));else void sendPacket(stream,{kind:'ack',id:packet.id}).catch(error=>duplex.destroy(error));
    }else if(packet.kind==='eof')duplex.push(null);
    else throw new Error('Invalid preview stream frame');
  });
  stream.on('end',(error?:string)=>{if(error)duplex.destroy(new Error(error));else duplex.push(null);});
  duplex.on('error',()=>{});
  return duplex;
}
function pipeBoth(left:Duplex,right:Duplex):void {
  left.on('error',()=>right.destroy());right.on('error',()=>left.destroy());
  // A clean TCP FIN must drain the ACK-backed writer before EOF. Destroying it
  // on the socket's close event truncates connection-close HTTP responses.
  left.on('close',()=>{if(!left.readableEnded)right.destroy();});
  right.on('close',()=>{if(!right.readableEnded)left.destroy();});left.pipe(right);right.pipe(left);
}
function terminalInput(packet: Packet): string | Buffer {
  if(packet.type==='input')return Buffer.from(String(packet.data||''));
  if(packet.type==='resize')return JSON.stringify({resize:{cols:Number(packet.cols)||80,rows:Number(packet.rows)||24}});
  throw new Error('Unsupported terminal input');
}

export async function initializeNetwork(app: DeviceApp): Promise<{
  peers: PeerManager; gateway: PreviewGateway;
  connectTerminal(sessionId:string,url:URL,client:WebSocket):Promise<boolean>;
}> {
  const remoteCatalogs=new Map(app.store.list<Catalog>('remote-catalog').map(catalog=>[catalog.id,catalog]));
  const liveApprovals=new Map<string,Approval[]>();
  let peers!: PeerManager;let remoteEvent=false;let closed=false;let lastPublished='';let lastApprovals='';
  const localState=():FactoryState=>({product:'EnoughFactory',version:'0.1.5',device:app.device,devices:[app.device],
    ...publicCatalog(app),approvals:app.store.list('approvals'),diagnostics:app.diagnostics,
    settings:{...app.settings,turnCredential:undefined}});
  const saveCatalog=(peerId:string,value:unknown)=>{
    const catalog=receiveCatalog(peerId,value);remoteCatalogs.set(peerId,catalog);app.store.set('remote-catalog',catalog);
    app.devices=app.devices.map(device=>device.id===peerId?{...device,capacity:device.platform==='browser'?0:catalog.capacity??device.capacity,workerResources:device.platform==='browser'?undefined:catalog.workerResources,workspaceProviders:catalog.workspaceProviders}:device);app.changed();
  };
  const browserEvent=(topic:string,data:unknown,cursor?:number)=>{for(const device of app.devices)if(device.platform==='browser'&&device.online)void peers.publishTo(device.id,topic,data,cursor).catch(()=>{});};
  const refreshPeer=async(peerId:string)=>{
    try{const state=rpcBody(await peers.request(peerId,{method:'GET',path:'/api/state?local=1'}));saveCatalog(peerId,state);
      const ids=new Set(remoteCatalogs.get(peerId)!.chats.map(chat=>chat.id));
      liveApprovals.set(peerId,records<Approval>(object(state).approvals,item=>typeof item.id==='string'&&ids.has(String(item.chatId))));app.changed();
    }catch(error){if(!closed)app.emit('network-error',{deviceId:peerId,error:(error as Error).message});}
  };
  const catalogOwner=(bucket:keyof Pick<Catalog,'projects'|'sessions'|'chats'|'goals'|'tasks'|'attempts'>,id:string):string|undefined=>{
    if(app.store.get(bucket,id))return app.device.id;
    for(const catalog of remoteCatalogs.values())if(catalog[bucket].some(item=>item.id===id))return catalog.id;
    // Internal factory project metadata is private to its owner, but a known environment
    // still identifies which device can resolve that project's retained source reference.
    if(bucket==='projects')for(const catalog of remoteCatalogs.values())if(catalog.sessions.some(session=>session.projectId===id))return catalog.id;
    return undefined;
  };
  const owner=(call:ApiCall):string|undefined=>{
    const route=call.url.pathname;
    if(route.startsWith('/api/factory/worker/'))return undefined;
    if(/^\/api\/artifacts\/[^/]+(?:\/(?:content|chunk))?$/.test(route)&&call.url.searchParams.has('deviceId'))return call.url.searchParams.get('deviceId')||undefined;
    // A preview grant belongs to the viewing service even when its session is remote.
    if(/\/((?:desktop-)?preview)$/.test(route)||route.startsWith('/api/previews/'))return undefined;
    const match=route.match(/^\/api\/(projects|sessions|chats|goals|tasks|attempts)\/([^/]+)/);
    if(match)return catalogOwner(match[1] as 'projects',decodeURIComponent(match[2]));
    const approval=route.match(/^\/api\/approvals\/([^/]+)/);
    if(approval){if(app.store.get('approvals',approval[1]))return app.device.id;for(const [peerId,items] of liveApprovals)if(items.some(item=>item.id===approval[1]))return peerId;}
    if(call.method==='POST'&&route==='/api/sessions')return catalogOwner('projects',String(call.body.projectId));
    if(call.method==='POST'&&route==='/api/chats')return catalogOwner('sessions',String(call.body.sessionId));
    if(call.method==='POST'&&route==='/api/goals')return catalogOwner('projects',String(call.body.projectId));
    return undefined;
  };
  const routeBefore=app.routeRemote;
  app.routeRemote=async call=>{
    if(call.peerId)return undefined;
    if(call.method==='POST'&&/^\/api\/sessions\/[^/]+\/(?:desktop-preview|browser-preview|preview)$/.test(call.url.pathname))return createPreview(call);
    const deviceId=owner(call);
    if(deviceId&&deviceId!==app.device.id){requireOnline(app,deviceId);
      try{return rpcBody(await peers.request(deviceId,{method:call.method,path:call.url.pathname+call.url.search,body:call.body}));}
      catch(error){if(error instanceof HttpError)throw error;throw new HttpError(503,(error as Error).message,'REMOTE_OUTCOME_UNKNOWN');}}
    return routeBefore?.(call);
  };
  const request=async(peerId:string,rpc:RpcRequest):Promise<RpcResponse>=>{
    try{
      if(rpc.method!=='GET')app.assertServiceAvailable();
      const url=new URL(rpc.path,'http://enoughfactory.local');
      if(url.origin!=='http://enoughfactory.local'||!['GET','POST','PUT','PATCH','DELETE'].includes(rpc.method))throw new HttpError(400,'Invalid peer operation.');
      if(rpc.method==='GET'&&url.pathname==='/api/state')return {v:1,id:rpc.id,status:200,body:url.searchParams.get('local')==='1'?localState():app.state()};
      const controller=peers.devices().find(device=>device.id===peerId)?.platform==='browser';
      const controllerRoute=controller&&(/^\/api\/(settings|devices|previews|runtime)(?:\/|$)/.test(url.pathname)||url.pathname==='/api/service/shutdown');
      if(!controllerRoute&&!/^\/api\/(health|diagnostics|projects|sessions|chats|approvals|goals|tasks|attempts|artifacts)(?:\/|$)/.test(url.pathname)&&!url.pathname.startsWith('/api/factory/worker/'))throw new HttpError(403,'This operation is private to its device.');
      if(url.pathname.endsWith('/preview')||url.pathname.endsWith('/desktop-preview'))throw new HttpError(403,'Preview grants are issued by the viewing device.');
      const call:ApiCall={method:rpc.method,url,body:object(rpc.body),peerId};
      if(rpc.method==='POST'&&url.pathname.endsWith('/browser-preview'))return {v:1,id:rpc.id,status:200,body:await createPreview(call)};
      const deviceId=owner(call);if(deviceId&&deviceId!==app.device.id){requireOnline(app,deviceId);const response=await peers.request(deviceId,{method:rpc.method,path:rpc.path,body:rpc.body});return {...response,id:rpc.id};}
      return {v:1,id:rpc.id,status:200,body:await app.dispatch(call)};
    }catch(error){return {v:1,id:rpc.id,status:error instanceof HttpError?error.status:500,body:{error:(error as Error).message,code:error instanceof HttpError?error.code:undefined}};}
  };
  peers=await PeerManager.create({dataDir:app.dataDir,name:app.settings.deviceName,signalingUrl:app.settings.signalingUrl,
    iceServers:iceServers(app.settings),relayFallback:true,onRequest:request,
    onDevices(devices){
      const old=new Map(app.devices.map(device=>[device.id,device.online]));
      app.devices=devices.map(device=>device.local?{...app.device,...device,capacity:app.device.capacity,workerResources:app.device.workerResources,workspaceProviders:app.device.workspaceProviders}:device.platform==='browser'?{...device,capacity:0,workerResources:undefined}:{...device,capacity:remoteCatalogs.get(device.id)?.capacity??device.capacity,workerResources:remoteCatalogs.get(device.id)?.workerResources,workspaceProviders:remoteCatalogs.get(device.id)?.workspaceProviders});
      const paired=new Set(devices.filter(device=>!device.local).map(device=>device.id));
      for(const peerId of remoteCatalogs.keys())if(!paired.has(peerId)){remoteCatalogs.delete(peerId);app.store.delete('remote-catalog',peerId);liveApprovals.delete(peerId);}
      for(const device of devices){if(!device.online)liveApprovals.delete(device.id);else if(!device.local&&device.platform!=='browser'&&!old.get(device.id))void refreshPeer(device.id);}
      app.changed();
    },
    onEvent(peerId,event){
      if(event.topic==='catalog'){saveCatalog(peerId,event.data);void refreshPeer(peerId);return;}
      // Live messages are delivered to subscribers, never copied into this device's transcript store.
      if(['state','network-error','peer-artifact'].includes(event.topic))return;
      const data={...object(event.data),deviceId:peerId,peerCursor:event.cursor};
      remoteEvent=true;try{app.emit(event.topic,data);}finally{remoteEvent=false;}browserEvent(event.topic,data,event.cursor);
      if(event.topic.startsWith('approval'))void refreshPeer(peerId);
    },
    async onStreamOpen(_peerId,options,stream){
      app.assertServiceAvailable();
      const match=options.path.match(/^\/api\/sessions\/([^/]+)\/(preview-tcp|terminal)$/);
      if(!match)throw new HttpError(404,'Unknown remote stream');
      const sessionId=decodeURIComponent(match[1]);const deviceId=catalogOwner('sessions',sessionId);
      if(deviceId&&deviceId!==app.device.id){requireOnline(app,deviceId);bridgePeerStreams(stream,await peers.openStream(deviceId,options));return;}
      const record=app.sessions.record(sessionId);
      if(record.deviceId!==app.device.id)throw new HttpError(403,'This session belongs to another device');
      const engine=app.sessions.get(sessionId);
      if(options.kind==='preview-tcp'&&match[2]==='preview-tcp'){
        const target=object(options.body);const socket=await connectSessionProxy(engine.ready.proxy||'',{host:String(target.host||''),port:Number(target.port)});
        pipeBoth(tcpDuplex(stream),socket);return;
      }
      if(options.kind!=='terminal'||match[2]!=='terminal')throw new HttpError(400,'Stream kind does not match its route');
      await serveTerminal(app,sessionId,engine.shellUrl,engine.shellHeaders,options,stream);
    },
    onArtifact(peerId,manifest,path){app.store.set('peer-artifacts',{id:manifest.id,peerId,manifest,path,receivedAt:now()});app.emit('peer-artifact',{id:manifest.id,peerId,manifest});},
    onError(error){if(!closed)app.emit('network-error',{error:error.message});}
  });
  app.serviceActivityHooks.push(()=>{
    const activity=peers.serviceActivity();
    return activity.transfers||activity.uploads||activity.processing?['Peer artifact transfers are active.']:[];
  });
  app.serviceHandoffHooks.push(()=>peers.beginServiceHandoff());
  // Replace the provisional install ID before creating any environments and migrate
  // existing owner references once. The signing identity survives window/service restarts.
  const previousId=app.device.id;const device={...peers.localDevice,capacity:app.device.capacity??2,workerResources:app.device.workerResources};
  if(previousId!==device.id)app.store.transaction(()=>{
    for(const bucket of ['projects','sessions','chats','tasks','attempts'])for(const saved of app.store.list<Record<string,unknown>&{id:string}>(bucket))if(saved.deviceId===previousId)app.store.set(bucket,{...saved,deviceId:device.id});
    for(const goal of app.store.list<Goal>('goals'))if(goal.coordinatorId===previousId)app.store.set('goals',{...goal,coordinatorId:device.id});
  });
  app.setDevice(device);app.devices=peers.devices().map(item=>item.local?app.device:item.platform==='browser'?{...item,capacity:0,workerResources:undefined}:item);
  const catalogBefore=app.catalog;
  app.catalog=()=>{
    const prior=catalogBefore?.()||{};const local=publicCatalog(app);
    const paired=new Set(app.devices.filter(device=>!device.local).map(device=>device.id));
    const catalogs=[local,...[...remoteCatalogs.values()].filter(catalog=>paired.has(catalog.id))];
    return {...prior,projects:catalogs.flatMap(item=>item.projects),sessions:catalogs.flatMap(item=>item.sessions),chats:catalogs.flatMap(item=>item.chats),
      goals:catalogs.flatMap(item=>item.goals),tasks:catalogs.flatMap(item=>item.tasks),attempts:catalogs.flatMap(item=>item.attempts),
      approvals:[...app.store.list<Approval>('approvals'),...[...liveApprovals].filter(([peerId])=>app.devices.find(device=>device.id===peerId)?.online).flatMap(([,items])=>items)]};
  };
  const gateway=new PreviewGateway({
    publicBrowserGateway:process.env.ENOUGHFACTORY_PREVIEW_ORIGIN_TEMPLATE?{originTemplate:process.env.ENOUGHFACTORY_PREVIEW_ORIGIN_TEMPLATE,port:Number(process.env.ENOUGHFACTORY_PREVIEW_PORT||43126),listenHost:process.env.ENOUGHFACTORY_PREVIEW_HOST||'127.0.0.1'}:undefined,
    getSession(sessionId){const deviceId=catalogOwner('sessions',sessionId);if(deviceId&&deviceId!==app.device.id)throw new HttpError(409,'Remote preview transport is unavailable.');return {proxyUrl:app.sessions.get(sessionId).ready.proxy||''};},
    async connectPeer(sessionId,target:PreviewTarget){const deviceId=catalogOwner('sessions',sessionId);if(!deviceId||deviceId===app.device.id)return undefined;requireOnline(app,deviceId);
      try{const stream=await peers.openStream(deviceId,{kind:'preview-tcp',path:`/api/sessions/${encodeURIComponent(sessionId)}/preview-tcp`,body:target});
        stream.on('end',(error?:string)=>{if(error&&!closed)app.emit('network-error',{deviceId,sessionId,error});});return tcpDuplex(stream);}
      catch(error){app.emit('network-error',{deviceId,sessionId,error:(error as Error).message});throw error;}}
  });
  async function createPreview(call:ApiCall):Promise<unknown>{
    const preview=call.url.pathname.match(/^\/api\/sessions\/([^/]+)\/(desktop-preview|browser-preview|preview)$/)!;
    if(preview[2]==='browser-preview'&&!process.env.ENOUGHFACTORY_PREVIEW_ORIGIN_TEMPLATE)throw new HttpError(409,'This device has no public browser preview gateway. Open the session from an installed device service, or configure a self-hosted HTTPS preview gateway.','PUBLIC_PREVIEW_UNAVAILABLE');
    const sid=decodeURIComponent(preview[1]);const deviceId=catalogOwner('sessions',sid);
    if(!deviceId)throw new HttpError(404,'Session not found.');requireOnline(app,deviceId);
    const url=typeof call.body.url==='string'?call.body.url:'http://localhost:3000';
    try{return preview[2]==='desktop-preview'?await gateway.createDesktop(sid,url):await gateway.createBrowser(sid,url);}
    catch(error){throw new HttpError(400,(error as Error).message);}
  }
  app.extensions.push(async call=>{
    const route=call.url.pathname;
    if(call.method==='POST'&&['/api/devices/invite','/api/devices/pairing'].includes(route)){
      try{const invitation=peers.createInvitation();return {...invitation,invite:invitation.url};}catch(error){throw new HttpError(400,(error as Error).message);}}
    if(call.method==='POST'&&route==='/api/devices/pair'){
      const invitation=call.body.invite||call.body.code;if(typeof invitation!=='string'||!invitation.trim())throw new HttpError(400,'Paste an invitation from another device.');
      try{const paired=await peers.pair(invitation);
        // Persist the endpoint only after the invitation has been authenticated.
        const code=invitation.includes('://')?new URL(invitation).searchParams.get('code')||'':invitation;
        const source=object(JSON.parse(Buffer.from(code,'base64url').toString()));
        if(typeof source.signalingUrl==='string'){app.settings.signalingUrl=source.signalingUrl;app.store.set('settings',{id:'main',...app.settings});lastConfig=JSON.stringify(configureSettings(app.settings));app.changed();}
        return paired;}catch(error){throw new HttpError(400,(error as Error).message);}
    }
    const forget=route.match(/^\/api\/devices\/([^/]+)(?:\/forget)?$/);
    if(forget&&(call.method==='DELETE'||call.method==='POST'&&route.endsWith('/forget'))){if(forget[1]===app.device.id)throw new HttpError(400,'The local device cannot be unpaired.');await peers.forget(forget[1]);return {ok:true};}
    if(call.method==='POST'&&/^\/api\/sessions\/[^/]+\/(?:desktop-preview|browser-preview|preview)$/.test(route))return createPreview(call);
    const remove=route.match(/^\/api\/previews\/([^/]+)$/);if(remove&&call.method==='DELETE'){await gateway.closePreview(remove[1]);return {ok:true};}
    return undefined;
  });
  function configureSettings(settings:Settings){return {signalingUrl:settings.signalingUrl,iceServers:iceServers(settings),relayFallback:true};}
  let lastConfig=JSON.stringify(configureSettings(app.settings));let lastName=app.settings.deviceName;let configureChain=Promise.resolve();
  const listener=(topic:string,data:unknown)=>{
    if(remoteEvent||closed)return;
    if(topic==='state'){
      const config=JSON.stringify(configureSettings(app.settings));const name=app.settings.deviceName;
      if(config!==lastConfig||name!==lastName){lastConfig=config;lastName=name;configureChain=configureChain.then(async()=>{await peers.rename(name);await peers.configure(configureSettings(app.settings));}).catch(error=>app.emit('network-error',{error:error.message}));}
      const catalog=publicCatalog(app);const stable=JSON.stringify({...catalog,updatedAt:''});if(stable!==lastPublished){lastPublished=stable;void peers.publish('catalog',catalog);}
      const approvals=JSON.stringify(app.store.list('approvals'));if(approvals!==lastApprovals){lastApprovals=approvals;void peers.publish('approval-update',{});}
      browserEvent('state',{deviceId:app.device.id});
    }else if(!['network-error','peer-artifact'].includes(topic))void peers.publish(topic,data);
  };
  app.listeners.add(listener);
  const timer=setInterval(()=>{for(const device of app.devices)if(!device.local&&device.platform!=='browser'&&device.online)void refreshPeer(device.id);},30000);timer.unref();
  app.closers.push(async()=>{closed=true;clearInterval(timer);app.listeners.delete(listener);await configureChain;await gateway.close();await peers.stop();});
  await peers.start();app.changed();
  return {peers,gateway,async connectTerminal(sessionId,url,client){
    const deviceId=catalogOwner('sessions',sessionId);if(!deviceId||deviceId===app.device.id)return false;
    let stream:PeerStream|undefined;let detach:(()=>void)|undefined;let ready=false;let inputBytes=0;let inputChain=Promise.resolve();
    const pending:Packet[]=[];
    const fail=(error:Error)=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify({type:'error',data:error.message}));client.close();stream?.close(error.message);};
    const sendInput=(packet:Packet)=>{const size=Buffer.byteLength(JSON.stringify(packet));
      inputChain=inputChain.then(()=>sendPacket(stream!,packet)).catch(fail).finally(()=>{inputBytes-=size;});};
    // Resize and input can arrive as soon as the local socket opens, before RTC
    // and the owning terminal are ready. Preserve their order through attachment.
    client.on('message',(data,binary)=>{
      let packet:Packet;try{packet=binary?{type:'input',data:data.toString()}:object(JSON.parse(data.toString()));terminalInput(packet);}catch{packet={type:'input',data:data.toString()};}
      inputBytes+=Buffer.byteLength(JSON.stringify(packet));if(inputBytes>maxStreamBuffer){fail(new Error('Terminal input queue is full'));return;}
      if(ready)sendInput(packet);else pending.push(packet);
    });
    client.on('close',()=>{detach?.();stream?.close();pending.length=0;});client.on('error',()=>stream?.close());
    try{requireOnline(app,deviceId);const terminalId=url.searchParams.get('terminalId')||'main';
      stream=await peers.openStream(deviceId,{kind:'terminal',path:`/api/sessions/${encodeURIComponent(sessionId)}/terminal`,
        body:{terminalId,cols:Number(url.searchParams.get('cols')||80),rows:Number(url.searchParams.get('rows')||24)},cursor:Number(url.searchParams.get('cursor')||0)});
      if(client.readyState!==WebSocket.OPEN){stream.close();return true;}
      let cursor=Number(url.searchParams.get('cursor')||0);detach=parsePackets(stream,packet=>{
        if(packet.type==='output'){const sequence=Number(packet.cursor||0);if(sequence&&sequence<=cursor)return;cursor=sequence||cursor;
          if(client.bufferedAmount>maxStreamBuffer){stream!.close('Terminal viewer fell behind');client.close(1013,'Terminal viewer fell behind');return;}
          if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify(packet));}
        else if(packet.type==='error'&&client.readyState===WebSocket.OPEN)client.send(JSON.stringify(packet));
      });
      stream.on('end',(error?:string)=>{if(error&&client.readyState===WebSocket.OPEN)client.send(JSON.stringify({type:'error',data:error}));client.close();});
      await sendPacket(stream,{type:'attach'});for(const packet of pending.splice(0))sendInput(packet);ready=true;
      if(client.readyState!==WebSocket.OPEN)stream.close();
    }catch(error){fail(error as Error);}
    return true;
  }};
}

async function serveTerminal(app:DeviceApp,sessionId:string,shellUrl:(terminalId:string)=>string,shellHeaders:()=>Record<string,string>,options:StreamOptions,stream:PeerStream):Promise<void> {
  const body=object(options.body);const terminalId=String(body.terminalId||'main');
  const url=new URL(shellUrl.call(app.sessions.get(sessionId),terminalId));
  for(const field of ['cols','rows'])if(Number(body[field])>0)url.searchParams.set(field,String(body[field]));
  const socket=new WebSocket(url,{headers:shellHeaders.call(app.sessions.get(sessionId)),handshakeTimeout:15000,maxPayload:maxStreamBuffer});
  let attached=false;let closePending=false;let queuedBytes=0;let sequence=Number(options.cursor||0);let sendChain=Promise.resolve();
  const queue:Packet[]=[];const attachTimeout=setTimeout(()=>{if(!attached)stream.close('Terminal viewer did not attach');},15000);attachTimeout.unref();
  const send=(packet:Packet)=>{const size=Buffer.byteLength(String(packet.data||''));
    sendChain=sendChain.then(()=>sendPacket(stream,packet)).catch(error=>{socket.close();stream.close(error.message);})
      .finally(()=>{queuedBytes-=size;if(queuedBytes<64*1024&&socket.readyState===WebSocket.OPEN)socket.resume();});};
  const detach=parsePackets(stream,packet=>{
    if(packet.type==='attach'){clearTimeout(attachTimeout);attached=true;for(const item of queue.splice(0))send(item);if(closePending)finish();return;}
    if(socket.readyState!==WebSocket.OPEN)throw new Error('Terminal is not connected');
    if(socket.bufferedAmount>maxStreamBuffer)throw new Error('Terminal input queue is full');
    socket.send(terminalInput(packet));
  });
  socket.on('message',(data,binary)=>{
    const packet:Packet={type:'output',data:binary?Buffer.from(data as Buffer).toString('utf8'):data.toString(),cursor:++sequence};
    queuedBytes+=Buffer.byteLength(String(packet.data));if(queuedBytes>maxStreamBuffer){stream.close('Terminal output queue is full');socket.close();return;}
    if(queuedBytes>128*1024)socket.pause();if(attached)send(packet);else queue.push(packet);
  });
  function finish(){if(!attached){closePending=true;return;}void sendChain.finally(()=>stream.close(undefined,'events'));}
  socket.on('error',error=>stream.close(error.message));socket.on('close',finish);
  stream.on('end',()=>{clearTimeout(attachTimeout);detach();socket.close();});
  await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);socket.once('close',()=>reject(new Error('Terminal closed before connecting')));});
}
