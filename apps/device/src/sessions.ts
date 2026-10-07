import { EnvmuxEngine, type EnvmuxSession, type EnvmuxReady, type EnvmuxState } from '@enoughfactory/envmux';
import type { Project, Session, RepositoryChanges, ContainerRuntimeStatus, WorkingDirectoryMount, Chat } from '@enoughfactory/contracts';
import { dockerInvocation, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { ArtifactStore, WorkingDirectoryManager, type WorkingDirectorySource, type WorkingDirectorySnapshot, type WorkingDirectoryCapture } from '@enoughfactory/workspaces';
import { Store } from './store.ts';
import { exec, HttpError, id, now } from './util.ts';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { managedRepositoryReader, readRepositoryChanges } from './repository-changes.ts';
import { prepareDevelopmentToolchain, validateFrozenDevelopmentToolchain, type FrozenDevelopmentToolchain } from './development-toolchain.ts';

interface WorkspaceBinding { bindSource:string; stateVolume:string; }
interface PrivateSession { id: string; ready: EnvmuxReady; projectPath: string; pid?: number; workspace?:WorkspaceBinding; }
interface LaunchRecord { id:string;projectPath:string;generation:number;dockerHost:string;workspace?:WorkspaceBinding; workingDirectorySources?:WorkingDirectorySource[]; referenceContext?:WorkingDirectorySource; developmentToolchain?:FrozenDevelopmentToolchain; }
interface LaunchOptions { workspace?:WorkspaceBinding; workingDirectorySources?:WorkingDirectorySource[]; referenceContext?:WorkingDirectorySource; developmentToolchain?:FrozenDevelopmentToolchain; assertCurrent?:()=>void; }
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
  needsTermination(sessionId:string):boolean {return this.owns(sessionId)&&this.record(sessionId).status!=='stopped'&&(this.live.has(sessionId)||this.starts.has(sessionId)||Boolean(this.store.get<PrivateSession>('session-private',sessionId)));}
  serviceActivity():{starting:number;stopping:number} {return {starting:new Set([...this.starts.keys(),...this.launchJobs.keys()]).size,stopping:new Set([...this.stopping,...this.stopJobs.keys()]).size};}
  assertCanArchive(sessionId:string):void {
    const record=this.record(sessionId);
    if(!['stopped','failed'].includes(record.status)||this.live.has(sessionId)||this.starts.has(sessionId)||this.launchJobs.has(sessionId)||this.stopJobs.has(sessionId)||this.stopping.has(sessionId)||this.needsTermination(sessionId))throw new HttpError(409,'Stop this environment and confirm its work has returned before removing it.','ENVIRONMENT_IN_USE');
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
    const record=this.record(sessionId);if(record.archivedAt)throw new HttpError(409,'Restore this environment before starting work.','ENVIRONMENT_REMOVED');
    const project=this.store.get<Project>('projects',record.projectId);if(project)this.assertActiveProject(project);
    return record;
  }
  runtimeProgress(status:ContainerRuntimeStatus):void {for(const sessionId of this.runtimeWaits)this.patch(sessionId,{phase:status.phase||'Preparing EnoughFactory runtime'});}
  async recover(): Promise<void> {
    for (const saved of this.store.list<PrivateSession>('session-private')) {
      const record = this.store.get<Session>('sessions', saved.id);
      if (!record || record.archivedAt || record.status === 'stopped') continue;
      if(saved.ready.dockerHost!==this.runtime.endpoint.host){this.patch(saved.id,{status:'unknown',phase:'This session belongs to a previous container engine.',error:'EnoughFactory will not attach to your personal Docker. Preserve its work there and start a new EnoughFactory environment.'});continue;}
      try { await this.runtime.ensureReady();await this.attach(saved); }
      catch(error) { if(!(error instanceof SessionGenerationChangedError))this.patch(saved.id, {status:'unknown', phase:'The owned environment is not connected.',error:(error as Error).message}); }
    }
    for (const record of this.store.list<Session>('sessions')) if (!record.archivedAt && record.status === 'starting' && !this.live.has(record.id)) this.patch(record.id,{status:'unknown',phase:'Device service restarted during startup.'});
  }
  private async attach(saved:PrivateSession):Promise<EnvmuxSession>{
    if(saved.ready.dockerHost!==this.runtime.endpoint.host)throw new HttpError(409,'This environment belongs to a previous container engine. Create a new EnoughFactory environment.');
    const toolchain=this.store.get<LaunchRecord>('session-launch',saved.id)?.developmentToolchain;
    if(toolchain&&toolchain!=='default'){
      const frozen=validateFrozenDevelopmentToolchain(toolchain);
      if(frozen!=='default'&&saved.ready.goldenImage!==frozen.image)throw new HttpError(409,'This environment did not confirm its saved development toolchain. Its work is retained; inspect it before starting a replacement.');
    }
    const generation=(this.generations.get(saved.id)||this.store.get<LaunchRecord>('session-launch',saved.id)?.generation||0)+1;this.generations.set(saved.id,generation);
    const current=()=>this.generations.get(saved.id)===generation;
    const engine=await this.engine.attach(saved);if(!current())throw new SessionGenerationChangedError();
    this.live.set(saved.id,engine);
    if(this.record(saved.id).workingDirectories?.length&&!this.store.get<{id:string;complete:boolean}>('session-working-directory-provision',saved.id)?.complete)throw new HttpError(409,'Additional folders were not fully provisioned. The retained container has not been reseeded; inspect its files before restarting.');
    if(this.store.get<LaunchRecord>('session-launch',saved.id)?.referenceContext&&!this.store.get<{id:string;complete:boolean}>('session-reference-context-provision',saved.id)?.complete)throw new HttpError(409,'Retained reference evidence was not fully provisioned. No worker execution can use this environment yet.');
    const state=await engine.state();if(!current()||this.live.get(saved.id)!==engine)throw new SessionGenerationChangedError();
    await this.update(saved.id,state);this.observe(saved.id,engine,generation);return engine;
  }
  async create(project: Project, name: string, options?: LaunchOptions): Promise<Session> {
    this.assertActiveProject(project);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new HttpError(400,'Use a session name with letters, numbers, dots, underscores or hyphens.');
    if (this.store.list<Session>('sessions').some(s=>s.projectId===project.id && s.name===name && !['stopped','failed'].includes(s.status))) throw new HttpError(409,'This session already exists.');
    const record: Session = {id:id('session'),projectId:project.id,deviceId:this.deviceId,name,status:'starting',phase:'Preparing EnoughFactory runtime',createdAt:now(),updatedAt:now(),services:[]};
    this.store.set('sessions',record); this.changed();
    this.launch(record,project,options);return record;
  }
  private launch(record:Session,project:Project,options?:LaunchOptions):void{
    const generation=(this.generations.get(record.id)||this.store.get<LaunchRecord>('session-launch',record.id)?.generation||0)+1;this.generations.set(record.id,generation);
    this.store.set<LaunchRecord>('session-launch',{id:record.id,projectPath:project.path,generation,dockerHost:this.runtime.endpoint.host,workspace:options?.workspace,workingDirectorySources:options?.workingDirectorySources,referenceContext:options?.referenceContext,developmentToolchain:options?.developmentToolchain});
    const current=()=>this.generations.get(record.id)===generation;
    const abort = new AbortController(); this.starts.set(record.id,abort);this.runtimeWaits.add(record.id);
    const job=(async()=>{await this.runtime.ensureReady();this.runtimeWaits.delete(record.id);if(abort.signal.aborted)throw new Error('Environment startup canceled.');
      const developmentToolchain=await prepareDevelopmentToolchain(this.runtime.endpoint,project,{frozen:options?.developmentToolchain,signal:abort.signal,onProgress:phase=>{if(current())this.patch(record.id,{phase});}});
      if(!current()||abort.signal.aborted)throw new Error('Environment startup canceled.');
      this.store.set('session-launch',{...this.store.get<LaunchRecord>('session-launch',record.id)!,developmentToolchain});
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
      return this.engine.start({projectPath:project.path,name:record.name,workspace:options?.workspace,goldenImage:developmentToolchain==='default'?undefined:developmentToolchain.image,signal:abort.signal,onEvent: e=>{
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
      await this.provisionWorkingDirectories(record.id,engine,true);
      const assertCurrent=()=>{if(!current()||this.live.get(record.id)!==engine||abort.signal.aborted)throw new SessionGenerationChangedError();options?.assertCurrent?.();};
      assertCurrent();
      await this.provisionReferenceContext(record.id,engine,assertCurrent);
      assertCurrent();
      this.patch(record.id,{status:'ready',containerId:engine.ready.instance,enginePid:engine.process?.pid,branch:engine.ready.branch});
      engine.process?.once('exit',code=>{if(!current())return; this.streams.get(record.id)?.abort(); this.streams.delete(record.id); this.live.delete(record.id);const requested=this.stopping.has(record.id);this.stopping.delete(record.id);this.patch(record.id,{status:code!==0?'failed':requested?'stopped':'unknown',phase:code!==0?'Environment stopped with an error':requested?'Work returned to Git':'Engine disconnected',error:code!==0?`Engine exited with ${code}; inspect retained work before retrying.`:undefined}); });
      const state=await engine.state();if(!current()||this.live.get(record.id)!==engine)return;
      await this.update(record.id,state); this.observe(record.id,engine,generation);
    }).catch(error=>{if(!current())return;if(abort.signal.aborted&&this.stopping.has(record.id)&&!this.live.has(record.id)){this.stopping.delete(record.id);this.patch(record.id,{status:'stopped',error:undefined,phase:'Startup canceled; retained work is preserved'});}else this.patch(record.id,{status:this.live.has(record.id)?'unknown':'failed',error:error.message,phase:this.live.has(record.id)?'Environment retained; additional setup was not confirmed':'Could not prepare the environment'});}).finally(()=>{this.runtimeWaits.delete(record.id);if(this.starts.get(record.id)===abort)this.starts.delete(record.id);if(this.launchJobs.get(record.id)===job)this.launchJobs.delete(record.id);});
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
    this.store.set('sessions',{...current,...values,updatedAt:now()}); this.changed();
  }
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
    const operation=this.stopSession(sessionId).finally(()=>this.stopJobs.delete(sessionId));this.stopJobs.set(sessionId,operation);return operation;
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
    this.assertWorkAvailable(sessionId);
    if(this.stopJobs.has(sessionId)||this.stopping.has(sessionId))throw new HttpError(409,'Wait for this environment to finish returning its work before restarting.');
    const record=this.record(sessionId),connected=this.live.get(sessionId);
    if(connected){await connected.restart();await this.update(sessionId,await connected.state());return;}
    const saved=this.store.get<PrivateSession>('session-private',sessionId),launch=this.store.get<LaunchRecord>('session-launch',sessionId);
    if(record.status!=='stopped'){if(!saved)throw new HttpError(409,'Reconnect or inspect the environment before restarting uncertain work.');await this.runtime.ensureReady();const engine=await this.attach(saved);await engine.restart();await this.update(sessionId,await engine.state());return;}
    if((launch?.dockerHost||saved?.ready.dockerHost)!==this.runtime.endpoint.host)throw new HttpError(409,'This session used a previous container engine. Create a new EnoughFactory environment from its returned Git branch.');
    const project=this.store.get<Project>('projects',record.projectId);if(!project)throw new HttpError(404,'The source project is no longer available.');
    this.patch(sessionId,{status:'starting',phase:'Preparing EnoughFactory runtime',error:undefined,services:[]});this.launch(record,project,{workspace:launch?.workspace||saved?.workspace,workingDirectorySources:launch?.workingDirectorySources,referenceContext:launch?.referenceContext,developmentToolchain:launch?.developmentToolchain||record.developmentToolchain});
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
