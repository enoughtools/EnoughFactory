import test, { after } from 'node:test';
import { cleanup } from 'node-datachannel';
after(()=>cleanup());
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { PeerManager } from '../src/index.js';
import { createSignalingService, configFromEnvironment } from '../../../services/signaling/src/server.ts';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn:()=>boolean,ms=15000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('Condition timed out');await delay(25);}}
for(const transport of ['webrtc','relay'] as const) {
  test(`Two services pair, ${transport} control/terminal/bulk, and reconnect`,{timeout:45000},async()=> {
    const root=await mkdtemp(join(tmpdir(),'enough-peers-'));
    const server=createSignalingService({...configFromEnvironment({PORT:'0',ENOUGH_SIGNALING_HOST:'127.0.0.1',STUN_URLS:''}),allowedOrigins:[]});
    const listening=await server.listen();const signalingUrl=`ws://127.0.0.1:${listening.port}/ws`;
    let artifactPath='';const observed:string[]=[];
    const turnOptions=transport==='webrtc'&&process.env.ENOUGH_TEST_TURN_URL?{relayOnlyIce:true,iceServers:[{urls:process.env.ENOUGH_TEST_TURN_URL,username:'enough',credential:'local-verification'}]}:{};
    const a=await PeerManager.create({dataDir:join(root,'a'),name:'A',signalingUrl,transport,...turnOptions,onError:e=>observed.push(e.message),
      onRequest:async(_peer,req)=>({v:1,id:req.id,status:200,body:{path:req.path,body:req.body}}),
      onStreamOpen:(_peer,_options,stream)=>{stream.on('data',(data:Buffer)=>{void stream.send(data);});},
      onArtifact:(_peer,_manifest,path)=>{artifactPath=path;}});
    const b=await PeerManager.create({dataDir:join(root,'b'),name:'B',signalingUrl,transport,...turnOptions,onError:e=>observed.push(e.message),
      onRequest:async(_peer,req)=>({v:1,id:req.id,status:200,body:{path:req.path,body:req.body}}),
      onStreamOpen:(_peer,_options,stream)=>{stream.on('data',(data:Buffer)=>{void stream.send(data);});},
      onArtifact:(_peer,_manifest,path)=>{artifactPath=path;}});
    try {
      await a.start();await b.start();await b.pair(a.createInvitation().code);
      await until(()=>a.devices().some(d=>d.id===b.localDevice.id&&d.online));
      assert.equal(a.devices().find(d=>d.id===b.localDevice.id)?.transport,transport);
      if(turnOptions.relayOnlyIce)assert.equal(a.connectionInfo(b.localDevice.id)?.localType,'relay');
      const response=await a.request(b.localDevice.id,{method:'POST',path:'/api/check',body:{hello:'world'}});
      assert.deepEqual(response.body,{path:'/api/check',body:{hello:'world'}});
      const large={text:'EnoughFactory '.repeat(14_000)};
      const fragmented=await a.request(b.localDevice.id,{method:'POST',path:'/api/large',body:large});
      assert.deepEqual(fragmented.body,{path:'/api/large',body:large});
      const stream=await a.openStream(b.localDevice.id,{kind:'terminal',path:'/shell',cursor:10});
      const received=new Promise<Buffer>(resolve=>stream.once('data',resolve));await stream.send('echo enough');
      const artifact=randomBytes(256*1024);const artifactFile=join(root,'bundle.bin');await writeFile(artifactFile,artifact);
      await a.uploadArtifact(b.localDevice.id,artifactFile,{id:'test-bundle',name:'bundle',size:artifact.length,sha256:createHash('sha256').update(artifact).digest('hex')});
      assert.equal((await received).toString(),'echo enough');assert.deepEqual(await readFile(artifactPath),artifact);stream.close();
      const emptyFile=join(root,'empty.bin');await writeFile(emptyFile,Buffer.alloc(0));
      await a.uploadArtifact(b.localDevice.id,emptyFile,{id:'empty-bundle',name:'empty',size:0,sha256:createHash('sha256').update('').digest('hex')});
      assert.equal((await readFile(artifactPath)).length,0);
      await b.stop();await until(()=>!a.devices().find(d=>d.id===b.localDevice.id)?.online,20000);
      await b.start();await until(()=>a.devices().some(d=>d.id===b.localDevice.id&&d.online));
      const resumed=await a.request(b.localDevice.id,{method:'GET',path:'/api/resumed'});assert.equal(resumed.status,200);
      assert.equal(observed.filter(e=>/fingerprint|signature|Invalid envelope/.test(e)).length,0,observed.join('; '));
    }finally{await a.stop();await b.stop();await server.close();await rm(root,{recursive:true,force:true});}
  });
}
