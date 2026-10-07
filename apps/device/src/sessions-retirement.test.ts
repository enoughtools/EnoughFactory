import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import type { Session } from '@enoughfactory/contracts';
import type { EnvmuxReady } from '@enoughfactory/envmux';
import { SessionController } from './sessions.ts';
import { Store } from './store.ts';

async function fixture(t:TestContext){
  const directory=await mkdtemp(path.join(tmpdir(),'enough-retirement-lease-')),store=new Store(directory);
  const endpoint={host:'unix:///tmp/owned-enough-retirement-fixture.sock',configDirectory:path.join(directory,'docker'),cliPath:'/unused-owned-docker'};
  const sessions=new SessionController(store,'fixture',()=>{},()=>{},{endpoint,ensureReady:async()=>endpoint,bridgeHostAddress:()=>undefined},path.join(directory,'workspace-data'));
  const ready:EnvmuxReady={type:'ready',version:1,endpoint:'http://127.0.0.1:1',token:'fixture',project:'repository',session:'work',instance:'repository-work',workdir:'/work',user:'root',branch:'envmux/work',dockerHost:endpoint.host};
  const session:Session={id:'session_fixture',projectId:'project',deviceId:'fixture',name:'work',status:'unknown',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),services:[],containerId:ready.instance};
  store.set('sessions',session);store.set('session-private',{id:session.id,ready,projectPath:directory,pid:99999999});store.set('session-launch',{id:session.id,projectPath:directory,generation:1,dockerHost:endpoint.host});
  t.after(async()=>{sessions.close();store.close();await rm(directory,{recursive:true,force:true});});
  return {sessions,store,session,ready,directory};
}

test('retirement fences restart and recovery without rewriting an uncertain provider outcome',async t=>{
  const f=await fixture(t);let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  let attached=0;f.sessions.engine.attach=async()=>{attached++;throw new Error('Must not attach during retirement');};
  assert.equal(f.sessions.canRetireEnvironment(f.session.id),true);
  const retirement=f.sessions.withRetirementLease(f.session.id,async()=>{entered();await held;});await started;
  await assert.rejects(f.sessions.restart(f.session.id),/releasing/);
  await assert.rejects(f.sessions.create({id:'project-alias',name:'Fixture',path:f.directory,deviceId:'fixture',createdAt:new Date().toISOString(),runtime:'codex',approvalMode:'approve-all',rules:[]},'work'),/name is preserving/);
  await f.sessions.recover();assert.equal(attached,0);
  await assert.rejects(f.sessions.withRetirementLease(f.session.id,async()=>{}),/active owner or operation/);
  assert.equal(f.sessions.serviceActivity().stopping,1);
  assert.equal(f.sessions.record(f.session.id).status,'unknown');
  release();await retirement;
  assert.equal(f.sessions.serviceActivity().stopping,0);
  assert.equal(f.sessions.record(f.session.id).status,'unknown','Container cleanup never claims whether an uncertain turn succeeded or failed');
});

test('an active native owner and starting or stopping lifecycle cannot be retired',async t=>{
  const f=await fixture(t);
  f.store.set('session-private',{id:f.session.id,ready:f.ready,projectPath:f.directory,pid:process.pid});
  assert.equal(f.sessions.canRetireEnvironment(f.session.id),false);
  await assert.rejects(f.sessions.withRetirementLease(f.session.id,async()=>assert.fail('Must retain active native owner')),/active owner/);
  f.store.set('session-private',{id:f.session.id,ready:f.ready,projectPath:f.directory,pid:99999999});
  for(const status of ['starting','stopping','ready'] as const){f.store.set('sessions',{...f.session,status});assert.equal(f.sessions.canRetireEnvironment(f.session.id),false);}
});

test('a later session with the same envmux name fences cleanup of the older name-only record',async t=>{
  const f=await fixture(t),later={...f.session,id:'session_later'};
  f.store.set('sessions',later);f.store.set('session-launch',{id:later.id,projectPath:f.directory,generation:1,dockerHost:f.ready.dockerHost});f.store.set('session-private',{id:later.id,ready:f.ready,projectPath:f.directory,pid:99999999});
  assert.equal(f.sessions.canRetireEnvironment(f.session.id),false,'Ambiguous legacy metadata is preserved');
  const ownerId=createHash('sha256').update(JSON.stringify([f.ready.dockerHost,f.directory,f.session.name])).digest('hex');
  f.store.set('session-container-owner',{id:ownerId,sessionId:later.id,generation:1});
  assert.equal(f.sessions.canRetireEnvironment(f.session.id),false);
  assert.equal(f.sessions.canRetireEnvironment(later.id),true);
  await assert.rejects(f.sessions.restart(f.session.id),(error:unknown)=>{assert.equal((error as {code:string}).code,'ENVIRONMENT_NAME_REUSED');return true;});
});

test('retired history is accessible and legacy archives give a concrete fresh-environment action',async t=>{
  const f=await fixture(t);
  f.store.set('projects',{id:'project',name:'Fixture',path:f.directory,deviceId:'fixture',createdAt:new Date().toISOString(),runtime:'codex',approvalMode:'approve-all',rules:[]});
  f.store.set('session-container-retirement',{id:f.session.id,name:f.ready.instance,containerId:'a'.repeat(64),status:'removed',archive:path.join(f.directory,'provider-history','codex.tar.gz'),updatedAt:new Date().toISOString()});
  assert.equal(f.sessions.needsTermination(f.session.id),false);
  assert.throws(()=>f.sessions.get(f.session.id),(error:unknown)=>{assert.equal((error as {code:string}).code,'ENVIRONMENT_ARCHIVED');assert.match((error as Error).message,/preserved files/);return true;});
  await assert.rejects(f.sessions.restart(f.session.id),(error:unknown)=>{assert.equal((error as {code:string}).code,'ENVIRONMENT_ARCHIVED');assert.match((error as Error).message,/fresh environment from its retained candidate/);return true;});
  assert.equal(f.sessions.archivedEnvironment(f.session.id)?.status,'removed');
  assert.equal(f.sessions.record(f.session.id).status,'unknown');
});
