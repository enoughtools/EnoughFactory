import { EnvmuxEngine, type EnvmuxSession, type EnvmuxReady, type EnvmuxState } from '@enoughfactory/envmux';
import type { Project, Session, RepositoryChanges, ContainerRuntimeStatus, WorkingDirectoryMount, Chat, RuntimeKind } from '@enoughfactory/contracts';
import { dockerInvocation, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { ArtifactStore, WorkingDirectoryManager, type WorkingDirectorySource, type WorkingDirectorySnapshot, type WorkingDirectoryCapture } from '@enoughfactory/workspaces';
import { Store } from './store.ts';
import { exec, HttpError, id, now } from './util.ts';
import path from 'node:path';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { managedRepositoryReader, readRepositoryChanges } from './repository-changes.ts';
import { prepareDevelopmentToolchain, validateFrozenDevelopmentToolchain, type FrozenDevelopmentToolchain } from './development-toolchain.ts';
import { retireStoppedFactoryContainer } from './factory-container-retirement.ts';
import { restoreFactoryContainerArchives } from './factory-container-restore.ts';
import { prepareAgentToolchain, verifyPreparedAgentToolchain, type PreparedAgentToolchain } from '@enoughfactory/agents';

interface WorkspaceBinding { bindSource:string; stateVolume:string; }
interface PrivateSession { id: string; ready: EnvmuxReady; projectPath: string; pid?: number; workspace?:WorkspaceBinding; }
interface LaunchRecord { id:string;projectPath:string;generation:number;dockerHost:string;workspace?:WorkspaceBinding; workingDirectorySources?:WorkingDirectorySource[]; referenceContext?:WorkingDirectorySource; developmentToolchain?:FrozenDevelopmentToolchain; agentToolchain?:PreparedAgentToolchain; }
type RetirementReceipt = Awaited<ReturnType<typeof retireStoppedFactoryContainer>>;
interface ContainerRetirement { id:string;containerId:string;name:string;status:'archiving'|'removed'|'restored';receipt?:RetirementReceipt;archive?:string;updatedAt:string; }
interface LaunchOptions { workspace?:WorkspaceBinding; workingDirectorySources?:WorkingDirectorySource[]; referenceContext?:WorkingDirectorySource; developmentToolchain?:FrozenDevelopmentToolchain; assertCurrent?:()=>void; retainedEnvironment?:RetirementReceipt; agentToolchain?:PreparedAgentToolchain; }
interface RuntimeAccess { endpoint:DockerRuntimeEndpoint; ensureReady():Promise<DockerRuntimeEndpoint>; bridgeHostAddress():string|undefined; }
class SessionGenerationChangedError extends HttpError {constructor(){super(409,'A newer environment connection replaced this request.');}}
export class SessionController {
  readonly engine: EnvmuxEngine;
  private live = new Map<string, EnvmuxSession>();
  private streams = new Map<string, AbortController>();
  private starts = new Map<string, AbortController>();
  private stopping = new Set<string>();
  private launchJobs = new Map<string,Promise<void>>();
  private stopJobs = new Map<string,Promise<void>>();
  private generations = new Map<string,number>();
  private runtimeWaits = new Set<string>();
  private stoppedInputReleases = new Set<string>();
  private restoring = new Set<string>();
  readonly afterTerminal: Array<(sessionId:string)=>void> = [];
  readonly beforeStop: Array<(sessionId:string)=>Promise<void>> = [];
  readonly afterCaptureBeforeStop: Array<(sessionId:string)=>Promise<void>> = [];
  directoryManager: WorkingDirectoryManager;
  private directoryCaptures = new Map<string,Promise<WorkingDirectoryCapture[]>>();
  constructor(private store: Store, private deviceId: string, private changed: () => void, private event: (topic: string, data: unknown) => void, private runtime:RuntimeAccess, private workspaceDataDir=path.join(path.dirname(path.dirname(runtime.endpoint.configDirectory)),'workspace-data')) {
    this.engine = new EnvmuxEngine({binary: process.env.ENOUGHFACTORY_ENVMUX_PATH,dockerRuntime:runtime.endpoint,containerHostAddress:runtime.bridgeHostAddress(),workspaceRoot: process.env.ENOUGHFACTORY_REPO||process.env.ENOUGHFACTORY_RESOURCES||path.resolve(process.cwd(),process.cwd().endsWith('/apps/device')?'../..':'.')});
    this.directoryManager=new WorkingDirectoryManager({dataDir:workspaceDataDir,artifacts:new ArtifactStore(path.join(workspaceDataDir,'artifacts'),deviceId)});
  }
  setDeviceId(deviceId: string): void {this.deviceId=deviceId;this.directoryManager=new WorkingDirectoryManager({dataDir:this.workspaceDataDir,artifacts:new ArtifactStore(path.join(this.workspaceDataDir,'artifacts'),deviceId)});}
  owns(sessionId:string):boolean {return (this.store.get<LaunchRecord>('session-launch',sessionId)?.dockerHost||this.store.get<PrivateSession>('session-private',sessionId)?.ready.dockerHost)===this.runtime.endpoint.host;}
  needsTermination(sessionId:string):boolean {return this.owns(sessionId)&&this.store.get<ContainerRetirement>('session-container-retirement',sessionId)?.status!=='removed'&&this.record(sessionId).status!=='stopped'&&(this.live.has(sessionId)||this.starts.has(sessionId)||Boolean(this.store.get<PrivateSession>('session-private',sessionId)));}
  serviceActivity():{starting:number;stopping:number} {return {starting:new Set([...this.starts.keys(),...this.launchJobs.keys(),...this.restoring]).size,stopping:new Set([...this.stopping,...this.stopJobs.keys(),...this.stoppedInputReleases]).size};}
  retirementIdentityKey(sessionId:string):string {const launch=this.store.get<LaunchRecord>('session-launch',sessionId),saved=this.store.get<PrivateSession>('session-private',sessionId);return `${launch?.generation??0}:${saved?.ready.instance??this.record(sessionId).containerId??''}`;}
  retirementContainerName(sessionId:string):string {const name=this.store.get<PrivateSession>('session-private',sessionId)?.ready.instance??this.record(sessionId).containerId;if(!name)throw new HttpError(409,'No owned container identity was confirmed for this environment.','ENVIRONMENT_IDENTITY_UNKNOWN');return name;}
  private namespaceId(projectPath:string,name:string):string {return createHash('sha256').update(JSON.stringify([this.runtime.endpoint.host,projectPath,name])).digest('hex');}
  private ownsNamespace(sessionId:string):boolean {
    const launch=this.store.get<LaunchRecord>('session-launch',sessionId),record=this.record(sessionId);if(!launch)return false;
    const owner=this.store.get<{id:string;sessionId:string;generation:number}>('session-container-owner',this.namespaceId(launch.projectPath,record.name));
    if(owner)return owner.sessionId===sessionId&&owner.generation===launch.generation;
    // Legacy name-only metadata cannot distinguish two app sessions that reused
    // one envmux name. Preserve both until exact ownership can be reconciled.
    return !this.store.list<Session>('sessions').some(other=>other.id!==sessionId&&other.name===record.name&&this.store.get<LaunchRecord>('session-launch',other.id)?.projectPath===launch.projectPath&&this.store.get<PrivateSession>('session-private',other.id)&&!this.archivedEnvironment(other.id));
  }
  archivedEnvironment(sessionId:string):ContainerRetirement|undefined {this.record(sessionId);const retired=this.store.get<ContainerRetirement>('session-container-retirement',sessionId);return retired?.status==='removed'?retired:undefined;}
  private nativeOwnerAlive(sessionId:string):boolean {
    const pid=this.live.get(sessionId)?.process?.pid??this.store.get<PrivateSession>('session-private',sessionId)?.pid;
    if(!pid)return false;
    try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;return true;}
  }
  canRetireEnvironment(sessionId:string):boolean {
    const record=this.record(sessionId);
    return this.owns(sessionId)&&this.ownsNamespace(sessionId)&&['stopped','failed','unknown'].includes(record.status)&&!this.starts.has(sessionId)&&!this.launchJobs.has(sessionId)&&!this.stopJobs.has(sessionId)&&!this.stopping.has(sessionId)&&!this.directoryCaptures.has(sessionId)&&!this.restoring.has(sessionId)&&!this.nativeOwnerAlive(sessionId);
  }
  /** A terminal provider outcome and a stopped container are independent facts. */
  async withRetirementLease<T>(sessionId:string,operation:()=>Promise<T>):Promise<T> {
    if(this.stoppedInputReleases.has(sessionId)||!this.canRetireEnvironment(sessionId))throw new HttpError(409,'This environment still has an active owner or operation.','ENVIRONMENT_IN_USE');
    this.stoppedInputReleases.add(sessionId);
    this.streams.get(sessionId)?.abort();this.streams.delete(sessionId);this.live.delete(sessionId);
    this.generations.set(sessionId,(this.generations.get(sessionId)||0)+1);
    try{return await operation();}finally{this.stoppedInputReleases.delete(sessionId);}
  }
  assertCanArchive(sessionId:string):void {
    const record=this.record(sessionId);
    if(!['stopped','failed'].includes(record.status)||this.live.has(sessionId)||this.starts.has(sessionId)||this.launchJobs.has(sessionId)||this.stopJobs.has(sessionId)||this.stopping.has(sessionId)||this.needsTermination(sessionId))throw new HttpError(409,'Stop this environment and confirm its work has returned before removing it.','ENVIRONMENT_IN_USE');
  }
  /** A stopped session cannot restart while its reconstructible host inputs are released. */
  async withStoppedInputs<T>(sessionId:string, operation:()=>Promise<T>):Promise<T> {
    if(this.stoppedInputReleases.has(sessionId))throw new HttpError(409,'This environment is releasing retained input copies.','ENVIRONMENT_BUSY');
    this.assertCanArchive(sessionId);
    if(!this.owns(sessionId)||this.record(sessionId).status!=='stopped')throw new HttpError(409,'Confirm the owned environment has stopped before releasing its input copies.','ENVIRONMENT_IN_USE');
    this.stoppedInputReleases.add(sessionId);
    try{return await operation();}finally{this.stoppedInputReleases.delete(sessionId);}
  }
  async retireEphemeralEnvironment(sessionId:string,dataDir:string,options:{assertCurrent:()=>void;assertSpace:()=>void;runtimeKinds:RuntimeKind[]}):Promise<void> {
    const saved=this.store.get<PrivateSession>('session-private',sessionId),launch=this.store.get<LaunchRecord>('session-launch',sessionId),record=this.record(sessionId);
    if(!this.stoppedInputReleases.has(sessionId)||!saved||!launch||saved.ready.dockerHost!==this.runtime.endpoint.host||(record.containerId!=null&&record.containerId!==saved.ready.instance)||!this.owns(sessionId))throw new HttpError(409,'Container retirement requires its owned terminal-session lease.');
    const previous=this.store.get<ContainerRetirement>('session-container-retirement',sessionId);
    if(previous&&previous.name!==saved.ready.instance)throw new HttpError(409,'The container ownership changed.');
    const current=()=>{options.assertCurrent();if(!this.stoppedInputReleases.has(sessionId)||!this.canRetireEnvironment(sessionId)||this.store.get<PrivateSession>('session-private',sessionId)?.ready.instance!==saved.ready.instance||this.store.list<Chat>('chats').some(chat=>chat.sessionId===sessionId&&['running','waiting'].includes(chat.status)))throw new HttpError(409,'The terminal environment identity or provider ownership changed.');};
    const receipt=await retireStoppedFactoryContainer({endpoint:this.runtime.endpoint,dataDir,assertCurrent:current,assertSpace:options.assertSpace,pinnedContainerId:previous?.status==='restored'?undefined:previous?.containerId,
      pinContainerId:containerId=>this.store.set('session-container-retirement',{id:sessionId,containerId,name:saved.ready.instance,status:'archiving',updatedAt:now()}),
      preservation:{runtimeKinds:options.runtimeKinds,includeWorkAndHome:true,removeOwnedVolumes:true,additionalPaths:record.workingDirectories?.map(root=>root.path)},
      identity:{sessionId,container:saved.ready.instance,name:saved.ready.instance,project:saved.ready.project,sessionName:saved.ready.session,projectPath:launch.projectPath,branch:saved.ready.branch,workdir:saved.ready.workdir}});
    this.store.set('session-container-retirement',{id:sessionId,containerId:receipt.containerId,name:saved.ready.instance,status:'removed',receipt,archive:receipt.archive,sha256:receipt.sha256,size:receipt.size,rawSha256:receipt.rawSha256,rawSize:receipt.rawSize,updatedAt:now()});
    this.store.append('session-environment-history',sessionId,{containerId:receipt.containerId,receipt,retiredAt:now()});
    this.changed();
  }
  async retireWorkerContainer(sessionId:string,dataDir:string,assertCurrent:()=>void,assertSpace:()=>void):Promise<void> {
    const runtimeKinds=[...new Set(this.store.list<Chat>('chats').filter(chat=>chat.sessionId===sessionId).map(chat=>chat.runtime))];
    return this.retireEphemeralEnvironment(sessionId,dataDir,{assertCurrent,assertSpace,runtimeKinds});
  }
  assertActiveProject(project:Project|undefined):void {
    if(!project)throw new HttpError(404,'The source project is no longer available.');
    const visited=new Set<string>();let current:Project|undefined=project;
    while(current&&!visited.has(current.id)){
      if(current.archivedAt)throw new HttpError(409,'Restore this project before starting or restoring its environment.','PROJECT_REMOVED');
      visited.add(current.id);current=current.sourceProjectId?this.store.get<Project>('projects',current.sourceProjectId):undefined;
    }
  }
  assertWorkAvailable(sessionId:string):Session {
    if(this.stoppedInputReleases.has(sessionId))throw new HttpError(409,'Wait for retained input copies to finish releasing before restarting this environment.','ENVIRONMENT_BUSY');
    if(this.restoring.has(sessionId))throw new HttpError(409,'This environment is restoring its preserved work and conversation state.','ENVIRONMENT_BUSY');
    if(this.archivedEnvironment(sessionId))throw new HttpError(409,'This ephemeral environment has been removed. Its conversation and preserved files are retained. Restart it to create a fresh environment from that archive.','ENVIRONMENT_ARCHIVED',{archiveUrl:`/api/sessions/${sessionId}/environment-archive`,restartUrl:`/api/sessions/${sessionId}/restart`});
    const record=this.record(sessionId);if(record.archivedAt)throw new HttpError(409,'Restore this environment before starting work.','ENVIRONMENT_REMOVED');
    const project=this.store.get<Project>('projects',record.projectId);if(project)this.assertActiveProject(project);
    return record;
  }
  runtimeProgress(status:ContainerRuntimeStatus):void {for(const sessionId of this.runtimeWaits)this.patch(sessionId,{phase:status.phase||'Preparing EnoughFactory runtime'});}
  async recover(): Promise<void> {
    for (const saved of this.store.list<PrivateSession>('session-private')) {
      const record = this.store.get<Session>('sessions', saved.id);
      if (!record || record.archivedAt || record.status === 'stopped'||this.archivedEnvironment(saved.id)||this.stoppedInputReleases.has(saved.id)||this.restoring.has(saved.id)) continue;
      if(saved.ready.dockerHost!==this.runtime.endpoint.host){this.patch(saved.id,{status:'unknown',phase:'This session belongs to a previous container engine.',error:'EnoughFactory will not attach to your personal Docker. Preserve its work there and start a new EnoughFactory environment.'});continue;}
      try { await this.runtime.ensureReady();await this.attach(saved); }
      catch(error) { if(!(error instanceof SessionGenerationChangedError))this.patch(saved.id, {status:'unknown', phase:'The owned environment is not connected.',error:(error as Error).message}); }
    }
    for (const record of this.store.list<Session>('sessions')) if (!record.archivedAt && record.status === 'starting' && !this.live.has(record.id)) this.patch(record.id,{status:'unknown',phase:'Device service restarted during startup.'});
  }
  private async attach(saved:PrivateSession):Promise<EnvmuxSession>{
    if(saved.ready.dockerHost!==this.runtime.endpoint.host)throw new HttpError(409,'This environment belongs to a previous container engine. Create a new EnoughFactory environment.');
    const launch=this.store.get<LaunchRecord>('session-launch',saved.id),toolchain=launch?.developmentToolchain;
    if(toolchain&&toolchain!=='default'){
      const frozen=validateFrozenDevelopmentToolchain(toolchain);
      if(frozen!=='default'&&saved.ready.goldenImage!==(launch?.agentToolchain?.image??frozen.image))throw new HttpError(409,'This environment did not confirm its saved development toolchain. Its work is retained; inspect it before starting a replacement.');
      if(launch?.agentToolchain)await verifyPreparedAgentToolchain(this.runtime.endpoint,launch.agentToolchain);
    }
    const generation=(this.generations.get(saved.id)||this.store.get<LaunchRecord>('session-launch',saved.id)?.generation||0)+1;this.generations.set(saved.id,generation);
    const current=()=>this.generations.get(saved.id)===generation;
    const engine=await this.engine.attach(saved);if(!current())throw new SessionGenerationChangedError();
    this.live.set(saved.id,engine);
    if(this.store.get<{id:string;status:string}>('session-environment-restore',saved.id)?.status==='restoring')throw new HttpError(409,'The new environment did not finish restoring its preserved files. The original archive remains available; inspect recovery before continuing.','ENVIRONMENT_RESTORE_INCOMPLETE');
    if(this.record(saved.id).workingDirectories?.length&&!this.store.get<{id:string;complete:boolean}>('session-working-directory-provision',saved.id)?.complete)throw new HttpError(409,'Additional folders were not fully provisioned. The retained container has not been reseeded; inspect its files before restarting.');
    if(this.store.get<LaunchRecord>('session-launch',saved.id)?.referenceContext&&!this.store.get<{id:string;complete:boolean}>('session-reference-context-provision',saved.id)?.complete)throw new HttpError(409,'Retained reference evidence was not fully provisioned. No worker execution can use this environment yet.');
    const state=await engine.state();if(!current()||this.live.get(saved.id)!==engine)throw new SessionGenerationChangedError();
    await this.update(saved.id,state);this.observe(saved.id,engine,generation);return engine;
  }
  async create(project: Project, name: string, options?: LaunchOptions): Promise<Session> {
    this.assertActiveProject(project);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new HttpError(400,'Use a session name with letters, numbers, dots, underscores or hyphens.');
    if(this.store.list<Session>('sessions').some(session=>session.name===name&&(session.projectId===project.id||this.store.get<LaunchRecord>('session-launch',session.id)?.projectPath===project.path)&&(this.stoppedInputReleases.has(session.id)||this.restoring.has(session.id))))throw new HttpError(409,'This environment name is preserving or restoring its previous contents. Wait for that operation to finish.','ENVIRONMENT_BUSY');
    if (this.store.list<Session>('sessions').some(s=>s.projectId===project.id && s.name===name && !['stopped','failed'].includes(s.status))) throw new HttpError(409,'This session already exists.');
    const record: Session = {id:id('session'),projectId:project.id,deviceId:this.deviceId,name,status:'starting',phase:'Preparing EnoughFactory runtime',createdAt:now(),updatedAt:now(),services:[]};
    this.store.set('sessions',record); this.changed();
    this.launch(record,project,options);return record;
  }
  private launch(record:Session,project:Project,options?:LaunchOptions):void{
    const generation=(this.generations.get(record.id)||this.store.get<LaunchRecord>('session-launch',record.id)?.generation||0)+1;this.generations.set(record.id,generation);
    this.store.set<LaunchRecord>('session-launch',{id:record.id,projectPath:project.path,generation,dockerHost:this.runtime.endpoint.host,workspace:options?.workspace,workingDirectorySources:options?.workingDirectorySources,referenceContext:options?.referenceContext,developmentToolchain:options?.developmentToolchain,agentToolchain:options?.agentToolchain});
    this.store.set('session-container-owner',{id:this.namespaceId(project.path,record.name),sessionId:record.id,generation,updatedAt:now()});
    const current=()=>this.generations.get(record.id)===generation;
    const abort = new AbortController(); this.starts.set(record.id,abort);this.runtimeWaits.add(record.id);
    const job=(async()=>{await this.runtime.ensureReady();this.runtimeWaits.delete(record.id);if(abort.signal.aborted)throw new Error('Environment startup canceled.');
      const developmentToolchain=await prepareDevelopmentToolchain(this.runtime.endpoint,project,{frozen:options?.developmentToolchain,signal:abort.signal,onProgress:phase=>{if(current())this.patch(record.id,{phase});}});
      if(!current()||abort.signal.aborted)throw new Error('Environment startup canceled.');
      const agentToolchain=developmentToolchain==='default'?undefined:options?.agentToolchain
        ?await verifyPreparedAgentToolchain(this.runtime.endpoint,options.agentToolchain,{signal:abort.signal})
        :await prepareAgentToolchain(this.runtime.endpoint,developmentToolchain.image,project.runtime,{signal:abort.signal,onProgress:phase=>{if(current())this.patch(record.id,{phase});}});
      if(!current()||abort.signal.aborted)throw new Error('Environment startup canceled.');
      this.store.set('session-launch',{...this.store.get<LaunchRecord>('session-launch',record.id)!,developmentToolchain,agentToolchain});
      this.patch(record.id,{developmentToolchain:developmentToolchain==='default'?undefined:developmentToolchain});
      if(options?.workingDirectorySources!==undefined?options.workingDirectorySources.length:project.workingDirectories?.length){
        this.patch(record.id,{phase:'Snapshotting additional working folders'});
        let roots=await this.directoryManager.sourceSnapshots(record.id);
        if(!roots.length)roots=await this.directoryManager.prepare({identity:record.id,...(options?.workingDirectorySources?{transferred:options.workingDirectorySources}:{sources:project.workingDirectories})});
        this.patch(record.id,{workingDirectories:roots.map(root=>this.publicRoot(root,'preparing'))});
        this.store.set('session-launch',{...this.store.get<LaunchRecord>('session-launch',record.id)!,workingDirectorySources:roots.map(({path:_,...source})=>source)});
        this.store.set('session-working-directory-provision',{id:record.id,complete:false});
      }else{
        this.store.set('session-launch',{...this.store.get<LaunchRecord>('session-launch',record.id)!,workingDirectorySources:[]});
      }
      if(options?.referenceContext){
        if(!current()||abort.signal.aborted)throw new SessionGenerationChangedError();options.assertCurrent?.();
        if((options.workingDirectorySources||[]).some(root=>root.name.toLowerCase()===options.referenceContext!.name.toLowerCase()))throw new Error('Reference evidence must not overlap an authored working folder.');
        await this.directoryManager.prepare({identity:`${record.id}-reference-context`,transferred:[options.referenceContext]});
        if(!current()||abort.signal.aborted)throw new SessionGenerationChangedError();options.assertCurrent?.();
        this.store.set('session-reference-context-provision',{id:record.id,complete:false});
      }
      if(abort.signal.aborted)throw new Error('Environment startup canceled.');
      options?.assertCurrent?.();
      if(current())this.patch(record.id,{phase:'Preparing environment',error:undefined});
      return this.engine.start({projectPath:project.path,name:record.name,workspace:options?.workspace,goldenImage:developmentToolchain==='default'?undefined:agentToolchain!.image,signal:abort.signal,onEvent: e=>{
      if(!current())return;
      if(e.type==='phase') this.patch(record.id,{phase:e.phase});
      if(e.type==='error') this.patch(record.id,{error:e.error});
      this.event('session',{sessionId:record.id,...e});
    },onLog: line=>{
      if(!current())return;
      // Bootstrap stdout may contain private vendor URLs. Store startup output only
      // after removing credential-bearing query strings and proxy authority.
      const text=line.replace(/([?&](?:token|auth|password)=)[^&\s]+/gi,'$1[private]').replace(/(socks5?:\/\/)[^@\s]+@/gi,'$1[private]@');
      this.store.append('session-output',record.id,{at:now(),text}); this.event('output',{sessionId:record.id,text});
    }});})().then(async engine=>{
      if(!current()){await engine.stop();return;}
      this.live.set(record.id,engine);
      this.store.set<PrivateSession>('session-private',{id:record.id,ready:engine.ready,projectPath:project.path,pid:engine.process?.pid,workspace:options?.workspace});
      if(options?.retainedEnvironment){
        this.store.set('session-environment-restore',{id:record.id,status:'restoring',receipt:options.retainedEnvironment,container:engine.ready.instance,updatedAt:now()});
        this.store.set('session-container-retirement',{id:record.id,name:engine.ready.instance,status:'restored',containerId:engine.ready.instance,previousContainerId:options.retainedEnvironment.containerId,updatedAt:now()});
      }
      await this.provisionWorkingDirectories(record.id,engine,true);
      const assertCurrent=()=>{if(!current()||this.live.get(record.id)!==engine||abort.signal.aborted)throw new SessionGenerationChangedError();options?.assertCurrent?.();};
      assertCurrent();
      await this.provisionReferenceContext(record.id,engine,assertCurrent);
      assertCurrent();
      if(options?.retainedEnvironment){
        this.patch(record.id,{phase:'Restoring preserved work and provider history'});
        await restoreFactoryContainerArchives({endpoint:this.runtime.endpoint,dataDir:path.dirname(this.workspaceDataDir),receipt:options.retainedEnvironment,
          identity:{sessionId:record.id,container:engine.ready.instance,name:engine.ready.instance,project:engine.ready.project,sessionName:engine.ready.session,projectPath:project.path,branch:engine.ready.branch,workdir:engine.ready.workdir},assertCurrent});
        assertCurrent();
        this.store.set('session-container-retirement',{id:record.id,name:engine.ready.instance,status:'restored',containerId:engine.ready.instance,previousContainerId:options.retainedEnvironment.containerId,updatedAt:now()});
        this.store.set('session-environment-restore',{id:record.id,status:'restored',sourceContainerId:options.retainedEnvironment.containerId,container:engine.ready.instance,updatedAt:now()});
        this.restoring.delete(record.id);
      }
      this.patch(record.id,{status:'ready',containerId:engine.ready.instance,enginePid:engine.process?.pid,branch:engine.ready.branch});
      engine.process?.once('exit',code=>{if(!current())return; this.streams.get(record.id)?.abort(); this.streams.delete(record.id); this.live.delete(record.id);const requested=this.stopping.has(record.id);this.stopping.delete(record.id);this.patch(record.id,{status:code!==0?'failed':requested?'stopped':'unknown',phase:code!==0?'Environment stopped with an error':requested?'Work returned to Git':'Engine disconnected',error:code!==0?`Engine exited with ${code}; inspect retained work before retrying.`:undefined}); });
      const state=await engine.state();if(!current()||this.live.get(record.id)!==engine)return;
      await this.update(record.id,state); this.observe(record.id,engine,generation);
    }).catch(error=>{if(!current())return;if(abort.signal.aborted&&this.stopping.has(record.id)&&!this.live.has(record.id)){this.stopping.delete(record.id);this.patch(record.id,{status:'stopped',error:undefined,phase:'Startup canceled; retained work is preserved'});}else this.patch(record.id,{status:this.live.has(record.id)?'unknown':'failed',error:error.message,phase:this.live.has(record.id)?'Environment retained; additional setup was not confirmed':'Could not prepare the environment'});}).finally(()=>{this.restoring.delete(record.id);this.runtimeWaits.delete(record.id);if(this.starts.get(record.id)===abort)this.starts.delete(record.id);if(this.launchJobs.get(record.id)===job)this.launchJobs.delete(record.id);this.notifyTerminal(record.id);});
    this.launchJobs.set(record.id,job);
  }
  get(sessionId: string): EnvmuxSession {
    this.assertWorkAvailable(sessionId);
    const session=this.live.get(sessionId); if(!session) throw new HttpError(409,'This environment is not connected.','SESSION_UNAVAILABLE'); return session;
  }
  assertCanStartWork(sessionId:string):void{this.assertWorkAvailable(sessionId);if(this.record(sessionId).status!=='ready'||this.stopping.has(sessionId)||this.stopJobs.has(sessionId)||this.directoryCaptures.has(sessionId))throw new HttpError(409,'Wait until the environment is ready and its working folders have finished being preserved.','ENVIRONMENT_BUSY');}
  record(sessionId: string): Session { const r=this.store.get<Session>('sessions',sessionId); if(!r) throw new HttpError(404,'Session not found.'); return r; }
  async waitReady(sessionId:string,timeoutMs=30*60_000):Promise<EnvmuxSession>{
    const started=Date.now();while(Date.now()-started<timeoutMs){const record=this.record(sessionId);if(record.status==='ready')return this.get(sessionId);if(['failed','stopped','unknown'].includes(record.status))throw new Error(record.error||record.phase||'Environment unavailable');await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('Environment startup timed out.');
  }
  async waitStopped(sessionId:string,timeoutMs=120_000):Promise<Session>{
    const started=Date.now();while(Date.now()-started<timeoutMs){const record=this.record(sessionId);if(record.status==='stopped')return record;if(record.status==='failed')throw new Error(record.error||'Environment stop failed');await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('Environment has not confirmed that work was returned.');
  }
  private patch(sessionId: string, values: Partial<Session>): void {
    const current=this.store.get<Session>('sessions',sessionId); if(!current) return;
    this.store.set('sessions',{...current,...values,updatedAt:now()}); this.changed();if(values.status)this.notifyTerminal(sessionId);
  }
  private notifyTerminal(sessionId:string):void {if(['stopped','failed','unknown'].includes(this.record(sessionId).status))for(const hook of this.afterTerminal)hook(sessionId);}
  private async update(sessionId: string,state: EnvmuxState): Promise<void> {
    this.patch(sessionId,{status:state.failed?'failed':this.stopping.has(sessionId)?'stopping':state.ready?'ready':'starting',phase:state.phase,error:state.failed,branch:state.branch,services:state.tasks.filter(t=>!t.internal).map(t=>({name:t.name,status:t.status||t.state,command:t.command,url:state.routes.find(r=>r.name===t.name)?.url,port:state.routes.find(r=>r.name===t.name)?.port}))});
  }
  private observe(sessionId: string,engine: EnvmuxSession,generation:number): void {
    if(this.generations.get(sessionId)!==generation||this.live.get(sessionId)!==engine)return;
    this.streams.get(sessionId)?.abort(); const abort=new AbortController(); this.streams.set(sessionId,abort);
    void(async()=>{try { for await(const state of engine.events(abort.signal)) {if(this.generations.get(sessionId)!==generation)return;await this.update(sessionId,state);this.event('session-state',{sessionId,state});} }
      catch(error){if(!abort.signal.aborted&&this.generations.get(sessionId)===generation)this.patch(sessionId,{status:'unknown',phase:'Environment connection lost'});}})();
  }
  async stop(sessionId: string): Promise<void> {
    if(this.record(sessionId).status==='stopped')return;
    const previous=this.stopJobs.get(sessionId);if(previous)return previous;
    const operation=this.stopSession(sessionId).finally(()=>{this.stopJobs.delete(sessionId);this.notifyTerminal(sessionId);});this.stopJobs.set(sessionId,operation);return operation;
  }
  private async stopSession(sessionId:string):Promise<void>{
    this.stopping.add(sessionId);
    this.patch(sessionId,{status:'stopping',phase:'Returning work to Git'});
    if(this.starts.has(sessionId)&&!this.live.has(sessionId)){this.starts.get(sessionId)!.abort();await this.launchJobs.get(sessionId);if(this.record(sessionId).status==='failed')throw new Error(this.record(sessionId).error||'Startup has not confirmed termination.');return;}
    if(this.starts.has(sessionId))await this.launchJobs.get(sessionId);
    try {for(const hook of this.beforeStop)await hook(sessionId);let engine=this.live.get(sessionId);if(!engine){const saved=this.store.get<PrivateSession>('session-private',sessionId);if(!saved)throw new HttpError(409,'The environment owner has not confirmed its state.');engine=await this.attach(saved);}await this.captureWorkingDirectories(sessionId);for(const hook of this.afterCaptureBeforeStop)await hook(sessionId);await engine.stop();}catch(error){this.stopping.delete(sessionId);this.patch(sessionId,{status:'unknown',phase:'Could not confirm work was returned; environment retained',error:(error as Error).message});throw error;}
    this.stopping.delete(sessionId);this.patch(sessionId,{status:'stopped',phase:'Work returned to Git'});
    this.streams.get(sessionId)?.abort();this.live.delete(sessionId);
    await this.disposeReferenceContext(sessionId);
  }
  async restart(sessionId: string): Promise<void> {
    const launchNamespace=this.store.get<LaunchRecord>('session-launch',sessionId),restartRecord=this.record(sessionId);
    if(launchNamespace){
      if(this.store.list<Session>('sessions').some(other=>other.id!==sessionId&&other.name===restartRecord.name&&this.store.get<LaunchRecord>('session-launch',other.id)?.projectPath===launchNamespace.projectPath&&(this.stoppedInputReleases.has(other.id)||this.restoring.has(other.id))))throw new HttpError(409,'This environment name is preserving or restoring its previous contents.','ENVIRONMENT_BUSY');
      const owner=this.store.get<{id:string;sessionId:string}>('session-container-owner',this.namespaceId(launchNamespace.projectPath,restartRecord.name));
      if(owner&&owner.sessionId!==sessionId&&!this.archivedEnvironment(owner.sessionId))throw new HttpError(409,'A newer environment owns this name. Its work is retained; create a fresh environment with another name to continue.','ENVIRONMENT_NAME_REUSED');
    }
    const archive=this.archivedEnvironment(sessionId);
    if(archive){
      if(this.stoppedInputReleases.has(sessionId)||this.restoring.has(sessionId)||this.starts.has(sessionId)||this.stopJobs.has(sessionId)||this.stopping.has(sessionId))throw new HttpError(409,'Wait for environment preservation to finish.','ENVIRONMENT_BUSY');
      const record=this.record(sessionId),launch=this.store.get<LaunchRecord>('session-launch',sessionId),saved=this.store.get<PrivateSession>('session-private',sessionId),project=this.store.get<Project>('projects',record.projectId);
      this.assertActiveProject(project);
      if(record.archivedAt)throw new HttpError(409,'Restore this environment before restarting.','ENVIRONMENT_REMOVED');
      if(!archive.receipt||archive.receipt.version!==2)throw new HttpError(409,'This older environment has preserved conversation history. Create a fresh environment from its retained candidate to continue.','ENVIRONMENT_ARCHIVED',{archiveUrl:`/api/sessions/${sessionId}/environment-archive`});
      if(!project||!launch||launch.dockerHost!==this.runtime.endpoint.host)throw new HttpError(409,'The original workspace is unavailable. Create a fresh environment from the retained candidate.','ENVIRONMENT_ARCHIVED');
      try{const entry=await lstat(project.path);if(!entry.isDirectory())throw new Error('Not a directory');}catch{throw new HttpError(409,'This merged workspace was released. Its conversation and canonical candidate are retained; start a new task to continue.','ENVIRONMENT_ARCHIVED',{archiveUrl:`/api/sessions/${sessionId}/environment-archive`});}
      this.restoring.add(sessionId);
      this.patch(sessionId,{status:'starting',phase:'Creating a fresh ephemeral environment',error:undefined,services:[]});
      this.launch(record,project,{workspace:launch.workspace||saved?.workspace,workingDirectorySources:launch.workingDirectorySources,referenceContext:launch.referenceContext,developmentToolchain:launch.developmentToolchain||record.developmentToolchain,retainedEnvironment:archive.receipt,agentToolchain:launch.agentToolchain});
      return;
    }
    this.assertWorkAvailable(sessionId);
    if(this.stopJobs.has(sessionId)||this.stopping.has(sessionId))throw new HttpError(409,'Wait for this environment to finish returning its work before restarting.');
    const record=this.record(sessionId),connected=this.live.get(sessionId);
    if(connected){await connected.restart();await this.update(sessionId,await connected.state());return;}
    const saved=this.store.get<PrivateSession>('session-private',sessionId),launch=this.store.get<LaunchRecord>('session-launch',sessionId);
    if(record.status!=='stopped'){if(!saved)throw new HttpError(409,'Reconnect or inspect the environment before restarting uncertain work.');await this.runtime.ensureReady();const engine=await this.attach(saved);await engine.restart();await this.update(sessionId,await engine.state());return;}
    if((launch?.dockerHost||saved?.ready.dockerHost)!==this.runtime.endpoint.host)throw new HttpError(409,'This session used a previous container engine. Create a new EnoughFactory environment from its returned Git branch.');
    const project=this.store.get<Project>('projects',record.projectId);if(!project)throw new HttpError(404,'The source project is no longer available.');
    this.patch(sessionId,{status:'starting',phase:'Preparing EnoughFactory runtime',error:undefined,services:[]});this.launch(record,project,{workspace:launch?.workspace||saved?.workspace,workingDirectorySources:launch?.workingDirectorySources,referenceContext:launch?.referenceContext,developmentToolchain:launch?.developmentToolchain||record.developmentToolchain,agentToolchain:launch?.agentToolchain});
  }
  async changes(sessionId: string, selectedPath?: string, rootId?:string): Promise<RepositoryChanges> {
    if(!rootId){const engine=this.get(sessionId);return readRepositoryChanges(managedRepositoryReader(this.runtime.endpoint,engine.ready),selectedPath);}
    const root=(this.record(sessionId).workingDirectories||[]).find(item=>item.id===rootId);if(!root)throw new HttpError(404,'Working folder not found.');
    if(this.record(sessionId).status!=='stopped'){const engine=this.get(sessionId);return readRepositoryChanges(managedRepositoryReader(this.runtime.endpoint,{...engine.ready,workdir:root.path}),selectedPath,root.baseCommit);}
    const capture=this.store.get<{id:string;roots:WorkingDirectoryCapture[]}>('session-working-directory-captures',sessionId)?.roots.find(item=>item.id===rootId);
    if(!capture)throw new HttpError(409,'This folder has no confirmed retained snapshot.');
    const target=path.join(this.workspaceDataDir,'working-directory-inspection',sessionId,rootId,capture.commit);
    await this.directoryManager.importCapture(capture,target);
    return readRepositoryChanges(async args=>{try{const r=await exec('git',['--no-optional-locks','--no-pager','--literal-pathspecs','-c','core.hooksPath=/dev/null','-C',target,...args]);return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(error){const r=error as {code:number;stdout:string;stderr:string};return r;}},selectedPath,root.baseCommit);
  }
  private publicRoot(root:WorkingDirectorySnapshot,status:WorkingDirectoryMount['status'],capture?:WorkingDirectoryCapture):WorkingDirectoryMount{return {id:root.id,name:root.name,path:root.containerPath,kind:root.kind,baseCommit:root.baseCommit,sourceCommit:root.sourceCommit,status,...(capture?{capture:{commit:capture.commit,bundleArtifactId:capture.bundleArtifact.id,diffArtifactId:capture.diffArtifact.id}}:{})};}
  private async docker(args:string[]):Promise<string>{const i=dockerInvocation(this.runtime.endpoint,args);return (await exec(i.command,i.args,{env:i.env,timeout:120_000,maxBuffer:16*1024*1024})).stdout;}
  private async provisionWorkingDirectories(sessionId:string,engine:EnvmuxSession,relaunch=false):Promise<void>{
    const mounts=this.record(sessionId).workingDirectories;if(!mounts?.length||!relaunch)return;
    const snapshots=await this.directoryManager.sourceSnapshots(sessionId);
    const captures=this.store.get<{id:string;roots:WorkingDirectoryCapture[]}>('session-working-directory-captures',sessionId)?.roots||[];
    for(const root of snapshots){
      let source=root.path;const captured=captures.find(item=>item.id===root.id);
      if(captured){source=path.join(this.workspaceDataDir,'working-directory-restore',sessionId,root.id,captured.commit);await this.directoryManager.importCapture(captured,source);}
      await this.docker(['exec','--user','0',engine.ready.instance,'mkdir','-p','--',root.containerPath]);
      await this.docker(['cp',`${source}/.`,`${engine.ready.instance}:${root.containerPath}`]);
    }
    this.store.set('session-working-directory-provision',{id:sessionId,complete:true});
    this.patch(sessionId,{workingDirectories:snapshots.map(root=>this.publicRoot(root,'ready'))});
  }
  async workingDirectorySources(identity:string,project:Project):Promise<WorkingDirectorySource[]>{const roots=await this.directoryManager.prepare({identity,sources:project.workingDirectories||[]});return roots.map(({path:_,...source})=>source);}
  private async provisionReferenceContext(sessionId:string,engine:EnvmuxSession,assertCurrent:()=>void):Promise<void>{
    const source=this.store.get<LaunchRecord>('session-launch',sessionId)?.referenceContext;if(!source)return;
    assertCurrent();
    const [snapshot]=await this.directoryManager.prepare({identity:`${sessionId}-reference-context`,transferred:[source]});
    assertCurrent();
    if(!snapshot)throw new Error('The worker reference evidence snapshot is unavailable.');
    await this.docker(['exec','--user','0',engine.ready.instance,'mkdir','-p','--',snapshot.containerPath]);
    assertCurrent();
    await this.docker(['cp',`${snapshot.path}/.`,`${engine.ready.instance}:${snapshot.containerPath}`]);
    assertCurrent();
    // This discourages accidental edits, not root access. Retained authority stays
    // in verified immutable artifacts; this private copy is never captured.
    await this.docker(['exec','--user','0',engine.ready.instance,'chmod','-R','a-w','--',snapshot.containerPath]);
    assertCurrent();
    this.store.set('session-reference-context-provision',{id:sessionId,complete:true,sha256:source.sourceArtifact.sha256});
  }
  async disposeReferenceContext(sessionId:string):Promise<void>{
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(sessionId))throw new Error('Invalid reference context session identity.');
    if(this.needsTermination(sessionId))throw new Error('Confirm environment termination before disposing its reference inputs.');
    await rm(path.join(this.workspaceDataDir,'working-directories',`${sessionId}-reference-context`),{recursive:true,force:true});
  }
  async captureWorkingDirectories(sessionId:string):Promise<WorkingDirectoryCapture[]>{
    if(!this.record(sessionId).workingDirectories?.length)return [];
    if(this.store.list<Chat>('chats').some(chat=>chat.sessionId===sessionId&&['running','waiting'].includes(chat.status)))throw new HttpError(409,'Wait for or interrupt the active agent before capturing working folders.');
    const existing=this.directoryCaptures.get(sessionId);if(existing)return existing;
    if(this.record(sessionId).status==='stopped'){
      const roots=this.store.get<{id:string;roots:WorkingDirectoryCapture[]}>('session-working-directory-captures',sessionId)?.roots||[],expected=this.record(sessionId).workingDirectories!;
      if(roots.length!==expected.length||expected.some(root=>!roots.some(capture=>capture.id===root.id&&capture.name===root.name&&capture.baseCommit===root.baseCommit)))throw new HttpError(409,'Not every additional working folder has a confirmed retained snapshot. Inspect the retained environment before accepting this attempt.');
      return roots;
    }
    const operation=(async()=>{
      const engine=this.live.get(sessionId);if(!engine)throw new HttpError(409,'Reconnect the environment before capturing its folders.');
      const snapshots=await this.directoryManager.sourceSnapshots(sessionId),exports:string[]=[];
      await this.docker(['pause',engine.ready.instance]);
      try{for(const root of snapshots){const destination=path.join(this.workspaceDataDir,'working-directory-exports',sessionId,randomUUID());await mkdir(destination,{recursive:true,mode:0o700});await this.docker(['cp',`${engine.ready.instance}:${root.containerPath}/.`,destination]);exports.push(destination);}}
      finally{await this.docker(['unpause',engine.ready.instance]);}
      const worker=this.store.list<{id:string;sessionId?:string;goal?:{id:string};task?:{id:string}}>('factory-workers').find(record=>record.sessionId===sessionId);
      const controller=this.store.list<{id:string;sessionId?:string;goalId?:string}>('factory-controller-runs').find(record=>record.sessionId===sessionId);
      const context=worker?{goalId:worker.goal?.id,taskId:worker.task?.id,attemptId:worker.id}:controller?{goalId:controller.goalId}:{};
      const roots:WorkingDirectoryCapture[]=[];for(let i=0;i<snapshots.length;i++){const capture=await this.directoryManager.captureFromPath(snapshots[i]!,exports[i]!,context);roots.push(capture);for(const manifest of [capture.bundleArtifact,capture.diffArtifact])this.store.set('artifacts',manifest);}
      this.store.set('session-working-directory-captures',{id:sessionId,roots});
      this.patch(sessionId,{workingDirectories:snapshots.map(root=>this.publicRoot(root,'captured',roots.find(item=>item.id===root.id)))});
      // Immutable artifacts and their capture journal now own recovery. Remove
      // only this invocation's staging copies, never prior or uncertain exports.
      for(const destination of exports)await rm(destination,{recursive:true,force:true});
      return roots;
    })().catch(error=>{this.patch(sessionId,{workingDirectories:this.record(sessionId).workingDirectories?.map(root=>({...root,status:'failed',error:error.message}))});throw error;}).finally(()=>this.directoryCaptures.delete(sessionId));
    this.directoryCaptures.set(sessionId,operation);return operation;
  }
  output(sessionId: string): string {return this.store.events<{text:string}>('session-output',sessionId).map(e=>e.value.text).join('\n');}
  close(): void {for(const controller of this.streams.values())controller.abort();}
}
