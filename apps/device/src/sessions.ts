import { EnvmuxEngine, type EnvmuxSession, type EnvmuxReady, type EnvmuxState } from '@enoughfactory/envmux';
import type { Project, Session, RepositoryChanges } from '@enoughfactory/contracts';
import { Store } from './store.ts';
import { HttpError, id, now } from './util.ts';
import path from 'node:path';

interface PrivateSession { id: string; ready: EnvmuxReady; projectPath: string; pid?: number; }
export class SessionController {
  readonly engine: EnvmuxEngine;
  private live = new Map<string, EnvmuxSession>();
  private streams = new Map<string, AbortController>();
  private starts = new Map<string, AbortController>();
  private stopping = new Set<string>();
  constructor(private store: Store, private deviceId: string, private changed: () => void, private event: (topic: string, data: unknown) => void) {
    this.engine = new EnvmuxEngine({binary: process.env.ENOUGHFACTORY_ENVMUX_PATH, workspaceRoot: process.env.ENOUGHFACTORY_REPO||process.env.ENOUGHFACTORY_RESOURCES||path.resolve(process.cwd(),process.cwd().endsWith('/apps/device')?'../..':'.')});
  }
  setDeviceId(deviceId: string): void {this.deviceId=deviceId;}
  async recover(): Promise<void> {
    for (const saved of this.store.list<PrivateSession>('session-private')) {
      const record = this.store.get<Session>('sessions', saved.id);
      if (!record || record.status === 'stopped') continue;
      try { const engine = await this.engine.attach(saved); this.live.set(saved.id, engine); await this.update(saved.id, await engine.state()); this.observe(saved.id, engine); }
      catch { this.patch(saved.id, {status:'unknown', phase:'Connection lost. Reconnect or inspect the environment before restarting.'}); }
    }
    for (const record of this.store.list<Session>('sessions')) if (record.status === 'starting' && !this.live.has(record.id)) this.patch(record.id,{status:'unknown',phase:'Device service restarted during startup.'});
  }
  async create(project: Project, name: string, options?: {workspace?: {bindSource:string;stateVolume:string}}): Promise<Session> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new HttpError(400,'Use a session name with letters, numbers, dots, underscores or hyphens.');
    if (this.store.list<Session>('sessions').some(s=>s.projectId===project.id && s.name===name && !['stopped','failed'].includes(s.status))) throw new HttpError(409,'This session already exists.');
    const record: Session = {id:id('session'),projectId:project.id,deviceId:this.deviceId,name,status:'starting',phase:'Preparing environment',createdAt:now(),updatedAt:now(),services:[]};
    this.store.set('sessions',record); this.changed();
    const abort = new AbortController(); this.starts.set(record.id,abort);
    void this.engine.start({projectPath:project.path,name,workspace:options?.workspace,signal:abort.signal,onEvent: e=>{
      if(e.type==='phase') this.patch(record.id,{phase:e.phase});
      if(e.type==='error') this.patch(record.id,{error:e.error});
      this.event('session',{sessionId:record.id,...e});
    },onLog: line=>{
      // Bootstrap stdout may contain private vendor URLs. Store startup output only
      // after removing credential-bearing query strings and proxy authority.
      const text=line.replace(/([?&](?:token|auth|password)=)[^&\s]+/gi,'$1[private]').replace(/(socks5?:\/\/)[^@\s]+@/gi,'$1[private]@');
      this.store.append('session-output',record.id,{at:now(),text}); this.event('output',{sessionId:record.id,text});
    }}).then(async engine=>{
      this.live.set(record.id,engine);
      this.store.set('session-private',{id:record.id,ready:engine.ready,projectPath:project.path,pid:engine.process?.pid});
      this.patch(record.id,{status:'ready',containerId:engine.ready.instance,enginePid:engine.process?.pid,branch:engine.ready.branch});
      await this.update(record.id,await engine.state()); this.observe(record.id,engine);
      engine.process?.once('exit',code=>{ this.streams.get(record.id)?.abort(); this.streams.delete(record.id); this.live.delete(record.id);const requested=this.stopping.has(record.id);this.stopping.delete(record.id);this.patch(record.id,{status:code!==0?'failed':requested?'stopped':'unknown',phase:code!==0?'Environment stopped with an error':requested?'Work returned to Git':'Engine disconnected',error:code!==0?`Engine exited with ${code}; inspect retained work before retrying.`:undefined}); });
    }).catch(error=>this.patch(record.id,{status:'failed',error:error.message,phase:'Startup failed'})).finally(()=>this.starts.delete(record.id));
    return record;
  }
  get(sessionId: string): EnvmuxSession {
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
  private observe(sessionId: string,engine: EnvmuxSession): void {
    this.streams.get(sessionId)?.abort(); const abort=new AbortController(); this.streams.set(sessionId,abort);
    void(async()=>{try { for await(const state of engine.events(abort.signal)) {await this.update(sessionId,state);this.event('session-state',{sessionId,state});} }
      catch(error){if(!abort.signal.aborted)this.patch(sessionId,{status:'unknown',phase:'Environment connection lost'});}})();
  }
  async stop(sessionId: string): Promise<void> {
    this.stopping.add(sessionId);
    this.patch(sessionId,{status:'stopping',phase:'Returning work to Git'});
    if(this.starts.has(sessionId)){this.starts.get(sessionId)!.abort();return;}
    try {await this.get(sessionId).stop();}catch(error){this.stopping.delete(sessionId);this.patch(sessionId,{status:'failed',phase:'Could not confirm work was returned',error:(error as Error).message});throw error;}
    this.stopping.delete(sessionId);this.patch(sessionId,{status:'stopped',phase:'Work returned to Git'});
    this.streams.get(sessionId)?.abort();this.live.delete(sessionId);
  }
  async restart(sessionId: string): Promise<void> {await this.get(sessionId).restart();await this.update(sessionId,await this.get(sessionId).state());}
  async changes(sessionId: string): Promise<RepositoryChanges> {
    const engine=this.get(sessionId); const [status,diff]=await Promise.all([engine.repositoryStatus(),engine.repositoryDiff()]);
    return {branch:status.branch,head:status.head,status:status.entries.map(e=>`${e.indexStatus}${e.workingTreeStatus} ${e.path}`).join('\n'),diff:diff.diff};
  }
  output(sessionId: string): string {return this.store.events<{text:string}>('session-output',sessionId).map(e=>e.value.text).join('\n');}
  close(): void {for(const controller of this.streams.values())controller.abort();}
}
