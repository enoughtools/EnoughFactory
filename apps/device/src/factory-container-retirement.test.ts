import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { hashFile } from '@enoughfactory/workspaces';
import { retireStoppedFactoryContainer } from './factory-container-retirement.ts';
import { exec } from './util.ts';

async function fixture(t:TestContext) {
  const dataDir=await mkdtemp(path.join(tmpdir(),'enough-container-retire-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const id='a'.repeat(64),name='repository-f-123456789abc',projectPath='/private/factory/workspaces/attempt/repository';
  const identity={sessionId:'session_fixture',container:name,name,project:'repository',sessionName:'f-123456789abc',projectPath,branch:'envmux/f-123456789abc',workdir:'/work'};
  const inspected={Id:id,Name:`/${name}`,Created:'2026-10-07T00:00:00Z',State:{Running:false,Paused:false,Restarting:false,Dead:false,Pid:0,Status:'exited',StartedAt:'2026-10-07T00:01:00Z',FinishedAt:'2026-10-07T00:02:00Z',ExitCode:0},Config:{Labels:{'envmux.schema':'2','envmux.kind':'session','envmux.instance':name,'envmux.project':'repository','envmux.session':identity.sessionName,'envmux.directory':projectPath,'envmux.branch':identity.branch,'envmux.workdir':'/work'}}};
  const home=path.join(dataDir,'provider-fixture'),codex=path.join(home,'.codex');
  await mkdir(path.join(codex,'sessions'),{recursive:true});
  await writeFile(path.join(codex,'auth.json'),'private fixture authentication\n');
  await writeFile(path.join(codex,'config.toml'),'private fixture configuration\n');
  await writeFile(path.join(codex,'sessions','trajectory.jsonl'),'private fixture complete trajectory\n');
  await writeFile(path.join(codex,'state.sqlite'),Buffer.alloc(2*1024**2));
  const tar=path.join(dataDir,'fixture.tar');await exec('/usr/bin/tar',['-cf',tar,'-C',home,'.codex']);
  const statePath=path.join(dataDir,'fake-docker-state.json'),cliPath=path.join(dataDir,'fake-docker');
  const initial={inspected,mode:'normal',inspections:0,removed:false,calls:[] as string[][]};
  await writeFile(statePath,JSON.stringify(initial));
  await writeFile(cliPath,`#!${process.execPath}\nconst fs=require('node:fs');const statePath=${JSON.stringify(statePath)};const tar=${JSON.stringify(tar)};const state=JSON.parse(fs.readFileSync(statePath,'utf8'));const args=process.argv.slice(2);if(args[0]!=='--host'||args[2]!=='--config')process.exit(90);const command=args.slice(4);state.calls.push(command);const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));if(command[0]==='inspect'){state.inspections++;save();if(state.removed){process.stderr.write('Error: No such object');process.exit(1);}const inspected=structuredClone(state.inspected);if(state.mode==='identity-race'&&state.inspections>1)inspected.State.StartedAt='2026-10-07T00:03:00Z';process.stdout.write(JSON.stringify([inspected]));}else if(command[0]==='cp'){save();if(state.mode==='cp-fail'){process.stdout.write(Buffer.alloc(512));process.stderr.write('private diagnostic that must never reach logs');process.exitCode=1;}else fs.createReadStream(tar).pipe(process.stdout);}else if(command[0]==='rm'){if(command.length!==2||command[1]!==state.inspected.Id)process.exit(91);state.removed=true;save();process.stdout.write(command[1]+'\\n');}else process.exit(92);`);
  await chmod(cliPath,0o700);
  const endpoint={host:'unix:///private/enoughfactory-test.sock',configDirectory:path.join(dataDir,'docker-config'),cliPath};
  let pinnedContainerId:string|undefined;
  const run=(overrides:Partial<Parameters<typeof retireStoppedFactoryContainer>[0]>={})=>retireStoppedFactoryContainer({endpoint,dataDir,identity,assertCurrent:()=>{},assertSpace:()=>{},pinnedContainerId,pinContainerId:value=>{pinnedContainerId=value;},...overrides});
  const state=async()=>JSON.parse(await readFile(statePath,'utf8')) as typeof initial;
  const update=async(value:Partial<typeof initial>)=>writeFile(statePath,JSON.stringify({...await state(),...value}));
  return {dataDir,tar,id,identity,inspected,run,state,update};
}

test('accepted stopped worker retirement compresses and verifies complete private provider history before removing only its full ID',async t=>{
  const f=await fixture(t),receipt=await f.run();
  assert.equal(receipt.status,'removed');assert.equal(receipt.containerId,f.id);
  const raw=await hashFile(f.tar);assert.equal(receipt.rawSha256,raw.sha256);assert.equal(receipt.rawSize,raw.size);
  assert(receipt.size<receipt.rawSize/100,'History is compressed directly rather than retaining a large raw tar');
  assert.equal((await lstat(receipt.archive)).mode&0o077,0);
  assert.equal((await lstat(path.dirname(receipt.archive))).mode&0o077,0);
  const restored=path.join(f.dataDir,'restored');await mkdir(restored);
  await exec('/usr/bin/tar',['-xzf',receipt.archive,'-C',restored]);
  assert.equal(await readFile(path.join(restored,'.codex','auth.json'),'utf8'),'private fixture authentication\n');
  assert.equal(await readFile(path.join(restored,'.codex','config.toml'),'utf8'),'private fixture configuration\n');
  assert.equal(await readFile(path.join(restored,'.codex','sessions','trajectory.jsonl'),'utf8'),'private fixture complete trajectory\n');
  const replay=await f.run();assert.equal(replay.status,'removed');
  assert.deepEqual((await f.state()).calls.filter(args=>args[0]==='rm'),[['rm',f.id]],'Acknowledgment replay never removes a replacement or any volumes');
  assert.equal((await f.state()).calls.filter(args=>args[0]==='cp').length,1);
});

test('retirement preserves containers with changed ownership, active execution, or failed archive capture',async t=>{
  const f=await fixture(t);
  await f.update({inspected:{...f.inspected,Config:{Labels:{...f.inspected.Config.Labels,'envmux.session':'different-worker'}}}});
  await assert.rejects(f.run(),/exact envmux ownership/);assert.equal((await f.state()).removed,false);
  await f.update({inspected:{...f.inspected,State:{...f.inspected.State,Running:true,Pid:22,Status:'running'}}});
  await assert.rejects(f.run(),/conclusively stopped/);assert.equal((await f.state()).removed,false);
  await f.update({inspected:f.inspected,mode:'cp-fail'});
  await assert.rejects(f.run(),/archive failed/);assert.equal((await f.state()).removed,false);
});

test('fresh stopped-state identity and application authority must survive the archive before any removal',async t=>{
  const changed=await fixture(t);await changed.update({mode:'identity-race'});
  await assert.rejects(changed.run(),/changed while its history was archived/);assert.equal((await changed.state()).removed,false);
  const current=await fixture(t);let authority=true,checks=0;
  await assert.rejects(current.run({assertCurrent:()=>{if(!authority)throw new Error('Worker authority changed');},assertSpace:()=>{if(++checks>1)authority=false;}}),/Worker authority changed/);
  assert.equal((await current.state()).removed,false);
});

test('archive storage admission failure leaves the worker container intact',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.run({assertSpace:()=>{throw new Error('Preserve host disk reserve');}}),/Preserve host disk reserve/);
  assert.equal((await f.state()).removed,false);assert.equal((await f.state()).calls.some(args=>args[0]==='cp'),false);
});

test('missing retained history fails closed with both an existing and an already missing container',async t=>{
  const f=await fixture(t);let checks=0;
  await assert.rejects(f.run({assertCurrent:()=>{if(++checks>1)throw new Error('Pause before removal');}}),/Pause before removal/);
  const directory=path.join(f.dataDir,'provider-history',f.identity.sessionId,f.id);
  await rm(path.join(directory,'codex.tar.gz'));
  await assert.rejects(f.run(),/ENOENT/);
  assert.equal((await f.state()).removed,false);
  assert.equal((await f.state()).calls.some(args=>args[0]==='rm'),false);
  await f.update({removed:true});
  await assert.rejects(f.run(),/ENOENT/);
  const receipt=JSON.parse(await readFile(path.join(directory,'receipt.json'),'utf8'));
  assert.equal(receipt.status,'archived','Missing history never becomes a successful removed receipt');
  assert.equal((await f.state()).calls.some(args=>args[0]==='rm'),false);
});
