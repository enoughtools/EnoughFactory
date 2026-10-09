import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import type { Attempt, ControllerRun, ExecutionCapability, ExecutionTargetAdvertisement, FactoryTask, Goal, InspectionAuthority, InspectionJob, InspectionSourceIdentity, InspectionVerificationRun, Project, TaskQualityRequirements } from '@enoughfactory/contracts';
import { readJsonObject, type AttemptDetail } from '@enoughfactory/factory';
import { ArtifactStore, InspectionSnapshotManager, WorkspaceManager, exportInspectionContainerRoots, exportInspectionSnapshot, type ArtifactManifest, type InspectionSnapshot, type WorkingDirectorySource } from '@enoughfactory/workspaces';
import { dockerInvocation } from '@enoughfactory/runtime';
import { RUNTIME_PINS } from '@enoughfactory/agents';
import { BROWSER_VIEWPORT_MAX_DIMENSION, BrowserInspectionManager, validateBrowserViewport, type BrowserToolResult, type BrowserViewport } from '@enoughfactory/browser-inspection';
import { NativeInspectionBackend, type NativeAction, type NativeReadiness } from '@enoughfactory/native-inspection';
import type { DeviceApp } from './app.ts';
import type { FactoryInspectionPorts } from './factory.ts';
import type { AgentToolBridge, AgentToolBridgeContext, ChatController } from './chats.ts';
import { InspectionJobs } from './inspection-jobs.ts';
import { InspectionDelegation } from './inspection-delegation.ts';
import type { PeerManager } from '@enoughfactory/peers';
import { parseBrowserObservation } from './inspection-browser-observation.ts';
import { InspectionVerificationHistory } from './inspection-verification-history.ts';
import { beginBrowserFormObservation, completeBrowserFormObservation } from './inspection-browser-values.ts';
import { createContainerInspectionBridge, createHostInspectionBridge, inspectionMcpHandler, type InspectionMcpBridge } from './inspection-mcp.ts';
import { NativeInspectionAdapter, type NativeFixtureProfile, type NativeInspectionBuild } from './inspection-native.ts';
import { NativeBuildRunner } from './inspection-build-runner.ts';
import { InspectionQualityService, inspectionSourceContentMatches } from './inspection-quality.ts';
import { InspectionVerifier, inspectionAcceptanceContractSha256, inspectionQualityPolicySha256, inspectionVerificationKey } from './inspection-verifier.ts';
import { verificationContractChunk, verificationContractFullyRead, type VerificationContractRead } from './inspection-verification-contract.ts';
import { evaluateObservedCondition } from './inspection-condition.ts';
import { NativeProfileSetup } from './inspection-profile-setup.ts';
import { NativeProfileSync } from './inspection-profile-sync.ts';
import { HostDiskAdmission } from './host-disk-admission.ts';
import { InspectionRetention } from './inspection-retention.ts';
import { inspectionGoalQuality } from './inspection-goal-quality.ts';
import { INSPECTION_SOURCE_MAX_BYTES } from './inspection-source-policy.ts';
import { HttpError } from './util.ts';

const execute=promisify(execFile);
const text=(value:unknown)=>({type:'text',text:JSON.stringify(value)});
const result=(value:unknown)=>({content:[text(value)]});
const objectSchema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'};
const nativeProfileSchema=objectSchema({
  id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,64}$',description:'Stable profile identity. The platform belongs inside build, not on the profile.'},
  build:objectSchema({tool:{type:'string',enum:['xcodebuild']},project:{type:'string',description:'Relative .xcodeproj or .xcworkspace path in the primary captured source.'},scheme:string,platform:{type:'string',enum:['macos','ios-simulator']},configuration:{type:'string',enum:['Debug','Release'],description:'Defaults to Debug.'}},['tool','project','scheme','platform']),
  launchArguments:{type:'array',minItems:1,maxItems:32,items:{type:'string'},description:'Exact fixture invocation. Must request fixture mode and include a unique {runId} namespace; the source audit checks early routing and rejects production fallback for malformed fixture invocations.'},
  fixtureExpectedDataRoot:{type:'string',description:'For macos, fresh /tmp/enoughfactory-fixtures/{runId} (or /private/tmp equivalent), optionally followed by safe namespace segments. Omit for ios-simulator: its fresh owned app sandbox is audited instead.'},
  bundleIdentifier:{type:'string',description:'Optional exact product bundle identifier.'},
},['id','build','launchArguments']);
const tools=[
  {name:'factory_capabilities',description:'Get actual execution and inspection readiness and configured native profiles.',inputSchema:objectSchema({})},
  {name:'factory_verification_contract',description:'Read the complete original frozen acceptance contract for this independent verifier in bounded ranges. Continue at nextOffset until totalCharacters; requirements are never summarized or silently omitted.',inputSchema:objectSchema({offset:{type:'integer',minimum:0},maxCharacters:{type:'integer',minimum:1,maximum:16000}},['offset','maxCharacters'])},
  {name:'factory_native_profile_propose',description:'Set up testing for a new native app. Propose a fixed build and isolated fixture using the exact profile schema (platform is build.platform); Factory independently audits actual immutable source before issuing its profile receipt. No manual receipt or host SDK is needed for the source review. Poll factory_native_profile_status. Any source edit requires a fresh audit.',inputSchema:objectSchema({requestId:string,profile:nativeProfileSchema,auditPaths:{type:'array',minItems:1,maxItems:128,items:objectSchema({rootId:{type:'string',description:'Declared source root ID from factory_capabilities; primary for the app source.'},path:{type:'string',description:'Relative original source file path in that root.'},purposes:{type:'array',minItems:1,items:{type:'string',enum:['entry','storage','credentials','providers','preferences','notifications','build']}}},['rootId','path','purposes'])}},['requestId','profile','auditPaths'])},
  {name:'factory_native_profile_status',description:'Read your independent native setup audit and concrete findings. Waiting preserves your source and author; unknown ownership is reconciled before the same review continues.',inputSchema:objectSchema({auditId:string,waitSeconds:{type:'integer',minimum:0,maximum:30}},['auditId'])},
  {name:'factory_native_build',description:'Capture your dirty/untracked source and build an exact private native product using a configured profile. Returns a durable job; poll it before launching.',inputSchema:objectSchema({profileId:string,requestId:string},['profileId','requestId'])},
  {name:'factory_job_status',description:'Read your durable build/session job. Waiting does not create another author attempt.',inputSchema:objectSchema({jobId:string,waitSeconds:{type:'integer',minimum:0,maximum:30}},['jobId'])},
  {name:'factory_native_start',description:'Launch your verified build with the configured isolated fixture. A shared Mac or Simulator lease queues fairly.',inputSchema:objectSchema({buildJobId:string,requestId:string},['buildJobId','requestId'])},
  {name:'factory_observe',description:'Inspect your owned app. Returns actual screenshot pixels and fresh actionable element IDs. Observe after each action.',inputSchema:objectSchema({sessionId:string,requestId:string},['sessionId','requestId'])},
  {name:'factory_native_action',description:'Interact using a fresh observation. Click/type require elementId from the last observation. Type also needs text: set mode explicitly to replace or append. Keys are enter, backspace, escape, tab, selectAll. Scroll needs elementId and direction. Re-observe after each action.',inputSchema:objectSchema({sessionId:string,requestId:string,observationId:string,action:objectSchema({kind:{type:'string',enum:['click','type','key','scroll']},elementId:string,text:string,mode:{type:'string',enum:['replace','append']},key:{type:'string',enum:['enter','backspace','escape','tab','selectAll']},direction:{type:'string',enum:['up','down','left','right']}},['kind'])},['sessionId','requestId','observationId','action'])},
  {name:'factory_native_restart',description:'Restart the exact owned app in the same fixture and simulator, preserving its data. Requires a fresh observation and confirmed previous process exit.',inputSchema:objectSchema({sessionId:string,requestId:string,observationId:string},['sessionId','requestId','observationId'])},
  {name:'factory_browser_start',description:'Prepare an isolated Chromium browser sharing your author container localhost. Set viewport width and height here when the contract requires dimensions before the first navigation or observation; omitted viewport keeps the browser default. Includes its supported tools.',inputSchema:objectSchema({requestId:string,viewport:objectSchema({width:{type:'integer',minimum:1,maximum:BROWSER_VIEWPORT_MAX_DIMENSION},height:{type:'integer',minimum:1,maximum:BROWSER_VIEWPORT_MAX_DIMENSION}},['width','height'])},['requestId'])},
  {name:'factory_browser_call',description:'Operate your own browser using its advertised Playwright tools. Inspect screenshot images and resulting state; fresh observation required for input.',inputSchema:objectSchema({sessionId:string,requestId:string,observationId:string,tool:string,arguments:{type:'object'}},['sessionId','requestId','tool','arguments'])},
  {name:'factory_assert',description:'Check a condition against the last actual UI observation. Use labelEquals for exact visible read-only text and valueEquals for exact observed editable values. Records the observed result; does not accept a model-written pass claim.',inputSchema:objectSchema({sessionId:string,observationId:string,labelIncludes:string,labelEquals:string,valueIncludes:string,valueEquals:string,absent:{type:'boolean'}},['sessionId','observationId','labelIncludes'])},
  {name:'factory_stop',description:'Stop your owned native/browser session and release its lease after backend acknowledgement.',inputSchema:objectSchema({sessionId:string},['sessionId'])},
  {name:'factory_reference',description:'Inspect a supplied reference source or image in a declared workspace root. Returns original content and records its inspected identity.',inputSchema:objectSchema({referenceId:string,rootId:string,relativePath:string,sourceSnapshotId:string},['referenceId','rootId','relativePath','sourceSnapshotId'])},
  {name:'factory_quality_submit',description:'Submit workflow assertions and visual review against your configured quality contract. Verified screenshots and image delivery are checked independently.',inputSchema:objectSchema({report:{type:'object'}},['report'])},
];
interface SourceRecord {id:string;snapshot:InspectionSnapshot;source:InspectionSourceIdentity;verificationRunId?:string;}
interface BackendRecord {id:string;kind:'native'|'browser';backendSessionId:string;}
interface BuildRecord {id:string;buildId:string;preparationArtifact?:ArtifactManifest;source?:InspectionSourceIdentity;finishedAt?:string;retiredAt?:string;}
interface Submission {id:string;kind:'build'|'native'|'browser';chatSessionId:string;containerId?:string;profile?:NativeFixtureProfile;buildId?:string;snapshot?:InspectionSnapshot;viewport?:BrowserViewport;}
interface GrantToken {id:string;token:string;grantId:string;authority:InspectionAuthority;}
interface HostSetupRecord {id:'mac-shell';status:'preparing'|'failed'|'ready';attempts:number;attemptedAt:string;updatedAt:string;retryAfter:number;error?:string;runtimeKey?:string;}
const hostSetupBucket='inspection-host-setup',hostSetupRetryMs=60000,hostSetupAutomaticAttempts=3;
const hostSetupRuntimeKey=`darwin-${process.arch}-node-${RUNTIME_PINS.node}-codex-${RUNTIME_PINS.codex}`;
// Service-owned preparation only. File descriptors keep chmod from following a
// replaced symlink; every selected entry still has to match canonical bytes.
const controllerModesScript=`const fs=require('node:fs/promises'),C=require('node:fs').constants,p=require('node:path'),crypto=require('node:crypto');
(async()=>{const changes=JSON.parse(process.argv[1]);for(const {root,entry} of changes){
if(!p.isAbsolute(root)||await fs.realpath(root)!==root||!entry.path||entry.path.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('Unsafe controller source path.');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino,parts=entry.path.split('/'),parents=[];for(let i=0;i<parts.length;i++){const location=p.join(root,...parts.slice(0,i)),state=await fs.lstat(location);if(!state.isDirectory()||state.isSymbolicLink())throw Error('Changed controller source parent.');parents.push({location,state});}
const target=p.join(root,...parts),state=await fs.lstat(target),revalidate=async()=>{if(await fs.realpath(root)!==root)throw Error('Changed controller source root.');for(const parent of parents){const actual=await fs.lstat(parent.location);if(!actual.isDirectory()||actual.isSymbolicLink()||!same(actual,parent.state))throw Error('Changed controller source parent.');}if(!same(await fs.lstat(target),state))throw Error('Changed controller source inode.');};
if(entry.kind==='symlink'){if(!state.isSymbolicLink()||await fs.readlink(target)!==entry.target||typeof fs.lchmod!=='function')throw Error('Changed or unsupported controller source link.');await revalidate();await fs.lchmod(target,entry.mode);continue;}
const handle=await fs.open(target,C.O_RDONLY|C.O_NOFOLLOW|(entry.kind==='directory'?C.O_DIRECTORY:0));try{const actual=await handle.stat();if(!same(actual,state))throw Error('Changed controller source inode.');if(entry.kind==='directory'?!actual.isDirectory():!actual.isFile()||actual.size!==entry.size||crypto.createHash('sha256').update(await handle.readFile()).digest('hex')!==entry.sha256)throw Error('Controller source bytes changed during preparation.');await revalidate();await handle.chmod(entry.mode);}finally{await handle.close();}
}})().catch(e=>{process.stderr.write(e.message);process.exitCode=1;});`;

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
  readonly profileSetup:NativeProfileSetup;
  readonly profileSync?:NativeProfileSync;
  private readonly active=new Map<string,Promise<void>>();
  private readonly bridges=new Set<InspectionMcpBridge>();
  private readonly contexts=new Map<string,AgentToolBridgeContext>();
  private refreshing?:Promise<ExecutionTargetAdvertisement[]>;
  private closing=false;
  private maintaining?:Promise<void>;
  private timer?:ReturnType<typeof setInterval>;
  private hostPreparation?:Promise<void>;
  private hostPreparationAbort?:AbortController;
  private hostPreparationGeneration=0;
  private hostPreparationRequest?:'automatic'|'requested';
  private macPermissionRequest?:Promise<{readiness:NativeReadiness;executionTargets:ExecutionTargetAdvertisement[]}>;
  constructor(readonly app:DeviceApp,readonly chats:ChatController,network?:{peers:PeerManager}){
    this.artifacts=new ArtifactStore(path.join(app.dataDir,'workspace-data','artifacts'),app.device.id);
    this.jobs=new InspectionJobs(app.store,{deviceId:app.device.id,authorityCurrent:authority=>this.authorityCurrent(authority)});
    this.snapshots=new InspectionSnapshotManager({dataDir:path.join(app.dataDir,'inspection'),artifacts:this.artifacts});
    this.quality=new InspectionQualityService({store:app.store,artifacts:this.artifacts,authorityCurrent:authority=>this.authorityCurrent(authority)});
    this.verifier=new InspectionVerifier({app,chats,quality:this.quality,authorityCurrent:authority=>this.authorityCurrent(authority),readiness:()=>this.readiness(),delegatedReadiness:projectId=>this.delegation?.capabilities(projectId)??Promise.resolve([]),allowNativeProfileSetup:true,pendingNativeSetup:(authority,source)=>this.profileSetup?.pending(authority,source),reconcileInspection:(run,signal)=>this.reconcileVerifierInspection(run,signal)});
    this.retention=new InspectionRetention({dataDir:path.join(app.dataDir,'inspection'),artifacts:this.artifacts,store:app.store,jobs:this.jobs,activeJobIds:()=>new Set(this.active.keys()),protectedSnapshotIds:()=>new Set(this.profileSetup?.list().filter(run=>['queued','preparing','running','waiting','unknown'].includes(run.status)).map(run=>run.source.snapshotId))});
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
    this.profileSetup=new NativeProfileSetup({app,chats,artifacts:this.artifacts,snapshots:this.snapshots,authorityCurrent:authority=>this.authorityCurrent(authority),verifySnapshot:async(snapshot,signal)=>{if(snapshot.path.startsWith(path.join(app.dataDir,'inspection','inspection-snapshots')+path.sep))await this.snapshots.verify(snapshot,signal);else await this.verifier.verifySnapshot(snapshot,signal);},readiness:()=>this.readiness(),sourceCurrent:async(sessionId,authority,signal)=>{
      const session=app.sessions.record(sessionId),execution=app.sessions.execution(sessionId),context={session,execution,signal,chat:{id:'source-audit-current',sessionId,runtime:'codex'} as AgentToolBridgeContext['chat']};
      const current=await this.captureActual(context,authority,false);try{return current.source;}finally{await this.snapshots.remove(current.snapshot);}
    },retainSnapshot:async(snapshot,authority)=>{await this.retention.retain(snapshot,authority);},configure:(projectId,profile)=>this.configureProfile(projectId,profile),retireReviewer:run=>this.retireProfileReviewer(run)});
    if(network)this.profileSync=new NativeProfileSync({app,peers:network.peers,artifacts:this.artifacts,auditOriginal:async id=>{const original=this.profileSetup.original(id),configured=this.profiles(original.audit.projectId).find(profile=>profile.id===original.audit.proposal.profile.id);if(configured?.receipt?.sha256!==original.audit.receipt?.sha256)throw new Error('A newer independently audited profile superseded this source receipt.');return original;},authorityCurrent:authority=>this.authorityCurrent(authority),auditApproved:run=>this.profileSetup.approved(run),configure:(projectId,profile)=>this.configureProfile(projectId,profile)});
  }
  private configureProfile(projectId:string,profile:NativeFixtureProfile):void{const profiles=this.profiles(projectId).filter(current=>current.id!==profile.id);if(profiles.length>=16)throw new Error('The project already has sixteen native fixture profiles.');this.app.store.set('inspection-project-profiles',{id:projectId,profiles:[...profiles,profile]});this.app.emit('inspection-evidence',{projectId,profileId:profile.id,purpose:'native-profile-ready'});this.app.changed();}
  private async syncNativeProfiles():Promise<void>{if(!this.profileSync)return;await this.profileSync.reconcilePending();for(const run of this.profileSetup.list().filter(run=>run.status==='configured'&&this.authorityCurrent(run.authority))){const profile=this.profiles(run.projectId).find(profile=>profile.id===run.proposal.profile.id&&profile.receipt?.sha256===run.receipt?.sha256);if(!profile)continue;for(const device of this.app.devices.filter(device=>device.id!==this.app.device.id&&device.online&&device.executionTargets?.some(target=>target.kind==='host-macos'))){try{await this.profileSync.sync(run,profile,device.id);}catch(error){this.app.emit('inspection-setup',{auditId:run.id,deviceId:device.id,error:(error as Error).message});}}}}
  private async retireProfileReviewer(run:import('./inspection-profile-setup.ts').NativeProfileAudit):Promise<void>{
    if(!run.sessionId)return;
    const session=this.app.sessions.record(run.sessionId),project=this.app.store.get<Project>('projects',session.projectId);
    if(!project||project.id!==`workspace-${run.id}`||session.verificationRunId!==run.id||!this.app.sessions.owns(session.id))throw new Error('Source reviewer cleanup lost its exact session owner.');
    const root=path.join(this.app.dataDir,'workspace-data','workspaces',run.id),repository=path.join(root,'repository'),bucket='inspection-profile-audit-retirement';
    type Retirement={id:string;sessionId:string;chatId?:string;root:string;proposalSha256:string;source:import('@enoughfactory/workspaces').InspectionSnapshotTransfer;createdAt:string;disposeStartedAt?:string;retiredAt?:string};
    let journal=this.app.store.get<Retirement>(bucket,run.id);
    const assertCurrent=()=>{const current=this.profileSetup.get(run.id);if(!['configured','rejected','canceled'].includes(current.status)||current.chatId!==run.chatId||current.sessionId!==session.id||run.chatId&&this.chats.isRunning(run.chatId))throw new Error('Source reviewer cleanup no longer has a confirmed ended owner.');};assertCurrent();
    if(project.path!==repository||journal&&(journal.sessionId!==session.id||journal.chatId!==run.chatId||journal.root!==root||journal.proposalSha256!==run.proposalSha256))throw new Error('Source reviewer retirement identity changed.');
    if(journal?.retiredAt)return;
    let rootMissing=false;try{if(await realpath(root)!==root)throw new Error('Source reviewer workspace escaped its owned directory.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;rootMissing=true;}
    if(rootMissing){
      const released=session.executionTargetKind==='host-macos'?!!this.app.store.get<{releasedAt?:string}>('session-host',session.id)?.releasedAt:!!this.app.sessions.archivedEnvironment(session.id);
      if(!journal?.disposeStartedAt||session.status!=='stopped'||!released)throw new Error('Source reviewer scratch disappeared without a confirmed durable retirement.');
      for(const artifact of [journal.source.sourceManifest,...journal.source.sourceArtifacts.map(item=>item.manifest)])await this.artifacts.path(artifact);
      this.app.store.set(bucket,{...journal,retiredAt:new Date().toISOString()});return;
    }
    const owner=JSON.parse(await readFile(path.join(root,'audit-owner.json'),'utf8'));
    if(owner.runId!==run.id||owner.deviceId!==run.ownerDeviceId||owner.proposalSha256!==run.proposalSha256||JSON.stringify(owner.source)!==JSON.stringify(run.source))throw new Error('Source reviewer cleanup owner changed.');
    if(session.status!=='stopped')await this.app.sessions.stop(session.id);
    if(!journal){
      const host=session.executionTargetKind==='host-macos'?this.app.store.get<{prepared:{cwd:string};releasedAt?:string}>('session-host',session.id):undefined;
      if(host?.releasedAt)throw new Error('The native reviewer input was released before its source was retained.');
      if(host)await this.app.sessions.assertHostExecutionCurrent(session.id);
      const preserved=await this.snapshots.create({roots:[{id:'primary',name:'primary',path:host?.prepared.cwd??repository}],includeAll:true,context:run.authority,maxBytes:INSPECTION_SOURCE_MAX_BYTES});
      try{const source=await exportInspectionSnapshot({snapshot:preserved,artifacts:this.artifacts,context:run.authority,limits:{maxBytes:INSPECTION_SOURCE_MAX_BYTES}});journal={id:run.id,sessionId:session.id,chatId:run.chatId,root,proposalSha256:run.proposalSha256,source,createdAt:new Date().toISOString()};this.app.store.set(bucket,journal);}finally{await this.snapshots.remove(preserved);}
    }
    assertCurrent();
    if(session.executionTargetKind==='host-macos'){
      await this.app.sessions.withStoppedInputs(session.id,async()=>{const processes=(await this.chats.manager.hostProcesses()).filter(process=>process.sessionId===session.id||process.sessionId.startsWith(`${session.id}-decision-`));if(processes.some(process=>process.state!=='exited'))throw new Error('The source reviewer provider still has unresolved ownership.');for(const providerSession of new Set([session.id,...processes.map(process=>process.sessionId)]))await this.chats.manager.retireHostSession(providerSession,this.app.store.get<{prepared:{cwd:string}}>('session-host',session.id)?.prepared.cwd??repository);await this.app.sessions.disposeHostWorkspace(session.id);});
    }else if(!this.app.sessions.archivedEnvironment(session.id)){
      const disk=new HostDiskAdmission(()=>[this.app.dataDir],()=>this.app.device.name);
      await this.app.withRuntimeOperation(()=>this.app.sessions.withRetirementLease(session.id,()=>this.chats.manager.withIdleContainer(this.app.sessions.retirementContainerName(session.id),()=>this.app.sessions.retireEphemeralEnvironment(session.id,this.app.dataDir,{assertCurrent,assertSpace:()=>disk.assert(),runtimeKinds:['codex']}))));
    }
    assertCurrent();journal={...journal!,disposeStartedAt:journal?.disposeStartedAt??new Date().toISOString()};this.app.store.set(bucket,journal);
    await new WorkspaceManager({dataDir:path.join(this.app.dataDir,'workspace-data'),deviceId:this.app.device.id}).dispose(run.id);
    this.app.store.set(bucket,{...journal,retiredAt:new Date().toISOString()});
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
    this.jobs.recoverAfterRestart();this.delegation?.initialize();this.verifier.recover();this.profileSetup.recover();this.profileSync?.initialize();
    this.chats.setToolBridge(context=>this.bridge(context));
    this.app.extensions.push(async({method,url,body,peerId})=>{
      if(method==='GET'&&url.pathname==='/api/inspection/readiness')return {executionTargets:await this.readiness({prepareHost:'requested'})};
      if(method==='POST'&&url.pathname==='/api/inspection/mac-permissions'){
        if(url.searchParams.has('deviceId')&&url.searchParams.get('deviceId')!==this.app.device.id)throw new HttpError(403,'Request Mac testing permissions on their owning device.');
        if(process.platform!=='darwin'||this.app.device.platform!=='darwin')throw new HttpError(409,'Mac testing permissions require a Mac device.');
        return this.requestMacPermissions();
      }
      const task=url.pathname.match(/^\/api\/tasks\/([^/]+)\/inspection$/);
      if(method==='GET'&&task){const jobs=this.jobs.listJobs().filter(job=>job.authority.taskId===task[1]),remote=this.delegation?.taskInspection(task[1]);const unique=<T extends {id:string}>(items:T[])=>[...new Map(items.map(item=>[item.id,item])).values()];return {jobs:unique([...jobs,...remote?.jobs||[]]),sessions:unique([...jobs.flatMap(job=>this.jobs.sessions(job.id)),...remote?.sessions||[]]),evidence:unique([...jobs.flatMap(job=>this.jobs.evidence(job.id)),...remote?.evidence||[]]),verifiers:this.app.store.list<InspectionVerificationRun>('inspection-verifier-runs').filter(run=>run.authority.taskId===task[1])};}
      const profiles=url.pathname.match(/^\/api\/projects\/([^/]+)\/inspection-profiles$/);
      if(profiles&&method==='GET')return this.profiles(profiles[1]);
      const profileAudits=url.pathname.match(/^\/api\/projects\/([^/]+)\/inspection-profile-audits$/);if(profileAudits&&method==='GET')return this.profileSetup.list(profileAudits[1]).map(run=>this.profileSetup.publicView(run));
      if(profiles&&method==='PUT'){
        if(peerId)throw new HttpError(403,'Configure native fixture profiles on the owning device.');
        if(!this.app.store.get<Project>('projects',profiles[1]))throw new HttpError(404,'Project not found.');
        if(!Array.isArray(body.profiles)||body.profiles.length>16)throw new HttpError(400,'Provide up to sixteen verified native profiles.');
        const ids=new Set<string>();for(const value of body.profiles){const profile=value as NativeFixtureProfile;if(!profile||typeof profile.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(profile.id)||ids.has(profile.id)||!profile.build||!Array.isArray(profile.launchArguments)||!profile.launchArguments.every(arg=>typeof arg==='string')||!profile.launchArguments.some(arg=>arg.includes('{runId}'))||!/^[a-f0-9]{64}$/.test(profile.fixtureEvidenceSha256)||!profile.receipt||profile.receipt.sha256!==profile.fixtureEvidenceSha256)throw new HttpError(400,'Native profiles require unique identities and an original audited fixture receipt matching their source hash.');ids.add(profile.id);try{const receipt=await this.artifacts.get(profile.receipt.id);if(receipt.sha256!==profile.fixtureEvidenceSha256||receipt.size!==profile.receipt.size)throw new Error('Receipt manifest changed.');await this.artifacts.read(receipt);}catch{throw new HttpError(400,'The original audited fixture receipt is unavailable or changed.');}}
        this.app.store.set('inspection-project-profiles',{id:profiles[1],profiles:body.profiles});this.app.changed();return this.profiles(profiles[1]);
      }
      return undefined;
    });
    this.app.serviceActivityHooks.push(()=>{const verifiers=this.app.store.list<InspectionVerificationRun>('inspection-verifier-runs').filter(run=>['preparing','running','unknown'].includes(run.status)||run.status==='waiting'&&Boolean(run.sessionId));const held=this.jobs.listJobs().filter(job=>['preparing','running','waiting','unknown','cancellation-requested'].includes(job.status)),audits=this.profileSetup.list().filter(run=>['queued','preparing','running','unknown'].includes(run.status));return held.length||verifiers.length||audits.length?[`${held.length} inspection job(s), ${verifiers.length} verifier(s) and ${audits.length} source audit(s) have active or unresolved ownership.`]:[];});
    this.app.closers.push(()=>this.close());
    void this.app.withServiceOperation(async()=>{await this.recoverOwnedSessions();await this.recoverOwnedBuilds();}).catch(error=>this.app.emit('inspection-error',{error:(error as Error).message}));
    this.timer=setInterval(()=>{
      if(this.closing||this.maintaining)return;
      this.maintaining=this.app.withServiceOperation(async()=>{
        this.profileSetup.maintain();const outcomes=await Promise.allSettled([this.readiness({prepareHost:'automatic'}),this.recoverOwnedBuilds(),this.retireIdleBrowsers(),this.retention.sweep(),this.retireColdProducts(),this.verifier.sweepCompleted(run=>this.canRetireVerifier(run)),this.syncNativeProfiles()]);
        for(const outcome of outcomes)if(outcome.status==='rejected')this.app.emit('inspection-error',{error:(outcome.reason as Error).message});
      }).catch(error=>this.app.emit('inspection-error',{error:(error as Error).message})).finally(()=>{this.maintaining=undefined;});
    },30000);this.timer.unref();
    await this.readiness({prepareHost:'automatic'});
  }
  profiles(projectId:string):NativeFixtureProfile[]{return this.app.store.get<{id:string;profiles:NativeFixtureProfile[]}>('inspection-project-profiles',projectId)?.profiles||[];}
  /** Public recheck preflight reads ownership only; it never stops or resumes work. */
  retainedVerificationSettled:NonNullable<FactoryInspectionPorts['retainedVerificationSettled']>=async input=>{
    const unavailable=(reason:string)=>({ready:false,reason});
    const current=()=>{
      const goal=this.app.store.get<Goal>('goals',input.goal.id),task=this.app.store.get<FactoryTask>('tasks',input.task.id),attempt=this.app.store.get<Attempt>('attempts',input.attempt.id),detail=this.app.store.get<AttemptDetail>('factory-attempt-details',input.attempt.id);
      const quality=detail?.contract?detail.contract.quality:task?.quality,revision=detail?.assignmentGoalRevision??detail?.goalRevision??goal?.revision;
      const qualityMatches=quality&&input.quality?inspectionQualityPolicySha256(quality)===inspectionQualityPolicySha256(input.quality):quality===undefined&&input.quality===undefined;
      const authority:InspectionAuthority={goalId:input.goal.id,goalRevision:revision??-1,taskId:input.task.id,attemptId:input.attempt.id,authorityGeneration:input.attempt.generation,policyRevision:revision??-1};
      // A successful author is marked failed when its later checks fail. This
      // read-only exception does not reactivate its retired tool authority.
      return !this.closing&&!!goal&&goal.coordinatorId===this.app.device.id&&goal.revision===input.goal.revision&&!['draft','planning','completed','failed','canceled'].includes(goal.status)&&!!task&&task.goalId===goal.id&&task.currentAttemptId===input.attempt.id&&task.status==='failed'&&!!attempt&&attempt.taskId===task.id&&attempt.generation===input.attempt.generation&&attempt.status==='failed'&&!!detail&&!!detail.contract&&detail.phase==='checking'&&detail.result?.status==='succeeded'&&detail.cancellation==='none'&&!detail.integration&&isDeepStrictEqual(detail.candidate,input.candidate)&&attempt.candidate===input.candidate.commit&&detail.checks?.some(check=>!check.passed)&&detail.checks.every(check=>check.candidateCommit===input.candidate.commit&&check.checkedCommit===input.candidate.commit)&&qualityMatches&&isDeepStrictEqual(goal,input.goal)&&isDeepStrictEqual(task,input.task)&&isDeepStrictEqual(attempt,input.attempt)?{authority,quality,goal,task,attempt,detail}:undefined;
    };
    const selected=current();if(!selected)return unavailable('The original author candidate, requirements or task authority changed.');
    const runs=this.app.store.list<InspectionVerificationRun>('inspection-verifier-runs').filter(run=>run.authority.attemptId===input.attempt.id);
    if([...this.contexts.values()].some(context=>!context.signal.aborted&&(context.attemptId===input.attempt.id||runs.some(run=>run.id===context.verificationRunId))))return unavailable('The original candidate still has an active inspection conversation.');
    const qualityDigest=selected.quality?inspectionQualityPolicySha256(selected.quality):undefined;
    for(const run of runs){
      if(run.authority.goalId!==selected.authority.goalId||run.authority.taskId!==selected.authority.taskId||run.authority.goalRevision!==selected.authority.goalRevision||run.authority.authorityGeneration!==selected.authority.authorityGeneration||run.authority.policyRevision!==selected.authority.policyRevision||run.purpose==='goal-final'||run.source.candidateId!==input.candidate.id||run.source.candidateCommit!==input.candidate.commit||run.policySha256!==qualityDigest||run.policySha256!==inspectionQualityPolicySha256(run.quality)||run.id!==inspectionVerificationKey(run))return unavailable('A retained verifier no longer matches this exact candidate and frozen requirements.');
      const provider=await this.verifier.providerSettled(run);if(!provider.ready)return provider;
      if(!this.canRetireVerifier(run))return unavailable('The original candidate still has active or uncertain inspection jobs, sessions or resource leases.');
    }
    // An author may have inspected before a verifier was allocated. Those jobs
    // must also have honest terminal outcomes and positively released resources.
    const related=this.jobs.listJobs().filter(job=>job.authority.attemptId===input.attempt.id);
    if(related.some(job=>this.inspectionJobActive(job)||!['succeeded','failed','canceled'].includes(job.status)||this.jobs.sessions(job.id).some(session=>session.status!=='stopped')||this.jobs.leases(job.id).some(lease=>lease.status==='held')))return unavailable('Original author inspection effects remain active or unresolved.');
    if(this.profileSetup.list().some(run=>run.authority.attemptId===input.attempt.id&&['queued','preparing','running','waiting','unknown'].includes(run.status)))return unavailable('The original native testing audit still has pending or uncertain ownership.');
    const latestRuns=this.app.store.list<InspectionVerificationRun>('inspection-verifier-runs').filter(run=>run.authority.attemptId===input.attempt.id);
    if(latestRuns.length!==runs.length||runs.some(run=>!isDeepStrictEqual(latestRuns.find(latest=>latest.id===run.id),run)||!this.verifier.providerOwnerCurrent(run)||!this.canRetireVerifier(run))||[...this.contexts.values()].some(context=>!context.signal.aborted&&(context.attemptId===input.attempt.id||runs.some(run=>run.id===context.verificationRunId))))return unavailable('Verifier ownership changed during the inspection preflight.');
    return isDeepStrictEqual(current(),selected)?{ready:true}:unavailable('Task authority changed during the inspection preflight.');
  };
  qualityCheck:NonNullable<FactoryInspectionPorts['qualityCheck']>=async input=>{
    const roots=[{id:'primary',name:'primary',path:input.path},...(input.workingDirectories||[]).map(root=>{
      const captured=input.candidate.workingDirectories?.find(item=>item.containerPath===root.containerPath);
      return {id:captured?.id||path.basename(root.containerPath),name:captured?.name||path.basename(root.containerPath),path:root.path};
    })];
    const snapshot=await this.snapshots.create({roots,signal:input.signal,maxBytes:INSPECTION_SOURCE_MAX_BYTES});
    try{
      const detail=this.app.store.get<AttemptDetail>('factory-attempt-details',input.attempt.id),revision=detail?.assignmentGoalRevision??detail?.goalRevision??input.goal.revision;
      const authority:InspectionAuthority={goalId:input.goal.id,goalRevision:revision,taskId:input.task.id,attemptId:input.attempt.id,authorityGeneration:input.attempt.generation,policyRevision:revision};
      const source:InspectionSourceIdentity={snapshotId:snapshot.id,sha256:snapshot.sourceDigest,candidateId:input.candidate.id,candidateCommit:input.candidate.commit,checkedCommit:input.checkedCommit,roots:snapshot.roots.map(root=>({id:root.id,sha256:root.sourceDigest,...(root.sourceCommit?{commit:root.sourceCommit}:{})}))};
      this.profileSetup.bindCandidate(authority,input.candidate,source);
      const checked=await this.quality.check({authority,quality:input.quality,source,candidateCommit:input.candidate.commit,checkedCommit:input.checkedCommit});
      if(!checked.passed&&!checked.recovery)return checked;
      const setup=this.profileSetup.pending(authority,source);
      if(setup?.status==='rejected')return{...checked,passed:false,exitCode:1,output:`Native fixture audit ${setup.auditId} rejected this exact source: ${setup.reason}${setup.verdict?` Original judgment artifact ${setup.verdict.id} (${setup.verdict.sha256}).`:''}`,recovery:undefined};
      if(setup){this.profileSetup.maintain();const reason=`Native testing setup is ${setup.status}: ${setup.reason} The successful author and exact candidate remain retained.`;return{...checked,passed:false,exitCode:1,output:reason,recovery:{condition:'inspection-evidence',reason}};}
      const project=this.app.store.get<Project>('projects',input.goal.projectId);if(!project)throw new Error('The verification project is unavailable.');
      const run=await this.verifier.ensure({authority,quality:input.quality,source,snapshot,project,signal:input.signal});
      if(run.status==='succeeded'&&run.acceptanceContract&&run.chatId)return this.quality.check({authority,quality:input.quality,source,candidateCommit:input.candidate.commit,checkedCommit:input.checkedCommit,verification:{runId:run.id,chatId:run.chatId,acceptanceContractSha256:inspectionAcceptanceContractSha256(run.acceptanceContract)}});
      if(['failed','canceled'].includes(run.status))return {...checked,passed:false,exitCode:1,output:run.reason||'Independent application verification failed.',recovery:undefined};
      const reason=run.reason||'Independent application verification is waiting for inspection readiness.';return {...checked,passed:false,exitCode:1,output:reason,recovery:{condition:'inspection-evidence',reason}};
    }finally{await this.snapshots.remove(snapshot);}
  };
  private requestMacPermissions():Promise<{readiness:NativeReadiness;executionTargets:ExecutionTargetAdvertisement[]}>{
    if(this.closing)throw new Error('Inspection service is closing.');
    if(this.macPermissionRequest)return this.macPermissionRequest;
    let operation:Promise<{readiness:NativeReadiness;executionTargets:ExecutionTargetAdvertisement[]}>;
    operation=this.app.withServiceOperation(async signal=>{
      const current=()=>{signal.throwIfAborted();if(this.closing)throw new Error('Inspection service closed before Mac permissions were checked.');};
      current();const readiness=await this.native.requestMacPermissions();current();
      await this.refreshing?.catch(()=>{});current();
      const executionTargets=await this.readiness({signal});current();
      return {readiness,executionTargets};
    }).finally(()=>{if(this.macPermissionRequest===operation)this.macPermissionRequest=undefined;});
    this.macPermissionRequest=operation;return operation;
  }
  private prepareHost(mode:'automatic'|'requested'):void{
    if(this.closing||this.hostPreparation)return;
    const recorded=this.app.store.get<HostSetupRecord>(hostSetupBucket,'mac-shell');
    const previous=recorded?.runtimeKey&&recorded.runtimeKey!==hostSetupRuntimeKey?undefined:recorded;
    if(previous&&previous.retryAfter>Date.now()||mode==='automatic'&&(previous?.attempts??0)>=hostSetupAutomaticAttempts)return;
    const generation=++this.hostPreparationGeneration,controller=new AbortController();this.hostPreparationAbort=controller;
    let lifecycleSignal:AbortSignal|undefined,operation:Promise<void>;
    operation=this.app.withServiceOperation(async serviceSignal=>{
      lifecycleSignal=serviceSignal;
      const signal=AbortSignal.any([serviceSignal,controller.signal,AbortSignal.timeout(600000)]);
      const current=()=>{signal.throwIfAborted();if(this.closing||generation!==this.hostPreparationGeneration)throw new Error('Mac agent setup was revoked.');};
      current();const attemptedAt=new Date().toISOString(),attempts=(previous?.attempts??0)+1;
      const record:HostSetupRecord={id:'mac-shell',status:'preparing',attempts,attemptedAt,updatedAt:attemptedAt,retryAfter:Date.now()+hostSetupRetryMs,runtimeKey:hostSetupRuntimeKey};
      this.app.store.set(hostSetupBucket,record);
      try{
        await this.chats.manager.provisionHost(signal);current();
        const provider=(await this.chats.manager.hostAvailability(signal)).find(provider=>provider.kind==='codex');current();
        if(!provider?.available)throw new Error(provider?.details||'The pinned Mac agent tools are still unavailable after preparation.');
        this.app.store.set(hostSetupBucket,{...record,status:'ready',attempts:0,retryAfter:0,updatedAt:new Date().toISOString()});
      }catch(error){
        if(this.closing||generation!==this.hostPreparationGeneration||serviceSignal.aborted||controller.signal.aborted)return;
        const failure={...record,status:'failed' as const,error:error instanceof Error?error.message:String(error),retryAfter:Date.now()+hostSetupRetryMs,updatedAt:new Date().toISOString()};
        this.app.store.set(hostSetupBucket,failure);this.app.emit('inspection-setup',{capability:'mac-shell',...failure});
      }
    }).catch(error=>{if(!this.closing&&!controller.signal.aborted&&!lifecycleSignal?.aborted)this.app.emit('inspection-setup',{capability:'mac-shell',error:(error as Error).message});}).finally(async()=>{
      if(this.hostPreparation!==operation)return;this.hostPreparation=undefined;this.hostPreparationAbort=undefined;
      if(this.closing||generation!==this.hostPreparationGeneration||controller.signal.aborted||lifecycleSignal?.aborted)return;
      await this.refreshing?.catch(()=>{});
      if(this.closing||generation!==this.hostPreparationGeneration||controller.signal.aborted||lifecycleSignal?.aborted)return;
      await this.readiness({signal:lifecycleSignal}).catch(error=>{if(!this.closing&&!controller.signal.aborted&&!lifecycleSignal?.aborted)this.app.emit('inspection-error',{error:(error as Error).message});});
    });
    this.hostPreparation=operation;
  }
  async readiness(input:{prepareHost?:'automatic'|'requested';signal?:AbortSignal}={}):Promise<ExecutionTargetAdvertisement[]>{
    if(this.closing)throw new Error('Inspection service is closing.');
    input.signal?.throwIfAborted();
    if(input.prepareHost==='requested'||input.prepareHost&&!this.hostPreparationRequest)this.hostPreparationRequest=input.prepareHost;
    if(this.refreshing)return this.refreshing;
    return this.refreshing=(async()=>{
      const containerReady=(this.app.device.capacity??0)>0;
      const capabilities:ExecutionTargetAdvertisement[]=[{id:'container',kind:'container',protocolVersion:1,readiness:containerReady?'ready':'setup-required',capacity:this.app.device.capacity,workspaceProviders:this.app.device.workspaceProviders||['git'],runtimes:['codex'],resources:this.app.device.workerResources,capabilities:[{kind:'linux-shell',readiness:containerReady?'ready':'setup-required',reason:containerReady?undefined:'Start the private runtime to run container work.',setupAction:containerReady?undefined:'Start the runtime from Devices.'},{kind:'chromium-inspection',readiness:containerReady?'ready':'setup-required',version:'playwright-mcp-0.0.82',reason:containerReady?'Prepared on demand in the private runtime.':'Start the private runtime to prepare browser testing.'}]}];
      if(process.platform==='darwin'){
        const [providers,mac,ios,apple]=await Promise.all([this.chats.manager.hostAvailability(),this.native.readiness('macos'),this.native.readiness('ios-simulator'),execute('/usr/bin/xcrun',['--find','xcodebuild'],{timeout:10000}).then(()=>true,()=>false)]);
        if(this.closing)throw new Error('Inspection service closed before readiness was checked.');input.signal?.throwIfAborted();
        const provider=providers.find(provider=>provider.kind==='codex')!;
        const preparationRequest=this.hostPreparationRequest;this.hostPreparationRequest=undefined;
        if(!provider.available&&preparationRequest)this.prepareHost(preparationRequest);
        let setup=this.app.store.get<HostSetupRecord>(hostSetupBucket,'mac-shell');
        if(provider.available&&setup&&!this.hostPreparation&&(setup.status!=='ready'||setup.attempts!==0||setup.runtimeKey!==hostSetupRuntimeKey)){setup={...setup,status:'ready',attempts:0,retryAfter:0,error:undefined,runtimeKey:hostSetupRuntimeKey,updatedAt:new Date().toISOString()};this.app.store.set(hostSetupBucket,setup);}
        const hostReadiness=provider.available?'ready':this.hostPreparation?'preparing':'setup-required';
        const reason=provider.available?undefined:this.hostPreparation?'Preparing the pinned Mac authoring tools.':[setup?.error,provider.details,setup?.status==='preparing'?'Previous Mac agent preparation was interrupted.':undefined].filter(Boolean).join(' ')||'The pinned Mac authoring tools are not prepared.';
        const setupAction=hostReadiness==='setup-required'?`Check readiness to retry Mac agent setup${setup&&setup.retryAfter>Date.now()?` after ${new Date(setup.retryAfter).toISOString()}`:''}.`:undefined;
        capabilities.push({id:'mac-host',kind:'host-macos',protocolVersion:1,readiness:hostReadiness,reason,setupAction,capacity:Math.max(1,Math.min(4,cpus().length-1)),resources:{cpus:cpus().length,memoryGiB:totalmem()/1024**3},workspaceProviders:['git'],runtimes:['codex'],capabilities:[{kind:'mac-shell',readiness:hostReadiness,version:provider.version,reason,setupAction},{kind:'apple-compilation',readiness:apple?'ready':'setup-required',setupAction:apple?undefined:'Install Xcode and its command line tools.'},{kind:'macos-app-inspection',readiness:mac.status,reason:mac.reasons.join(' ')||undefined,setupAction:mac.status==='ready'?undefined:'Set up the native testing helper, Accessibility and screen capture permissions.'},{kind:'ios-simulator-inspection',readiness:ios.status,reason:ios.reasons.join(' ')||undefined,setupAction:ios.status==='ready'?undefined:'Install the iPhone testing runner and an iOS Simulator runtime.'}]});
      }
      if(this.closing)throw new Error('Inspection service closed before readiness was checked.');
      input.signal?.throwIfAborted();
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
    if(context.chat.verificationRunId?.startsWith('profile-audit-'))return this.profileSetup.bridge(context);
    const verification=await this.verifier.verificationSource(context),authority=verification?.run.authority||this.authority(context);if(!authority)return this.controllerBridge(context);
    const key=`${authority.attemptId}-${authority.authorityGeneration}-${authority.goalRevision}`;
    let saved=this.app.store.get<GrantToken>('inspection-private-tokens',key);
    if(saved){try{this.jobs.authorize(saved.token);}catch{saved=undefined;}}
    if(!saved){const grant=this.jobs.issueAuthority(authority,{capabilities:['chromium-inspection','apple-compilation','macos-app-inspection','ios-simulator-inspection'],executionTargetIds:['container','mac-host']});saved={id:key,token:grant.token,grantId:grant.grant.id,authority};this.app.store.set('inspection-private-tokens',saved);}
    const token=saved.token;this.contexts.set(authority.attemptId,context);
    const historicalTools=verification?[
      {name:'factory_verification_history',description:'List original same-goal evidence for the verifier anchor and accepted task contracts. Historical context never establishes current workflow acceptance.',inputSchema:objectSchema({offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:24}})},
      {name:'factory_verification_evidence',description:'Read original scoped records, source-transfer manifests, author retirement, and completed author tool-event chronology. For author-trace, finish text ranges for each event page then continue nextEventCursor until complete; failures remain failures. Historical context is never current workflow proof.',inputSchema:objectSchema({kind:{type:'string',enum:['inspection','attempt','candidate-diff','goal-check','quality-report','author-trace','source-manifest','author-retirement']},id:string,eventCursor:{type:'integer',minimum:0},eventLimit:{type:'integer',minimum:1,maximum:32},offset:{type:'integer',minimum:0},maxCharacters:{type:'integer',minimum:1,maximum:16000}},['kind','id','offset','maxCharacters'])},
      {name:'factory_verification_image',description:'View original historical screenshot pixels for the scoped goal/task/attempt. Records a historical image view only; current acceptance still needs this verifier own current-source UI observations.',inputSchema:objectSchema({evidenceId:string},['evidenceId'])},
    ]:[];
    const history=new InspectionVerificationHistory({store:this.app.store,artifacts:this.artifacts,current:()=>this.verifier.verificationSource(context),qualityReports:this.quality});
    const handler=inspectionMcpHandler([...tools,...historicalTools],async(name,args)=>this.app.withServiceOperation(async()=>{this.jobs.authorize(token);if(context.signal.aborted)throw new Error('The author turn was canceled.');return this.call(context,token,name,args);}));
    const bridge=context.execution.kind==='host-macos'?await createHostInspectionBridge(token,handler):await createContainerInspectionBridge(this.app.runtime.endpoint,context.execution.containerId!,token,handler);
    this.bridges.add(bridge);
    return {mcpServers:{factory:bridge.server},systemInstructions:'Factory inspection tools are available. Use factory_capabilities first. Capture/build your actual source, open it, view screenshot image responses, operate fresh element IDs, check resulting state and repair serious defects. Native builds and UI sessions are different durable jobs; poll queued/running jobs with factory_job_status. Finish or explicitly stop all inspection jobs before ending your turn. For a new native app with no matching profile, use factory_native_profile_propose with its fixed xcodebuild recipe, per-run fixture arguments and original source starting paths for entry/storage/credentials/providers/preferences/notifications/build. Poll factory_native_profile_status; the service independently reviews original source and issues its receipt. Changed compiled source needs a fresh profile audit. Use configured isolated native fixture profiles; do not launch personal-data instances. Compiling alone is not product acceptance. If factory_capabilities returns a quality contract, you may submit factory_quality_submit. Factory independently verifies missing evidence after authoring. Report schema: report={version:1,source:job.source,workflows:[{id:requiredWorkflowId,platform,before:screenshotEvidenceId,action:actionId,after:screenshotEvidenceId,outcome:passedOrFailedOrBlocked,assertion:concreteObservedResult,assertionEvidenceId}],reviews:[{platform,observations:[screenshotEvidenceId],references:[{id:requiredReferenceId,comparison:concreteComparison}],dimensions:{hierarchy,spacing,clipping,typography,controls,states},defects:[{id,severity:minorOrMajorOrBlocking,status:openOrRepaired,description,observation:screenshotEvidenceId}]}]}. IDs must come from actual tool receipts; all six dimensions need concrete review text. Inspect supplied reference files via factory_reference and actual screenshot images. A report with missing receipts is a durable evidence wait; serious defects require repair.',onToolImage:async(image)=>{
      const sha256=createHash('sha256').update(image.bytes).digest('hex');
      if(verification){
        const current=await this.verifier.verificationSource(context);if(!current)throw new Error('The independent verifier image owner changed.');
        const historical=history.acknowledgeImage({run:current.run,chatId:context.chat.id,sha256,server:image.server,tool:image.tool,eventId:image.itemId||randomUUID(),mimeType:image.mimeType,byteLength:image.bytes.length});
        if(historical)return {artifactId:historical.id,sha256,mimeType:image.mimeType,byteLength:image.bytes.length};
      }
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
  private async controllerContext(context:AgentToolBridgeContext,goal:Goal,controllerRunId:string):Promise<AgentToolBridgeContext>{
    const run=this.app.store.get<ControllerRun>('factory-controller-runs',controllerRunId);
    if(!run||run.goalId!==goal.id||run.sessionId!==context.session.id||run.chatId!==context.chat.id)throw new Error('The controller source context has no matching service owner.');
    const project=this.app.store.get<Project>('projects',goal.projectId);if(!project)throw new Error('The integrated project is unavailable.');
    const declared=project.workingDirectories||[],mounted=context.session.workingDirectories||[];
    const undeclared=mounted.filter(root=>!declared.some(source=>source.id===root.id));
    if(undeclared.length){
      const attachment=undeclared[0],sources=this.app.store.get<{id:string;workingDirectorySources?:WorkingDirectorySource[]}>('session-launch',context.session.id)?.workingDirectorySources||[];
      const frozen=sources.filter(root=>root.id===`controller-context-${controllerRunId}`);
      if(undeclared.length!==1||attachment!.id!==`controller-context-${controllerRunId}`||frozen.length!==1||frozen[0]!.kind!=='folder'||attachment!.kind!==frozen[0]!.kind||attachment!.name!==frozen[0]!.name||attachment!.baseCommit!==frozen[0]!.baseCommit||attachment!.sourceCommit!==frozen[0]!.sourceCommit||frozen[0]!.sourceArtifact.metadata?.workingDirectoryId!==attachment!.id||frozen[0]!.sourceArtifact.metadata?.commit!==frozen[0]!.baseCommit)throw new Error('The controller has an undeclared folder without a frozen service-owned evidence attachment. Recreate its source context.');
      if(context.execution.kind==='container'){
        if(attachment!.path!==frozen[0]!.containerPath)throw new Error('The controller evidence attachment changed its frozen mount path.');
      }else{
        const host=this.app.store.get<{id:string;deviceId:string;prepared:{sessionId:string;roots:Array<WorkingDirectorySource&{path:string}>}}>('session-host',context.session.id),prepared=host?.prepared.roots.filter(root=>root.id===attachment!.id)||[];
        if(host?.deviceId!==this.app.device.id||host.prepared.sessionId!==context.session.id||prepared.length!==1||prepared[0]!.path!==attachment!.path||prepared[0]!.sourceArtifact.id!==frozen[0]!.sourceArtifact.id||prepared[0]!.sourceArtifact.sha256!==frozen[0]!.sourceArtifact.sha256)throw new Error('The controller evidence attachment changed its retained host mount path.');
      }
    }
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
    return {...context,session:{...context.session,workingDirectories:roots}};
  }
  private async captureControllerSource(context:AgentToolBridgeContext,goal:Goal,controllerRunId:string):Promise<SourceRecord>{
    return this.captureActual(await this.controllerContext(context,goal,controllerRunId));
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
    const snapshot=await this.snapshots.create({roots:[{id:'primary',name:'primary',path:project.path},...(project.workingDirectories||[]).map(root=>({id:root.id,name:root.name,path:root.path}))],signal,maxBytes:INSPECTION_SOURCE_MAX_BYTES});
    const after=await gitState(),primary=snapshot.roots.find(root=>root.id==='primary');
    const clean=primary?.kind==='git'?Boolean(before?.clean&&after?.clean&&before.commit===after.commit&&primary.sourceCommit===after.commit):undefined;
    return {id:snapshot.id,snapshot,...(clean!==undefined?{clean}:{}),...(clean?{checkedCommit:after!.commit}:{}),source:{snapshotId:snapshot.id,sha256:snapshot.sourceDigest,roots:snapshot.roots.map(root=>({id:root.id,sha256:root.sourceDigest,...(root.sourceCommit?{commit:root.sourceCommit}:{})}))}};
  }
  /** Materialize canonical permissions, never normalize them out of source identity. */
  private async prepareControllerSource(context:AgentToolBridgeContext,goal:Goal,run:ControllerRun,canonical:SourceRecord):Promise<SourceRecord>{
    let current=await this.captureControllerSource(context,goal,run.id);
    if(inspectionSourceContentMatches(current.source,canonical.source))return current;
    const contents=(snapshot:InspectionSnapshot)=>JSON.stringify(snapshot.manifest.roots.map(root=>({id:root.id,name:root.name,entries:root.entries.map(({mode:_mode,...entry})=>entry)})));
    if(contents(current.snapshot)!==contents(canonical.snapshot)){await this.snapshots.remove(current.snapshot);throw new Error('The evaluator workspace differs from the current integrated project or one of its reference folders. Changed bytes, paths and symlink targets require a fresh evaluator source context.');}
    const assertCurrent=()=>{
      context.signal.throwIfAborted();const saved=this.app.store.get<ControllerRun>('factory-controller-runs',run.id),actual=this.app.store.get<Goal>('goals',goal.id);
      if(this.closing||saved?.sessionId!==context.session.id||saved.chatId!==context.chat.id||saved.role!=='evaluator'||!['starting','running','waiting'].includes(saved.status)||actual?.revision!==goal.revision||['paused','completed','failed','canceled'].includes(actual.status)||!this.app.sessions.owns(context.session.id)||this.chats.isRunning(context.chat.id))throw new Error('The evaluator source preparation owner changed.');
    };
    const selected=await this.controllerContext(context,goal,run.id),paths=new Map([['primary',context.execution.workdir],...(selected.session.workingDirectories||[]).map(root=>[root.id,root.path] as [string,string])]);
    const originalEntries=new Map(current.snapshot.manifest.roots.map(root=>[root.id,new Map(root.entries.map(entry=>[entry.path,entry]))]));
    const changes=canonical.snapshot.manifest.roots.flatMap(root=>root.entries.filter(entry=>originalEntries.get(root.id)!.get(entry.path)!.mode!==entry.mode).map(entry=>({rootId:root.id,root:paths.get(root.id)!,entry}))).sort((left,right)=>right.entry.path.split('/').length-left.entry.path.split('/').length);
    let auditId:string|undefined;
    try{
      assertCurrent();
      const project=this.app.store.get<Project>('projects',goal.projectId)!,canonicalPaths=new Map([['primary',project.path],...(project.workingDirectories||[]).map(root=>[root.id,root.path] as [string,string])]);
      for(const change of changes){if(!change.root)throw new Error('The evaluator omitted a declared source root.');if(context.execution.kind==='host-macos'&&await realpath(change.root)===await realpath(canonicalPaths.get(change.rootId)!))throw new Error('Canonical source permissions cannot be changed while preparing an evaluator.');}
      const previous=await exportInspectionSnapshot({snapshot:current.snapshot,artifacts:this.artifacts,context:{goalId:goal.id,taskId:'control-evaluator',attemptId:run.id},signal:context.signal,limits:{maxBytes:INSPECTION_SOURCE_MAX_BYTES}});
      for(const artifact of [previous.sourceManifest,...previous.sourceArtifacts.map(root=>root.manifest)])this.app.store.set('factory-artifacts',artifact);
      auditId=randomUUID();this.app.store.set('controller-source-preparations',{id:auditId,controllerRunId:run.id,goalId:goal.id,goalRevision:goal.revision,sessionId:context.session.id,chatId:context.chat.id,status:'preparing',previous:current.source,previousTransfer:previous,canonical:canonical.source,changedModes:changes.length,createdAt:new Date().toISOString()});
      for(let offset=0;offset<changes.length;offset+=32){
        assertCurrent();const args=['-e',controllerModesScript,JSON.stringify(changes.slice(offset,offset+32))];
        if(context.execution.kind==='container'){const invocation=dockerInvocation(this.app.runtime.endpoint,['exec','--user','0',context.execution.containerId!,'/opt/enoughfactory/node/bin/node',...args]);await execute(invocation.command,invocation.args,{env:invocation.env,timeout:30000,maxBuffer:1024*1024,signal:context.signal});}
        else await execute(process.execPath,args,{timeout:30000,maxBuffer:1024*1024,signal:context.signal});
      }
      assertCurrent();const restored=await this.captureControllerSource(context,goal,run.id);
      if(!inspectionSourceContentMatches(restored.source,canonical.source)){await this.snapshots.remove(restored.snapshot);throw new Error('The evaluator source changed while canonical permissions were materialized.');}
      this.app.store.set('controller-source-preparations',{...this.app.store.get<{id:string}>('controller-source-preparations',auditId)!,status:'ready',actual:restored.source,completedAt:new Date().toISOString()});
      await this.snapshots.remove(current.snapshot);current=restored;return current;
    }catch(error){if(auditId)this.app.store.set('controller-source-preparations',{...this.app.store.get<{id:string}>('controller-source-preparations',auditId)!,status:'failed',error:(error as Error).message,completedAt:new Date().toISOString()});await this.snapshots.remove(current.snapshot);throw error;}
  }
  prepareControllerReview:NonNullable<FactoryInspectionPorts['prepareControllerReview']>=async input=>{
    if(!this.goalQuality(input.goal.id))return;
    const chat=input.run.chatId&&this.app.store.get<import('@enoughfactory/contracts').Chat>('chats',input.run.chatId);if(!chat)throw new Error('The evaluator source preparation conversation is unavailable.');
    const context:AgentToolBridgeContext={chat,session:this.app.sessions.record(input.run.sessionId),execution:this.app.sessions.execution(input.run.sessionId),signal:input.signal||new AbortController().signal};
    const canonical=await this.canonicalSource(input.goal,input.signal);let current:SourceRecord|undefined;
    try{
      if(canonical.clean===false)throw new Error('The integrated project changed before evaluator source preparation.');
      current=await this.prepareControllerSource(context,input.goal,input.run,canonical);
      const after=await this.canonicalSource(input.goal,input.signal);
      try{if(!inspectionSourceContentMatches(after.source,canonical.source)||after.clean===false||after.checkedCommit!==canonical.checkedCommit)throw new Error('The integrated project changed during evaluator source preparation.');}finally{await this.snapshots.remove(after.snapshot);}
    }finally{await this.snapshots.remove(canonical.snapshot);if(current)await this.snapshots.remove(current.snapshot);}
  };
  reviewController=async(input:{goal:Goal;run:ControllerRun;resultText:string;signal?:AbortSignal})=>{
    const quality=this.goalQuality(input.goal.id);if(!quality)return {ready:true,evidenceIds:[]};
    const decision=readJsonObject(input.resultText);
    // An actionable repair plan returns to planning. Missing canonical evidence
    // alone is a service-owned verification step, independent of a success claim.
    if(decision.complete!==true&&Array.isArray(decision.additionalTasks)&&decision.additionalTasks.length)return {ready:true,evidenceIds:[]};
    const chat=input.run.chatId&&this.app.store.get<import('@enoughfactory/contracts').Chat>('chats',input.run.chatId);
    if(!chat)return {ready:false,reason:'The evaluator conversation is unavailable.',evidenceIds:[]};
    const context:AgentToolBridgeContext={chat,session:this.app.sessions.record(input.run.sessionId),execution:this.app.sessions.execution(input.run.sessionId),signal:input.signal||new AbortController().signal};
    const canonical=await this.canonicalSource(input.goal,input.signal);
    let current:SourceRecord|undefined;
    try{let review:unknown;try{review=decision.visualReview;}catch{/* The protocol parser retains its own decision error. */}
      const tasks=this.app.store.list<FactoryTask>('tasks').filter(task=>task.goalId===input.goal.id);
      if(decision.complete!==true&&tasks.some(task=>!['completed','canceled'].includes(task.status)))return {ready:true,evidenceIds:[]};
      try{current=await this.prepareControllerSource(context,input.goal,input.run,canonical);}catch(error){input.signal?.throwIfAborted();return {ready:false,reason:(error as Error).message,evidenceIds:[]};}
      if(!inspectionSourceContentMatches(current.source,canonical.source))return {ready:false,reason:'The evaluator workspace differs from the current integrated project or one of its reference folders. Refresh verification from the current source; retained screenshots cannot certify changed or reverted code.',evidenceIds:[]};
      if(canonical.clean===false)return {ready:false,reason:'The integrated project has uncommitted changes or changed while its source was captured. Commit or restore those changes before final app verification; no completed commit can certify this working tree.',evidenceIds:[]};
      let checked=decision.complete===true?await this.quality.reviewCheck({goalId:input.goal.id,controllerRunId:input.run.id,source:canonical.source,quality,review}):{ready:false,reason:'Inspect the independently verified current integrated product before deciding completion.',evidenceIds:[] as string[]};
      {
        if(tasks.some(task=>!['completed','canceled'].includes(task.status)))return {ready:false,reason:'Finish or explicitly cancel the remaining goal tasks before final app verification. Their recorded requirements remain part of acceptance.',evidenceIds:[]};
        const anchors=tasks.filter(task=>task.status==='completed').flatMap(task=>{
          const attempt=task.currentAttemptId?this.app.store.get<Attempt>('attempts',task.currentAttemptId):undefined,detail=attempt?this.app.store.get<AttemptDetail>('factory-attempt-details',attempt.id):undefined;
          if(!attempt||attempt.status!=='succeeded'||!detail?.candidate||!detail.integration||detail.integration.candidateCommit!==detail.candidate.commit||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(detail.candidate.commit)||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(detail.integration.commit))return [];
          return [{task,attempt,detail}];
        }).sort((left,right)=>(right.attempt.endedAt||right.task.updatedAt||'').localeCompare(left.attempt.endedAt||left.task.updatedAt||'')||right.task.id.localeCompare(left.task.id));
        const anchor=anchors[0];
        if(!anchor||!canonical.checkedCommit){
          return {ready:false,reason:'Final verification needs a retained accepted candidate plus a clean integrated Git commit. Restore the accepted candidate and integration record or finish integration before verifying the app.',evidenceIds:[]};
        }else{
          const revision=anchor.detail.assignmentGoalRevision??anchor.detail.goalRevision??input.goal.revision;
          const authority:InspectionAuthority={goalId:input.goal.id,goalRevision:revision,taskId:anchor.task.id,attemptId:anchor.attempt.id,authorityGeneration:anchor.attempt.generation,policyRevision:revision};
          const source:InspectionSourceIdentity={...canonical.source,candidateId:anchor.detail.candidate!.id,candidateCommit:anchor.detail.candidate!.commit,checkedCommit:canonical.checkedCommit};
          const probe=await this.quality.check({authority,quality,source,candidateCommit:source.candidateCommit!,checkedCommit:source.checkedCommit});
          if(!probe.passed&&!probe.recovery)return {ready:false,reason:`Final app verification found defects that still require repair: ${probe.output}`,evidenceIds:[]};
          {
            const project=this.app.store.get<Project>('projects',input.goal.projectId)!;
            const verification=await this.verifier.ensure({authority,source,snapshot:canonical.snapshot,quality,project,purpose:'goal-final',goalRevision:input.goal.revision,signal:input.signal});
            if(verification.status!=='succeeded'||!verification.acceptanceContract||!verification.chatId)return {ready:false,reason:`Final app verification ${verification.status}: ${verification.reason||'Waiting for current-source screenshots and workflow assertions under the complete original acceptance contract. The accepted author attempt remains retained.'}`,evidenceIds:[]};
            const verified=await this.quality.check({authority,quality,source,candidateCommit:source.candidateCommit!,checkedCommit:source.checkedCommit,verification:{runId:verification.id,chatId:verification.chatId,acceptanceContractSha256:inspectionAcceptanceContractSha256(verification.acceptanceContract)}});
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
    return {mcpServers:{factory_review:bridge.server},systemInstructions:'Use factory_review_screens, factory_review_image, factory_review_evidence and factory_review_reference before judging app completion. Inspect original pixels and measured workflow assertions. The list provides current integrated source and quality requirements. If quality is present, your completion decision must include visualReview:{source:theCurrentSource,reviews:[{platform,observations:[actualScreenshotEvidenceId],references:[{id,comparison:concreteReferenceComparison}],dimensions:{hierarchy,spacing,clipping,typography,controls,states},defects:[{id,severity:minorOrMajorOrBlocking,status:openOrRepaired,description,observation}]}]}. View every screenshot you cite and inspect each required reference file yourself. Include all six dimensions as concrete critique text. Keep older source identities explicit; screenshot presence and accepted task counts alone do not establish current acceptance.',onToolImage:async image=>{
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
    const controllers=this.app.store.list<ControllerRun>('factory-controller-runs').filter(run=>run.sessionId===context.session.id&&run.chatId===context.chat.id);
    if(controllers.length>1)throw new Error('The execution source has ambiguous controller owners.');
    if(controllers.length){const run=controllers[0]!,goal=this.app.store.get<Goal>('goals',run.goalId);if(!goal)throw new Error('The controller source goal is unavailable.');context=await this.controllerContext(context,goal,run.id);}
    const roots=[{id:'primary',name:'primary',path:context.execution.workdir},...(context.session.workingDirectories||[]).map(root=>({id:root.id,name:root.name,path:root.path}))];
    let exported:Awaited<ReturnType<typeof exportInspectionContainerRoots>>|undefined;
    try{
      if(context.execution.kind==='container')exported=await exportInspectionContainerRoots({endpoint:this.app.runtime.endpoint,containerId:context.execution.containerId!,roots,scratchDirectory:path.join(this.app.dataDir,'inspection','exports'),signal:context.signal,limits:{maxBytes:INSPECTION_SOURCE_MAX_BYTES}});
      const snapshot=await this.snapshots.create({roots:exported?.roots||roots,signal:context.signal,maxBytes:INSPECTION_SOURCE_MAX_BYTES,context:authority?{goalId:authority.goalId,taskId:authority.taskId,attemptId:authority.attemptId}:undefined});
      const source:InspectionSourceIdentity={snapshotId:snapshot.id,sha256:snapshot.sourceDigest,roots:snapshot.roots.map(root=>({id:root.id,sha256:root.sourceDigest,...(root.sourceCommit?{commit:root.sourceCommit}:{})}))};
      const record={id:snapshot.id,snapshot,source};if(retain){if(!authority)throw new Error('Retained execution source requires an author owner.');await this.retention.retain(snapshot,authority);this.app.store.set('inspection-source-snapshots',record);}return record;
    }finally{await exported?.cleanup();}
  }
  private async call(context:AgentToolBridgeContext,token:string,name:string,args:Record<string,unknown>):Promise<unknown>{
    const authority=this.jobs.authorize(token).authority;
    const verification=context.chat.verificationRunId?await this.verifier.verificationSource(context):undefined;
    if(['factory_verification_history','factory_verification_evidence','factory_verification_image'].includes(name)){
      if(!verification)throw new Error('Historical inspection reads require an independent current verifier.');
      return new InspectionVerificationHistory({store:this.app.store,artifacts:this.artifacts,current:()=>this.verifier.verificationSource(context),qualityReports:this.quality}).call(name,args);
    }
    if(name==='factory_native_profile_status')return result(this.profileSetup.publicView(await this.profileSetup.status(String(args.auditId),authority,Number(args.waitSeconds)||0)));
    if(name==='factory_native_profile_propose'){
      const project=this.app.store.get<Project>('projects',context.session.projectId),projectId=project?.sourceProjectId||project?.id;if(!projectId)throw new Error('Native setup project is unavailable.');
      const source=await this.capture(context,authority);
      return result({audit:this.profileSetup.publicView(await this.profileSetup.propose({requestId:String(args.requestId),proposal:{profile:args.profile,auditPaths:args.auditPaths},authority,source:source.source,snapshot:source.snapshot,projectId,sourceSessionId:context.session.id,sourceChatId:context.chat.id}))});
    }
    const delegated=await this.delegation?.dispatch(context,token,name,args);if(delegated!==undefined)return delegated;
    if(name==='factory_quality_submit'){
      const detail=this.app.store.get<AttemptDetail>('factory-attempt-details',authority.attemptId),quality=verification?.run.quality||detail?.contract?.quality||this.app.store.get<FactoryTask>('tasks',authority.taskId)?.quality;
      if(!quality)throw new Error('This task has no configured visual/workflow acceptance contract.');
      const bound=verification?.run.acceptanceContract&&verification.run.chatId?{runId:verification.run.id,chatId:verification.run.chatId,acceptanceContractSha256:inspectionAcceptanceContractSha256(verification.run.acceptanceContract)}:undefined;
      if(bound&&!verificationContractFullyRead(verification!.run.acceptanceContract!,bound.runId,bound.chatId,this.app.store.events<VerificationContractRead>('inspection-verification-contract-reads',bound.runId).map(event=>event.value)))throw new Error('Read every original acceptance contract range with factory_verification_contract before submitting verification.');
      const checked=await this.quality.submit({authority,quality,report:args.report,...(bound?{verification:bound}:{})});this.app.emit('inspection-evidence',{authority,reportId:checked.id});return result(checked);
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
      const bound=verification?.run.acceptanceContract&&verification.run.chatId?{runId:verification.run.id,chatId:verification.run.chatId,acceptanceContractSha256:inspectionAcceptanceContractSha256(verification.run.acceptanceContract)}:undefined;
      this.app.store.set('factory-artifacts',artifact);this.app.store.set('inspection-reference-views',{id:randomUUID(),referenceId:args.referenceId,authority,source:source.source,artifactIds:[artifact.id],artifacts:[artifact],inspectedAt:new Date().toISOString(),...(bound?{verification:bound}:{})});
      return {content:[text({referenceId:args.referenceId,artifact}),mime.startsWith('image/')?{type:'image',mimeType:mime,data:bytes.toString('base64')}:{type:'text',text:bytes.toString('utf8').slice(0,128*1024)}]};
      };
      if(source.verificationRunId){const verified=await this.verifier.verificationSource(context);if(!verified||verified.run.id!==source.verificationRunId||verified.id!==source.id)throw new Error('This reference source belongs to another verifier.');return inspect(verified.snapshot);}
      if(this.app.store.get('inspection-source-retention',source.id))return this.retention.use(source.id,inspect,context.signal);
      await this.snapshots.verify(source.snapshot,context.signal);return inspect(source.snapshot);
    }
    if(name==='factory_verification_contract'){
      if(!verification?.run.acceptanceContract||verification.run.chatId!==context.chat.id)throw new Error('Only the current independent verifier can read its original acceptance contract.');
      const chunk=verificationContractChunk(verification.run.acceptanceContract,Number(args.offset),Number(args.maxCharacters));
      this.app.store.append('inspection-verification-contract-reads',verification.run.id,{runId:verification.run.id,chatId:context.chat.id,contractSha256:chunk.contractSha256,offset:chunk.offset,end:chunk.nextOffset});
      return result(chunk);
    }
    if(name==='factory_capabilities'){const project=this.app.store.get<Project>('projects',context.session.projectId),projectId=project?.sourceProjectId||project?.id||'',detail=this.app.store.get<AttemptDetail>('factory-attempt-details',authority.attemptId);return result({targets:await this.readiness(),delegatedTargets:await this.delegation?.capabilities(projectId)||[],profiles:this.profiles(projectId).map(profile=>({id:profile.id,build:profile.build})),quality:verification?.run.quality||detail?.contract?.quality||this.app.store.get<FactoryTask>('tasks',authority.taskId)?.quality});}
    if(name==='factory_job_status'){
      let job=this.ownJob(token,args.jobId);const seconds=Math.max(0,Math.min(30,Number(args.waitSeconds)||0));
      if(this.active.has(job.id)&&seconds){await Promise.race([this.active.get(job.id),new Promise(resolve=>setTimeout(resolve,seconds*1000))]);job=this.ownJob(token,args.jobId);}
      const backend=job.sessionId?this.app.store.get<BackendRecord>('inspection-backends',job.sessionId):undefined;
      return result({job,sessions:this.jobs.sessions(job.id),evidence:this.jobs.evidence(job.id),...(backend?.kind==='browser'&&job.sessionId&&this.jobs.getSession(job.sessionId)?.status==='ready'?{tools:await this.browser.listTools(backend.backendSessionId)}:{})});
    }
    if(name==='factory_native_build'||name==='factory_browser_start'){
      const isBuild=name==='factory_native_build',viewport=isBuild?undefined:validateBrowserViewport(args.viewport);
      const requestKey=createHash('sha256').update(JSON.stringify([authority,name,args.requestId])).digest('hex'),requestHash=createHash('sha256').update(JSON.stringify([name,args.profileId??null,...(viewport?[viewport]:[])])).digest('hex');
      const prior=this.app.store.get<{id:string;jobId:string;requestHash:string}>('inspection-request-jobs',requestKey);
      if(prior){if(prior.requestHash!==requestHash)throw new Error('Inspection request id was reused for different arguments.');return result({job:this.ownJob(token,prior.jobId),replayed:false});}
      const project=this.app.store.get<Project>('projects',context.session.projectId),profile=isBuild?this.profiles(project?.sourceProjectId||project?.id||'').find(profile=>profile.id===args.profileId):undefined;
      if(isBuild&&!profile)throw new Error(`Set up this native app with factory_native_profile_propose, then poll factory_native_profile_status. Its independent source audit issues the configured profile. Existing setup audits: ${JSON.stringify(this.profileSetup.list(project?.sourceProjectId||project?.id||'').map(run=>({id:run.id,profileId:run.proposal.profile.id,status:run.status,reason:run.reason})))}`);
      if(!isBuild&&context.execution.kind!=='container')throw new Error('Browser inspection currently requires a container author. Native authors use the Mac/iPhone inspection tools.');
      const source=await this.capture(context,authority);
      const job=this.jobs.createJob(token,{idempotencyKey:String(args.requestId),executionTargetId:isBuild?'mac-host':'container',capability:isBuild?'apple-compilation':'chromium-inspection',source:source.source,profile:isBuild?{profileId:profile!.id}:viewport?{viewport}:{} });
      this.app.store.set('inspection-submissions',{id:job.id,kind:isBuild?'build':'browser',chatSessionId:context.session.id,containerId:context.execution.containerId,profile,snapshot:source.snapshot,...(viewport?{viewport}:{})} satisfies Submission);
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
      const structured=this.app.store.get<{id:string;elements:Array<{label?:string;identifier?:string;value?:string}>;truncated:boolean;formValues?:{artifact:{id:string;sha256:string}}}>('inspection-structured-observations',String(args.observationId));
      if(!structured)throw new Error('This observation has no complete structured assertions. Use a native observation or a browser assertion tool.');
      if(args.absent===true&&structured.truncated)throw new Error('A truncated observation cannot prove an element is absent.');
      const passed=evaluateObservedCondition(structured.elements,{labelIncludes:needle,...(args.labelEquals!==undefined?{labelEquals:args.labelEquals as string}:{}),...(args.valueIncludes!==undefined?{valueIncludes:args.valueIncludes as string}:{}),...(args.valueEquals!==undefined?{valueEquals:args.valueEquals as string}:{}),...(args.absent===true?{absent:true}:{})});
      const artifact=await this.artifacts.put(JSON.stringify({passed,observationId:args.observationId,condition:args,observedAt:observation?.createdAt,...(structured.formValues?{formValuesArtifact:structured.formValues.artifact}:{})}),{goalId:authority.goalId,taskId:authority.taskId,attemptId:authority.attemptId,name:'workflow-assertion.json',mime:'application/json'});
      const evidence=this.jobs.publishEvidence(session.jobId,{kind:'assertion',sessionId:session.id,artifact,metadata:{passed,observationId:args.observationId,...(structured.formValues?{formValuesArtifactId:structured.formValues.artifact.id,formValuesArtifactSha256:structured.formValues.artifact.sha256}:{}),platform:backend.kind==='browser'?'web':session.capability==='macos-app-inspection'?'macos':'ios-simulator'}});this.app.store.set('factory-artifacts',artifact);return result({passed,evidenceId:evidence.id});
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
      const observes=name==='factory_observe'||browserTool==='browser_snapshot'||browserTool==='browser_take_screenshot';
      const formCall=(tool:string,arguments_:Record<string,unknown>)=>this.browser.call(backend.backendSessionId,tool,arguments_,browserOptions);
      const formFrame=observes?await beginBrowserFormObservation({backendSessionId:backend.backendSessionId,sourceSha256:session.source.sha256,authority},supported.map(tool=>tool.name),formCall):undefined;
      let observed=await this.browser.call(backend.backendSessionId,name==='factory_observe'?'browser_snapshot':browserTool,actionArgs,browserOptions);
      let snapshotResponse=observed;
      if(name==='factory_observe'||browserTool==='browser_take_screenshot'){
        const companion=await this.browser.call(backend.backendSessionId,name==='factory_observe'?'browser_take_screenshot':'browser_snapshot',name==='factory_observe'?{type:'png'}:{},browserOptions);
        if(browserTool==='browser_take_screenshot')snapshotResponse=companion;
        observed={...observed,result:{content:[...observed.result.content,...companion.result.content],isError:observed.result.isError||companion.result.isError},artifacts:[...observed.artifacts,...companion.artifacts]};
      }
      await this.assertBrowserSource(context,session.jobId);
      for(const artifact of observed.artifacts)this.app.store.set('factory-artifacts',artifact);
      const screenshots=observed.artifacts.filter(artifact=>artifact.mime.startsWith('image/'));
      const snapshotText=snapshotResponse.result.content.filter(block=>block.type==='text').map(block=>block.text||'').join('\n');
      const parsed=parseBrowserObservation(snapshotText);
      const exactForms=formFrame&&!observed.result.isError?await completeBrowserFormObservation(formFrame,parsed,snapshotText,formCall):undefined;
      await this.assertBrowserSource(context,session.jobId);
      const tree=parsed.uiTree;
      const evidence=screenshots.map(artifact=>this.jobs.publishEvidence(session.jobId,{kind:'screenshot',sessionId:session.id,actionId:begun.action.id,artifact,metadata:{platform:'web'}}));
      let observationId:string|undefined;
      if(observes&&!observed.result.isError&&exactForms?.observationCurrent!==false)observationId=this.jobs.recordObservation(begun.action.id,{uiTree:tree,elementIds:parsed.elementIds,screenshotEvidenceId:evidence[0]?.id}).id;
      const formArtifact=exactForms&&(parsed.formFields.length||exactForms.raw.reads.length)?await this.artifacts.put(Buffer.from(JSON.stringify({...exactForms.raw,inspectionSessionId:session.id,actionId:begun.action.id,observationId,source:session.source})),{goalId:authority.goalId,taskId:authority.taskId,attemptId:authority.attemptId,name:'browser-exact-form-observation.json',mime:'application/json'}):undefined;
      if(formArtifact)this.app.store.set('factory-artifacts',formArtifact);
      this.jobs.authorize(token);await this.assertBrowserSource(context,session.jobId);
      if(observationId)this.app.store.set('inspection-structured-observations',{id:observationId,elements:exactForms?.elements??parsed.elements,truncated:parsed.truncated,...(formArtifact?{formValues:{artifact:formArtifact,complete:exactForms!.raw.complete,reason:exactForms!.raw.reason}}:{})});
      const pageInvalid=exactForms?.observationCurrent===false;
      this.jobs.actionComplete(begun.action.id,{status:observed.result.isError||pageInvalid?'failed':'succeeded',...(pageInvalid?{reason:exactForms.raw.reason}:{}),evidenceIds:evidence.map(item=>item.id)});
      return {...observed.result,...(pageInvalid?{isError:true}:{}),content:[text({sessionId:session.id,actionId:begun.action.id,observationId,evidenceIds:evidence.map(item=>item.id),...(exactForms?{exactFormValues:{elements:pageInvalid?[]:exactForms.elements,complete:exactForms.raw.complete,reason:exactForms.raw.reason,...(formArtifact?{artifact:formArtifact}:{})}}:{})}),...observed.result.content]};
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
        const owned=await this.browser.prepare({id:session.id,sessionId:submission.chatSessionId,goalId:selected.authority.goalId,taskId:selected.authority.taskId,attemptId:selected.authority.attemptId,authorContainerId:submission.containerId!,authorityGeneration:selected.authority.authorityGeneration,source:{snapshotSha256:selected.source.sha256,dirty:true},...(submission.viewport?{viewport:submission.viewport}:{})},{signal,assertCurrent:()=>{if(!this.authorityCurrent(selected.authority))throw new Error('The author assignment changed.');}});
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
  private async recoverOwnedBuilds(run?:InspectionVerificationRun):Promise<void>{
    for(const job of this.jobs.listJobs().filter(job=>job.ownerDeviceId===this.app.device.id&&(!run||this.verifierOwnsJob(run,job))&&job.capability==='apple-compilation'&&job.status==='unknown'&&!this.inspectionJobActive(job)&&!this.app.store.get('inspection-delegation-owner-jobs',job.id))){
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
    const related=this.jobs.listJobs().filter(job=>this.verifierOwnsJob(run,job));
    return related.every(job=>!this.inspectionJobActive(job)&&['succeeded','failed','canceled'].includes(job.status)&&this.jobs.sessions(job.id).every(session=>session.status==='stopped')&&this.jobs.leases(job.id).every(lease=>lease.status!=='held'));
  }
  private verifierOwnsJob(run:InspectionVerificationRun,job:InspectionJob):boolean{return job.authority.attemptId===run.authority.attemptId||job.source.snapshotId===run.source.snapshotId;}
  private inspectionJobActive(job:InspectionJob):boolean{return this.active.has(job.id)||[...this.contexts.values()].some(context=>!context.signal.aborted&&context.attemptId===job.authority.attemptId);}
  private async reconcileVerifierInspection(run:InspectionVerificationRun,signal:AbortSignal):Promise<boolean>{
    signal.throwIfAborted();await this.recoverOwnedSessions(run);await this.recoverOwnedBuilds(run);signal.throwIfAborted();return this.canRetireVerifier(run);
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
  private async recoverOwnedSessions(run?:InspectionVerificationRun):Promise<void>{
    for(const job of this.jobs.listJobs().filter(job=>job.ownerDeviceId===this.app.device.id&&(!run||this.verifierOwnsJob(run,job))&&!this.inspectionJobActive(job)&&!this.app.store.get('inspection-delegation-owner-jobs',job.id))){
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
    this.closing=true;this.hostPreparationGeneration++;this.hostPreparationAbort?.abort();if(this.timer)clearInterval(this.timer);for(const bridge of this.bridges)await bridge.close();this.bridges.clear();
    for(const job of this.jobs.listJobs().filter(job=>job.ownerDeviceId===this.app.device.id&&['preparing','running','waiting','cancellation-requested'].includes(job.status)))this.jobs.markUnknown(job.id,'Device service closed; reconcile owned effects before replacement.');
    await this.profileSetup.close();await this.verifier.close();await this.delegation?.close();await this.builds.close();await this.native.closeTransport();
  }
}


export async function initializeInspection(app:DeviceApp,chats:ChatController,network?:{peers:PeerManager}):Promise<InspectionService>{const service=new InspectionService(app,chats,network);await service.initialize();return service;}
