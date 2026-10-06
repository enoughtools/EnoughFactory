import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { PeerManager } from '../packages/peers/src/index.ts';
import { createSignalingService, configFromEnvironment } from '../services/signaling/src/server.ts';
import { handlePolicyFixture } from './distributed-policy-fixture.ts';
import type { Attempt, ContainerRuntimeStatus, Decision, Device, FactoryTask, Goal, Project, Session } from '../packages/contracts/src/index.ts';
import type { ArtifactManifest, Candidate } from '../packages/workspaces/src/types.ts';

// Deliberate inference-bearing product journey, not a CI suite. The Linux worker
// is a native guest OS on this Mac, not a claim about two physical computers.
// Both app services and both private engines run actual production implementations.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = process.env.ENOUGHFACTORY_DISTRIBUTED_FIXTURE || await mkdtemp('/tmp/ef-distributed-');
const repository = path.join(fixture, 'repository');
const home = path.join(fixture, 'coordinator');
const resources = path.join(fixture, 'mac-resources');
const sourceResources = process.env.ENOUGHFACTORY_DISTRIBUTED_MAC_RESOURCES || path.join(root, 'releases/mac-arm64/EnoughFactory.app/Contents/Resources');
const serviceBundle = process.env.ENOUGHFACTORY_DISTRIBUTED_SERVICE || path.join(root, '.cache/distributed-service-0.1.2/service.cjs');
const expectedServiceHash = process.env.ENOUGHFACTORY_DISTRIBUTED_SERVICE_SHA256 || 'a1e0efdfc322fcfd46cbc42a1d7649f5b92052128d9494d7aa6ed40181756bd7';
const limaHome = process.env.ENOUGHFACTORY_DISTRIBUTED_LIMA_HOME || path.join(homedir(),'.enoughfactory/container/lima');
const limactl = process.env.ENOUGHFACTORY_DISTRIBUTED_LIMACTL || path.join(root, '.cache/container-runtime/darwin-arm64/lima/bin/limactl');
const guestRoot = process.env.ENOUGHFACTORY_DISTRIBUTED_GUEST_ROOT || '/home/enoughfactory.guest/enoughfactory-distributed-proof';
// Historical native asset default from this Mac/Ubuntu ARM64 fixture.
const guestResources = process.env.ENOUGHFACTORY_DISTRIBUTED_GUEST_RESOURCES || path.posix.join(guestRoot, 'EnoughFactory-0.1.1-linux-arm64/resources');
const workerHome = path.posix.join(guestRoot, 'state');
const providerHome = path.posix.join(guestRoot, 'provider-home');
const shared = path.join(limaHome, '../shared/distributed-worker-assets');
const coordinatorPort = Number(process.env.ENOUGHFACTORY_DISTRIBUTED_PORT || 4346);
const workerPort = Number(process.env.ENOUGHFACTORY_DISTRIBUTED_WORKER_PORT || 4347);
const signalingPort = Number(process.env.ENOUGHFACTORY_DISTRIBUTED_SIGNALING_PORT || 44437);
const signalingUrl = `ws://127.0.0.1:${signalingPort}/ws`;
const deadline = Date.now() + 35 * 60_000;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const steps: Array<{at:string;event:string;detail?:unknown}> = [];
const services: Service[] = [];
let reverse: ChildProcess | undefined;
let policyPeer: PeerManager | undefined;
let goalId: string | undefined;
let evidence: Record<string, unknown> | undefined;
const signaling = createSignalingService(configFromEnvironment({ ...process.env, ENOUGH_SIGNALING_HOST:'127.0.0.1',PORT:String(signalingPort),ENOUGH_SIGNALING_ALLOW_RELAY:'false',STUN_URLS:'stun:stun.cloudflare.com:3478',TURN_URLS:undefined,TURN_SECRET:undefined }));
function record(event: string, detail?: unknown) { steps.push({at:new Date().toISOString(),event,detail}); console.log(event, detail===undefined?'':JSON.stringify(detail)); }
function command(program: string,args: string[],cwd?:string,env?:NodeJS.ProcessEnv): string {
  const result=spawnSync(program,args,{cwd,env,encoding:'utf8',timeout:120_000,maxBuffer:16*1024*1024});
  assert.equal(result.status,0,result.stderr||result.error?.message);return result.stdout.trim();
}
function guest(args:string[]):string { return command(limactl,['shell','factory',...args],root,{...process.env,LIMA_HOME:limaHome}); }
function guestNode(script:string,args:string[]=[]):string { return guest([path.posix.join(guestResources,'runtime/node'),'-e',script,...args]); }
function rows<T>(directory:string,bucket:string,remote=false):T[] {
  if(remote)return JSON.parse(guestNode('const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.stringify(db.prepare("SELECT value FROM records WHERE bucket=?").all(process.argv[2]).map(x=>JSON.parse(x.value))));db.close();',[path.posix.join(directory,'factory.sqlite'),bucket]));
  const db=new DatabaseSync(path.join(directory,'factory.sqlite'),{readOnly:true});try{return db.prepare('SELECT value FROM records WHERE bucket=?').all(bucket).map(row=>JSON.parse(String(row.value)) as T);}finally{db.close();}
}
interface Snapshot {goal:Goal;tasks:FactoryTask[];attempts:Attempt[];decisions:Decision[];evaluations:Array<{head:string;evaluation:{complete:boolean;criteria:Array<{criterion:string;satisfied:boolean;evidence:string[]}>}}>}
interface WorkerRecord {id:string;coordinatorId:string;status:string;goal:Goal;attempt:Attempt;workspace?:{deviceId:string;baseCommit:string;projectPath:string};candidate?:Candidate;sessionId?:string;chatId?:string}
interface Received {id:string;peerId:string;manifest:ArtifactManifest;path:string}
class Service {
  child?:ChildProcess; token='';log=''; runtime?:ContainerRuntimeStatus;
  constructor(readonly name:string,readonly port:number,readonly dataDir:string,readonly remote:boolean) { services.push(this); }
  async api<T>(route:string,method='GET',body?:unknown):Promise<T> {
    let response:Response|undefined;
    for(let retry=0;retry<3;retry++){try{response=await fetch(`http://127.0.0.1:${this.port}${route}`,{method,headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120_000)});break;}catch(error){if(method!=='GET'||retry===2)throw error;this.alive();await delay(300);}}
    assert.ok(response);
    const result=await response.json();assert.equal(response.ok,true,`${this.name} ${method} ${route}: ${JSON.stringify(result)}`);return result as T;
  }
  async start():Promise<void> {
    this.log='';
    const runtimeResources=this.remote?guestResources:resources;
    const env:NodeJS.ProcessEnv={...process.env,ENOUGHFACTORY_HOME:this.dataDir,ENOUGHFACTORY_PORT:String(this.port),ENOUGHFACTORY_RESOURCES:runtimeResources,ENOUGHFACTORY_ENVMUX_PATH:path.join(runtimeResources,'envmux/envmux'),ENOUGHFACTORY_WEB_PATH:path.join(runtimeResources,'web'),ENOUGHFACTORY_CONTAINER_ASSETS:path.join(runtimeResources,'runtime/container'),ENOUGHFACTORY_CHECK_IMAGE:'node:22-bookworm',DOCKER_HOST:'unix:///tmp/enoughfactory-unowned-do-not-use.sock',DOCKER_CONTEXT:'enoughfactory-unowned',DOCKER_CONFIG:path.join(fixture,'unowned-docker-config')};
    if(this.remote) {
      // Explicit HOME copies only the already-authorized Codex credential into
      // containers. It does not grant the host home to the agent workspace.
      const assignments=['HOME='+providerHome,'XDG_RUNTIME_DIR=/run/user/501',...Object.entries(env).filter(([key])=>key.startsWith('ENOUGHFACTORY_')||key.startsWith('DOCKER_')).map(([key,value])=>`${key}=${value}`)];
      this.child=spawn(limactl,['shell','factory','env',...assignments,path.posix.join(runtimeResources,'runtime/node'),path.posix.join(runtimeResources,'device/service.cjs')],{cwd:root,env:{...process.env,LIMA_HOME:limaHome},stdio:['ignore','pipe','pipe']});
    } else this.child=spawn(path.join(resources,'runtime/node'),[path.join(resources,'device/service.cjs')],{cwd:fixture,env,stdio:['ignore','pipe','pipe']});
    for(const stream of [this.child.stdout,this.child.stderr])stream?.on('data',bytes=>{this.log=(this.log+bytes.toString()).slice(-200_000);});
    for(let i=0;i<150;i++) {
      assert.equal(this.child.exitCode,null,`${this.name} exited: ${this.log.slice(-5000)}`);
      try {
        const connection=JSON.parse(this.remote?guestNode('console.log(require("node:fs").readFileSync(process.argv[1],"utf8"))',[path.posix.join(this.dataDir,'connection.json')]):await readFile(path.join(this.dataDir,'connection.json'),'utf8'));
        this.token=connection.token;
        const health=await this.api<{version:string}>('/api/health');assert.equal(health.version,'0.1.2');record('service-ready',{name:this.name,platform:this.remote?'linux':'darwin',arch:'arm64',port:this.port});return;
      } catch { await delay(300); }
    }
    throw new Error(`${this.name} did not become ready: ${this.log.slice(-5000)}`);
  }
  async readyRuntime():Promise<ContainerRuntimeStatus> {
    const initial=await this.api<ContainerRuntimeStatus>('/api/runtime');if(initial.state!=='ready')await this.api('/api/runtime/start','POST',{});
    let previous='';
    while(Date.now()<deadline) {
      const status=await this.api<ContainerRuntimeStatus>('/api/runtime');
      const progress=JSON.stringify({name:this.name,state:status.state,phase:status.phase,error:status.error});if(previous!==progress){record('owned-runtime',JSON.parse(progress));previous=progress;}
      assert.ok(!['failed','unavailable'].includes(status.state),status.error||JSON.stringify(status.requiredActions));
      if(status.state==='ready') {
        assert.equal(status.kind,this.remote?'rootless':'lima');assert.notEqual(status.socketPath,'/var/run/docker.sock');assert.notEqual(status.socketPath,'/tmp/enoughfactory-unowned-do-not-use.sock');
        if(this.remote)assert.ok(status.dataDirectory.startsWith(this.dataDir+'/'));
        else if(!status.dataDirectory.startsWith(this.dataDir+'/')) {
          const receipt=JSON.parse(await readFile(path.join(this.dataDir,'container/runtime-location.json'),'utf8'));assert.equal(receipt.directory,status.dataDirectory);const metadata=await lstat(path.dirname(status.dataDirectory));assert.equal(metadata.uid,process.getuid?.());assert.equal(metadata.mode&0o777,0o700);
        }
        this.runtime=status;record('private-engine-ready',{name:this.name,kind:status.kind,socketPath:status.socketPath,dataDirectory:status.dataDirectory,dockerVersion:status.dockerVersion});return status;
      }
      await delay(1000);
    }
    throw new Error(`${this.name} runtime timed out`);
  }
  alive() {assert.ok(this.child&&this.child.exitCode===null&&this.child.signalCode===null,`${this.name} exited: ${this.log.slice(-5000)}`);}
  async stop():Promise<void> {
    if(!this.child||this.child.exitCode!==null||this.child.signalCode!==null)return;
    const live=this.child;await this.api('/api/service/shutdown','POST',{});
    if(live.exitCode===null&&live.signalCode===null)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`${this.name} did not stop`)),30_000);live.once('exit',()=>{clearTimeout(timer);resolve();});});
    record('service-stopped',{name:this.name});
  }
  async cleanRuntime():Promise<void> {
    if(!this.runtime||!this.child||this.child.exitCode!==null||this.child.signalCode!==null)return;
    const state=await this.api<{sessions:Session[]}>('/api/state?local=1');
    if(state.sessions.some(session=>!['stopped','failed'].includes(session.status))) { record('runtime-retained-for-diagnosis',{name:this.name});return; }
    const status=await this.api<ContainerRuntimeStatus>('/api/runtime');assert.equal(status.socketPath,this.runtime.socketPath);await this.api('/api/runtime/stop','POST',{});
    for(let i=0;i<120;i++){const current=await this.api<ContainerRuntimeStatus>('/api/runtime');if(current.state==='stopped'){record('private-engine-stopped',{name:this.name,socketPath:current.socketPath});return;}assert.notEqual(current.state,'failed',current.error);await delay(1000);}
    throw new Error(`${this.name} private runtime did not stop`);
  }
}
const coordinator=new Service('Mac coordinator',coordinatorPort,home,false);
const worker=new Service('Linux ARM worker',workerPort,workerHome,true);
async function observe<T>(label:string,read:()=>Promise<T>,ready:(value:T)=>boolean):Promise<T> {
  let previous='';while(Date.now()<deadline) {
    for(const service of services)service.alive();const value=await read();const snapshot=value as Partial<Snapshot>;
    if(snapshot.goal){const progress=JSON.stringify({status:snapshot.goal.status,nextAction:snapshot.goal.nextAction,tasks:snapshot.tasks?.map(task=>({id:task.id,status:task.status,deviceId:task.deviceId})),attempts:snapshot.attempts?.map(attempt=>({id:attempt.id,status:attempt.status,deviceId:attempt.deviceId,candidate:attempt.candidate}))});if(progress!==previous){record(label,JSON.parse(progress));previous=progress;}assert.ok(!['failed','canceled','waiting'].includes(snapshot.goal.status),`Factory needs intervention: ${progress}`);}
    if(ready(value))return value;await delay(400);
  }throw new Error(`${label} timed out`);
}
async function rtcConnected():Promise<{coordinator:Device;worker:Device}> {
  return observe('paired-RTC',async()=>({coordinator:await coordinator.api<{device:Device;devices:Device[]}>('/api/state'),worker:await worker.api<{device:Device;devices:Device[]}>('/api/state?local=1')}),state=>Boolean(state.coordinator.devices.find(device=>device.id===state.worker.device.id&&device.online&&device.transport==='webrtc')&&state.worker.devices.find(device=>device.id===state.coordinator.device.id&&device.online&&device.transport==='webrtc'))).then(state=>({coordinator:state.coordinator.device,worker:state.worker.device}));
}
async function policyFixture():Promise<unknown> {
  policyPeer=await PeerManager.create({dataDir:path.join(fixture,'policy-coordinator'),name:'Enough policy fixture coordinator',signalingUrl,relayFallback:false,transport:'webrtc',onRequest:async(peerId,request)=>({v:1,id:request.id,status:200,body:await handlePolicyFixture(request.body)})});await policyPeer.start();
  const invitePath=path.join(shared,'policy-invitation.json');await writeFile(invitePath,JSON.stringify(policyPeer.createInvitation()),{mode:0o600});
  const output=path.join(shared,'policy-fixture.cjs');await build({entryPoints:[path.join(root,'scripts/distributed-policy-fixture.ts')],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:output,external:['node-datachannel'],banner:{js:'const __enoughfactoryImportMetaUrl = require("node:url").pathToFileURL(__filename).href;'},define:{'import.meta.url':'__enoughfactoryImportMetaUrl'}});
  guest(['cp',output,path.posix.join(guestResources,'device/policy-fixture.cjs')]);
  // No invite/credential values are arguments or diagnostic output.
  const child=spawn(limactl,['shell','factory','env','ENOUGHFACTORY_POLICY_WORKER=1',`ENOUGHFACTORY_POLICY_DATA_DIR=${guestRoot}/policy-worker`,`ENOUGHFACTORY_POLICY_INVITATION_FILE=${invitePath}`,path.posix.join(guestResources,'runtime/node'),path.posix.join(guestResources,'device/policy-fixture.cjs')],{cwd:root,env:{...process.env,LIMA_HOME:limaHome},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout?.on('data',bytes=>{stdout+=bytes.toString();});child.stderr?.on('data',bytes=>{stderr+=bytes.toString();});
  try {await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Typed approval RTC fixture timed out'));},90_000);child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Typed approval fixture failed: ${stderr.slice(-3000)}`));});});const receipt=JSON.parse(stdout.trim().split('\n').at(-1)!);assert.equal(receipt.connectionInfo.transport,'webrtc');record('typed-policy-through-RTC',receipt);return receipt;}
  finally{await rm(invitePath,{force:true});await policyPeer.stop();policyPeer=undefined;}
}
async function verifyReceived(record:Received,remote=false):Promise<void> {
  const actual=remote?guestNode('const fs=require("node:fs"),crypto=require("node:crypto");const data=fs.readFileSync(process.argv[1]);console.log(JSON.stringify({size:data.length,sha256:crypto.createHash("sha256").update(data).digest("hex")}));',[record.path]):(()=>undefined)();
  const bytes=remote?undefined:await readFile(record.path);const content=remote?JSON.parse(actual!):{size:bytes!.length,sha256:hash(bytes!)};assert.equal(content.size,record.manifest.size);assert.equal(content.sha256,record.manifest.sha256);
}

record('fixture-created',{fixture,repository,scope:'Two native OS services and independent private engines on one physical Mac; actual paired RTC factory protocol.'});
if(process.env.ENOUGHFACTORY_DISTRIBUTED_VERIFY_ONLY==='1') {
  // Cleanup may have removed the fixture's copied resources. Recreate only
  // this private copy; verification never starts an engine or stages auth.
  const recreated=!existsSync(resources);
  if(recreated){await cp(sourceResources,resources,{recursive:true});await cp(serviceBundle,path.join(resources,'device/service.cjs'));}
  try {await verifyCompletedFixture();} finally {if(recreated)await rm(resources,{recursive:true,force:true});}
} else try {
  assert.equal(process.platform,'darwin');
  if(existsSync(path.join(home,'factory.sqlite')))assert.equal(rows<Goal>(home,'goals').length,0,'A fixture with retained goals requires ENOUGHFACTORY_DISTRIBUTED_VERIFY_ONLY=1; never launch duplicate inference.');assert.equal(hash(await readFile(serviceBundle)),expectedServiceHash);
  await mkdir(repository,{recursive:true});await mkdir(shared,{recursive:true});await cp(sourceResources,resources,{recursive:true});await cp(serviceBundle,path.join(resources,'device/service.cjs'));await cp(serviceBundle,path.join(shared,'service-0.1.2.cjs'));guest(['cp',path.join(shared,'service-0.1.2.cjs'),path.posix.join(guestResources,'device/service.cjs')]);
  assert.equal(guestNode('console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))',[path.posix.join(guestResources,'device/service.cjs')]),expectedServiceHash);
  const resourceIdentity={serviceSha256:expectedServiceHash,version:'0.1.2',source:'Current 0.1.2 portable service including Store migrations; unchanged verified v0.1.1 native Node/envmux/RTC/container assets in isolated copied trees',mac:JSON.parse(await readFile(path.join(resources,'bundle-provenance.json'),'utf8')),linux:JSON.parse(guestNode('console.log(require("node:fs").readFileSync(process.argv[1],"utf8"))',[path.posix.join(guestResources,'bundle-provenance.json')]))};
  record('service-payload-verified',{sha256:expectedServiceHash,version:'0.1.2'});
  // Stage the already-authorized account in this local VM through a private
  // transient file; neither its contents nor pairing credentials enter logs.
  const authTransit=path.join(shared,'authorized-codex-auth.json');
  await writeFile(authTransit,await readFile(path.join(process.env.HOME!,'.codex/auth.json')),{mode:0o600});
  try { guest(['mkdir','-p',path.posix.join(providerHome,'.codex')]);guest(['cp',authTransit,path.posix.join(providerHome,'.codex/auth.json')]);guest(['chmod','600',path.posix.join(providerHome,'.codex/auth.json')]); } finally { await rm(authTransit,{force:true}); }
  assert.equal(guestNode('const fs=require("node:fs");const s=fs.statSync(process.argv[1]);console.log(s.isFile()&&((s.mode&0o077)===0)?"private":"invalid")',[path.posix.join(providerHome,'.codex/auth.json')]),'private');
  await writeFile(path.join(repository,'README.md'),'# Distributed slug CLI\n\nA small dependency-free command-line utility.\n');
  await writeFile(path.join(repository,'.envmux.json'),JSON.stringify({name:'distributed-factory-proof',portal:{open:false},tools:{},tasks:{ready:{command:'printf "factory-environment-ready\\n"',kind:'once'}}},null,2));
  command('git',['init'],repository);command('git',['config','user.name','EnoughFactory'],repository);command('git',['config','user.email','factory@enoughtools.com'],repository);command('git',['add','.'],repository);if(spawnSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).status!==0)command('git',['commit','-m','Disposable distributed factory fixture'],repository);else assert.equal(command('git',['status','--porcelain'],repository),'');
  const initialHead=command('git',['rev-parse','HEAD'],repository);
  await signaling.listen();record('private-signaling-ready',{port:signalingPort,relayAllowed:false});
  reverse=spawn('/usr/bin/ssh',['-F',path.join(limaHome,'factory/ssh.config'),'-o','ControlMaster=no','-o','ControlPath=none','-o','ExitOnForwardFailure=yes','-N','-R',`127.0.0.1:${signalingPort}:127.0.0.1:${signalingPort}`,'lima-factory'],{stdio:['ignore','ignore','pipe']});let reverseError='';reverse.stderr?.on('data',bytes=>{reverseError+=bytes.toString();});await delay(500);assert.equal(reverse.exitCode,null,reverseError);
  await coordinator.start();await worker.start();
  await Promise.all([coordinator.readyRuntime(),worker.readyRuntime()]);
  await coordinator.api('/api/settings','PATCH',{deviceName:'Distributed Mac coordinator',signalingUrl});await worker.api('/api/settings','PATCH',{deviceName:'Distributed Linux worker',signalingUrl});
  // Settings changes reconfigure signaling after the service's debounced state
  // notification; let that lifecycle settle before requesting an invitation.
  await delay(500);
  const invitation=await coordinator.api<{code:string}>('/api/devices/invite','POST',{});await worker.api('/api/devices/pair','POST',{code:invitation.code});
  const identities=await rtcConnected();assert.notEqual(identities.coordinator.id,identities.worker.id);assert.equal(identities.worker.platform,'linux');assert.equal(identities.worker.arch,'arm64');record('factory-devices-paired',{coordinatorId:identities.coordinator.id,workerId:identities.worker.id,transport:'webrtc'});
  const typedPolicy=await policyFixture();
  for(const service of services){assert.equal((await fetch(`http://127.0.0.1:${service.port}/api/state`)).status,401);const diagnostics=await service.api<{docker:{available:boolean};envmux:{available:boolean;error?:string}}>('/api/diagnostics');assert.equal(diagnostics.docker.available,true);assert.equal(diagnostics.envmux.available,true,diagnostics.envmux.error);}
  const project=await coordinator.api<Project>('/api/projects','POST',{path:repository,name:'Distributed factory product journey',runtime:'codex',approvalMode:'approve-all'});
  const criteria=[
    'bin/slug.sh accepts one text argument and prints lowercase ASCII letters/digits separated by single hyphens with no leading/trailing hyphens; Hello__World!! produces hello-world.',
    'Whitespace-only or punctuation-only input exits 2 with a clear stderr error; tests/slug.test.sh passes normal, mixed-case, repeated separator, empty-result and digit cases.',
    'README.md documents invocation, normalization, empty-result exit status and tests; all source is integrated into this repository.'
  ];
  const goal=await coordinator.api<Goal>('/api/goals','POST',{projectId:project.id,title:'Ship the distributed slug CLI',objective:`Build and document a useful dependency-free POSIX shell slug CLI in bin/slug.sh with focused tests in tests/slug.test.sh. Use exactly ONE compact implementation task covering code, tests and docs, and set that planned task's deviceId to ${identities.worker.id} (the paired Linux ARM worker). This explicit remote placement is a requirement: the Mac is coordinator/planner/evaluator only. Run checks with bash tests/slug.test.sh using standard shell tools only (no packages or Node/Python). Preserve .envmux.json unchanged, make source executable, and complete the actual goal.`,criteria,runtime:'codex',approvalMode:'approve-all',autonomy:'autonomous',concurrency:1,maxAttempts:2,maxDurationMs:28*60_000});goalId=goal.id;assert.equal(goal.coordinatorId,identities.coordinator.id);record('real-distributed-autonomous-goal-created',{goalId,approvalMode:goal.approvalMode,autonomy:goal.autonomy,workerId:identities.worker.id});
  const read=()=>coordinator.api<Snapshot>(`/api/goals/${goal.id}`);
  const dispatched=await observe('factory-progress',read,snapshot=>snapshot.attempts.some(attempt=>attempt.status==='running'));
  assert.equal(dispatched.tasks.length,1);const first=dispatched.attempts[0]!;assert.equal(first.deviceId,identities.worker.id);assert.equal(dispatched.tasks[0]!.deviceId,identities.worker.id);
  await coordinator.api(`/api/goals/${goal.id}/pause`,'POST',{});record('coordinator-paused-worker-keeps-running',{attemptId:first.id,generation:first.generation});
  const retained=await observe('remote-candidate-return',read,snapshot=>snapshot.goal.status==='paused'&&snapshot.attempts.some(attempt=>attempt.id===first.id&&Boolean(attempt.candidate)));
  assert.equal(retained.tasks[0]!.status,'review');assert.equal(command('git',['rev-parse','HEAD'],repository),initialHead);
  const workerRecords=rows<WorkerRecord>(workerHome,'factory-workers',true);const execution=workerRecords.find(record=>record.id===first.id)!;assert.ok(execution);assert.equal(execution.coordinatorId,identities.coordinator.id);assert.equal(execution.status,'succeeded');assert.equal(execution.attempt.generation,first.generation);assert.equal(execution.workspace?.deviceId,identities.worker.id);assert.equal(execution.workspace?.baseCommit,initialHead);assert.ok(execution.workspace!.projectPath.startsWith(workerHome+'/worker-source/'));
  const sourceReceipts=rows<Received>(workerHome,'peer-artifacts',true).filter(record=>record.peerId===identities.coordinator.id);assert.equal(sourceReceipts.length,1);await verifyReceived(sourceReceipts[0]!,true);
  const candidate=execution.candidate!;assert.ok(candidate);const returned=rows<Received>(home,'peer-artifacts').filter(record=>record.peerId===identities.worker.id);assert.equal(returned.length,2);for(const manifest of [candidate.bundleArtifact,candidate.diffArtifact]){const received=returned.find(record=>record.id===manifest.id)!;assert.ok(received);assert.equal(received.manifest.sha256,manifest.sha256);await verifyReceived(received);}
  record('actual-factory-source-and-candidate-verified',{attemptId:first.id,generation:first.generation,source:sourceReceipts[0]!.manifest,candidateId:candidate.id,bundle:candidate.bundleArtifact,diff:candidate.diffArtifact,sourceOwner:identities.coordinator.id,candidateOwner:identities.worker.id});
  const beforeRestart={goalId:retained.goal.id,revision:retained.goal.revision,taskIds:retained.tasks.map(task=>task.id),attempts:retained.attempts.map(attempt=>({id:attempt.id,generation:attempt.generation,candidate:attempt.candidate}))};
  await coordinator.stop();await coordinator.start();await coordinator.readyRuntime();await rtcConnected();
  const recovered=await read();assert.equal(recovered.goal.status,'paused');assert.equal(recovered.goal.revision,beforeRestart.revision);assert.deepEqual(recovered.tasks.map(task=>task.id),beforeRestart.taskIds);assert.deepEqual(recovered.attempts.map(attempt=>({id:attempt.id,generation:attempt.generation,candidate:attempt.candidate})),beforeRestart.attempts);record('durable-remote-candidate-recovered',beforeRestart);
  await coordinator.api(`/api/goals/${goal.id}/resume`,'POST',{});
  const completed=await observe('factory-resumed',read,snapshot=>snapshot.goal.status==='completed');assert.equal(completed.attempts.length,1);assert.equal(completed.attempts[0]!.id,first.id);assert.equal(completed.attempts[0]!.generation,first.generation);assert.equal(completed.attempts[0]!.status,'succeeded');assert.ok(completed.tasks.every(task=>task.status==='completed'));assert.equal(completed.decisions.filter(decision=>decision.kind==='integrated').length,1);assert.ok(completed.decisions.some(decision=>decision.kind==='attempt-recovered'));
  const head=command('git',['rev-parse','HEAD'],repository);assert.notEqual(head,initialHead);assert.equal(command('git',['status','--porcelain'],repository),'');const tests=command('bash',['tests/slug.test.sh'],repository);assert.equal(command('bash',['bin/slug.sh','Hello__World!!'],repository),'hello-world');const empty=spawnSync('bash',['bin/slug.sh','!!!'],{cwd:repository,encoding:'utf8'});assert.equal(empty.status,2);assert.ok(empty.stderr.trim());
  const evaluation=completed.evaluations.at(-1)!;assert.equal(evaluation.head,head);assert.equal(evaluation.evaluation.complete,true);for(const criterion of completed.goal.criteria)assert.ok(evaluation.evaluation.criteria.some(item=>item.criterion===criterion&&item.satisfied&&item.evidence.length));
  const readiness=services.map(service=>{const records=rows<{id:string;ready:{dockerHost:string;instance:string;workdir:string}}>(service.dataDir,'session-private',service.remote);assert.ok(records.length>=(service.remote?1:2));for(const saved of records)assert.equal(saved.ready.dockerHost,`unix://${service.runtime!.socketPath}`);return {name:service.name,privateSocket:service.runtime!.socketPath,sessions:records.map(saved=>({sessionId:saved.id,dockerHost:saved.ready.dockerHost,instance:saved.ready.instance,workdir:saved.ready.workdir}))};});
  const workerState=await worker.api<{sessions:Session[];chats:Array<{id:string;threadId?:string;status:string}>}>('/api/state?local=1');const nativeChat=await worker.api<{threadId?:string;status:string}>(`/api/chats/${execution.chatId}`);assert.ok(nativeChat?.threadId);assert.equal(nativeChat.status,'idle');assert.ok(workerState.sessions.every(session=>session.status==='stopped'));
  record('real-distributed-goal-completed',{goalId:goal.id,head,attemptId:first.id,tests,criteria});
  evidence={formatVersion:1,status:'passed',verifiedAt:new Date().toISOString(),fixture,repository,initialHead,head,resourceIdentity,topology:'Mac ARM64 coordinator + native Ubuntu 24 ARM64 worker inside an EnoughFactory-owned VZ guest on the same physical Mac; separate services, identity keys and owned engines; no physical multi-machine claim.',identities,runtimes:services.map(service=>({name:service.name,status:service.runtime})),readiness,typedPolicy,remoteSource:sourceReceipts.map(({path:_,...record})=>record),remoteCandidateArtifacts:returned.map(({path:_,...record})=>record),workerExecution:{id:execution.id,coordinatorId:execution.coordinatorId,status:execution.status,sessionId:execution.sessionId,chatId:execution.chatId,workspace:execution.workspace},recovery:beforeRestart,goal:completed.goal,tasks:completed.tasks,attempts:completed.attempts,decisions:completed.decisions,evaluations:completed.evaluations,steps,scope:'Actual Codex planner, remote worker and evaluator; production DeviceApp source export, authenticated worker assignment/run/capture, verified source/bundle/diff transfer over direct WebRTC, retained candidate across coordinator restart, exactly one serialized integration and criterion evaluation at actual repository HEAD. Production typed approval routing is exercised by a clearly labeled deterministic callback fixture over a separate actual paired RTC connection; this full-access Codex goal emits no native approval requests and is not claimed as selective interception coverage.'};
} catch(error) {
  for(const service of services)await writeFile(path.join(fixture,service.remote?'worker-service.log':'coordinator-service.log'),service.log);
  await writeFile(path.join(fixture,'failure.json'),JSON.stringify({at:new Date().toISOString(),goalId,error:(error as Error).message,steps},null,2)+'\n');console.error(`Distributed journey failed; retained ${fixture}${goalId?`; goal ${goalId}`:''}`);throw error;
} finally {
  await policyPeer?.stop();
  for(const service of [...services].reverse())try{await service.cleanRuntime();}catch(error){record('cleanup-runtime-error',{name:service.name,error:(error as Error).message});}
  for(const service of [...services].reverse())try{await service.stop();}catch(error){record('cleanup-service-error',{name:service.name,error:(error as Error).message});}
  reverse?.kill('SIGTERM');await signaling.close();
  // Remove only this dedicated account copy; retained source/journals stay local.
  guestNode('require("node:fs").rmSync(process.argv[1],{force:true})',[path.posix.join(providerHome,'.codex/auth.json')]);
  if(evidence){await writeFile(path.join(root,'docs/verification/distributed-factory-evidence.json'),JSON.stringify({...evidence,steps},null,2)+'\n');console.log('Distributed factory journey passed; docs/verification/distributed-factory-evidence.json');}
}


/** Rechecks the retained completed journey; never creates a goal or starts an engine. */
async function verifyCompletedFixture():Promise<void> {
  const original=JSON.parse(await readFile(path.join(fixture,'failure.json'),'utf8')) as {at:string;goalId:string;error:string;steps:Array<{at:string;event:string;detail:any}>};
  assert.ok(original.goalId,'A retained completed journey is required.');
  assert.ok(original.error.includes('nativeChat?.threadId'),'Only the known final catalog/detail probe is being recovered.');
  const prior=original.steps; const detail=(event:string)=>{const found=prior.find(step=>step.event===event);assert.ok(found,event);return found.detail;};
  const all=rows<Goal>(home,'goals');const goal=all.find(item=>item.id===original.goalId)!;assert.equal(goal.status,'completed');
  const tasks=rows<FactoryTask>(home,'tasks').filter(item=>item.goalId===goal.id);
  const attempts=rows<Attempt>(home,'attempts').filter(item=>tasks.some(task=>task.id===item.taskId));
  const decisions=rows<Decision>(home,'decisions').filter(item=>item.goalId===goal.id);
  const evaluations=rows<Snapshot['evaluations'][number]&{goalId:string}>(home,'factory-evaluations').filter(item=>item.goalId===goal.id);
  assert.equal(tasks.length,1);assert.equal(attempts.length,1);assert.equal(attempts[0]!.status,'succeeded');assert.equal(tasks[0]!.status,'completed');
  assert.equal(decisions.filter(item=>item.kind==='integrated').length,1);assert.ok(decisions.some(item=>item.kind==='attempt-recovered'));
  const identities=detail('factory-devices-paired');const attempt=attempts[0]!;assert.equal(attempt.deviceId,identities.workerId);assert.equal(goal.coordinatorId,identities.coordinatorId);
  const recovery=detail('durable-remote-candidate-recovered');assert.equal(goal.revision,recovery.revision);assert.deepEqual(tasks.map(task=>task.id),recovery.taskIds);assert.deepEqual(attempts.map(item=>({id:item.id,generation:item.generation,candidate:item.candidate})),recovery.attempts);
  const execution=rows<WorkerRecord>(workerHome,'factory-workers',true).find(item=>item.id===attempt.id)!;assert.ok(execution);assert.equal(execution.status,'succeeded');assert.equal(execution.coordinatorId,goal.coordinatorId);assert.equal(execution.attempt.generation,attempt.generation);
  const candidate=execution.candidate!;assert.ok(candidate);assert.equal(candidate.commit,attempt.candidate);
  const sourceReceipts=rows<Received>(workerHome,'peer-artifacts',true).filter(item=>item.peerId===goal.coordinatorId);assert.equal(sourceReceipts.length,1);await verifyReceived(sourceReceipts[0]!,true);
  const returned=rows<Received>(home,'peer-artifacts').filter(item=>item.peerId===attempt.deviceId);assert.equal(returned.length,2);for(const manifest of [candidate.bundleArtifact,candidate.diffArtifact]){const received=returned.find(item=>item.id===manifest.id)!;assert.ok(received);assert.equal(received.manifest.sha256,manifest.sha256);await verifyReceived(received);}
  const initialHead=command('git',['rev-list','--max-parents=0','HEAD'],repository);const head=command('git',['rev-parse','HEAD'],repository);assert.notEqual(head,initialHead);assert.equal(command('git',['status','--porcelain'],repository),'');
  assert.equal(execution.workspace?.baseCommit,initialHead);assert.equal(candidate.baseCommit,initialHead);assert.equal(execution.workspace?.deviceId,attempt.deviceId);assert.ok(execution.workspace!.projectPath.startsWith(workerHome+'/worker-source/'));
  const integration=decisions.find(item=>item.kind==='integrated')!.data as {commit:string;checks:Array<{passed:boolean;checkedCommit:string}>};assert.equal(integration.commit,head);assert.ok(integration.checks.length);assert.ok(integration.checks.every(check=>check.passed&&check.checkedCommit===head));
  const tests=command('bash',['tests/slug.test.sh'],repository);assert.equal(command('bash',['bin/slug.sh','Hello__World!!'],repository),'hello-world');const empty=spawnSync('bash',['bin/slug.sh','!!!'],{cwd:repository,encoding:'utf8'});assert.equal(empty.status,2);assert.ok(empty.stderr.trim());
  const evaluation=evaluations.at(-1)!;assert.equal(evaluation.head,head);assert.equal(evaluation.evaluation.complete,true);for(const criterion of goal.criteria)assert.ok(evaluation.evaluation.criteria.some(item=>item.criterion===criterion&&item.satisfied&&item.evidence.length));
  const nativeChat=rows<{id:string;threadId?:string;status:string}>(workerHome,'chats',true).find(chat=>chat.id===execution.chatId)!;assert.ok(nativeChat?.threadId);assert.equal(nativeChat.status,'idle');assert.ok(!rows<{id:string}>(home,'chats').some(chat=>chat.id===nativeChat.id),'Worker transcript must stay on its owner.');
  // Each engine's own HTTP status confirms stopped; chat detail confirms the
  // persisted provider thread without relying on intentionally redacted catalog.
  const observedRuntime:Array<{name:string;status:ContainerRuntimeStatus}>=[];
  try {
    await coordinator.start();await worker.start();
    for(const service of services){const status=await service.api<ContainerRuntimeStatus>('/api/runtime');assert.equal(status.state,'stopped');const old=prior.find(step=>step.event==='private-engine-ready'&&step.detail.name===service.name)!.detail;assert.equal(status.socketPath,old.socketPath);assert.equal(status.dataDirectory,old.dataDirectory);observedRuntime.push({name:service.name,status});const localState=await service.api<{sessions:Session[]}>('/api/state?local=1');assert.ok(localState.sessions.every(session=>session.status==='stopped'));}
    const privateDetail=await worker.api<{threadId?:string;status:string}>(`/api/chats/${execution.chatId}`);assert.equal(privateDetail.threadId,nativeChat.threadId);assert.equal(privateDetail.status,'idle');
    const workerEvents=await worker.api<Array<{kind:string}>>(`/api/chats/${execution.chatId}/events`);assert.equal(workerEvents.filter(event=>event.kind==='approval').length,0);
  } finally {for(const service of [...services].reverse())await service.stop();}
  const readiness=services.map(service=>{const status=observedRuntime.find(item=>item.name===service.name)!.status;const records=rows<{id:string;ready:{dockerHost:string;instance:string;workdir:string}}>(service.dataDir,'session-private',service.remote);assert.ok(records.length>=(service.remote?1:2));for(const saved of records)assert.equal(saved.ready.dockerHost,`unix://${status.socketPath}`);return {name:service.name,privateSocket:status.socketPath,sessions:records.map(saved=>({sessionId:saved.id,dockerHost:saved.ready.dockerHost,instance:saved.ready.instance,workdir:saved.ready.workdir}))};});
  assert.equal(hash(await readFile(path.join(resources,'device/service.cjs'))),expectedServiceHash);assert.equal(guestNode('console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))',[path.posix.join(guestResources,'device/service.cjs')]),expectedServiceHash);
  assert.equal(guestNode('console.log(require("node:fs").existsSync(process.argv[1]))',[path.posix.join(providerHome,'.codex/auth.json')]),'false');
  await assert.rejects(readFile(path.join(shared,'authorized-codex-auth.json')),{code:'ENOENT'});await assert.rejects(readFile(path.join(shared,'policy-invitation.json')),{code:'ENOENT'});
  const sourceObservation=JSON.parse(await readFile(path.join(fixture,'source-observation.json'),'utf8'));
  const receiptPath=path.join(root,'docs/verification/distributed-factory-evidence.json');
  const earlier=existsSync(receiptPath)?JSON.parse(await readFile(receiptPath,'utf8')):undefined;
  const retained={formatVersion:1,status:'passed',verifiedAt:new Date().toISOString(),fixture,repository,initialHead,head,sourceObservation,resourceIdentity:{serviceSha256:expectedServiceHash,version:'0.1.2',source:'Immutable 0.1.2 portable service overlay on fixture copies of verified v0.1.1 native assets; original native provenance remains historical.',mac:JSON.parse(await readFile(path.join(resources,'bundle-provenance.json'),'utf8')),linux:JSON.parse(guestNode('console.log(require("node:fs").readFileSync(process.argv[1],"utf8"))',[path.posix.join(guestResources,'bundle-provenance.json')]))},topology:'Mac ARM64 coordinator + native Ubuntu 24 ARM64 worker in the existing EnoughFactory-owned VZ guest on the same physical Mac; independent services, signing identities and owned engines. No physical multi-machine claim.',identities,observedRuntime,readiness,typedPolicy:detail('typed-policy-through-RTC'),remoteSource:sourceReceipts.map(({path:_,...item})=>item),remoteCandidateArtifacts:returned.map(({path:_,...item})=>item),workerExecution:{id:execution.id,coordinatorId:execution.coordinatorId,status:execution.status,sessionId:execution.sessionId,chatId:execution.chatId,workspace:execution.workspace},recovery,goal,tasks,attempts,decisions,evaluations,cleanup:{ownedEnginesStopped:true,servicesStopped:true,dedicatedCodexCredentialRemoved:true,transientCredentialFileRemoved:true,pairInvitationFileRemoved:true,primaryAppVmPreserved:true},reverification:{at:new Date().toISOString(),originalFinalProbeError:{at:original.at,message:original.error,scope:'Only the final thread-ID probe incorrectly expected provider context in the public catalog. The goal already completed, integrations/evaluation and prior source/restart assertions passed. Original error retained unchanged.'},correctedProbe:'Native worker conversation detail endpoint and durable owning-device chat record both have the same provider thread ID; catalog intentionally omits it.',newModelTurns:0,criteriaChecked:goal.criteria.length},steps:[...prior,...steps],scope:'Real production DeviceApp source/attempt/run/capture protocol over authenticated direct WebRTC, real Codex planner/Linux worker/Mac evaluator under autonomous approve-all, verified source/bundle/diff bytes, same generation/candidate retained across coordinator restart, exactly one serialized integration and actual criterion evaluation at integrated HEAD. Typed approval coverage is the separately labeled deterministic callback fixture through production policy/mapping over an actual paired RTC link. Real full-access worker emitted zero native approval requests; no universal interception claimed.'};
  if(earlier?.fixture===fixture){retained.resourceIdentity=earlier.resourceIdentity;retained.cleanup={...retained.cleanup,...earlier.cleanup};}
  await writeFile(receiptPath,JSON.stringify(retained,null,2)+'\n');
  console.log(`Retained completed distributed journey verified: ${head}; ${goal.criteria.length} criteria; no new inference.`);
}
