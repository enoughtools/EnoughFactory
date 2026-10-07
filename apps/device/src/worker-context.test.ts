import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Attempt, Chat, FactoryTask, Goal, Project } from '@enoughfactory/contracts';
import type { AttemptDetail, PlanRecord, TaskDetail } from '@enoughfactory/factory';
import { EnvmuxSession, type EnvmuxReady, type EnvmuxState } from '@enoughfactory/envmux';
import type { TurnInput } from '@enoughfactory/agents';
import { DeviceApp } from './app.ts';
import type { ChatController } from './chats.ts';
import { initializeFactory } from './factory.ts';
import { assertCurrentWorkerAssignment, prepareWorkerContext, workerCandidates, type WorkerEvidenceContext } from './worker-context.ts';
import { exec } from './util.ts';

const git = async (directory: string, ...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args])).stdout.trim();
async function fixture(t: TestContext) {
  const root=await mkdtemp(path.join(tmpdir(),'enough-worker-evidence-')),primary=path.join(root,'primary'),container=path.join(root,'container');
  await mkdir(primary);await mkdir(container);
  await git(primary,'init','--quiet');await git(primary,'config','user.name','Fixture');await git(primary,'config','user.email','fixture@example.invalid');
  await writeFile(path.join(primary,'README.md'),'Accepted source remains authoritative\n');await git(primary,'add','.');await git(primary,'commit','-qm','Accepted primary');
  const previousHome=process.env.ENOUGHFACTORY_HOME;
  let app:DeviceApp;
  try{process.env.ENOUGHFACTORY_HOME=path.join(root,'owned');app=new DeviceApp();}
  finally{if(previousHome===undefined)delete process.env.ENOUGHFACTORY_HOME;else process.env.ENOUGHFACTORY_HOME=previousHome;}
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  t.mock.method(app,'ensureRuntimeReady',async()=>app.runtime.endpoint);
  t.mock.method(app.runtime,'ensureReady',async()=>assert.fail('Tests cannot start the private VM or engine'));
  const at='2026-10-07T00:00:00Z';
  const project:Project={id:'project',name:'Fixture',path:primary,deviceId:app.device.id,runtime:'codex',approvalMode:'approve-all',rules:[],developmentToolchain:'default',createdAt:at};
  const goal:Goal={id:'goal',projectId:project.id,coordinatorId:app.device.id,title:'Deliver reading',objective:'Deliver the reading experience using retained integration contracts',criteria:['Reading works'],status:'running',autonomy:'autonomous',approvalMode:'approve-all',runtime:'codex',concurrency:2,revision:2,createdAt:at,updatedAt:at};
  const task:FactoryTask={id:'new-reading',goalId:goal.id,title:'Repair reading against the retained integration manifest',description:'Seed the exact manifest-retained integration candidate in a fresh checkout and restore the missing ClientIntegration files needed for reading. Preserve the accepted tree and implement only reading-owned changes.',acceptanceCriteria:['Required contracts restored'],expectedOutputs:['ClientIntegration/ReadingBridge.swift'],writePaths:['ClientIntegration/ReadingBridge.swift'],dependsOn:['accepted-provider','accepted-reading'],status:'running',currentAttemptId:'new-attempt',createdAt:at,updatedAt:at};
  const attempt:Attempt={id:'new-attempt',taskId:task.id,generation:1,deviceId:app.device.id,status:'created',startedAt:at};
  const detail:AttemptDetail={id:attempt.id,goalId:goal.id,goalRevision:goal.revision,assignmentGoalRevision:goal.revision,phase:'preparing',cancellation:'none',contract:{title:task.title,description:task.description,acceptanceCriteria:task.acceptanceCriteria,expectedOutputs:task.expectedOutputs,writePaths:task.writePaths,dependsOn:task.dependsOn,checks:[],planRevision:goal.revision}};
  let created=0,invoked=0,stopped=0;
  let run:(chatId:string,prompt:string,options:Partial<TurnInput>)=>Promise<{text:string;threadId:string}>=async()=>assert.fail('No provider turn expected');
  const chats={
    create:(input:{sessionId:string;runtime:Chat['runtime'];approvalMode:Chat['approvalMode'];title:string;attemptId?:string})=>{created++;const chat:Chat={...input,id:`chat-${created}`,deviceId:app.device.id,status:'idle',createdAt:at,updatedAt:at};app.store.set('chats',chat);return chat;},
    get:(id:string)=>app.store.get<Chat>('chats',id)!,isRunning:()=>false,interrupt:async()=>{},waitForIdle:async()=>{},
    run:async(chatId:string,prompt:string,options:Partial<TurnInput>)=>{invoked++;return run(chatId,prompt,options);},
  } as unknown as ChatController;
  const factory=await initializeFactory(app,chats);await factory.coordinator.stop();
  const oldWorkspace=await factory.workspaces.create({projectPath:primary,goalId:goal.id,taskId:'old-integration',attemptId:'old-attempt'});
  await mkdir(path.join(oldWorkspace.path,'ClientIntegration'));
  await writeFile(path.join(oldWorkspace.path,'ClientIntegration','ReadingBridge.swift'),'public struct ReadingBridge { public let restored = true }\n');
  await writeFile(path.join(oldWorkspace.path,'UnrelatedIntegration.swift'),'This sibling file is not owned by reading\n');
  await git(oldWorkspace.path,'add','.');await git(oldWorkspace.path,'commit','-qm','Retained integration candidate');
  const candidate=await factory.workspaces.capture({workspaceId:oldWorkspace.id});
  app.store.set('projects',project);app.store.set('goals',goal);app.store.set('tasks',task);app.store.set('attempts',attempt);app.store.set('factory-attempt-details',detail);
  const oldTask:FactoryTask={...task,id:'old-integration',title:'Integration repair',description:'Retained shared package',dependsOn:[],status:'failed',currentAttemptId:'old-attempt',writePaths:['ClientIntegration/Other.swift']};
  app.store.set('tasks',oldTask);app.store.set('attempts',{...attempt,id:'old-attempt',taskId:oldTask.id,status:'failed'});
  app.store.set('factory-attempt-details',{...detail,id:'old-attempt',candidate,phase:'done'});
  app.store.set<TaskDetail>('factory-task-details',{id:oldTask.id,key:'integration',checks:[],planRevision:1,selected:false,failureSignatures:[],lastCandidate:{...candidate}});
  for(const id of task.dependsOn)app.store.set('tasks',{...oldTask,id,currentAttemptId:undefined,status:'completed',title:id});
  app.store.set<PlanRecord>('factory-plans',{id:goal.id,goalId:goal.id,revision:goal.revision,summary:`Restore exact retained integration candidate ${candidate.id} commit ${candidate.commit}; it is reference material, not accepted source.`,checks:[],taskKeys:{reading:task.id},createdAt:at});
  let beforeReferenceCopy:()=>Promise<void>=async()=>{};
  const engine=()=>{
    const ready:EnvmuxReady={type:'ready',version:1,endpoint:'http://127.0.0.1:1',token:'fixture',project:'Fixture',session:'reading',instance:'fixture-only',workdir:'/work',user:'root',branch:'envmux/reading',dockerHost:app.runtime.endpoint.host};
    const state:EnvmuxState={project:ready.project,session:ready.session,branch:ready.branch,base:'HEAD',image:'fixture',address:'127.0.0.1',instanceName:ready.instance,workdir:ready.workdir,shell:'/bin/sh',domain:'fixture',port:1,phase:'Ready',ready:true,startedAt:at,editorAttach:'',browserPort:0,routes:[],tasks:[],services:[],tools:[],log:[]};
    const value=new EnvmuxSession({ready,projectPath:primary});value.state=async()=>state;value.events=async function*(){};value.stop=async()=>{stopped++;};return value;
  };
  t.mock.method(app.sessions.engine,'start',async(input:Parameters<typeof app.sessions.engine.start>[0])=>{await cp(input.projectPath,path.join(container,'work'),{recursive:true});return engine();});
  const guest=(destination:string)=>{assert.match(destination,/^\/workspaces\/[a-zA-Z0-9._-]+(?:\/\.)?$/);return path.join(container,destination.replace(/^\//,'').replace(/\/\.$/,''));};
  (app.sessions as unknown as {docker(args:string[]):Promise<string>}).docker=async args=>{
    if(args[0]==='exec'){
      if(args.includes('mkdir'))await mkdir(guest(args.at(-1)!),{recursive:true});
      else assert.ok(args.includes('chmod')&&args.includes('a-w'),'Only reference permission provisioning is permitted');
      return '';
    }
    assert.equal(args[0],'cp');assert.ok(!args[1]!.startsWith('fixture-only:'),'No authored extra roots should be exported');
    await beforeReferenceCopy();await cp(args[1]!.replace(/\/\.$/,''),guest(args[2]!.slice('fixture-only:'.length)),{recursive:true,dereference:false});return '';
  };
  return {root,primary,container,app,factory,project,goal,task,attempt,detail,candidate,oldTask,
    setRun(value:typeof run){run=value;},setReferenceCopy(value:typeof beforeReferenceCopy){beforeReferenceCopy=value;},counts:()=>({created,invoked,stopped})};
}

test('new repair task receives exact cross-task retained bundles without seeding or capturing the whole candidate',async t=>{
  const f=await fixture(t),acceptedHead=await git(f.primary,'rev-parse','HEAD');
  assert.ok(!f.task.description.includes(f.candidate.id)&&!f.task.description.includes(f.candidate.commit),'Reproduce current task prose without direct candidate tokens');
  assert.ok(!f.task.dependsOn.includes(f.oldTask.id),'Depending on unfinished integration would create a cycle');
  // An unrelated branch repair advances coordinator authority while this preparing
  // assignment remains valid at its original dispatch revision.
  const currentGoal={...f.goal,revision:3};f.app.store.set('goals',currentGoal);f.app.store.set('factory-attempt-details',{...f.detail,goalRevision:3});
  assert.doesNotThrow(()=>assertCurrentWorkerAssignment(f.app.store,{goal:f.goal,task:f.task,attempt:f.attempt}));
  const selected=workerCandidates(f.app.store,f.goal,f.task,f.attempt);
  assert.equal(selected.selected[0]!.candidate.id,f.candidate.id,'Unfinished same-goal fallback covers the prose-only repair even after the old plan revision');
  const workspace=await f.factory.workspacePort.prepare({goal:currentGoal,task:f.task,attempt:f.attempt,project:f.project});
  const worker=f.app.store.get<{referenceContext:WorkerEvidenceContext;sessionId:string}>('factory-workers',f.attempt.id)!;
  assert.equal(worker.referenceContext.assignment.goalRevision,2);
  const contextPath=path.join(f.container,worker.referenceContext.source.containerPath.slice(1)),manifest=JSON.parse(await readFile(path.join(contextPath,'manifest.json'),'utf8'));
  const retained=manifest.candidates.find((entry:{id:string})=>entry.id===f.candidate.id);
  assert.equal(manifest.role,'worker');assert.equal(manifest.assignment.attemptId,f.attempt.id);
  assert.equal(retained.commit,f.candidate.commit);assert.equal(retained.bundleSha256,f.candidate.bundleArtifact.sha256);assert.equal(retained.repository,undefined,'Workers inspect exact bundles without host reconstruction');
  const bundle=path.join(contextPath,'candidates',f.candidate.id,'source.bundle');
  assert.deepEqual(await readFile(bundle),await readFile(await f.factory.workspaces.artifacts.path(f.candidate.bundleArtifact)));
  await assert.rejects(readFile(path.join(workspace.path,'ClientIntegration','ReadingBridge.swift')),/ENOENT/);
  assert.equal(await git(workspace.path,'rev-parse','HEAD'),acceptedHead);
  assert.equal(f.app.sessions.record(worker.sessionId).workingDirectories,undefined,'Reference evidence is not an authored extra root');
  assert.deepEqual(await f.app.sessions.captureWorkingDirectories(worker.sessionId),[]);
  f.setRun(async(_chat,prompt,options)=>{
    assert.match(prompt,/Retained reference evidence is available/);assert.ok(options.systemInstructions?.includes(worker.referenceContext.source.containerPath));
    assert.match(prompt,/Do not cherry-pick or replace the whole candidate implicitly/);
    const inspect=path.join(f.root,'inspect-exact');await mkdir(inspect);await git(inspect,'init','-q');await git(inspect,'fetch','--no-tags',bundle,retained.bundleRef);
    const restored=await git(inspect,'show',`${retained.commit}:ClientIntegration/ReadingBridge.swift`);
    await mkdir(path.join(workspace.path,'ClientIntegration'));await writeFile(path.join(workspace.path,'ClientIntegration','ReadingBridge.swift'),`${restored}\n`);
    await git(workspace.path,'add','.');await git(workspace.path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Restore only assigned reading file');
    return {text:'Restored the exact required retained contract',threadId:'fixture-thread'};
  });
  const result=await f.factory.runtime.execute({goal:currentGoal,task:f.task,attempt:f.attempt,workspace,project:f.project,prompt:f.task.description,assignmentGoalRevision:2});
  assert.equal(result.status,'succeeded');assert.equal(f.counts().invoked,1);
  const authored=await f.factory.workspaces.capture({workspaceId:workspace.id});
  assert.equal(await git(workspace.path,'ls-tree','--name-only',authored.commit),'ClientIntegration\nREADME.md');
  assert.equal(await git(f.primary,'rev-parse','HEAD'),acceptedHead);assert.equal(await git(f.primary,'status','--porcelain'),'');
  await assert.rejects(readFile(path.join(f.primary,'ClientIntegration','ReadingBridge.swift')),/ENOENT/);
  await f.app.sessions.stop(worker.sessionId);
  await assert.rejects(readFile(path.join(f.app.dataDir,'workspace-data','working-directories',`${worker.sessionId}-reference-context`,'snapshots.json')),/ENOENT/);
  assert.deepEqual(await readdir(path.join(f.app.dataDir,'workspace-data','controller-context')),[],'Disposable reconstruction staging is removed');
  const frozen=await prepareWorkerContext({goal:f.goal,task:f.task,attempt:f.attempt,project:f.project,store:f.app.store,workspaces:f.factory.workspaces,directoryManager:f.app.sessions.directoryManager,dataDir:f.app.dataDir,assertCurrent:()=>assertCurrentWorkerAssignment(f.app.store,{goal:f.goal,task:f.task,attempt:f.attempt})});
  assert.equal(frozen!.source.sourceArtifact.sha256,worker.referenceContext.source.sourceArtifact.sha256,'Reconnection reuses the exact frozen evidence identity');
  assert.ok(await f.factory.workspaces.artifacts.path(f.candidate.bundleArtifact),'Retained source survives disposable context cleanup');
});

test('cancellation during reference delivery never creates a runnable worker or provider turn and cleans disposable snapshots',async t=>{
  const f=await fixture(t);let entered!:()=>void,release!:()=>void;
  const copying=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
  f.setReferenceCopy(async()=>{entered();await blocked;});
  const prepared=f.factory.workspacePort.prepare({goal:f.goal,task:f.task,attempt:f.attempt,project:f.project});
  await copying;
  f.app.store.set('factory-attempt-details',{...f.detail,cancellation:'requested'});
  release();
  await assert.rejects(prepared,/authority changed|canceled|assignment changed/);
  assert.deepEqual(f.counts(),{created:0,invoked:0,stopped:1});
  const worker=f.app.store.get<{sessionId:string;status:string}>('factory-workers',f.attempt.id)!;
  assert.notEqual(worker.status,'prepared');assert.equal(f.app.sessions.record(worker.sessionId).status,'stopped');
  assert.equal(f.app.store.get<{complete:boolean}>('session-reference-context-provision',worker.sessionId)!.complete,false);
  await assert.rejects(readFile(path.join(f.app.dataDir,'workspace-data','working-directories',`${worker.sessionId}-reference-context`,'snapshots.json')),/ENOENT/);
  assert.deepEqual(await readdir(path.join(f.app.dataDir,'workspace-data','controller-context')),[]);
});

test('corrupted retained source and stale generation fail before reference evidence or an agent is exposed',async t=>{
  const f=await fixture(t);
  f.app.store.set('attempts',{...f.attempt,generation:2});
  await assert.rejects(f.factory.workspacePort.prepare({goal:f.goal,task:f.task,attempt:f.attempt,project:f.project}),/authority changed/);
  assert.equal(f.app.store.list('factory-workers').length,0);
  f.app.store.set('attempts',f.attempt);
  const bundle=await f.factory.workspaces.artifacts.path(f.candidate.bundleArtifact);
  await writeFile(bundle,Buffer.concat([await readFile(bundle),Buffer.from('corrupted')]));
  await assert.rejects(f.factory.workspacePort.prepare({goal:f.goal,task:f.task,attempt:f.attempt,project:f.project}),/integrity|hash|size/);
  assert.deepEqual(f.counts(),{created:0,invoked:0,stopped:0});
  assert.equal(f.app.store.list('sessions').length,0);
  assert.deepEqual(await readdir(path.join(f.app.dataDir,'workspace-data','controller-context')),[]);
});
