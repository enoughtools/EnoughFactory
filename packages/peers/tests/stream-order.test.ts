import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cleanup } from 'node-datachannel';
import { PeerManager } from '../src/index.js';
import { createSignalingService, configFromEnvironment } from '../../../services/signaling/src/server.ts';
after(()=>cleanup());
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn:()=>boolean){const end=Date.now()+10000;while(!fn()){if(Date.now()>end)throw new Error('Condition timed out');await delay(10);}}

test('Clean stream EOF follows final RTC bytes and targeted events reach only their recipient',{timeout:15000},async()=> {
  const directory=await mkdtemp(join(tmpdir(),'enough-stream-order-'));
  const signaling=createSignalingService(configFromEnvironment({PORT:'0',ENOUGH_SIGNALING_HOST:'127.0.0.1',STUN_URLS:''}));
  const address=await signaling.listen();const signalingUrl=`ws://127.0.0.1:${address.port}/ws`;
  const payload=randomBytes(512*1024);const receivedByB:unknown[]=[];const receivedByC:unknown[]=[];
  const a=await PeerManager.create({dataDir:join(directory,'a'),name:'Coordinator',signalingUrl,transport:'webrtc'});
  const b=await PeerManager.create({dataDir:join(directory,'b'),name:'Worker',signalingUrl,transport:'webrtc',onEvent:(_id,event)=>receivedByB.push(event),
    onStreamOpen:(_id,_options,stream)=> {stream.once('data',()=>{void stream.send(payload).then(()=>stream.close(undefined,'events'));});}});
  const c=await PeerManager.create({dataDir:join(directory,'c'),name:'Other worker',signalingUrl,transport:'webrtc',onEvent:(_id,event)=>receivedByC.push(event)});
  try {
    await Promise.all([a.start(),b.start(),c.start()]);await b.pair(a.createInvitation().code);await c.pair(a.createInvitation().code);
    await until(()=>a.devices().filter(device=>device.online&&!device.local).length===2);
    const stream=await a.openStream(b.localDevice.id,{kind:'terminal',path:'/final-output'});
    const parts:Buffer[]=[];stream.on('data',(bytes:Buffer)=>parts.push(bytes));
    const ended=new Promise<void>((resolve,reject)=>stream.once('end',error=>error?reject(new Error(error)):resolve()));
    await stream.send('finish');await ended;
    assert.deepEqual(Buffer.concat(parts),payload,'EOF must not overtake data on its ordered event channel');
    await a.publishTo(b.localDevice.id,'state',{revision:4},91);await until(()=>receivedByB.length===1);await delay(50);
    assert.deepEqual(receivedByB,[{v:1,type:'event',topic:'state',cursor:91,data:{revision:4}}]);assert.equal(receivedByC.length,0);
  }finally{await Promise.all([a.stop(),b.stop(),c.stop()]);await signaling.close();await rm(directory,{recursive:true,force:true});}
});
