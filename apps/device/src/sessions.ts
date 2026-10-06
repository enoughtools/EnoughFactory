import { EnvmuxEngine, type EnvmuxSession, type EnvmuxReady, type EnvmuxState } from '@enoughfactory/envmux';
import type { Project, Session, RepositoryChanges, ContainerRuntimeStatus } from '@enoughfactory/contracts';
import type { DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { Store } from './store.ts';
import { HttpError, id, now } from './util.ts';
import path from 'node:path';
import { managedRepositoryReader, readRepositoryChanges } from './repository-changes.ts';

interface WorkspaceBinding { bindSource:string; stateVolume:string; }
interface PrivateSession { id: string; ready: EnvmuxReady; projectPath: string; pid?: number; workspace?:WorkspaceBinding; }
interface LaunchRecord { id:string;projectPath:string;generation:number;dockerHost:string;workspace?:WorkspaceBinding; }
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
  constructor(private store: Store, private deviceId: string, private changed: () => void, private event: (topic: string, data: unknown) => void, private runtime:RuntimeAccess) {
    this.engine = new EnvmuxEngine({binary: process.env.ENOUGHFACTORY_ENVMUX_PATH,dockerRuntime:runtime.endpoint,containerHostAddress:runtime.bridgeHostAddress(),workspaceRoot: process.env.ENOUGHFACTORY_REPO||process.env.ENOUGHFACTORY_RESOURCES||path.resolve(process.cwd(),process.cwd().endsWith('/apps/device')?'../..':'.')});
  }
  setDeviceId(deviceId: string): void {this.deviceId=deviceId;}
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
    const generation=(this.generations.get(saved.id)||this.store.get<LaunchRecord>('session-launch',saved.id)?.generation||0)+1;this.generations.set(saved.id,generation);
    const current=()=>this.generations.get(saved.id)===generation;
    const engine=await this.engine.attach(saved);if(!current())throw new SessionGenerationChangedError();
    this.live.set(saved.id,engine);const state=await engine.state();if(!current()||this.live.get(saved.id)!==engine)throw new SessionGenerationChangedError();
    await this.update(saved.id,state);this.observe(saved.id,engine,generation);return engine;
  }
  async create(project: Project, name: string, options?: {workspace?: {bindSource:string;stateVolume:string}}): Promise<Session> {
    this.assertActiveProject(project);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new HttpError(400,'Use a session name with letters, numbers, dots, underscores or hyphens.');
    if (this.store.list<Session>('sessions').some(s=>s.projectId===project.id && s.name===name && !['stopped','failed'].includes(s.status))) throw new HttpError(409,'This session already exists.');
    const record: Session = {id:id('session'),projectId:project.id,deviceId:this.deviceId,name,status:'starting',phase:'Preparing EnoughFactory runtime',createdAt:now(),updatedAt:now(),services:[]};
    this.store.set('sessions',record); this.changed();
    this.launch(record,project,options);return record;
  }
  private launch(record:Session,project:Project,options?:{workspace?:WorkspaceBinding}):void{
    const generation=(this.generations.get(record.id)||this.store.get<LaunchRecord>('session-launch',record.id)?.generation||0)+1;this.generations.set(record.id,generation);
    this.store.set<LaunchRecord>('session-launch',{id:record.id,projectPath:project.path,generation,dockerHost:this.runtime.endpoint.host,workspace:options?.workspace});
    const current=()=>this.generations.get(record.id)===generation;
    const abort = new AbortController(); this.starts.set(record.id,abort);this.runtimeWaits.add(record.id);
    const job=(async()=>{await this.runtime.ensureReady();this.runtimeWaits.delete(record.id);if(abort.signal.aborted)throw new Error('Environment startup canceled.');
      if(current())this.patch(record.id,{phase:'Preparing environment',error:undefined});
      return this.engine.start({projectPath:project.path,name:record.name,workspace:options?.workspace,signal:abort.signal,onEvent: e=>{
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
      this.patch(record.id,{status:'ready',containerId:engine.ready.instance,enginePid:engine.process?.pid,branch:engine.ready.branch});
      engine.process?.once('exit',code=>{if(!current())return; this.streams.get(record.id)?.abort(); this.streams.delete(record.id); this.live.delete(record.id);const requested=this.stopping.has(record.id);this.stopping.delete(record.id);this.patch(record.id,{status:code!==0?'failed':requested?'stopped':'unknown',phase:code!==0?'Environment stopped with an error':requested?'Work returned to Git':'Engine disconnected',error:code!==0?`Engine exited with ${code}; inspect retained work before retrying.`:undefined}); });
      const state=await engine.state();if(!current()||this.live.get(record.id)!==engine)return;
      await this.update(record.id,state); this.observe(record.id,engine,generation);
    }).catch(error=>{if(!current())return;if(abort.signal.aborted&&this.stopping.has(record.id)){this.stopping.delete(record.id);this.patch(record.id,{status:'stopped',error:undefined,phase:'Startup canceled; retained work is preserved'});}else this.patch(record.id,{status:'failed',error:error.message,phase:'Could not prepare the environment'});}).finally(()=>{this.runtimeWaits.delete(record.id);if(this.starts.get(record.id)===abort)this.starts.delete(record.id);if(this.launchJobs.get(record.id)===job)this.launchJobs.delete(record.id);});
    this.launchJobs.set(record.id,job);
  }
  get(sessionId: string): EnvmuxSession {
    this.assertWorkAvailable(sessionId);
    const session=this.live.get(sessionId); if(!session) throw new HttpError(409,'This environment is not connected.','SESSION_UNAVAILABLE'); return session;
  }
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
    if(this.starts.has(sessionId)){this.starts.get(sessionId)!.abort();await this.launchJobs.get(sessionId);if(this.record(sessionId).status==='failed')throw new Error(this.record(sessionId).error||'Startup has not confirmed termination.');return;}
    try {let engine=this.live.get(sessionId);if(!engine){const saved=this.store.get<PrivateSession>('session-private',sessionId);if(!saved)throw new HttpError(409,'The environment owner has not confirmed its state.');engine=await this.attach(saved);}await engine.stop();}catch(error){this.stopping.delete(sessionId);this.patch(sessionId,{status:'unknown',phase:'Could not confirm work was returned',error:(error as Error).message});throw error;}
    this.stopping.delete(sessionId);this.patch(sessionId,{status:'stopped',phase:'Work returned to Git'});
    this.streams.get(sessionId)?.abort();this.live.delete(sessionId);
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
    this.patch(sessionId,{status:'starting',phase:'Preparing EnoughFactory runtime',error:undefined,services:[]});this.launch(record,project,{workspace:launch?.workspace||saved?.workspace});
  }
  async changes(sessionId: string, selectedPath?: string): Promise<RepositoryChanges> {
    const engine=this.get(sessionId);
    return readRepositoryChanges(managedRepositoryReader(this.runtime.endpoint,engine.ready),selectedPath);
  }
  output(sessionId: string): string {return this.store.events<{text:string}>('session-output',sessionId).map(e=>e.value.text).join('\n');}
  close(): void {for(const controller of this.streams.values())controller.abort();}
}
