import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnvmuxSession, type EnvmuxReady, type EnvmuxState } from '@enoughfactory/envmux';
import type { Project } from '@enoughfactory/contracts';
import { Store } from './store.ts';
import { SessionController } from './sessions.ts';

test('extra snapshots become ready before use, failed export retains the environment, and restart restores retained edits', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'enough-device-working-roots-')),owned=path.join(root,'owned'),container=path.join(root,'fake-container'),source=path.join(root,'source');
  await mkdir(source);await writeFile(path.join(source,'input.txt'),'original input\n');
  const store=new Store(path.join(root,'store'));
  const endpoint={host:'unix:///tmp/enough-working-root-test.sock',cliPath:'/tmp/unused-owned-docker',configDirectory:path.join(root,'config')};
  let controller=new SessionController(store,'fixture',()=>{},()=>{},{endpoint,ensureReady:async()=>endpoint,bridgeHostAddress:()=>undefined},owned);
  t.after(async()=>{controller.close();store.close();await rm(root,{recursive:true,force:true});});
  const ready:EnvmuxReady={type:'ready',version:1,endpoint:'http://127.0.0.1:1',token:'fixture',project:'Fixture',session:'roots',instance:'fixture-container',workdir:'/work',user:'root',branch:'envmux/roots',dockerHost:endpoint.host};
  const state={project:ready.project,session:ready.session,branch:ready.branch,base:'HEAD',image:'fixture',address:'127.0.0.1',instanceName:ready.instance,workdir:ready.workdir,shell:'/bin/sh',domain:'fixture',port:1,phase:'Ready',ready:true,startedAt:new Date().toISOString(),editorAttach:'',browserPort:0,routes:[],tasks:[],services:[],tools:[],log:[]} satisfies EnvmuxState;
  let stopped=0,failExport=false,paused=false,aborted=false,holdCopy=true;
  let releaseCopy!:()=>void,enteredCopy!:()=>void;const entered=new Promise<void>(resolve=>{enteredCopy=resolve;}),release=new Promise<void>(resolve=>{releaseCopy=resolve;});
  const engine=new EnvmuxSession({ready,projectPath:root});engine.state=async()=>state;engine.events=async function*(){};engine.stop=async()=>{stopped++;};
  const start=async(options:{signal?:AbortSignal})=>{options.signal?.addEventListener('abort',()=>{aborted=true;});await rm(container,{recursive:true,force:true});await mkdir(container);return engine;};controller.engine.start=start;
  const guest=(value:string)=>{assert.match(value,/^\/workspaces\/[a-zA-Z0-9._-]+(?:\/\.)?$/);return path.join(container,value.slice('/workspaces/'.length).replace(/\/\.$/,''));};
  const docker=async(args:string[])=>{
    if(args[0]==='pause'){paused=true;return '';}
    if(args[0]==='unpause'){paused=false;return '';}
    if(args[0]==='exec'){await mkdir(guest(args.at(-1)!),{recursive:true});return '';}
    assert.equal(args[0],'cp');const from=args[1]!,to=args[2]!;
    if(from.startsWith(`${ready.instance}:`)){assert.equal(paused,true);if(failExport)throw new Error('Export unavailable');await cp(guest(from.slice(ready.instance.length+1)),to,{recursive:true,dereference:false});}
    else {if(holdCopy){enteredCopy();await release;holdCopy=false;}await cp(from.replace(/\/\.$/,''),guest(to.slice(ready.instance.length+1)),{recursive:true,dereference:false});}
    return '';
  };
  (controller as unknown as {docker(args:string[]):Promise<string>}).docker=docker;
  const project:Project={id:'project',name:'Fixture',path:root,deviceId:'fixture',createdAt:new Date().toISOString(),runtime:'codex',approvalMode:'approve-all',rules:[],workingDirectories:[{id:'support',name:'support',path:source}]};
  store.set('projects',project);const session=await controller.create(project,'roots');await entered;
  const stopDuringCopy=controller.stop(session.id);await Promise.resolve();assert.equal(aborted,false,'Stop after engine readiness must preserve roots before signalling envmux');assert.equal(stopped,0);
  assert.throws(()=>controller.assertCanStartWork(session.id),/environment is ready/);
  releaseCopy();await stopDuringCopy;assert.equal(stopped,1);assert.equal((await controller.captureWorkingDirectories(session.id)).length,1);
  await controller.restart(session.id);await controller.waitReady(session.id,5000);
  assert.doesNotThrow(()=>controller.assertCanStartWork(session.id));
  assert.equal(controller.record(session.id).workingDirectories?.[0]?.status,'ready');
  assert.equal(await readFile(path.join(container,'support','input.txt'),'utf8'),'original input\n');
  await writeFile(path.join(container,'support','output.txt'),'retained output\n');
  failExport=true;await assert.rejects(controller.stop(session.id),/Export unavailable/);
  assert.equal(stopped,1,'a failed export must prevent envmux deletion');assert.equal(paused,false,'export failure must unpause retained work');assert.equal(controller.record(session.id).status,'unknown');
  controller.close();controller=new SessionController(store,'fixture',()=>{},()=>{},{endpoint,ensureReady:async()=>endpoint,bridgeHostAddress:()=>undefined},owned);controller.engine.attach=async()=>engine;controller.engine.start=start;
  (controller as unknown as {docker(args:string[]):Promise<string>}).docker=docker;await controller.recover();
  assert.equal(await readFile(path.join(container,'support','output.txt'),'utf8'),'retained output\n','reattaching after failed export must never reseed the retained container');
  failExport=false;await controller.stop(session.id);assert.equal(stopped,2);assert.equal(controller.record(session.id).workingDirectories?.[0]?.status,'captured');
  const captures=await controller.captureWorkingDirectories(session.id);assert.equal(captures.length,1);assert.ok(captures[0]?.bundleArtifact.sha256);
  await controller.restart(session.id);await controller.waitReady(session.id,5000);
  assert.equal(await readFile(path.join(container,'support','output.txt'),'utf8'),'retained output\n');
  assert.equal(await readFile(path.join(source,'input.txt'),'utf8'),'original input\n');await assert.rejects(readFile(path.join(source,'output.txt')),/ENOENT/);
  await controller.stop(session.id);store.delete('session-working-directory-captures',session.id);
  await assert.rejects(controller.captureWorkingDirectories(session.id),/Not every additional working folder/);
});
