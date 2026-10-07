import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnvmuxSession, type EnvmuxReady, type EnvmuxState } from '@enoughfactory/envmux';
import type { Project } from '@enoughfactory/contracts';
import type { ArtifactManifest, WorkingDirectoryCapture, WorkingDirectorySnapshot } from '@enoughfactory/workspaces';
import { Store } from './store.ts';
import { SessionController } from './sessions.ts';
import { factoryAttemptWorkingDirectorySources } from './factory.ts';

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

test('repair snapshots retain prior roots and include newly configured verification inputs without truncation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'enough-repair-working-roots-'));
  const dataDir = path.join(root, 'owned'), workspaceData = path.join(dataDir, 'workspace-data');
  const source = path.join(root, 'support'), reference = path.join(root, 'reference'), verification = path.join(root, 'verification-inputs');
  for (const directory of [source, reference, verification]) await mkdir(directory);
  await writeFile(path.join(source, 'input.txt'), 'original support\n');
  await writeFile(path.join(reference, 'reference.txt'), 'retained reference\n');
  await writeFile(path.join(verification, 'native-contract.json'), '{"requires":"real native evidence"}\n');
  const store = new Store(path.join(root, 'store'));
  const endpoint = { host: 'unix:///tmp/unused-repair.sock', cliPath: '/tmp/unused-docker', configDirectory: path.join(root, 'config') };
  const sessions = new SessionController(store, 'fixture', () => {}, () => {}, { endpoint, ensureReady: async () => assert.fail('Snapshot preparation must not start a runtime'), bridgeHostAddress: () => undefined }, workspaceData);
  t.after(async () => { sessions.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const original = [{ id: 'support', name: 'support', path: source }, { id: 'reference', name: 'reference', path: reference }];
  const prior = await sessions.directoryManager.prepare({ identity: 'original-attempt', sources: original });
  await writeFile(path.join(prior[0]!.path, 'input.txt'), 'retained authored repair\n');
  const captures = await Promise.all(prior.map(snapshot => sessions.directoryManager.captureFromPath(snapshot, snapshot.path)));
  await writeFile(path.join(source, 'input.txt'), 'new project contents must not replace retained work\n');
  const project: Project = { id: 'project', name: 'Fixture', path: root, deviceId: 'fixture', createdAt: new Date().toISOString(), runtime: 'codex', approvalMode: 'approve-all', rules: [], workingDirectories: [
    { id: 'support', name: 'renamed-support', path: source },
    { id: 'independent-verification-inputs', name: 'verification-inputs', path: verification },
  ] };
  const sources = await factoryAttemptWorkingDirectorySources(dataDir, sessions, 'repair-attempt', project, captures);
  assert.deepEqual(sources.map(({ id, name, containerPath }) => ({ id, name, containerPath })), [
    { id: 'support', name: 'support', containerPath: '/workspaces/support' },
    { id: 'reference', name: 'reference', containerPath: '/workspaces/reference' },
    { id: 'independent-verification-inputs', name: 'verification-inputs', containerPath: '/workspaces/verification-inputs' },
  ]);
  const snapshots = await sessions.directoryManager.prepare({ identity: 'repair-attempt' });
  assert.equal(await readFile(path.join(snapshots[0]!.path, 'input.txt'), 'utf8'), 'retained authored repair\n');
  assert.equal(await readFile(path.join(snapshots[2]!.path, 'native-contract.json'), 'utf8'), '{"requires":"real native evidence"}\n');
  assert.equal(await readFile(path.join(source, 'input.txt'), 'utf8'), 'new project contents must not replace retained work\n');
  assert(sources.every(source => !('path' in source)), 'Worker transfer contains immutable source envelopes, never coordinator filesystem paths');

  const collision = { ...project, workingDirectories: [{ id: 'new-support', name: 'SUPPORT', path: verification }] };
  await assert.rejects(factoryAttemptWorkingDirectorySources(dataDir, sessions, 'collision-attempt', collision, captures), /identifiers and names must be unique/);
  await assert.rejects(readFile(path.join(workspaceData, 'working-directories', 'collision-attempt', 'snapshots.json')), /ENOENT/, 'Collision cannot publish a truncated snapshot');
  const tooMany = { ...project, workingDirectories: Array.from({ length: 7 }, (_, index) => ({ id: `new-${index}`, name: `new-${index}`, path: verification })) };
  await assert.rejects(factoryAttemptWorkingDirectorySources(dataDir, sessions, 'over-capacity-attempt', tooMany, captures), /at most eight/);
  await assert.rejects(readFile(path.join(workspaceData, 'working-directories', 'over-capacity-attempt', 'snapshots.json')), /ENOENT/, 'Capacity failure cannot publish a truncated snapshot');
});

test('working-folder export cleanup waits for every retained artifact and journal', async t => {
  for (const failure of [undefined, 'copy', 'capture', 'artifact', 'journal'] as const) await t.test(failure || 'success', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'enough-session-export-cleanup-'));
    const owned = path.join(root, 'owned'), sessionId = 'session-export-fixture';
    const exportParent = path.join(owned, 'working-directory-exports', sessionId);
    const priorExport = path.join(exportParent, '11111111-1111-4111-8111-111111111111');
    const authoredRoot = path.join(root, 'authored'), sourceMetadata = path.join(owned, 'working-directories', sessionId);
    const artifactRoot = path.join(owned, 'artifacts');
    for (const directory of [priorExport, authoredRoot, sourceMetadata, artifactRoot]) await mkdir(directory, { recursive: true });
    await writeFile(path.join(priorExport, 'retained.txt'), 'uncertain prior export');
    await writeFile(path.join(authoredRoot, 'source.txt'), 'authored input');
    await writeFile(path.join(sourceMetadata, 'snapshots.json'), 'source metadata');
    const createdAt = new Date().toISOString();
    const manifest = (id: string): ArtifactManifest => ({ id, name: id, mime: 'application/octet-stream', sha256: 'a'.repeat(64), size: 1, deviceId: 'fixture', createdAt });
    const snapshots: WorkingDirectorySnapshot[] = ['one', 'two'].map(id => ({ id, name: id, kind: 'folder', containerPath: `/workspaces/${id}`, baseCommit: 'b'.repeat(40), sourceArtifact: manifest(`source-${id}`), path: path.join(sourceMetadata, id) }));
    const records = new Map<string, { id: string; [key: string]: unknown }>();
    const exports: string[] = [], artifactFiles: string[] = [];
    let registrations = 0, paused = false;
    const store = {
      get: (bucket: string, id: string) => records.get(`${bucket}:${id}`),
      list: (bucket: string) => [...records.entries()].filter(([key]) => key.startsWith(`${bucket}:`)).map(([, record]) => record),
      set: (bucket: string, value: { id: string; [key: string]: unknown }) => {
        if (bucket === 'artifacts' && ++registrations === 3 && failure === 'artifact') throw new Error('artifact registration unavailable');
        if (bucket === 'session-working-directory-captures') {
          assert.equal(registrations, 4);
          assert(exports.every(destination => existsSync(destination)), 'All staging copies remain until the complete capture journal is stored');
          if (failure === 'journal') throw new Error('capture journal unavailable');
        }
        records.set(`${bucket}:${value.id}`, value);
      },
    } as unknown as Store;
    store.set('sessions', { id: sessionId, projectId: 'project', deviceId: 'fixture', name: 'fixture', status: 'ready', createdAt, updatedAt: createdAt, services: [], workingDirectories: snapshots.map(snapshot => ({ id: snapshot.id, name: snapshot.name, path: snapshot.containerPath, kind: snapshot.kind, baseCommit: snapshot.baseCommit, status: 'ready' })) });
    store.set('chats', { id: 'chat-fixture', sessionId, status: 'completed', messages: ['retained conversation'] });
    const endpoint = { host: 'unix:///tmp/unused-export-cleanup.sock', cliPath: '/tmp/unused-docker', configDirectory: path.join(root, 'config') };
    const controller = new SessionController(store, 'fixture', () => {}, () => {}, { endpoint, ensureReady: async () => assert.fail('Export cleanup must not start a runtime'), bridgeHostAddress: () => undefined }, owned);
    t.after(async () => { controller.close(); await rm(root, { recursive: true, force: true }); });
    (controller as unknown as { live: Map<string, unknown> }).live.set(sessionId, { ready: { instance: 'fixture-container' } });
    (controller as unknown as { docker(args: string[]): Promise<string> }).docker = async args => {
      if (args[0] === 'pause' || args[0] === 'unpause') { paused = args[0] === 'pause'; return ''; }
      assert.equal(args[0], 'cp'); assert.equal(paused, true);
      const destination = args[2]!; exports.push(destination);
      await writeFile(path.join(destination, 'output.txt'), 'retained output');
      if (failure === 'copy' && exports.length === 2) throw new Error('copy unavailable');
      return '';
    };
    controller.directoryManager.sourceSnapshots = async () => snapshots;
    controller.directoryManager.captureFromPath = async (snapshot, exported): Promise<WorkingDirectoryCapture> => {
      assert(exports.every(destination => existsSync(destination)), 'No root export may be removed while any capture is pending');
      assert.equal(await readFile(path.join(exported, 'output.txt'), 'utf8'), 'retained output');
      if (failure === 'capture' && snapshot.id === 'two') throw new Error('capture unavailable');
      const bundleArtifact = manifest(`bundle-${snapshot.id}`), diffArtifact = manifest(`diff-${snapshot.id}`);
      for (const artifact of [bundleArtifact, diffArtifact]) { const file = path.join(artifactRoot, artifact.id); await writeFile(file, 'immutable retained bytes'); artifactFiles.push(file); }
      return { id: snapshot.id, name: snapshot.name, kind: snapshot.kind, containerPath: snapshot.containerPath, baseCommit: snapshot.baseCommit, commit: 'c'.repeat(40), bundleArtifact, diffArtifact };
    };
    if (failure) {
      await assert.rejects(controller.captureWorkingDirectories(sessionId), /unavailable/);
      assert(exports.every(destination => existsSync(destination)), 'Any export, capture, artifact or journal failure preserves all copied roots');
      assert.equal(store.get('session-working-directory-captures', sessionId), undefined);
    } else {
      const captures = await controller.captureWorkingDirectories(sessionId);
      assert.equal(captures.length, 2);
      assert.deepEqual(await readdir(exportParent), [path.basename(priorExport)], 'Only UUID exports created by this invocation are removed');
      assert.deepEqual(store.get('session-working-directory-captures', sessionId), { id: sessionId, roots: captures });
      assert(captures.every(capture => [capture.bundleArtifact, capture.diffArtifact].every(artifact => store.get('artifacts', artifact.id))));
    }
    assert.equal(paused, false);
    assert.equal(await readFile(path.join(priorExport, 'retained.txt'), 'utf8'), 'uncertain prior export');
    assert.equal(await readFile(path.join(authoredRoot, 'source.txt'), 'utf8'), 'authored input');
    assert.equal(await readFile(path.join(sourceMetadata, 'snapshots.json'), 'utf8'), 'source metadata');
    assert.equal(store.get<{ messages: string[] }>('chats', 'chat-fixture')?.messages[0], 'retained conversation');
    for (const file of artifactFiles) assert.equal(await readFile(file, 'utf8'), 'immutable retained bytes');
  });
});
