import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { pipeline } from 'node:stream/promises';
import { hashFile } from '@enoughfactory/workspaces';
import { openPreservedContainerTar, retireStoppedFactoryContainer, validateStoppedFactoryContainerArchives, type PreservedContainerArchive } from './factory-container-retirement.ts';
import { exec } from './util.ts';

async function fixture(t:TestContext) {
  const dataDir=await mkdtemp(path.join(tmpdir(),'enough-container-retire-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const id='a'.repeat(64),name='repository-f-123456789abc',projectPath='/private/factory/workspaces/attempt/repository';
  const identity={sessionId:'session_fixture',container:name,name,project:'repository',sessionName:'f-123456789abc',projectPath,branch:'envmux/f-123456789abc',workdir:'/work'};
  const inspected={Id:id,Name:`/${name}`,Created:'2026-10-07T00:00:00Z',State:{Running:false,Paused:false,Restarting:false,Dead:false,Pid:0,Status:'exited',StartedAt:'2026-10-07T00:01:00Z',FinishedAt:'2026-10-07T00:02:00Z',ExitCode:0},Config:{Labels:{'envmux.schema':'2','envmux.kind':'session','envmux.instance':name,'envmux.project':'repository','envmux.session':identity.sessionName,'envmux.directory':projectPath,'envmux.branch':identity.branch,'envmux.workdir':'/work'}},Mounts:[] as {Type:string;Name?:string;Source:string;Destination:string;RW:boolean;Driver?:string}[]};
  const home=path.join(dataDir,'provider-fixture'),codex=path.join(home,'.codex');
  await mkdir(path.join(codex,'sessions'),{recursive:true});
  await writeFile(path.join(codex,'auth.json'),'private fixture authentication\n');
  await writeFile(path.join(codex,'config.toml'),'private fixture configuration\n');
  await writeFile(path.join(codex,'sessions','trajectory.jsonl'),'private fixture complete trajectory\n');
  await writeFile(path.join(codex,'state.sqlite'),Buffer.alloc(2*1024**2));
  const tar=path.join(dataDir,'fixture.tar');await exec('/usr/bin/tar',['-cf',tar,'-C',home,'.codex']);
  const statePath=path.join(dataDir,'fake-docker-state.json'),cliPath=path.join(dataDir,'fake-docker');
  const initial={inspected,mode:'normal',inspections:0,removed:false,calls:[] as string[][],volumes:{} as Record<string,unknown>,tarPaths:{} as Record<string,string>,removedVolumes:[] as string[],failSource:''};
  await writeFile(statePath,JSON.stringify(initial));
  await writeFile(cliPath,`#!${process.execPath}
const fs=require('node:fs');const statePath=${JSON.stringify(statePath)};const tar=${JSON.stringify(tar)};
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));const args=process.argv.slice(2);
if(args[0]!=='--host'||args[2]!=='--config')process.exit(90);
const command=args.slice(4);state.calls.push(command);const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
if(command[0]==='inspect'&&command.includes('--format')){
 save();process.stdout.write(JSON.stringify({id:'b'.repeat(64),state:{Running:true,Pid:8},mounts:[{Type:'bind',Source:'/private/owned-inputs',Destination:'/shared',RW:true}]})+'\\n');
}else if(command[0]==='inspect'){
 state.inspections++;save();if(state.removed){process.stderr.write('Error: No such object');process.exit(1);}
 const inspected=structuredClone(state.inspected);if(state.mode==='identity-race'&&state.inspections>1)inspected.State.StartedAt='2026-10-07T00:03:00Z';process.stdout.write(JSON.stringify([inspected]));
}else if(command[0]==='cp'){
 save();const source=command[1].slice(command[1].indexOf(':')+1);
 if(state.mode==='cp-fail'||state.failSource===source){process.stdout.write(Buffer.alloc(512));process.stderr.write('private diagnostic that must never reach logs');process.exitCode=1;}
 else fs.createReadStream(state.tarPaths[source]||tar).pipe(process.stdout);
}else if(command[0]==='rm'){
 if(command.length!==2||command[1]!==state.inspected.Id)process.exit(91);state.removed=true;save();process.stdout.write(command[1]+'\\n');
}else if(command[0]==='volume'&&command[1]==='inspect'){
 save();const volume=state.volumes[command[2]];if(!volume||state.removedVolumes.includes(command[2])){process.stderr.write('Error: No such volume');process.exit(1);}process.stdout.write(JSON.stringify([volume]));
}else if(command[0]==='ps'){
 save();const name=command.find(value=>value.startsWith('volume='))?.slice(7);
 const ids=[];if(!state.removed&&(!name||state.volumes[name]))ids.push(state.inspected.Id);if(state.mode==='shared-volume'||state.mode==='shared-bind'&&!name)ids.push('b'.repeat(64));process.stdout.write(ids.join('\\n')+'\\n');
}else if(command[0]==='volume'&&command[1]==='rm'){
 if(command.length!==3||!state.removed||!state.volumes[command[2]])process.exit(93);
 state.removedVolumes.push(command[2]);save();process.stdout.write(command[2]+'\\n');
}else process.exit(92);
`);
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

async function ephemeralFixture(t: TestContext) {
  const f = await fixture(t), base = path.join(f.dataDir, 'ephemeral-fixture');
  const files: Record<string, string> = {
    'work/tracked.ts': 'tracked work\n', 'work/.gitignore': 'ignored/\n', 'work/ignored/new-design.txt': 'untracked ignored design\n',
    'home/developer/.ssh/config': 'private user ssh configuration\n',
    'root/.codex/sessions/trajectory.jsonl': 'complete provider trajectory\n', 'root/.codex/auth.json': 'private auth\n',
    'root/.claude/projects/session.jsonl': 'claude history\n', 'root/.enoughfactory/antigravity/sessions/state.json': 'antigravity history\n',
    'root/notes.txt': 'user root files\n', 'root/.npm/cache': 'reproducible npm cache\n', 'root/.cache/cache': 'reproducible download cache\n',
    'root/.codex/plugins/cache/reinstallable.js': 'reproducible plugin cache\n', 'extra/new-file.ts': 'additional writable directory\n',
    [`root/${'long-name-'.repeat(18)}/notes.txt`]: 'long path with PAX metadata\n',
  };
  for (const [name, text] of Object.entries(files)) {
    const filename = path.join(base, name); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, text);
  }
  const tarPaths: Record<string, string> = {};
  for (const source of ['/work', '/home', '/root', '/work/extra']) {
    const root = path.posix.basename(source), tar = path.join(f.dataDir, `${root}-input.tar`);
    await exec('/usr/bin/tar', ['-cf', tar, '--format=pax', '-C', base, root], { env: { ...process.env, COPYFILE_DISABLE: '1' } }); tarPaths[source] = tar;
  }
  const mounts = [
    { Type: 'volume', Name: `${f.identity.name}-home`, Source: '/var/lib/docker/volumes/home/_data', Destination: '/home', RW: true, Driver: 'local' },
    { Type: 'volume', Name: `${f.identity.name}-work`, Source: '/var/lib/docker/volumes/work/_data', Destination: '/work', RW: true, Driver: 'local' },
    { Type: 'bind', Source: '/private/owned-inputs/extra', Destination: '/work/extra', RW: true },
  ];
  const volumes = Object.fromEntries(['home', 'work'].map(role => [`${f.identity.name}-${role}`, {
    Name: `${f.identity.name}-${role}`, Driver: 'local', Scope: 'local', CreatedAt: '2026-10-07T00:00:00Z', Options: null,
    Labels: { 'envmux.schema': '2', 'envmux.instance': f.identity.name, 'envmux.project': f.identity.project,
      'envmux.session': f.identity.sessionName, 'envmux.directory': f.identity.projectPath, 'envmux.branch': f.identity.branch, 'envmux.volume': role },
  }]));
  await f.update({ inspected: { ...f.inspected, Mounts: mounts }, volumes, tarPaths });
  const preservation = { runtimeKinds: [] as ('codex' | 'claude' | 'antigravity')[], includeWorkAndHome: true as const, removeOwnedVolumes: true as const };
  const run = () => f.run({ preservation });
  return { ...f, run, preservation, files, volumes, mounts };
}

async function extractPreserved(archive: PreservedContainerArchive, dataDir: string, destination: string): Promise<void> {
  const input = await openPreservedContainerTar(archive, dataDir);
  const child = spawn('/usr/bin/tar', ['-xf', '-', '-C', destination], { stdio: ['pipe', 'ignore', 'pipe'] }); child.stderr.resume();
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Fixture extraction failed'))); });
  await Promise.all([pipeline(input, child.stdin), exited]);
}

test('stopped ephemeral sessions preserve ignored work, all provider histories, home and writable binds before exclusive owned volume removal', async t => {
  const f = await ephemeralFixture(t), receipt = await f.run();
  assert.equal(receipt.version, 2); if (receipt.version !== 2) throw new Error('Expected full preservation');
  assert.equal(receipt.status, 'removed'); assert.deepEqual(receipt.archives.map(archive => archive.source), ['/work', '/home', '/root', '/work/extra']);
  await validateStoppedFactoryContainerArchives(receipt, f.dataDir);
  const restored = path.join(f.dataDir, 'recovered'); await mkdir(restored);
  for (const archive of receipt.archives) await extractPreserved(archive, f.dataDir, restored);
  assert(receipt.archives.every(archive => archive.storage === 'cas-tar-v1'));
  for (const [name, text] of Object.entries(f.files)) {
    if (name.startsWith('root/.npm/') || name.startsWith('root/.cache/') || name.startsWith('root/.codex/plugins/cache/')) {
      await assert.rejects(lstat(path.join(restored, name)), { code: 'ENOENT' });
    } else assert.equal(await readFile(path.join(restored, name), 'utf8'), text);
  }
  const state = await f.state();
  assert.deepEqual(state.removedVolumes.sort(), [`${f.identity.name}-home`, `${f.identity.name}-work`]);
  assert.deepEqual(state.calls.filter(args => args[0] === 'rm'), [['rm', f.id]]);
  assert(state.calls.findIndex(args => args[0] === 'rm') > Math.max(...state.calls.map((args, index) => args[0] === 'cp' ? index : -1)));
  const before = state.calls.filter(args => args[0] === 'cp').length;
  await f.run(); assert.equal((await f.state()).calls.filter(args => args[0] === 'cp').length, before);
});

test('ephemeral retirement refuses active/shared/foreign ownership and never removes host bind sources', async t => {
  const shared = await ephemeralFixture(t); await shared.update({ mode: 'shared-volume' });
  await assert.rejects(shared.run(), /Another container references/); assert.equal((await shared.state()).removed, false);
  assert.deepEqual((await shared.state()).removedVolumes, []);
  const sharedBind = await ephemeralFixture(t); await sharedBind.update({ mode: 'shared-bind' });
  await assert.rejects(sharedBind.run(), /active container can write/); assert.equal((await sharedBind.state()).removed, false);
  const foreign = await ephemeralFixture(t);
  const name = `${foreign.identity.name}-work`, volume = foreign.volumes[name]!;
  await foreign.update({ volumes: { ...foreign.volumes, [name]: { ...volume, Labels: { ...volume.Labels, 'envmux.session': 'someone-else' } } } });
  await assert.rejects(foreign.run(), /exact envmux ownership/); assert.equal((await foreign.state()).removed, false);
  const active = await ephemeralFixture(t); await active.update({ inspected: { ...active.inspected, Mounts: active.mounts, State: { ...active.inspected.State, Running: true, Status: 'running', Pid: 4 } } });
  await assert.rejects(active.run(), /conclusively stopped/); assert.equal((await active.state()).removed, false);
});

test('partial capture resumes from verified archives and missing receipt bytes block even already removed containers', async t => {
  const f = await ephemeralFixture(t); await f.update({ failSource: '/home' });
  await assert.rejects(f.run(), /capture failed|incomplete/); assert.equal((await f.state()).removed, false);
  assert.deepEqual((await f.state()).removedVolumes, []);
  await f.update({ failSource: '' });
  const receipt = await f.run(); if (receipt.version !== 2) throw new Error('Expected full preservation');
  assert.equal((await f.state()).calls.filter(args => args[0] === 'cp' && args[1] === `${f.id}:/work`).length, 1, 'Completed archive is verified and reused rather than copied again');
  await rm(receipt.archives[1]!.archive);
  await assert.rejects(f.run(), /ENOENT/);
});

test('created but never started ephemeral containers are preserved and retired without claiming a successful task result', async t => {
  const f = await ephemeralFixture(t);
  await f.update({ inspected: { ...f.inspected, Mounts: f.mounts, State: { ...f.inspected.State, Status: 'created', StartedAt: '', FinishedAt: '' } } });
  const receipt = await f.run(); assert.equal(receipt.version, 2); assert.equal(receipt.status, 'removed');
});

test('user hardlinks to cache contents defer exclusions so their only file bytes survive retirement', async t => {
  const f = await ephemeralFixture(t), base = path.join(f.dataDir, 'ephemeral-fixture');
  await link(path.join(base, 'root/.cache/cache'), path.join(base, 'root/valuable.txt'));
  const rootTar = path.join(f.dataDir, 'root-hardlink.tar');
  await exec('/usr/bin/tar', ['-cf', rootTar, '--format=pax', '-C', base, 'root/.cache/cache', 'root/valuable.txt', 'root/.codex', 'root/.claude', 'root/.enoughfactory', 'root/notes.txt'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  await f.update({ tarPaths: { ...(await f.state()).tarPaths, '/root': rootTar } });
  const receipt = await f.run(); if (receipt.version !== 2) throw new Error('Expected full preservation');
  const root = receipt.archives.find(archive => archive.source === '/root')!;
  assert.equal(root.cacheExclusionsDeferred, true); assert.deepEqual(root.exclusions, []);
  await validateStoppedFactoryContainerArchives(receipt, f.dataDir);
  const recovered = path.join(f.dataDir, 'hardlink-recovered'); await mkdir(recovered);
  await extractPreserved(root, f.dataDir, recovered);
  assert.equal(await readFile(path.join(recovered, 'root/valuable.txt'), 'utf8'), 'reproducible download cache\n');
  assert.equal((await f.state()).removed, true);
});
