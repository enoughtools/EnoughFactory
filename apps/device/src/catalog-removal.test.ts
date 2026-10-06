import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Attempt, Chat, FactoryState, Goal, Project, Session } from '@enoughfactory/contracts';
import type { AttemptDetail } from '@enoughfactory/factory';
import { DeviceApp } from './app.ts';
import { exec } from './util.ts';

const at='2026-10-06T00:00:00.000Z';
async function fixture(t:TestContext) {
  const directory=await mkdtemp(path.join(tmpdir(),'enoughfactory-removal-'));
  const previous=process.env.ENOUGHFACTORY_HOME;
  let app:DeviceApp;
  try{process.env.ENOUGHFACTORY_HOME=directory;app=new DeviceApp();}
  finally{if(previous===undefined)delete process.env.ENOUGHFACTORY_HOME;else process.env.ENOUGHFACTORY_HOME=previous;}
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  for(const method of ['ensureReady','status','stop'] as const)t.mock.method(app.runtime,method,async()=>assert.fail('Catalog removal cannot operate the container runtime'));
  for(const method of ['stop','restart','create'] as const)t.mock.method(app.sessions,method,async()=>assert.fail('Catalog removal cannot operate environments'));
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T=unknown>(method:string,route:string,body?:unknown,authenticated=true) {
    const response=await fetch(origin+route,{method,headers:{...(authenticated?{authorization:`Bearer ${app.token}`}:{}) ,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as T};
  }
  const project:Project={id:'project',deviceId:app.device.id,name:'Product',path:path.join(directory,'repository'),createdAt:at,runtime:'codex',approvalMode:'approve-all',rules:[]};
  const session=(id:string,status:Session['status']='stopped',projectId=project.id):Session=>({id,name:id,deviceId:app.device.id,projectId,status,createdAt:at,updatedAt:at,services:[],branch:`envmux/${id}`});
  app.store.set('projects',project);
  const buckets=['projects','sessions','goals','tasks','attempts','factory-attempt-details','factory-workers','chats','approvals','artifacts','session-private','session-launch'];
  const snapshot=()=>buckets.map(bucket=>app.store.list(bucket));
  async function reject(route:string,status=409) {
    const before=snapshot();assert.equal((await request('DELETE',route)).status,status);assert.deepEqual(snapshot(),before,'Rejected removal must preserve catalog, ownership and evidence');
  }
  return {app,directory,request,project,session,reject};
}

test('environment removal rejects uncertain execution and preserves history through idempotent archive/restore',async t=>{
  const {app,directory,request,project,session,reject}=await fixture(t);
  const health=await request<{runtime:{stateDirectory:string;socketPath:string}}>('GET','/api/health');
  assert.equal(health.status,200);assert.equal(health.body.runtime.stateDirectory,app.runtime.dataDirectory);assert.equal(health.body.runtime.socketPath,app.runtime.endpoint.host.slice(7));
  for(const status of ['starting','ready','stopping','unknown'] as const){app.store.set('sessions',session('environment',status));await reject('/api/sessions/environment');}
  app.store.set('sessions',session('environment','failed'));
  app.store.set('session-private',{id:'environment',ready:{dockerHost:app.runtime.endpoint.host},projectPath:project.path});
  await reject('/api/sessions/environment');app.store.delete('session-private','environment');
  app.store.set('sessions',session('environment'));
  assert.equal((await request('DELETE','/api/sessions/environment',undefined,false)).status,401);await reject('/api/sessions/environment/output',404);
  const chat:Chat={id:'chat',sessionId:'environment',deviceId:app.device.id,title:'Retained conversation',runtime:'codex',approvalMode:'approve-all',status:'waiting',createdAt:at,updatedAt:at};
  app.store.set('chats',chat);await reject('/api/sessions/environment');app.store.set('chats',{...chat,status:'idle'});
  const attempt:Attempt={id:'attempt',taskId:'task',deviceId:app.device.id,status:'unknown',generation:1,startedAt:at};
  const detail:AttemptDetail={id:attempt.id,goalId:'goal',goalRevision:1,phase:'executing',cancellation:'none',workspace:{id:'workspace',path:'/private/workspace',baseCommit:'base',provider:'git',sessionId:'environment'}};
  app.store.set('attempts',attempt);app.store.set('factory-attempt-details',detail);await reject('/api/sessions/environment');
  app.store.set('attempts',{...attempt,status:'retired'});app.store.set('factory-attempt-details',{...detail,cancellation:'requested'});await reject('/api/sessions/environment');
  app.store.set('factory-attempt-details',{...detail,cancellation:'acknowledged'});
  const worker={id:'worker',status:'canceled',sessionId:'environment',project,result:{status:'failed',error:'Earlier worker failure'}};
  app.store.set('factory-workers',worker);await reject('/api/sessions/environment');app.store.set('factory-workers',{...worker,cancellationAcknowledged:true});
  const evidence=path.join(directory,'evidence.txt');await writeFile(evidence,'immutable proof');
  app.store.set('artifacts',{id:'evidence',path:evidence,sha256:'unchanged'});app.store.append('chat',chat.id,{text:'Original conversation'});app.store.append('session-output','environment',{text:'Retained output'});
  const receipts=['attempts','factory-attempt-details','factory-workers','chats','artifacts'].map(bucket=>app.store.list(bucket));
  const archived=await request<{session:Session}>('POST','/api/sessions/environment/archive');assert.equal(archived.status,200);assert.ok(archived.body.session.archivedAt);
  assert.equal((await request<{session:Session}>('DELETE','/api/sessions/environment')).body.session.archivedAt,archived.body.session.archivedAt);
  assert.deepEqual((await request<Session[]>('GET','/api/sessions')).body,[]);assert.equal((await request<Session[]>('GET','/api/sessions?archived=1')).body[0]!.id,'environment');
  assert.deepEqual((await request<FactoryState>('GET','/api/state')).body.chats,[]);assert.equal((await request<Session>('GET','/api/sessions/environment')).body.branch,'envmux/environment');
  assert.equal((await request<string>('GET','/api/sessions/environment/output')).body,'Retained output');
  assert.equal((await request('POST','/api/sessions/environment/restart')).status,409);assert.equal((await request('POST','/api/chats',{sessionId:'environment'})).status,409);
  const restored=await request<Session>('POST','/api/sessions/environment/restore');assert.equal(restored.status,200);assert.equal(restored.body.archivedAt,undefined);assert.equal((await request('POST','/api/sessions/environment/restore')).status,200);
  assert.equal((await request<FactoryState>('GET','/api/state')).body.chats[0]!.id,chat.id);assert.deepEqual(['attempts','factory-attempt-details','factory-workers','chats','artifacts'].map(bucket=>app.store.list(bucket)),receipts);
  assert.equal(app.store.events<{text:string}>('chat',chat.id)[0]!.value.text,'Original conversation');assert.equal(await readFile(evidence,'utf8'),'immutable proof');
});

test('project removal protects goals and hidden workers, restores only its own group and reuses the original identity',async t=>{
  const {app,request,project,session,reject}=await fixture(t);
  await mkdir(project.path);await exec('git',['init',project.path]);await writeFile(path.join(project.path,'README.md'),'Retained repository\n');
  const child:Project={...project,id:'child',internal:true,sourceProjectId:project.id,path:path.join(project.path,'internal-workspace')};app.store.set('projects',child);
  app.store.set('sessions',session('user'));app.store.set('sessions',session('factory','unknown',child.id));await reject('/api/projects/project');app.store.set('sessions',session('factory','stopped',child.id));
  const goal:Goal={id:'goal',projectId:project.id,coordinatorId:app.device.id,title:'Retained goal',objective:'Deliver',criteria:['Works'],status:'paused',autonomy:'autonomous',approvalMode:'approve-all',runtime:'codex',concurrency:4,revision:1,createdAt:at,updatedAt:at};
  for(const status of ['draft','running','paused','waiting'] as const){app.store.set('goals',{...goal,status});await reject('/api/projects/project');}app.store.set('goals',{...goal,status:'canceled'});
  app.store.set('factory-workers',{id:'remote-worker',status:'preparing',project:{...child,id:'new-workspace'},goal:{...goal,projectId:project.id}});await reject('/api/projects/project');app.store.delete('factory-workers','remote-worker');
  await reject('/api/projects/project/config',404);
  app.store.set('sessions',session('previously-removed'));assert.equal((await request('DELETE','/api/sessions/previously-removed')).status,200);const priorArchive=app.store.get<Session>('sessions','previously-removed')!.archivedAt;
  assert.equal((await request('POST','/api/projects/project/archive')).status,200);assert.equal((await request('DELETE','/api/projects/project')).status,200);
  assert.deepEqual((await request<Project[]>('GET','/api/projects')).body,[]);assert.deepEqual((await request<Session[]>('GET','/api/sessions')).body,[]);assert.equal((await request<Project[]>('GET','/api/projects?archived=true')).body[0]!.id,project.id);
  assert.equal((await request('POST','/api/sessions/user/restore')).status,409);assert.equal((await request('POST','/api/sessions',{projectId:project.id,name:'new'})).status,409);assert.equal((await request('POST','/api/goals',{projectId:project.id,objective:'New work'})).status,409);
  assert.equal((await request<FactoryState>('GET','/api/state')).body.goals[0]!.id,goal.id,'Goal history remains visible');assert.equal((await request<Project>('GET','/api/projects/project')).body.id,project.id);
  assert.equal((await request<Project>('POST','/api/projects',{path:project.path})).body.id,project.id,'Re-adding the path restores its original identity');assert.equal((await request('POST','/api/projects/project/restore')).status,200);
  assert.deepEqual((await request<Session[]>('GET','/api/sessions')).body.map(item=>item.id),['user','factory']);assert.equal(app.store.get<Project>('projects',child.id)!.archivedAt,undefined);assert.equal(app.store.get<Session>('sessions','previously-removed')!.archivedAt,priorArchive);
  assert.equal(await readFile(path.join(project.path,'README.md'),'utf8'),'Retained repository\n');assert.ok(await exec('git',['-C',project.path,'symbolic-ref','HEAD']));
  const remoteProject:Project={...project,id:'remote-project',deviceId:'remote-device',archivedAt:at};const remoteSession:Session={...session('remote-session'),projectId:remoteProject.id,deviceId:remoteProject.deviceId,archivedAt:at};
  app.catalog=()=>({projects:[project,remoteProject],sessions:[session('user'),remoteSession]});
  assert.equal((await request<Project[]>('GET','/api/projects')).body.some(item=>item.id===remoteProject.id),false);assert.equal((await request<Project[]>('GET','/api/projects?archived=1')).body[0]!.id,remoteProject.id,'Removed lists include paired metadata after aggregation');assert.equal((await request<Session[]>('GET','/api/sessions?archived=1')).body[0]!.id,remoteSession.id);
});
