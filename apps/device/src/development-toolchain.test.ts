import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project } from '@enoughfactory/contracts';
import { EnvmuxSession, type EnvmuxReady, type EnvmuxState, type StartOptions } from '@enoughfactory/envmux';
import { SWIFT_TOOLCHAIN, TOOLCHAIN_IMAGE_LABELS, type PreparedToolchain } from '@enoughfactory/runtime';
import { developmentToolchainChoice, parseDevelopmentToolchain } from './development-toolchain.ts';
import { SessionController } from './sessions.ts';
import { Store } from './store.ts';
import { exec } from './util.ts';

test('source detection selects the fixed Swift recipe, with an explicit ordinary-environment override',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'enough-toolchain-selection-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await exec('git',['-C',root,'init','-q']);
  assert.equal(await developmentToolchainChoice({path:root}),'default');
  await mkdir(path.join(root,'Sources'));await writeFile(path.join(root,'Sources','Domain.swift'),'struct Domain {}\n');
  assert.equal(await developmentToolchainChoice({path:root}),'swift-6.0.3');
  assert.equal(await developmentToolchainChoice({path:root,developmentToolchain:'default'}),'default');
  await rm(path.join(root,'Sources'),{recursive:true});await writeFile(path.join(root,'.swift-version'),'6.0.3\n');
  assert.equal(await developmentToolchainChoice({path:root}),'swift-6.0.3');
  await rm(path.join(root,'.swift-version'));await writeFile(path.join(root,'Package.swift'),'// swift-tools-version: 6.0\n');
  assert.equal(await developmentToolchainChoice({path:root}),'swift-6.0.3');
  assert.equal(parseDevelopmentToolchain('auto'),undefined);
  assert.throws(()=>parseDevelopmentToolchain('swift:latest'),/must be auto, default or swift-6.0.3/);
});

test('a retained session restarts with its frozen immutable toolchain after project settings change',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'enough-toolchain-session-')),store=new Store(path.join(root,'store'));
  const image=`sha256:${'a'.repeat(64)}`;
  const toolchain:PreparedToolchain={id:SWIFT_TOOLCHAIN.id,recipeSha256:SWIFT_TOOLCHAIN.recipeSha256,image,baseImage:SWIFT_TOOLCHAIN.baseImage,platform:'linux/arm64',swiftVersion:SWIFT_TOOLCHAIN.swiftVersion,nodeVersion:SWIFT_TOOLCHAIN.nodeVersion};
  // A bounded inert CLI returns only image-inspection metadata; it cannot reach a daemon.
  const cliPath=path.join(root,'owned-image-inspector');
  const inspect=JSON.stringify([{Id:image,Architecture:'arm64',Os:'linux',Config:{Labels:{[TOOLCHAIN_IMAGE_LABELS.managed]:'true',[TOOLCHAIN_IMAGE_LABELS.id]:toolchain.id,[TOOLCHAIN_IMAGE_LABELS.recipe]:toolchain.recipeSha256}}}]);
  await writeFile(cliPath,`#!/bin/sh\nprintf '%s\\n' '${inspect}'\n`,{mode:0o700});
  const endpoint={host:'unix:///tmp/enough-toolchain-inert.sock',cliPath,configDirectory:path.join(root,'config')};
  const controller=new SessionController(store,'fixture',()=>{},()=>{},{endpoint,ensureReady:async()=>endpoint,bridgeHostAddress:()=>undefined},path.join(root,'owned'));
  t.after(async()=>{controller.close();store.close();await rm(root,{recursive:true,force:true});});
  const ready:EnvmuxReady={type:'ready',version:1,endpoint:'http://127.0.0.1:1',token:'fixture',project:'Fixture',session:'swift',instance:'inert-container',workdir:'/work',user:'root',branch:'envmux/swift',dockerHost:endpoint.host,goldenImage:image};
  const state={ready:true,phase:'Ready',branch:ready.branch,tasks:[],routes:[]} as unknown as EnvmuxState;
  const starts:StartOptions[]=[];
  controller.engine.start=async options=>{starts.push(options);const engine=new EnvmuxSession({ready,projectPath:root});engine.state=async()=>state;engine.events=async function*(){};engine.stop=async()=>{};return engine;};
  const project:Project={id:'project',name:'Fixture',path:root,deviceId:'fixture',createdAt:new Date().toISOString(),runtime:'codex',approvalMode:'approve-all',rules:[],developmentToolchain:'swift-6.0.3'};
  store.set('projects',project);
  const session=await controller.create(project,'swift',{developmentToolchain:toolchain});await controller.waitReady(session.id,5000);
  assert.equal(starts[0]?.goldenImage,image);assert.deepEqual(controller.record(session.id).developmentToolchain,toolchain);
  await controller.stop(session.id);store.set('projects',{...project,developmentToolchain:'default'});
  await controller.restart(session.id);await controller.waitReady(session.id,5000);
  assert.equal(starts.length,2);assert.equal(starts[1]?.goldenImage,image);assert.deepEqual(controller.record(session.id).developmentToolchain,toolchain);
  await controller.stop(session.id);
});
