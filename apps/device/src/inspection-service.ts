import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Attempt, ControllerRun, ExecutionCapability, ExecutionTargetAdvertisement, FactoryTask, Goal, InspectionAuthority, InspectionJob, InspectionSourceIdentity, InspectionVerificationRun, Project, TaskQualityRequirements } from '@enoughfactory/contracts';
import { readJsonObject, type AttemptDetail } from '@enoughfactory/factory';
import { ArtifactStore, InspectionSnapshotManager, exportInspectionContainerRoots, type ArtifactManifest, type InspectionSnapshot } from '@enoughfactory/workspaces';
import { BrowserInspectionManager, type BrowserToolResult } from '@enoughfactory/browser-inspection';
import { NativeInspectionBackend, type NativeAction } from '@enoughfactory/native-inspection';
import type { DeviceApp } from './app.ts';
import type { FactoryInspectionPorts } from './factory.ts';
import type { AgentToolBridge, AgentToolBridgeContext, ChatController } from './chats.ts';
import { InspectionJobs } from './inspection-jobs.ts';
import { InspectionDelegation } from './inspection-delegation.ts';
import type { PeerManager } from '@enoughfactory/peers';
import { parseBrowserObservation } from './inspection-browser-observation.ts';
import { createContainerInspectionBridge, createHostInspectionBridge, inspectionMcpHandler, type InspectionMcpBridge } from './inspection-mcp.ts';
import { NativeInspectionAdapter, type NativeFixtureProfile, type NativeInspectionBuild } from './inspection-native.ts';
import { NativeBuildRunner } from './inspection-build-runner.ts';
import { InspectionQualityService, inspectionSourceContentMatches } from './inspection-quality.ts';
import { InspectionVerifier } from './inspection-verifier.ts';
import { InspectionRetention } from './inspection-retention.ts';
import { inspectionGoalQuality } from './inspection-goal-quality.ts';
import { HttpError } from './util.ts';

const execute=promisify(execFile);
const text=(value:unknown)=>({type:'text',text:JSON.stringify(value)});
const result=(value:unknown)=>({content:[text(value)]});
const objectSchema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'};
const tools=[
  {name:'factory_capabilities',description:'Get actual execution and inspection readiness and configured native profiles.',inputSchema:objectSchema({})},
  {name:'factory_native_build',description:'Capture your dirty/untracked source and build an exact private native product using a configured profile. Returns a durable job; poll it before launching.',inputSchema:objectSchema({profileId:string,requestId:string},['profileId','requestId'])},
  {name:'factory_job_status',description:'Read your durable build/session job. Waiting does not create another author attempt.',inputSchema:objectSchema({jobId:string,waitSeconds:{type:'integer',minimum:0,maximum:30}},['jobId'])},
  {name:'factory_native_start',description:'Launch your verified build with the configured isolated fixture. A shared Mac or Simulator lease queues fairly.',inputSchema:objectSchema({buildJobId:string,requestId:string},['buildJobId','requestId'])},
  {name:'factory_observe',description:'Inspect your owned app. Returns actual screenshot pixels and fresh actionable element IDs. Observe after each action.',inputSchema:objectSchema({sessionId:string,requestId:string},['sessionId','requestId'])},
  {name:'factory_native_action',description:'Interact using a fresh observation. Click/type require elementId from the last observation. Type also needs text: set mode explicitly to replace or append. Keys are enter, backspace, escape, tab, selectAll. Scroll needs elementId and direction. Re-observe after each action.',inputSchema:objectSchema({sessionId:string,requestId:string,observationId:string,action:objectSchema({kind:{type:'string',enum:['click','type','key','scroll']},elementId:string,text:string,mode:{type:'string',enum:['replace','append']},key:{type:'string',enum:['enter','backspace','escape','tab','selectAll']},direction:{type:'string',enum:['up','down','left','right']}},['kind'])},['sessionId','requestId','observationId','action'])},
  {name:'factory_native_restart',description:'Restart the exact owned app in the same fixture and simulator, preserving its data. Requires a fresh observation and confirmed previous process exit.',inputSchema:objectSchema({sessionId:string,requestId:string,observationId:string},['sessionId','requestId','observationId'])},
  {name:'factory_browser_start',description:'Prepare an isolated Chromium browser sharing your author container localhost. Includes its supported tools.',inputSchema:objectSchema({requestId:string},['requestId'])},
  {name:'factory_browser_call',description:'Operate your own browser using its advertised Playwright tools. Inspect screenshot images and resulting state; fresh observation required for input.',inputSchema:objectSchema({sessionId:string,requestId:string,observationId:string,tool:string,arguments:{type:'object'}},['sessionId','requestId','tool','arguments'])},
  {name:'factory_assert',description:'Check a condition against the last actual UI observation. Records the observed result; does not accept a model-written pass claim.',inputSchema:objectSchema({sessionId:string,observationId:string,labelIncludes:string,valueIncludes:string,absent:{type:'boolean'}},['sessionId','observationId','labelIncludes'])},
  {name:'factory_stop',description:'Stop your owned native/browser session and release its lease after backend acknowledgement.',inputSchema:objectSchema({sessionId:string},['sessionId'])},
  {name:'factory_reference',description:'Inspect a supplied reference source or image in a declared workspace root. Returns original content and records its inspected identity.',inputSchema:objectSchema({referenceId:string,rootId:string,relativePath:string,sourceSnapshotId:string},['referenceId','rootId','relativePath','sourceSnapshotId'])},
  {name:'factory_quality_submit',description:'Submit workflow assertions and visual review against your configured quality contract. Verified screenshots and image delivery are checked independently.',inputSchema:objectSchema({report:{type:'object'}},['report'])},
];
interface SourceRecord {id:string;snapshot:InspectionSnapshot;source:InspectionSourceIdentity;verificationRunId?:string;}
interface BackendRecord {id:string;kind:'native'|'browser';backendSessionId:string;}
interface BuildRecord {id:string;buildId:string;preparationArtifact?:ArtifactManifest;source?:InspectionSourceIdentity;finishedAt?:string;retiredAt?:string;}
interface Submission {id:string;kind:'build'|'native'|'browser';chatSessionId:string;containerId?:string;profile?:NativeFixtureProfile;buildId?:string;snapshot?:InspectionSnapshot;}
interface GrantToken {id:string;token:string;grantId:string;authority:InspectionAuthority;}

/** Service-owned visual tools. Provider processes receive only their own opaque authority. */
export class InspectionService {
  readonly artifacts:ArtifactStore;
  readonly jobs:InspectionJobs;
  readonly browser:BrowserInspectionManager;
  readonly native:NativeInspectionAdapter;
  readonly snapshots:InspectionSnapshotManager;
  readonly quality:InspectionQualityService;
  readonly delegation?:InspectionDelegation;
  readonly verifier:InspectionVerifier;
  readonly retention:InspectionRetention;
  readonly builds:NativeBuildRunner;
  private readonly active=new Map<string,Promise<void>>();
  private readonly bridges=new Set<InspectionMcpBridge>();
  private readonly contexts=new Map<string,AgentToolBridgeContext>();
  private refreshing?:Promise<ExecutionTargetAdvertisement[]>;
  private closing=false;
  private maintaining?:Promise<void>;
  private timer?:ReturnType<typeof setInterval>;
  constructor(readonly app:DeviceApp,readonly chats:ChatController,network?:{peers:PeerManager}){
    this.artifacts=new ArtifactStore(path.join(app.dataDir,'workspace-data','artifacts'),app.device.id);
    this.jobs=new InspectionJobs(app.store,{deviceId:app.device.id,authorityCurrent:authority=>this.authorityCurrent(authority)});
    this.snapshots=new InspectionSnapshotManager({dataDir:path.join(app.dataDir,'inspection'),artifacts:this.artifacts});
    this.quality=new InspectionQualityService({store:app.store,artifacts:this.artifacts,authorityCurrent:authority=>this.authorityCurrent(authority)});
    this.verifier=new InspectionVerifier({app,chats,quality:this.quality,authorityCurrent:authority=>this.authorityCurrent(authority),readiness:()=>this.readiness()});
    this.retention=new InspectionRetention({dataDir:path.join(app.dataDir,'inspection'),artifacts:this.artifacts,store:app.store,jobs:this.jobs,activeJobIds:()=>new Set(this.active.keys())});
    this.browser=new BrowserInspectionManager({endpoint:app.runtime.endpoint,dataDir:path.join(app.dataDir,'inspection','browser'),artifacts:this.artifacts,onRecord:()=>app.changed()});
    const backend=new NativeInspectionBackend({directory:path.join(app.dataDir,'inspection','native-sessions')});
    this.native=new NativeInspectionAdapter({dataDir:path.join(app.dataDir,'inspection'),artifacts:this.artifacts,backend,verifySnapshot:async(snapshot,signal)=>{
      if(snapshot.path.startsWith(path.join(app.dataDir,'inspection','inspection-snapshots')+path.sep))await this.snapshots.verify(snapshot,signal);
      else await this.verifier.verifySnapshot(snapshot,signal);
    }});
    this.builds=new NativeBuildRunner({dataDir:path.join(app.dataDir,'inspection'),artifacts:this.artifacts,verifierCopiesRoot:path.join(app.dataDir,'workspace-data','inspection-verification'),verifySnapshot:async(snapshot,signal)=>{
      if(snapshot.path.startsWith(path.join(app.dataDir,'inspection','inspection-snapshots')+path.sep))await this.snapshots.verify(snapshot,signal);else await this.verifier.verifySnapshot(snapshot,signal);
    }});
    if(network)this.delegation=new InspectionDelegation({app,peers:network.peers,jobs:this.jobs,native:this.native,builds:this.builds,artifacts:this.artifacts,profiles:id=>this.profiles(id),localAuthorityCurrent:authority=>this.localAuthorityCurrent(authority),capture:(context,authority)=>this.capture(context,authority)});
  }
  authorityCurrent(authority:InspectionAuthority):boolean{return this.localAuthorityCurrent(authority)||Boolean(this.delegation?.acceptedAuthorityCurrent(authority));}
  localAuthorityCurrent(authority:InspectionAuthority):boolean{
    const task=this.app.store.get<FactoryTask>('tasks',authority.taskId),attempt=this.app.store.get<Attempt>('attempts',authority.attemptId),goal=this.app.store.get<Goal>('goals',authority.goalId);
    const detail=attempt&&this.app.store.get<AttemptDetail>('factory-attempt-details',attempt.id);
    const revision=detail?.assignmentGoalRevision??detail?.goalRevision??goal?.revision;
    if(task&&attempt&&goal)return task.goalId===goal.id&&task.currentAttemptId===attempt.id&&attempt.generation===authority.authorityGeneration&&revision===authority.goalRevision&&authority.policyRevision===revision&&!['retired','failed'].includes(attempt.status)&&!['canceled','completed'].includes(goal.status);
    const worker=this.app.store.get<{id:string;goal:Goal;task:FactoryTask;attempt:Attempt;status:string}>('factory-workers',authority.attemptId);
    return Boolean(worker&&worker.goal.id===authority.goalId&&worker.goal.revision===authority.goalRevision&&worker.task.id===authority.taskId&&worker.attempt.generation===authority.authorityGeneration&&['preparing','prepared','running'].includes(worker.status));
  }
  async initialize():Promise<void>{
    this.jobs.recoverAfterRestart();this.delegation?.initialize();this.verifier.recover();
    this.chats.setToolBridge(context=>this.bridge(context));
    this.app.extensions.push(async({method,url,body,peerId})=>{
      if(method==='GET'&&url.pathname==='/api/inspection/readiness')return {executionTargets:await this.readiness()};
      const task=url.pathname.match(/^\/api\/tasks\/([^/]+)\/inspection$/);
      if(method==='GET'&&task){const jobs=this.jobs.listJobs().filter(job=>job.authority.taskId===task[1]),remote=this.delegation?.taskInspection(task[1]);const unique=<T extends {id:string}>(items:T[])=>[...new Map(items.map(item=>[item.id,item])).values()];return {jobs:unique([...jobs,...remote?.jobs||[]]),sessions:unique([...jobs.flatMap(job=>this.jobs.sessions(job.id)),...remote?.sessions||[]]),evidence:unique([...jobs.flatMap(job=>this.jobs.evidence(job.id)),...remote?.evidence||[]]),verifiers:this.app.store.list<InspectionVerificationRun>('inspection-verifier-runs').filter(run=>run.authority.taskId===task[1])};}
      const profiles=url.pathname.match(/^\/api\/projects\/([^/]+)\/inspection-profiles$/);
      if(profiles&&method==='GET')return this.profiles(profiles[1]);
      if(profiles&&method==='PUT'){
        if(peerId)throw new HttpError(403,'Configure native fixture profiles on the owning device.');
        if(!this.app.store.get<Project>('projects',profiles[1]))throw new HttpError(404,'Project not found.');
        if(!Array.isArray(body.profiles)||body.profiles.length>16)throw new HttpError(400,'Provide up to sixteen verified native profiles.');
        const ids=new Set<string>();for(const value of body.profiles){const profile=value as NativeFixtureProfile;if(!profile||typeof profile.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(profile.id)||ids.has(profile.id)||!profile.build||!Array.isArray(profile.launchArguments)||!profile.launchArguments.every(arg=>typeof arg==='string')||!profile.launchArguments.some(arg=>arg.includes('{runId}'))||!/^[a-f0-9]{64}$/.test(profile.fixtureEvidenceSha256)||!profile.receipt||profile.receipt.sha256!==profile.fixtureEvidenceSha256)throw new HttpError(400,'Native profiles require unique identities and an original audited fixture receipt matching their source hash.');ids.add(profile.id);try{const receipt=await this.artifacts.get(profile.receipt.id);if(receipt.sha256!==profile.fixtureEvidenceSha256||receipt.size!==profile.receipt.size)throw new Error('Receipt manifest changed.');await this.artifacts.read(receipt);}catch{throw new HttpError(400,'The original audited fixture receipt is unavailable or changed.');}}
        this.app.store.set('inspection-project-profiles',{id:profiles[1],profiles:body.profiles});this.app.changed();return this.profiles(profiles[1]);
      }
      return undefined;
    });
    this.app.serviceActivityHooks.push(()=>{const verifiers=this.app.store.list<InspectionVerificationRun>('inspection-verifier-runs').filter(run=>['preparing','running','unknown'].includes(run.status)||run.status==='waiting'&&Boolean(run.sessionId));const held=this.jobs.listJobs().filter(job=>['preparing','running','waiting','unknown','cancellation-requested'].includes(job.status));return held.length||verifiers.length?[`${held.length} inspection job(s) and ${verifiers.length} verifier(s) have active or unresolved ownership.`]:[];});
    this.app.closers.push(()=>this.close());
    void this.app.withServiceOperation(async()=>{await this.recoverOwnedSessions();await this.recoverOwnedBuilds();}).catch(error=>this.app.emit('inspection-error',{error:(error as Error).message}));
    this.timer=setInterval(()=>{
      if(this.closing||this.maintaining)return;
      this.maintaining=this.app.withServiceOperation(async()=>{
        const outcomes=await Promise.allSettled([this.readiness(),this.recoverOwnedBuilds(),this.retireIdleBrowsers(),this.retention.sweep(),this.retireColdProducts(),this.verifier.sweepCompleted(run=>this.canRetireVerifier(run))]);
        for(const outcome of outcomes)if(outcome.status==='rejected')this.app.emit('inspection-error',{error:(outcome.reason as Error).message});
      }).catch(error=>this.app.emit('inspection-error',{error:(error as Error).message})).finally(()=>{this.maintaining=undefined;});
    },30000);this.timer.unref();
    if(process.platform==='darwin')void this.app.withServiceOperation(signal=>this.chats.manager.provisionHost(signal)).then(()=>this.readiness(),error=>{this.app.emit('inspection-setup',{capability:'mac-shell',error:(error as Error).message});});
    await this.readiness();
  }
  profiles(projectId:string):NativeFixtureProfile[]{return this.app.store.get<{id:string;profiles:NativeFixtureProfile[]}>('inspection-project-profiles',projectId)?.profiles||[];}
  qualityCheck:NonNullable<FactoryInspectionPorts['qualityCheck']>=async input=>{
    const roots=[{id:'primary',name:'primary',path:input.path},...(input.workingDirectories||[]).map(root=>{
      const captured=input.candidate.workingDirectories?.find(item=>item.containerPath===root.containerPath);
      return {id:captured?.id||path.basename(root.containerPath),name:captured?.name||path.basename(root.containerPath),path:root.path};
    })];
    const snapshot=await this.snapshots.create({roots,signal:input.signal});
    try{
      const detail=this.app.store.get<AttemptDetail>('factory-attempt-details',input.attempt.id),revision=detail?.assignmentGoalRevision??detail?.goalRevision??input.goal.revision;
      const authority:InspectionAuthority={goalId:input.goal.id,goalRevision:revision,taskId:input.task.id,attemptId:input.attempt.id,authorityGeneration:input.attempt.generation,policyRevision:revision};
      const source:InspectionSourceIdentity={snapshotId:snapshot.id,sha256:snapshot.sourceDigest,candidateId:input.candidate.id,candidateCommit:input.candidate.commit,checkedCommit:input.checkedCommit,roots:snapshot.roots.map(root=>({id:root.id,sha256:root.sourceDigest,...(root.sourceCommit?{commit:root.sourceCommit}:{})}))};
      const checked=await this.quality.check({authority,quality:input.quality,source,candidateCommit:input.candidate.commit,checkedCommit:input.checkedCommit});
      if(checked.passed||!checked.recovery)return checked;
      const project=this.app.store.get<Project>('projects',input.goal.projectId);if(!project)throw new Error('The verification project is unavailable.');
      const run=await this.verifier.ensure({authority,quality:input.quality,source,snapshot,project,signal:input.signal});
      if(run.status==='succeeded')return this.quality.check({authority,quality:input.quality,source,candidateCommit:input.candidate.commit,checkedCommit:input.checkedCommit});
      if(['failed','canceled'].includes(run.status))return {...checked,output:run.reason||'Independent application verification failed.',recovery:undefined};
      const reason=run.reason||'Independent application verification is waiting for inspection readiness.';return {...checked,output:reason,recovery:{condition:'inspection-evidence',reason}};
    }finally{await this.snapshots.remove(snapshot);}
  };
  async readiness():Promise<ExecutionTargetAdvertisement[]>{
    if(this.refreshing)return this.refreshing;
    return this.refreshing=(async()=>{
      const containerReady=(this.app.device.capacity??0)>0;
      const capabilities:ExecutionTargetAdvertisement[]=[{id:'container',kind:'container',protocolVersion:1,readiness:containerReady?'ready':'setup-required',capacity:this.app.device.capacity,workspaceProviders:this.app.device.workspaceProviders||['git'],runtimes:['codex'],resources:this.app.device.workerResources,capabilities:[{kind:'linux-shell',readiness:containerReady?'ready':'setup-required',reason:containerReady?undefined:'Start the private runtime to run container work.',setupAction:containerReady?undefined:'Start the runtime from Devices.'},{kind:'chromium-inspection',readiness:containerReady?'ready':'setup-required',version:'playwright-mcp-0.0.82',reason:containerReady?'Prepared on demand in the private runtime.':'Start the private runtime to prepare browser testing.'}]}];
      if(process.platform==='darwin'){
        const [providers,mac,ios,apple]=await Promise.all([this.chats.manager.hostAvailability(),this.native.readiness('macos'),this.native.readiness('ios-simulator'),execute('/usr/bin/xcrun',['--find','xcodebuild'],{timeout:10000}).then(()=>true,()=>false)]);
        const provider=providers.find(provider=>provider.kind==='codex')!;
        capabilities.push({id:'mac-host',kind:'host-macos',protocolVersion:1,readiness:provider.available?'ready':'preparing',capacity:Math.max(1,Math.min(4,cpus().length-1)),resources:{cpus:cpus().length,memoryGiB:totalmem()/1024**3},workspaceProviders:['git'],runtimes:['codex'],capabilities:[{kind:'mac-shell',readiness:provider.available?'ready':'preparing',version:provider.version,reason:provider.available?undefined:'Preparing the pinned Mac authoring tools.'},{kind:'apple-compilation',readiness:apple?'ready':'setup-required',setupAction:apple?undefined:'Install Xcode and its command line tools.'},{kind:'macos-app-inspection',readiness:mac.status,reason:mac.reasons.join(' ')||undefined,setupAction:mac.status==='ready'?undefined:'Set up the native testing helper, Accessibility and screen capture permissions.'},{kind:'ios-simulator-inspection',readiness:ios.status,reason:ios.reasons.join(' ')||undefined,setupAction:ios.status==='ready'?undefined:'Install the iPhone testing runner and an iOS Simulator runtime.'}]});
      }
      if(JSON.stringify(this.app.device.executionTargets)!==JSON.stringify(capabilities)){this.app.device={...this.app.device,executionTargets:capabilities};this.app.devices=[this.app.device,...this.app.devices.filter(device=>device.id!==this.app.device.id)];this.app.emit('execution-capabilities',capabilities);this.app.changed();}
      return capabilities;
    })().finally(()=>{this.refreshing=undefined;});
  }
  private authority(context:AgentToolBridgeContext):InspectionAuthority|undefined{
    if(!context.attemptId)return;
    const attempt=this.app.store.get<Attempt>('attempts',context.attemptId),task=attempt&&this.app.store.get<FactoryTask>('tasks',attempt.taskId),goal=task&&this.app.store.get<Goal>('goals',task.goalId);
    const worker=this.app.store.get<{id:string;goal:Goal;task:FactoryTask;attempt:Attempt}>('factory-workers',context.attemptId);
    const assignedAttempt=attempt||worker?.attempt,assignedTask=task||worker?.task,assignedGoal=goal||worker?.goal;
    if(!assignedAttempt||!assignedTask||!assignedGoal)return;
    const detail=this.app.store.get<AttemptDetail>('factory-attempt-details',assignedAttempt.id),revision=detail?.assignmentGoalRevision??detail?.goalRevision??assignedGoal.revision;
    return {goalId:assignedGoal.id,goalRevision:revision,taskId:assignedTask.id,attemptId:assignedAttempt.id,authorityGeneration:assignedAttempt.generation,policyRevision:revision};
  }
  private async bridge(context:AgentToolBridgeContext):Promise<AgentToolBridge|undefined>{
    if(context.chat.runtime!=='codex')return;
    const verification=await this.verifier.verificationSource(context),authority=verification?.run.authority||this.authority(context);if(!authority)return this.controllerBridge(context);
    const key=`${authority.attemptId}-${authority.authorityGeneration}-${authority.goalRevision}`;
    let saved=this.app.store.get<GrantToken>('inspection-private-tokens',key);
    if(saved){try{this.jobs.authorize(saved.token);}catch{saved=undefined;}}
    if(!saved){const grant=this.jobs.issueAuthority(authority,{capabilities:['chromium-inspection','apple-compilation','macos-app-inspection','ios-simulator-inspection'],executionTargetIds:['container','mac-host']});saved={id:key,token:grant.token,grantId:grant.grant.id,authority};this.app.store.set('inspection-private-tokens',saved);}
    const token=saved.token;this.contexts.set(authority.attemptId,context);
    const handler=inspectionMcpHandler(tools,async(name,args)=>this.app.withServiceOperation(async()=>{this.jobs.authorize(token);if(context.signal.aborted)throw new Error('The author turn was canceled.');return this.call(context,token,name,args);}));
    const bridge=context.execution.kind==='host-macos'?await createHostInspectionBridge(token,handler):await createContainerInspectionBridge(this.app.runtime.endpoint,context.execution.containerId!,token,handler);
    this.bridges.add(bridge);
    return {mcpServers:{factory:bridge.server},systemInstructions:'Factory inspection tools are available. Use factory_capabilities first. Capture/build your actual source, open it, view screenshot image responses, operate fresh element IDs, check resulting state and repair serious defects. Native builds and UI sessions are different durable jobs; poll queued/running jobs with factory_job_status. Finish or explicitly stop all inspection jobs before ending your turn. Use configured isolated native fixture profiles; do not launch personal-data instances. Compiling alone is not product acceptance. If factory_capabilities returns a quality contract, you may submit factory_quality_submit. Factory independently verifies missing evidence after authoring. Report schema: report={version:1,source:job.source,workflows:[{id:requiredWorkflowId,platform,before:screenshotEvidenceId,action:actionId,after:screenshotEvidenceId,outcome:passedOrFailedOrBlocked,assertion:concreteObservedResult,assertionEvidenceId}],reviews:[{platform,observations:[screenshotEvidenceId],references:[{id:requiredReferenceId,comparison:concreteComparison}],dimensions:{hierarchy,spacing,clipping,typography,controls,states},defects:[{id,severity:minorOrMajorOrBlocking,status:openOrRepaired,description,observation:screenshotEvidenceId}]}]}. IDs must come from actual tool receipts; all six dimensions need concrete review text. Inspect supplied reference files via factory_reference and actual screenshot images. A report with missing receipts is a durable evidence wait; serious defects require repair.',onToolImage:async(image)=>{
      const sha256=createHash('sha256').update(image.bytes).digest('hex');
      const existing=[...this.jobs.listJobs(authority).flatMap(job=>this.jobs.evidence(job.id)),...this.delegation?.evidenceForAuthority(authority)||[]].find(evidence=>evidence.kind==='screenshot'&&evidence.artifact.sha256===sha256)?.artifact;
      const artifact=existing||await this.artifacts.put(image.bytes,{goalId:authority.goalId,taskId:authority.taskId,attemptId:authority.attemptId,name:`inspection-${sha256.slice(0,12)}.png`,mime:image.mimeType});
      this.app.store.set('factory-artifacts',artifact);
      const delivery={id:randomUUID(),chatId:context.chat.id,eventId:image.itemId||randomUUID(),artifactSha256:sha256,authority,route:'tool-image',at:new Date().toISOString()};
      this.app.store.set('provider-image-deliveries',delivery);
      return {artifactId:artifact.id,sha256,mimeType:image.mimeType,byteLength:image.bytes.length,deliveryId:delivery.id};
    },release:async()=>{await bridge.close();this.bridges.delete(bridge);this.contexts.delete(authority.attemptId);await this.stopAuthoritySessions(token,authority);}};
  }
  private goalQuality(goalId:string):TaskQualityRequirements|undefined {
    return inspectionGoalQuality(this.app.store,goalId);
  }
  private async captureControllerSource(context:AgentToolBridgeContext,goal:Goal,controllerRunId:string):Promise<SourceRecord>{
    const project=this.app.store.get<Project>('projects',goal.projectId);if(!project)throw new Error('The integrated project is unavailable.');
    const declared=project.workingDirectories||[],mounted=context.session.workingDirectories||[];
    const direct=declared.map(root=>mounted.filter(item=>item.id===root.id));
    if(direct.some(matches=>matches.length>1))throw new Error('The evaluator has ambiguous declared reference-folder identities. Recreate its source context.');
    const aggregate=mounted.filter(root=>root.id===`controller-context-${controllerRunId}`);
    const aggregated=declared.length===8&&direct.every(matches=>matches.length===0)&&aggregate.length===1;
    const roots=declared.map((root,index)=>{
      const match=direct[index]![0];
      if(match)return {...match,id:root.id,name:root.name};
      if(!aggregated||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(root.id))throw new Error(`The evaluator is missing declared reference folder ${root.name}. Recreate its source context before final review.`);
      // The eight-folder layout is service-defined; a model-writable manifest
      // cannot redirect a canonical reference identity to another path.
      return {...aggregate[0]!,id:root.id,name:root.name,path:path.join(aggregate[0]!.path,'project-directories',root.id)};
    });
    if(context.execution.kind==='host-macos')for(const root of roots){
      try{const actual=await realpath(root.path);if(aggregated&&!actual.startsWith((await realpath(aggregate[0]!.path))+path.sep))throw new Error('Reference folder escapes its controller context.');}
      catch(error){context.signal.throwIfAborted();throw new Error(`The evaluator cannot read declared reference folder ${root.name}: ${(error as Error).message}`);}
    }
    return this.captureActual({...context,session:{...context.session,workingDirectories:roots}});
  }
  private async canonicalSource(goal:Goal,signal?:AbortSignal):Promise<SourceRecord&{clean?:boolean;checkedCommit?:string}>{
    const project=this.app.store.get<Project>('projects',goal.projectId);if(!project)throw new Error('The integrated project is unavailable.');
    const gitState=async()=>{
      try{
        const [head,status]=await Promise.all([
          execute('git',['-C',project.path,'rev-parse','--verify','HEAD^{commit}'],{timeout:10000,maxBuffer:1024*1024,signal}),
          execute('git',['-C',project.path,'status','--porcelain=v1','--untracked-files=all'],{timeout:10000,maxBuffer:1024*1024,signal}),
        ]);
        const commit=head.stdout.trim();return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)?{commit,clean:status.stdout.length===0}:undefined;
      }catch(error){signal?.throwIfAborted();return undefined;}
    };
    const before=await gitState();
    const snapshot=await this.snapshots.create({roots:[{id:'primary',name:'primary',path:project.path},...(project.workingDirectories||[]).map(root=>({id:root.id,name:root.name,path:root.path}))],signal});
    const after=await gitState(),primary=snapshot.roots.find(root=>root.id==='primary');
    const clean=primary?.kind==='git'?Boolean(before?.clean&&after?.clean&&before.commit===after.commit&&primary.sourceCommit===after.commit):undefined;
    return {id:snapshot.id,snapshot,...(clean!==undefined?{clean}:{}),...(clean?{checkedCommit:after!.commit}:{}),source:{snapshotId:snapshot.id,sha256:snapshot.sourceDigest,roots:snapshot.roots.map(root=>({id:root.id,sha256:root.sourceDigest,...(root.sourceCommit?{commit:root.sourceCommit}:{})}))}};
  }
  reviewController=async(input:{goal:Goal;run:ControllerRun;resultText:string;signal?:AbortSignal})=>{
    const quality=this.goalQuality(input.goal.id);if(!quality)return {ready:true,evidenceIds:[]};
    const decision=readJsonObject(input.resultText);if(decision.complete!==true)return {ready:true,evidenceIds:[]};
    const chat=input.run.chatId&&this.app.store.get<import('@enoughfactory/contracts').Chat>('chats',input.run.chatId);
    if(!chat)return {ready:false,reason:'The evaluator conversation is unavailable.',evidenceIds:[]};
    const context:AgentToolBridgeContext={chat,session:this.app.sessions.record(input.run.sessionId),execution:this.app.sessions.execution(input.run.sessionId),signal:input.signal||new AbortController().signal};
    const canonical=await this.canonicalSource(input.goal,input.signal);
    let current:SourceRecord|undefined;
    try{let review:unknown;try{review=decision.visualReview;}catch{/* The protocol parser retains its own decision error. */}
      try{current=await this.captureControllerSource(context,input.goal,input.run.id);}catch(error){input.signal?.throwIfAborted();return {ready:false,reason:(error as Error).message,evidenceIds:[]};}
      if(!inspectionSourceContentMatches(current.source,canonical.source))return {ready:false,reason:'The evaluator workspace differs from the current integrated project or one of its reference folders. Refresh verification from the current source; retained screenshots cannot certify changed or reverted code.',evidenceIds:[]};
      if(canonical.clean===false)return {ready:false,reason:'The integrated project has uncommitted changes or changed while its source was captured. Commit or restore those changes before final app verification; no completed commit can certify this working tree.',evidenceIds:[]};
      let checked=await this.quality.reviewCheck({goalId:input.goal.id,controllerRunId:input.run.id,source:canonical.source,quality,review});
      if(!checked.ready){
        const tasks=this.app.store.list<FactoryTask>('tasks').filter(task=>task.goalId===input.goal.id);
        if(tasks.some(task=>!['completed','canceled'].includes(task.status)))return {ready:false,reason:'Finish or explicitly cancel the remaining goal tasks before final app verification. Their recorded requirements remain part of acceptance.',evidenceIds:[]};
        const reports=await this.quality.controllerReportContext({goalId:input.goal.id,source:canonical.source});
        const currentPolicies=reports.reports.filter(report=>report.currentSource&&report.currentAuthority&&report.latestForPolicy&&!report.unavailable&&report.recordedStatus==='ready-for-review').flatMap(report=>report.quality?[report.quality as TaskQualityRequirements]:[]);
        const currentCoverage=quality.platforms.every(platform=>currentPolicies.some(policy=>policy.platforms.includes(platform)))
          &&quality.workflows.every(workflow=>currentPolicies.some(policy=>policy.workflows.some(item=>item.id===workflow.id&&item.platform===workflow.platform)))
          &&quality.referenceIds.every(id=>currentPolicies.some(policy=>policy.referenceIds.includes(id)));
        const anchors=tasks.filter(task=>task.status==='completed').flatMap(task=>{
          const attempt=task.currentAttemptId?this.app.store.get<Attempt>('attempts',task.currentAttemptId):undefined,detail=attempt?this.app.store.get<AttemptDetail>('factory-attempt-details',attempt.id):undefined;
          if(!attempt||attempt.status!=='succeeded'||!detail?.candidate||!detail.integration||detail.integration.candidateCommit!==detail.candidate.commit||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(detail.candidate.commit)||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(detail.integration.commit))return [];
          return [{task,attempt,detail}];
        }).sort((left,right)=>(right.attempt.endedAt||right.task.updatedAt||'').localeCompare(left.attempt.endedAt||left.task.updatedAt||'')||right.task.id.localeCompare(left.task.id));
        const anchor=anchors[0];
        if(!anchor||!canonical.checkedCommit){
          if(!currentCoverage)return {ready:false,reason:'Current-source app evidence is missing, and final verification needs a retained accepted candidate plus a clean integrated Git commit. Restore the accepted candidate and integration record or finish integration before verifying the app.',evidenceIds:[]};
        }else{
          const revision=anchor.detail.assignmentGoalRevision??anchor.detail.goalRevision??input.goal.revision;
          const authority:InspectionAuthority={goalId:input.goal.id,goalRevision:revision,taskId:anchor.task.id,attemptId:anchor.attempt.id,authorityGeneration:anchor.attempt.generation,policyRevision:revision};
          const source:InspectionSourceIdentity={...canonical.source,candidateId:anchor.detail.candidate!.id,candidateCommit:anchor.detail.candidate!.commit,checkedCommit:canonical.checkedCommit};
          const probe=await this.quality.check({authority,quality,source,candidateCommit:source.candidateCommit!,checkedCommit:source.checkedCommit});
          if(!probe.passed&&!probe.recovery)return {ready:false,reason:`Final app verification found defects that still require repair: ${probe.output}`,evidenceIds:[]};
          const exactPolicy=reports.reports.some(report=>report.taskId===authority.taskId&&report.currentSource&&JSON.stringify(report.quality)===JSON.stringify(quality));
          if(!probe.passed&&(!currentCoverage||exactPolicy)){
            const project=this.app.store.get<Project>('projects',input.goal.projectId)!;
            const verification=await this.verifier.ensure({authority,source,snapshot:canonical.snapshot,quality,project,purpose:'goal-final',goalRevision:input.goal.revision,signal:input.signal});
            if(verification.status!=='succeeded')return {ready:false,reason:`Final app verification ${verification.status}: ${verification.reason||'Waiting for current-source screenshots and workflow assertions. The accepted author attempt remains retained.'}`,evidenceIds:[]};
            const verified=await this.quality.check({authority,quality,source,candidateCommit:source.candidateCommit!,checkedCommit:source.checkedCommit});
            if(!verified.passed)return {ready:false,reason:`Final app verification needs attention: ${verified.recovery?.reason||verified.output}`,evidenceIds:[]};
            checked=await this.quality.reviewCheck({goalId:input.goal.id,controllerRunId:input.run.id,source:canonical.source,quality,review});
          }
        }
      }
      const after=await this.canonicalSource(input.goal,input.signal);
      try{if(!inspectionSourceContentMatches(after.source,canonical.source)||after.clean===false||after.checkedCommit!==canonical.checkedCommit)return {ready:false,reason:'The integrated project changed during its final review. Verify the latest source.',evidenceIds:[]};}finally{await this.snapshots.remove(after.snapshot);}
      return checked;
    }finally{await this.snapshots.remove(canonical.snapshot);if(current)await this.snapshots.remove(current.snapshot);}
  };
  private async controllerBridge(context:AgentToolBridgeContext):Promise<AgentToolBridge|undefined>{
    const run=this.app.store.list<ControllerRun>('factory-controller-runs').find(run=>run.chatId===context.chat.id&&run.sessionId===context.session.id);
    const goal=run&&this.app.store.get<Goal>('goals',run.goalId);if(!run||!goal)return;
    const current=()=>{const saved=this.app.store.get<ControllerRun>('factory-controller-runs',run.id),actual=this.app.store.get<Goal>('goals',goal.id);if(context.signal.aborted||!saved||!['starting','running'].includes(saved.status)||actual?.revision!==goal.revision)throw new Error('This controller review was retired.');};
    let source:Promise<SourceRecord>|undefined;
    const reviewSource=()=>source??=(this.captureControllerSource(context,goal,run.id));
    const handler=inspectionMcpHandler([
      {name:'factory_review_screens',description:'List actual screenshots, assertions, bounded verified quality-report workflow links and exact source identities for this goal. Includes the canonical integrated source, controller source match and required review contract.',inputSchema:objectSchema({})},
      {name:'factory_review_image',description:'View original screenshot pixels and its UI observation. Older screens cannot establish current app acceptance.',inputSchema:objectSchema({evidenceId:string},['evidenceId'])},
      {name:'factory_review_evidence',description:'Read an original quality report by its report ID, or assertion/build evidence plus its owned job, actions and observation. Read every required workflow assertionEvidenceId; report summaries cannot establish its measured result.',inputSchema:objectSchema({evidenceId:string},['evidenceId'])},
      {name:'factory_review_reference',description:'Inspect original reference content in a declared current-source root before comparing the app design. Records this evaluator viewing the reference.',inputSchema:objectSchema({referenceId:string,rootId:string,relativePath:string},['referenceId','rootId','relativePath'])},
    ],async(name,args)=>this.app.withServiceOperation(async()=>{
      current();const jobs=this.jobs.listJobs().filter(job=>job.authority.goalId===goal.id),evidence=jobs.flatMap(job=>this.jobs.evidence(job.id));
      if(name==='factory_review_screens'){
        const actual=await reviewSource(),canonical=await this.canonicalSource(goal,context.signal);
        try{const qualityReports=await this.quality.controllerReportContext({goalId:goal.id,source:canonical.source});current();
          return result({source:canonical.source,controllerSource:actual.source,controllerSourceMatchesCanonical:inspectionSourceContentMatches(actual.source,canonical.source),quality:this.goalQuality(goal.id),roots:canonical.snapshot.roots.map(root=>({id:root.id,name:root.name})),qualityReports,
            screens:evidence.filter(item=>item.kind==='screenshot').slice(-24).map(item=>({id:item.id,taskId:item.authority.taskId,source:item.source,currentSource:inspectionSourceContentMatches(item.source,canonical.source),artifact:item.artifact,metadata:item.metadata,createdAt:item.createdAt})),assertions:evidence.filter(item=>item.kind==='assertion').slice(-24).map(item=>({id:item.id,source:item.source,metadata:item.metadata}))});
        }finally{await this.snapshots.remove(canonical.snapshot);}
      }
      if(name==='factory_review_reference'){
        const actual=await reviewSource(),quality=this.goalQuality(goal.id);
        if(!quality?.referenceIds.includes(String(args.referenceId)))throw new Error('This reference is not part of the goal quality contract.');
        const root=actual.snapshot.roots.find(root=>root.id===args.rootId&&(root.id===args.referenceId||root.name===args.referenceId));if(!root)throw new Error('Select the declared root matching this reference identity.');
        const target=await realpath(path.resolve(root.path,String(args.relativePath||''))),base=await realpath(root.path);if(!target.startsWith(base+path.sep))throw new Error('Reference path escapes its declared root.');
        const bytes=await readFile(target),mime=/\.png$/i.test(target)?'image/png':/\.jpe?g$/i.test(target)?'image/jpeg':'text/plain';
        if(bytes.length>(mime==='text/plain'?128*1024:2*1024*1024))throw new Error('Choose a bounded reference file whose original contents can be inspected.');
        current();const artifact=await this.artifacts.put(bytes,{goalId:goal.id,name:path.basename(target),mime});current();this.app.store.set('factory-artifacts',artifact);
        this.app.store.set('controller-reference-views',{id:randomUUID(),controllerRunId:run.id,goalId:goal.id,source:actual.source,referenceId:args.referenceId,artifacts:[artifact]});
        return {content:[text({referenceId:args.referenceId,source:actual.source,artifact}),mime.startsWith('image/')?{type:'image',mimeType:mime,data:bytes.toString('base64')}:{type:'text',text:bytes.toString('utf8')}]};
      }
      const item=evidence.find(item=>item.id===args.evidenceId);
      if(!item&&name==='factory_review_evidence'){
        const original=await this.quality.controllerReport({goalId:goal.id,reportId:String(args.evidenceId)});current();
        this.app.store.set('controller-evidence-views',{id:randomUUID(),controllerRunId:run.id,goalId:goal.id,evidenceId:original.record.id,source:original.record.source,artifact:original.record.reportArtifact,viewedAt:new Date().toISOString()});
        return result({qualityReport:{id:original.record.id,authority:original.record.authority,source:original.record.source,quality:original.record.quality,reportArtifact:original.record.reportArtifact},original:original.original});
      }
      if(!item)throw new Error('This evidence is not retained for your goal.');
      const manifest=await this.artifacts.get(item.artifact.id);if(manifest.sha256!==item.artifact.sha256||manifest.size!==item.artifact.size)throw new Error('The original evidence manifest changed.');
      const bytes=await this.artifacts.read(manifest);current();
      const observation=this.app.store.list<{id:string;screenshotEvidenceId?:string;uiTree?:string}>('inspection-observations').find(observation=>observation.screenshotEvidenceId===item.id||observation.id===item.metadata?.observationId);
      if(name==='factory_review_evidence'){
        this.app.store.set('controller-evidence-views',{id:randomUUID(),controllerRunId:run.id,goalId:goal.id,evidenceId:item.id,source:item.source,artifact:manifest,viewedAt:new Date().toISOString()});
        return result({evidence:item,job:jobs.find(job=>job.id===item.jobId),actions:item.sessionId?this.jobs.actions(item.sessionId).slice(-24):[],observation,original:manifest.mime.startsWith('image/')?{use:'factory_review_image'}:bytes.length<=128*1024?bytes.toString('utf8'):{artifact:manifest,reason:'The original is larger than the bounded review response.'}});
      }
      if(item.kind!=='screenshot'||!manifest.mime.startsWith('image/'))throw new Error('Select a screenshot to inspect its pixels.');
      return {content:[text({evidenceId:item.id,source:item.source,metadata:item.metadata,uiTree:observation?.uiTree}),{type:'image',mimeType:item.artifact.mime,data:bytes.toString('base64')}]};
    }));
    const token=randomBytes(32).toString('base64url');
    const bridge=context.execution.kind==='host-macos'?await createHostInspectionBridge(token,handler):await createContainerInspectionBridge(this.app.runtime.endpoint,context.execution.containerId!,token,handler);this.bridges.add(bridge);
    return {mcpServers:{factory_review:bridge.server},systemInstructions:'Use factory_review_screens, factory_review_image, factory_review_evidence and factory_review_reference before judging app completion. Inspect original pixels and measured workflow assertions. The list provides current integrated source and quality requirements. If quality is present, your completion decision must include visualReview:{source:theCurrentSource,reviews:[{platform,observations:[actualScreenshotEvidenceId],references:[{id,comparison:concreteReferenceComparison}],dimensions:{hierarchy,spacing,clipping,typography,controls,states},defects:[{id,severity,status,description,observation}]}]}. View every screenshot you cite and inspect each required reference file yourself. Include all six dimensions as concrete critique text. Keep older source identities explicit; screenshot presence and accepted task counts alone do not establish current acceptance.',onToolImage:async image=>{
      current();const sha256=createHash('sha256').update(image.bytes).digest('hex');
      const screenshot=this.jobs.listJobs().filter(job=>job.authority.goalId===goal.id).flatMap(job=>this.jobs.evidence(job.id)).find(item=>item.kind==='screenshot'&&item.artifact.sha256===sha256);
      const reference=this.app.store.list<{id:string;controllerRunId:string;artifacts:ArtifactManifest[]}>('controller-reference-views').filter(view=>view.controllerRunId===run.id).flatMap(view=>view.artifacts).find(artifact=>artifact.sha256===sha256);
      const artifact=screenshot?.artifact||reference;if(!artifact)throw new Error('Controller image is not retained goal evidence or an inspected reference.');
      this.app.store.set('controller-image-deliveries',{id:randomUUID(),controllerRunId:run.id,goalId:goal.id,goalRevision:goal.revision,chatId:context.chat.id,eventId:image.itemId||randomUUID(),artifactSha256:sha256,at:new Date().toISOString()});
      return {artifactId:artifact.id,sha256,mimeType:image.mimeType,byteLength:image.bytes.length};
    },release:async()=>{await bridge.close();this.bridges.delete(bridge);if(source){const retained=await source;await this.snapshots.remove(retained.snapshot);}}};
  }
  private ownJob(token:string,id:unknown):InspectionJob{
    const grant=this.jobs.authorize(token),job=typeof id==='string'?this.jobs.getJob(id):undefined;
    if(!job||JSON.stringify(job.authority)!==JSON.stringify(grant.authority))throw new Error('This inspection job belongs to another author.');return job;
  }
  private ownSession(token:string,id:unknown){const session=typeof id==='string'?this.jobs.getSession(id):undefined;if(!session)throw new Error('Inspection session not found.');this.ownJob(token,session.jobId);return session;}
  private async capture(context:AgentToolBridgeContext,authority:InspectionAuthority,retain=true):Promise<SourceRecord>{
    const verification=await this.verifier.verificationSource(context);
    if(verification){const record={id:verification.id,snapshot:verification.snapshot,source:verification.source};if(retain)this.app.store.set('inspection-source-snapshots',{...record,verificationRunId:verification.run.id});return record;}
    return this.captureActual(context,authority,retain);
  }
  private async captureActual(context:AgentToolBridgeContext,authority?:InspectionAuthority,retain=false):Promise<SourceRecord>{
    const roots=[{id:'primary',name:'primary',path:context.execution.workdir},...(context.session.workingDirectories||[]).map(root=>({id:root.id,name:root.name,path:root.path}))];
    let exported:Awaited<ReturnType<typeof exportInspectionContainerRoots>>|undefined;
    try{
      if(context.execution.kind==='container')exported=await exportInspectionContainerRoots({endpoint:this.app.runtime.endpoint,containerId:context.execution.containerId!,roots,scratchDirectory:path.join(this.app.dataDir,'inspection','exports'),signal:context.signal});
      const snapshot=await this.snapshots.create({roots:exported?.roots||roots,signal:context.signal,context:authority?{goalId:authority.goalId,taskId:authority.taskId,attemptId:authority.attemptId}:undefined});
      const source:InspectionSourceIdentity={snapshotId:snapshot.id,sha256:snapshot.sourceDigest,roots:snapshot.roots.map(root=>({id:root.id,sha256:root.sourceDigest,...(root.sourceCommit?{commit:root.sourceCommit}:{})}))};
      const record={id:snapshot.id,snapshot,source};if(retain){if(!authority)throw new Error('Retained execution source requires an author owner.');await this.retention.retain(snapshot,authority);this.app.store.set('inspection-source-snapshots',record);}return record;
    }finally{await exported?.cleanup();}
  }
  private async call(context:AgentToolBridgeContext,token:string,name:string,args:Record<string,unknown>):Promise<unknown>{
    const authority=this.jobs.authorize(token).authority;
    const verification=context.chat.verificationRunId?await this.verifier.verificationSource(context):undefined;
    const delegated=await this.delegation?.dispatch(context,token,name,args);if(delegated!==undefined)return delegated;
    if(name==='factory_quality_submit'){
      const detail=this.app.store.get<AttemptDetail>('factory-attempt-details',authority.attemptId),quality=verification?.run.quality||detail?.contract?.quality||this.app.store.get<FactoryTask>('tasks',authority.taskId)?.quality;
      if(!quality)throw new Error('This task has no configured visual/workflow acceptance contract.');
      const checked=await this.quality.submit({authority,quality,report:args.report});this.app.emit('inspection-evidence',{authority,reportId:checked.id});return result(checked);
    }
    if(name==='factory_reference'){
      const source=typeof args.sourceSnapshotId==='string'?this.app.store.get<SourceRecord>('inspection-source-snapshots',args.sourceSnapshotId):undefined;
      if(!source||!this.jobs.listJobs(authority).some(job=>job.source.snapshotId===source.id))throw new Error('Select your current inspection source snapshot.');
      const detail=this.app.store.get<AttemptDetail>('factory-attempt-details',authority.attemptId),quality=verification?.run.quality||detail?.contract?.quality||this.app.store.get<FactoryTask>('tasks',authority.taskId)?.quality;
      if(!quality?.referenceIds.includes(String(args.referenceId)))throw new Error('This reference is not in the task quality contract.');
      const inspect=async(snapshot:InspectionSnapshot)=>{
      // Reference bytes come from the captured source roots, never arbitrary host paths.
      const root=snapshot.roots.find(root=>root.id===args.rootId);if(!root)throw new Error('Reference root is not declared.');
      if(args.referenceId!==root.id&&args.referenceId!==root.name)throw new Error('The reference identity must match its configured source root.');
      const target=await realpath(path.resolve(root.path,String(args.relativePath||''))),base=await realpath(root.path);
      if(!target.startsWith(base+path.sep))throw new Error('Reference path escapes its declared root.');
      const bytes=await readFile(target);if(bytes.length>2*1024*1024)throw new Error('Reference exceeds the bounded tool size.');
      const mime=/\.png$/i.test(target)?'image/png':/\.jpe?g$/i.test(target)?'image/jpeg':'text/plain';
      if(mime==='text/plain'&&bytes.length>128*1024)throw new Error('Choose a reference file smaller than 128 KiB so its full contents can be inspected.');
      const artifact=await this.artifacts.put(bytes,{goalId:authority.goalId,taskId:authority.taskId,attemptId:authority.attemptId,name:path.basename(target),mime});
      this.app.store.set('factory-artifacts',artifact);this.app.store.set('inspection-reference-views',{id:randomUUID(),referenceId:args.referenceId,authority,source:source.source,artifactIds:[artifact.id],artifacts:[artifact],inspectedAt:new Date().toISOString()});
      return {content:[text({referenceId:args.referenceId,artifact}),mime.startsWith('image/')?{type:'image',mimeType:mime,data:bytes.toString('base64')}:{type:'text',text:bytes.toString('utf8').slice(0,128*1024)}]};
      };
      if(source.verificationRunId){const verified=await this.verifier.verificationSource(context);if(!verified||verified.run.id!==source.verificationRunId||verified.id!==source.id)throw new Error('This reference source belongs to another verifier.');return inspect(verified.snapshot);}
      if(this.app.store.get('inspection-source-retention',source.id))return this.retention.use(source.id,inspect,context.signal);
      await this.snapshots.verify(source.snapshot,context.signal);return inspect(source.snapshot);
    }
    if(name==='factory_capabilities'){const project=this.app.store.get<Project>('projects',context.session.projectId),projectId=project?.sourceProjectId||project?.id||'',detail=this.app.store.get<AttemptDetail>('factory-attempt-details',authority.attemptId);return result({targets:await this.readiness(),delegatedTargets:await this.delegation?.capabilities(projectId)||[],profiles:this.profiles(projectId).map(profile=>({id:profile.id,build:profile.build})),quality:verification?.run.quality||detail?.contract?.quality||this.app.store.get<FactoryTask>('tasks',authority.taskId)?.quality});}
    if(name==='factory_job_status'){
      let job=this.ownJob(token,args.jobId);const seconds=Math.max(0,Math.min(30,Number(args.waitSeconds)||0));
      if(this.active.has(job.id)&&seconds){await Promise.race([this.active.get(job.id),new Promise(resolve=>setTimeout(resolve,seconds*1000))]);job=this.ownJob(token,args.jobId);}
      const backend=job.sessionId?this.app.store.get<BackendRecord>('inspection-backends',job.sessionId):undefined;
      return result({job,sessions:this.jobs.sessions(job.id),evidence:this.jobs.evidence(job.id),...(backend?.kind==='browser'&&job.sessionId&&this.jobs.getSession(job.sessionId)?.status==='ready'?{tools:await this.browser.listTools(backend.backendSessionId)}:{})});
    }
    if(name==='factory_native_build'||name==='factory_browser_start'){
      const requestKey=createHash('sha256').update(JSON.stringify([authority,name,args.requestId])).digest('hex'),requestHash=createHash('sha256').update(JSON.stringify([name,args.profileId??null])).digest('hex');
      const prior=this.app.store.get<{id:string;jobId:string;requestHash:string}>('inspection-request-jobs',requestKey);
      if(prior){if(prior.requestHash!==requestHash)throw new Error('Inspection request id was reused for different arguments.');return result({job:this.ownJob(token,prior.jobId),replayed:false});}
      const isBuild=name==='factory_native_build';
      const project=this.app.store.get<Project>('projects',context.session.projectId),profile=isBuild?this.profiles(project?.sourceProjectId||project?.id||'').find(profile=>profile.id===args.profileId):undefined;
      if(isBuild&&!profile)throw new Error('Configure a verified native build/fixture profile on the project first.');
      if(!isBuild&&context.execution.kind!=='container')throw new Error('Browser inspection currently requires a container author. Native authors use the Mac/iPhone inspection tools.');
      const source=await this.capture(context,authority);
      const job=this.jobs.createJob(token,{idempotencyKey:String(args.requestId),executionTargetId:isBuild?'mac-host':'container',capability:isBuild?'apple-compilation':'chromium-inspection',source:source.source,profile:isBuild?{profileId:profile!.id}:{}});
      this.app.store.set('inspection-submissions',{id:job.id,kind:isBuild?'build':'browser',chatSessionId:context.session.id,containerId:context.execution.containerId,profile,snapshot:source.snapshot} satisfies Submission);
      this.app.store.set('inspection-request-jobs',{id:requestKey,jobId:job.id,requestHash});
      this.pump();return result({job});
    }
    if(name==='factory_native_start'){
      const buildJob=this.ownJob(token,args.buildJobId),build=this.app.store.get<BuildRecord>('inspection-build-results',buildJob.id);
      if(buildJob.status!=='succeeded'||!build)throw new Error('The native build must finish successfully before launch.');
      if(build.retiredAt&&build.preparationArtifact)await this.native.restorePreparedProduct(build.buildId,build.preparationArtifact);
      const product=await this.native.product(build.buildId),capability:ExecutionCapability=product.platform==='macos'?'macos-app-inspection':'ios-simulator-inspection';
      const job=this.jobs.createJob(token,{idempotencyKey:String(args.requestId),executionTargetId:'mac-host',capability,source:buildJob.source,profile:{buildId:build.buildId}});
      this.app.store.set('inspection-submissions',{id:job.id,kind:'native',chatSessionId:context.session.id,buildId:build.buildId} satisfies Submission);this.pump();return result({job});
    }
    const session=this.ownSession(token,args.sessionId),backend=this.app.store.get<BackendRecord>('inspection-backends',session.id);
    if(!backend)throw new Error('The inspection backend needs reconciliation; its effects will not be replayed.');
    if(name==='factory_browser_call'&&backend.kind!=='browser')throw new Error('Browser tools require a browser session.');
    if(['factory_native_action','factory_native_restart'].includes(name)&&backend.kind!=='native')throw new Error('Native actions require a native session.');
    if(name==='factory_stop'){await this.stopSession(session.id);return result({stopped:true});}
    if(name==='factory_assert'){
      if(session.latestObservationId!==args.observationId)throw new Error('Re-observe before asserting current UI state.');
      const observation=this.jobs.observation(String(args.observationId)),needle=String(args.labelIncludes||'');if(!needle.trim())throw new Error('An assertion needs a concrete observed label.');
      const structured=this.app.store.get<{id:string;elements:Array<{label?:string;identifier?:string;value?:string}>;truncated:boolean}>('inspection-structured-observations',String(args.observationId));
      if(!structured)throw new Error('This observation has no complete structured assertions. Use a native observation or a browser assertion tool.');
      if(args.absent===true&&structured.truncated)throw new Error('A truncated observation cannot prove an element is absent.');
      const matches=structured.elements.filter(element=>(element.label||element.identifier||'').includes(needle));
      const passed=args.absent===true?matches.length===0:matches.some(element=>typeof args.valueIncludes!=='string'||(element.value||'').includes(args.valueIncludes));
      const artifact=await this.artifacts.put(JSON.stringify({passed,observationId:args.observationId,condition:args,observedAt:observation?.createdAt}),{goalId:authority.goalId,taskId:authority.taskId,attemptId:authority.attemptId,name:'workflow-assertion.json',mime:'application/json'});
      const evidence=this.jobs.publishEvidence(session.jobId,{kind:'assertion',sessionId:session.id,artifact,metadata:{passed,observationId:args.observationId,platform:backend.kind==='browser'?'web':session.capability==='macos-app-inspection'?'macos':'ios-simulator'}});this.app.store.set('factory-artifacts',artifact);return result({passed,evidenceId:evidence.id});
    }
    const browserTool=String(args.tool||''),kind=name==='factory_native_restart'?'restart':name==='factory_observe'?'observe':name==='factory_native_action'?String((args.action as Record<string,unknown>)?.kind):browserTool==='browser_navigate'?'navigate':browserTool==='browser_take_screenshot'?'screenshot':['browser_snapshot','browser_console_messages','browser_network_requests'].includes(browserTool)?'observe':browserTool.includes('type')||browserTool.includes('fill')?'type':browserTool.includes('press_key')?'key':browserTool.includes('scroll')?'scroll':'click';
    const actionArgs=name==='factory_native_action'?args.action as Record<string,unknown>:args.arguments as Record<string,unknown>||{};
    if(backend.kind==='browser')await this.assertBrowserSource(context,session.jobId);
    const target=actionArgs.target??actionArgs.ref;
    const begun=this.jobs.beginAction(token,session.id,{idempotencyKey:String(args.requestId),kind:kind as import('@enoughfactory/contracts').InspectionActionKind,arguments:{...actionArgs,...(target?{elementId:target}:{})},observationId:typeof args.observationId==='string'?args.observationId:undefined});
    if(!begun.execute)return result({action:begun.action,replayed:false});
    this.jobs.markActionRunning(begun.action.id);
    try{
      if(backend.kind==='native'){
        if(name==='factory_native_restart'){
          const observation=this.app.store.get<{id:string;backendObservationId:string}>('inspection-observation-backends',String(args.observationId));if(!observation)throw new Error('The native observation is unavailable.');
          const outcome=await this.native.restart(backend.backendSessionId,observation.backendObservationId);
          this.jobs.confirmSessionRestarted(session.id,{previousProcessExited:outcome.previousProcessExited,...(outcome.pid?{processIdentity:{pid:outcome.pid,startedAt:new Date().toISOString()}}:{})});
          this.jobs.actionComplete(begun.action.id,{status:'succeeded'});return result({actionId:begun.action.id,...outcome});
        }
        if(name==='factory_observe'){
          const observation=await this.native.observe(backend.backendSessionId),bytes=await readFile(observation.screenshot.path);
          const artifact=await this.artifacts.put(bytes,{goalId:authority.goalId,taskId:authority.taskId,attemptId:authority.attemptId,name:'native-observation.png',mime:'image/png'});
          const evidence=this.jobs.publishEvidence(session.jobId,{kind:'screenshot',sessionId:session.id,actionId:begun.action.id,artifact,metadata:{platform:session.capability==='macos-app-inspection'?'macos':'ios-simulator',backendObservationId:observation.observationId}});
          const recorded=this.jobs.recordObservation(begun.action.id,{elementIds:observation.elements.map(element=>element.id),uiTree:JSON.stringify(observation.elements).slice(0,100000),screenshotEvidenceId:evidence.id,viewport:{width:observation.screenshot.width,height:observation.screenshot.height,scale:1}});
          this.app.store.set('inspection-structured-observations',{id:recorded.id,elements:observation.elements,truncated:observation.truncated});
          this.app.store.set('inspection-observation-backends',{id:recorded.id,backendObservationId:observation.observationId});this.app.store.set('factory-artifacts',artifact);
          this.jobs.actionComplete(begun.action.id,{status:'succeeded',evidenceIds:[evidence.id]});
          return {content:[text({sessionId:session.id,observationId:recorded.id,screenshotEvidenceId:evidence.id,elements:observation.elements,truncated:observation.truncated}),{type:'image',mimeType:'image/png',data:bytes.toString('base64')}]};
        }
        const observation=this.app.store.get<{id:string;backendObservationId:string}>('inspection-observation-backends',String(args.observationId));if(!observation)throw new Error('The native observation is unavailable.');
        const outcome=await this.native.act(backend.backendSessionId,{...actionArgs,observationId:observation.backendObservationId} as NativeAction);this.jobs.actionComplete(begun.action.id,{status:'succeeded'});return result({actionId:begun.action.id,...outcome});
      }
      if(!['factory_browser_call','factory_observe'].includes(name))throw new Error('Use the advertised browser tools to inspect this browser session.');
      const supported=await this.browser.listTools(backend.backendSessionId);if(name!=='factory_observe'&&!supported.some(tool=>tool.name===browserTool))throw new Error('This browser tool is not advertised.');
      const browserOptions={signal:context.signal,source:{snapshotSha256:session.source.sha256,dirty:true},assertCurrent:()=>{this.jobs.authorize(token);}};
      let observed=await this.browser.call(backend.backendSessionId,name==='factory_observe'?'browser_snapshot':browserTool,actionArgs,browserOptions);
      if(name==='factory_observe'||browserTool==='browser_take_screenshot'){
        const companion=await this.browser.call(backend.backendSessionId,name==='factory_observe'?'browser_take_screenshot':'browser_snapshot',name==='factory_observe'?{type:'png'}:{},browserOptions);
        observed={...observed,result:{content:[...observed.result.content,...companion.result.content],isError:observed.result.isError||companion.result.isError},artifacts:[...observed.artifacts,...companion.artifacts]};
      }
      await this.assertBrowserSource(context,session.jobId);
      for(const artifact of observed.artifacts)this.app.store.set('factory-artifacts',artifact);
      const screenshots=observed.artifacts.filter(artifact=>artifact.mime.startsWith('image/'));
      const parsed=parseBrowserObservation(observed.result.content.filter(block=>block.type==='text').map(block=>block.text||'').join('\n'));
      const tree=parsed.uiTree;
      const evidence=screenshots.map(artifact=>this.jobs.publishEvidence(session.jobId,{kind:'screenshot',sessionId:session.id,actionId:begun.action.id,artifact,metadata:{platform:'web'}}));
      let observationId:string|undefined;
      if((kind==='observe'||kind==='screenshot')&&!observed.result.isError){
        observationId=this.jobs.recordObservation(begun.action.id,{uiTree:tree,elementIds:parsed.elementIds,screenshotEvidenceId:evidence[0]?.id}).id;
        this.app.store.set('inspection-structured-observations',{id:observationId,elements:parsed.elements,truncated:parsed.truncated});
      }
      this.jobs.actionComplete(begun.action.id,{status:observed.result.isError?'failed':'succeeded',evidenceIds:evidence.map(item=>item.id)});
      return {...observed.result,content:[text({sessionId:session.id,actionId:begun.action.id,observationId,evidenceIds:evidence.map(item=>item.id)}),...observed.result.content]};
    }catch(error){
      const uncertain=(error as {outcomeUnknown?:boolean}).outcomeUnknown===true||['action-unknown','helper-disconnected','termination-unknown','restart-unknown','process-changed','simulator-unknown'].includes((error as {code?:string}).code||'')||/timeout|timed out|transport|disconnected|unresponsive|closed/i.test((error as Error).message);
      if(uncertain)this.jobs.markActionUnknown(begun.action.id,(error as Error).message);
      else this.jobs.actionComplete(begun.action.id,{status:'failed',reason:(error as Error).message});
      throw error;
    }
  }
  private async assertBrowserSource(context:AgentToolBridgeContext,jobId:string):Promise<void>{
    const job=this.jobs.getJob(jobId);if(!job)throw new Error('Browser inspection job is unavailable.');
    const current=await this.captureActual(context,job.authority,false);
    try{if(current.source.sha256!==job.source.sha256)throw new Error('Source changed since this browser session started. Stop it and start a new inspection of the repaired source.');}
    finally{await this.snapshots.remove(current.snapshot);}
  }
  private pump():void{
    if(this.closing)return;let job:InspectionJob|undefined;
    while((job=this.jobs.claimNext(undefined,job=>!this.app.store.get('inspection-delegation-owner-jobs',job.id)))){
      const selected=job;
      const operation=this.app.withServiceOperation(async signal=>{
        const submission=this.app.store.get<Submission>('inspection-submissions',selected.id);if(!submission)throw new Error('The inspection request has no retained preparation.');
        this.jobs.markRunning(selected.id);
        if(submission.kind==='build'){
          const build=(snapshot:InspectionSnapshot)=>this.builds.build(snapshot,submission.profile!,{authority:selected.authority,jobId:selected.id,signal});
          const built=this.app.store.get('inspection-source-retention',selected.source.snapshotId)?await this.retention.use(selected.source.snapshotId,build,signal):await build(submission.snapshot!);
          this.retainBuild(selected,built);if(built.status==='canceled')this.jobs.confirmCanceled(selected.id,built.error||'Native compilation was canceled after confirmed teardown.');else this.jobs.finishJob(selected.id,{status:built.status==='passed'?'succeeded':'failed',reason:built.status==='passed'?undefined:built.error||'Native compilation failed. Inspect its original report before repairing.'});return;
        }
        if(submission.kind==='native'){
          const ready=await this.native.readiness(selected.capability==='macos-app-inspection'?'macos':'ios-simulator');
          if(ready.status!=='ready')throw new Error(`Native inspection is waiting for setup: ${ready.reasons.join(' ')}`);
          const session=this.jobs.openSession(selected.id);
          this.app.store.set('inspection-backends',{id:session.id,kind:'native',backendSessionId:session.id} satisfies BackendRecord);
          const owned=await this.native.start(submission.buildId!,selected.authority.attemptId,session.id);
          this.jobs.markSessionReady(session.id,{...(owned.pid?{processIdentity:{pid:owned.pid,startedAt:owned.startedAt}}:{}),simulatorId:owned.simulatorId});return;
        }
        const session=this.jobs.openSession(selected.id);
        this.app.store.set('inspection-backends',{id:session.id,kind:'browser',backendSessionId:session.id} satisfies BackendRecord);
        const owned=await this.browser.prepare({id:session.id,sessionId:submission.chatSessionId,goalId:selected.authority.goalId,taskId:selected.authority.taskId,attemptId:selected.authority.attemptId,authorContainerId:submission.containerId!,authorityGeneration:selected.authority.authorityGeneration,source:{snapshotSha256:selected.source.sha256,dirty:true}},{signal,assertCurrent:()=>{if(!this.authorityCurrent(selected.authority))throw new Error('The author assignment changed.');}});
        this.jobs.markSessionReady(session.id);
      }).catch(error=>{
        const sessions=this.jobs.sessions(selected.id).filter(session=>session.status!=='stopped');
        const failure=error as {code?:string;allocationOutcome?:string;sessionId?:string},kind=this.app.store.get<Submission>('inspection-submissions',selected.id)?.kind;
        const unallocated=failure.code==='BROWSER_NOT_ALLOCATED'&&kind==='browser'||failure.code==='session-not-allocated'&&failure.allocationOutcome==='not-allocated'&&kind==='native'&&sessions.length===1&&failure.sessionId===sessions[0]!.id;
        if(unallocated){
          for(const session of sessions)this.jobs.confirmSessionStopped(session.id,'Preparation failed before this owned backend was allocated.');
          this.jobs.reconcileJob(selected.id,{status:'failed',reason:(error as Error).message,releaseConfirmed:true});
        }
        else if((error as {outcomeUnknown?:boolean}).outcomeUnknown===true||sessions.length)this.jobs.markUnknown(selected.id,`Reconcile the owned backend before retrying: ${(error as Error).message}`);
        else {try{this.jobs.finishJob(selected.id,{status:'failed',reason:(error as Error).message});}catch{this.jobs.markUnknown(selected.id,(error as Error).message);}}
      }).finally(()=>{this.active.delete(selected.id);this.app.emit('inspection-job',this.jobs.getJob(selected.id));this.app.changed();this.pump();});
      this.active.set(selected.id,operation);
    }
  }
  private retainBuild(job:InspectionJob,built:NativeInspectionBuild,publish=true):void{
    const originals=[built.reportArtifact,built.snapshotArtifact,built.preparationArtifact,built.fixtureReceiptArtifact,...built.evidenceArtifacts,...built.productArtifacts,built.candidate.bundleArtifact,built.candidate.diffArtifact,...(built.candidate.workingDirectories||[]).flatMap(root=>[root.bundleArtifact,root.diffArtifact])];
    const retained=new Set(this.jobs.evidence(job.id).map(item=>item.artifact.id));
    for(const artifact of [...new Map(originals.map(artifact=>[artifact.id,artifact])).values()]){this.app.store.set('factory-artifacts',artifact);if(publish&&!retained.has(artifact.id))this.jobs.publishEvidence(job.id,{kind:built.productArtifacts.some(product=>product.id===artifact.id)?'build-product':'log',artifact,metadata:{status:built.status}});}
    this.app.store.set('inspection-build-results',{id:job.id,buildId:built.id,preparationArtifact:built.preparationArtifact,source:job.source,finishedAt:new Date().toISOString()} satisfies BuildRecord);
  }
  private async recoverOwnedBuilds():Promise<void>{
    for(const job of this.jobs.listJobs().filter(job=>job.ownerDeviceId===this.app.device.id&&job.capability==='apple-compilation'&&job.status==='unknown'&&!this.active.has(job.id)&&!this.app.store.get('inspection-delegation-owner-jobs',job.id))){
      if(this.closing)return;const outcome=await this.builds.cancel(job.id);
      if(outcome.status!=='completed'){this.jobs.markUnknown(job.id,outcome.reason);continue;}
      if(outcome.build)this.retainBuild(job,outcome.build,false);
      try{
        this.jobs.reconcileJob(job.id,{status:'running',reason:'The original native build worker retained a verified completion and confirmed compiler teardown.'});
        if(outcome.build)this.retainBuild(job,outcome.build);
        if(outcome.canceled)this.jobs.confirmCanceled(job.id,outcome.error||outcome.build?.error);else this.jobs.finishJob(job.id,{status:outcome.build?.status==='passed'?'succeeded':'failed',reason:outcome.error||outcome.build?.error});
      }catch(error){this.jobs.reconcileJob(job.id,{status:outcome.canceled?'canceled':'failed',reason:`The original build ended, but this author is no longer current: ${(error as Error).message}`,releaseConfirmed:true});}
    }
    this.app.changed();
  }
  private async retireColdProducts():Promise<void>{
    const jobs=this.jobs.listJobs();for(const build of this.app.store.list<BuildRecord>('inspection-build-results')){
      if(this.closing)return;if(build.retiredAt||!build.preparationArtifact||!build.finishedAt||Date.now()-Date.parse(build.finishedAt)<300000)continue;
      const owner=jobs.find(job=>job.id===build.id);if(!owner||this.contexts.size&&[...this.contexts.values()].some(context=>context.attemptId===owner.authority.attemptId))continue;
      if(jobs.filter(job=>job.source.snapshotId===owner.source.snapshotId).some(job=>this.active.has(job.id)||!['succeeded','failed','canceled'].includes(job.status)||this.jobs.sessions(job.id).some(session=>session.status!=='stopped')||this.jobs.leases(job.id).some(lease=>lease.status==='held')))continue;
      try{await this.native.retirePreparedProduct(build.buildId,{releaseConfirmed:true});this.app.store.set('inspection-build-results',{...build,retiredAt:new Date().toISOString()});}catch(error){this.app.emit('inspection-retention',{buildId:build.buildId,reason:(error as Error).message});}
    }
  }
  private canRetireVerifier(run:InspectionVerificationRun):boolean{
    if(this.closing||[...this.contexts.values()].some(context=>context.verificationRunId===run.id))return false;
    const related=this.jobs.listJobs().filter(job=>job.authority.attemptId===run.authority.attemptId||job.source.snapshotId===run.source.snapshotId);
    return related.every(job=>!this.active.has(job.id)&&['succeeded','failed','canceled'].includes(job.status)&&this.jobs.sessions(job.id).every(session=>session.status==='stopped')&&this.jobs.leases(job.id).every(lease=>lease.status!=='held'));
  }
  private async stopSession(id:string):Promise<void>{
    const session=this.jobs.getSession(id);if(!session)return;
    const backend=this.app.store.get<BackendRecord>('inspection-backends',id);if(!backend)throw new Error('Unknown session ownership needs reconciliation before release.');
    if(backend.kind==='native')await this.native.stop(backend.backendSessionId);else {
      try{const outcome=await this.browser.retire(backend.backendSessionId);if(outcome.state!=='retired')throw new Error(outcome.reason||'Browser removal is unconfirmed.');}
      catch(error){if((error as {code?:string}).code!=='BROWSER_NOT_ALLOCATED')throw error;}
    }
    this.jobs.confirmSessionStopped(id);
    try{this.jobs.finishJob(session.jobId,{status:'succeeded'});}catch{this.jobs.reconcileJob(session.jobId,{status:'failed',reason:'Owned session stopped after authority changed or its outcome became uncertain.',releaseConfirmed:true});}
    this.app.changed();this.pump();
  }
  private async recoverOwnedSessions():Promise<void>{
    for(const job of this.jobs.listJobs().filter(job=>job.ownerDeviceId===this.app.device.id&&!this.app.store.get('inspection-delegation-owner-jobs',job.id))){
      for(const session of this.jobs.sessions(job.id).filter(session=>session.status!=='stopped')){
        if(this.closing)return;const backend=this.app.store.get<BackendRecord>('inspection-backends',session.id);if(!backend)continue;
        try{
          if(backend.kind==='native'){const outcome=await this.native.recoverStop(backend.backendSessionId);if(outcome.status!=='stopped')throw new Error(outcome.reason||'Native shutdown remains unconfirmed.');}
          else {const outcome=await this.browser.retire(backend.backendSessionId);if(outcome.state!=='retired')throw new Error(outcome.reason||'Browser shutdown remains unconfirmed.');}
          this.jobs.confirmSessionStopped(session.id,'Owned backend shutdown was confirmed after service restart. Historical action outcomes remain unknown.');
          this.jobs.reconcileJob(job.id,{status:'failed',reason:'Inspection was interrupted by service restart; its owned backend is stopped. Start a new explicit inspection to continue.',releaseConfirmed:true});
        }catch(error){this.jobs.markUnknown(job.id,`Owned backend reconciliation is incomplete: ${(error as Error).message}`);}
      }
    }
    this.app.changed();
  }
  private async stopAuthoritySessions(token:string,authority:InspectionAuthority):Promise<void>{
    await this.delegation?.stopAuthoritySessions(authority);
    for(const job of this.jobs.listJobs(authority).filter(job=>job.ownerDeviceId===this.app.device.id))for(const session of this.jobs.sessions(job.id).filter(session=>session.status==='ready')){
      try{await this.stopSession(session.id);}catch(error){this.app.emit('inspection-error',{jobId:job.id,error:(error as Error).message});}
    }
  }
  private async retireIdleBrowsers():Promise<void>{
    const retired=await this.browser.retireIdle();for(const lease of retired){const backend=this.app.store.list<BackendRecord>('inspection-backends').find(record=>record.kind==='browser'&&record.backendSessionId===lease.id);if(!backend)continue;const session=this.jobs.getSession(backend.id);if(!session)continue;this.jobs.confirmSessionStopped(session.id,'The idle browser was retired; start an explicit new inspection to continue.');this.jobs.reconcileJob(session.jobId,{status:'failed',reason:'The idle browser was retired after confirmed removal.',releaseConfirmed:true});}if(retired.length){this.app.changed();this.pump();}
  }
  async close():Promise<void>{
    this.closing=true;if(this.timer)clearInterval(this.timer);for(const bridge of this.bridges)await bridge.close();this.bridges.clear();
    for(const job of this.jobs.listJobs().filter(job=>job.ownerDeviceId===this.app.device.id&&['preparing','running','waiting','cancellation-requested'].includes(job.status)))this.jobs.markUnknown(job.id,'Device service closed; reconcile owned effects before replacement.');
    await this.verifier.close();await this.delegation?.close();await this.builds.close();await this.native.closeTransport();
  }
}


export async function initializeInspection(app:DeviceApp,chats:ChatController,network?:{peers:PeerManager}):Promise<InspectionService>{const service=new InspectionService(app,chats,network);await service.initialize();return service;}
