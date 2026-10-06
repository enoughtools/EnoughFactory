import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID, generateKeyPairSync, createPublicKey, diffieHellman, type KeyObject } from 'node:crypto';
import { readFile, mkdir, open, stat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname, platform, arch } from 'node:os';
import WebSocket from 'ws';
import type { Device, RpcRequest, RpcResponse, StreamEvent } from '@enoughfactory/contracts';
import { identityId, loadIdentity, saveJson, signValue, verifyValue, encrypt, decrypt, secretKey, type Identity, type Ciphertext } from './identity.js';
import { canonical, signedPart, type SignedEnvelope, type IceServer, type Frame, type Lane, type StreamOptions, type ArtifactManifest } from './protocol.js';
import { NativeConnection } from './native.js';
import { PeerStream } from './stream.js';
import { iceCredentialsNeedRefresh, liveRtcIceServers, negotiatedRelayLimits, type RelayLimits } from './types.js';
export { PeerStream, bridgePeerStreams } from './stream.js';
export { streamToDuplex } from './duplex.js';
export type { IceServer, StreamOptions, ArtifactManifest } from './protocol.js';

export interface PeerOptions {
  dataDir: string; name?: string; signalingUrl?: string; iceServers?: IceServer[]; relayFallback?: boolean;
  /** Force encrypted websocket relay; useful behind networks blocking UDP. */
  transport?: 'auto'|'relay'|'webrtc'; relayOnlyIce?: boolean;
  onRequest?: (peerId: string,request: RpcRequest)=>Promise<RpcResponse>;
  onEvent?: (peerId: string,event: StreamEvent)=>void;
  onDevices?: (devices: Device[])=>void;
  onStreamOpen?: (peerId: string,options: StreamOptions,stream: PeerStream)=>Promise<void>|void;
  onArtifact?: (peerId: string,manifest: ArtifactManifest,path: string)=>Promise<void>|void;
  onError?: (error: Error)=>void;
}
interface PairedDevice extends Device { publicKey: string }
interface Invitation { v: 1; deviceId: string; name: string; publicKey: string; signalingUrl: string; secret: string; expiresAt: string }
interface PendingPair { invitation: Invitation; resolve: (device: Device)=>void; reject: (error: Error)=>void; timer: NodeJS.Timeout }
interface QueueItem { wire: string; resolve:()=>void; reject:(error: Error)=>void }
interface Link {
  id: string; session: string; initiator: boolean; ephemeral: { publicKey: KeyObject; privateKey: KeyObject }; relayKey?: Buffer;
  native?: NativeConnection; creating?: Promise<NativeConnection>; connecting?: NodeJS.Timeout;
  transport?: 'webrtc'|'relay'; seq: number; remoteSeq: Map<string,number>; queue: Record<Lane,QueueItem[]>;
  queueBytes: Record<Lane,number>; draining?: boolean; candidates: {candidate:string;mid:string}[]; described: boolean;
}
interface PendingRpc { resolve:(value:RpcResponse)=>void; reject:(error:Error)=>void; timer:NodeJS.Timeout; peerId:string }
interface IncomingTransfer { peerId:string; manifest:ArtifactManifest; path:string; offset:number }
const now = ()=>new Date().toISOString();
const sleep = (ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/** Paired, authenticated service-to-service transport. Presence never grants control. */
export class PeerManager extends EventEmitter {
  readonly identity: Identity;
  readonly localDevice: Device;
  private catalog = new Map<string,PairedDevice>();
  private links = new Map<string,Link>();
  private socket?: WebSocket;
  private signalReady = false;
  private deliveryAcknowledgments = false;
  private signalingPongAt = 0;
  private relayLimits?: RelayLimits;
  private nextRelaySendAt = 0;
  private stopped = true;
  private reconnect?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private reconnectDelay = 500;
  private signalSequence = 0;
  private signalEpoch = randomUUID();
  private iceServers: IceServer[];
  private invitations = new Map<string,Invitation>();
  private pendingPairs = new Map<string,PendingPair>();
  private rpc = new Map<string,PendingRpc>();
  private streams = new Map<string,{peerId:string;stream:PeerStream}>();
  private streamReady = new Map<string,{resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private transfers = new Map<string,IncomingTransfer>();
  private uploads = 0;
  private transferProcessing = 0;
  private serviceHandoff = false;
  private receipts = new Map<string,RpcResponse>();
  private processing = new Map<string,Promise<RpcResponse>>();
  private receiveSequences = new Map<string,number>();
  private fragments=new Map<string,{parts:Buffer[];total:number;bytes:number;expires:number}>();
  private eventCursor=0;
  private saveChain: Promise<void> = Promise.resolve();
  private constructor(private options: PeerOptions,identity: Identity,devices: PairedDevice[]) {
    super(); this.identity=identity; this.iceServers=options.iceServers??[];
    this.localDevice={id:identity.id,name:options.name??hostname(),platform:platform(),arch:arch(),online:true,lastSeen:now(),local:true,publicKey:identity.publicKey,transport:'local'};
    for (const device of devices) {
      if (device.id!==identityId(device.publicKey)) throw new Error('Paired device identity is invalid');
      this.catalog.set(device.id,{...device,online:false,local:false});
    }
  }
  static async create(options: PeerOptions): Promise<PeerManager> {
    const directory=join(options.dataDir,'peers'); await mkdir(directory,{recursive:true,mode:0o700});
    const identity=await loadIdentity(directory); let devices:PairedDevice[]=[];
    try { devices=JSON.parse(await readFile(join(directory,'devices.json'),'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
    return new PeerManager(options,identity,devices);
  }
  connectionInfo(peerId:string):{transport?:'webrtc'|'relay';localType?:string;remoteType?:string;rtt?:number}|undefined {const link=this.links.get(peerId);if(!link)return;return {transport:link.transport,...(link.transport==='webrtc'?link.native?.connectionInfo():{})};}
  devices(): Device[] { return [this.localDevice,...this.catalog.values()].map(device=>({...device})); }
  serviceActivity(): {transfers:number;uploads:number;processing:number} {
    return {transfers:[...this.transfers.values()].filter(transfer=>this.links.get(transfer.peerId)?.transport).length,
      uploads:this.uploads,processing:this.transferProcessing};
  }
  beginServiceHandoff():void {this.serviceHandoff=true;}
  async start(): Promise<void> {
    if (!this.stopped) return; this.stopped=false;
    if (this.options.signalingUrl) this.connectSignaling();
    this.heartbeat=setInterval(()=> {
      if(this.signalReady && this.socket?.readyState===WebSocket.OPEN){
        if(this.deliveryAcknowledgments && Date.now()-this.signalingPongAt>=30_000)this.socket.terminate();
        else {
          if(this.deliveryAcknowledgments)this.socket.send('ping');
          if(iceCredentialsNeedRefresh(this.iceServers))this.socket.send(JSON.stringify({v:1,type:'ice-request'}));
        }
      }
      for (const link of this.links.values()) {
        if (!link.transport && !link.connecting && this.signalReady) this.initiate(link.id);
        // Hosted relay reachability comes from room presence and its automatic
        // socket pong. Idle RPCs would wake a hibernating Worker every15 seconds.
        if (link.transport && !(link.transport==='relay' && this.deliveryAcknowledgments))
          void this.request(link.id,{method:'GET',path:'/__peers/ping'},5000).catch(()=>{if(this.links.get(link.id)===link)this.disconnect(link.id,'Connection heartbeat missed');});
      }
    },15000); this.heartbeat.unref();
  }
  async stop(): Promise<void> {
    this.stopped=true; this.signalReady=false;this.deliveryAcknowledgments=false;this.signalingPongAt=0;
    this.relayLimits=undefined;this.nextRelaySendAt=0;
    if (this.reconnect) clearTimeout(this.reconnect); if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close(); this.socket=undefined;
    for (const id of [...this.links.keys()]) this.disconnect(id,'Device service stopped');
    for (const pair of this.pendingPairs.values()) {clearTimeout(pair.timer);pair.reject(new Error('Device service stopped'));} this.pendingPairs.clear();
    await this.saveChain;
  }
  async configure(settings: Pick<PeerOptions,'signalingUrl'|'iceServers'|'relayFallback'|'transport'>):Promise<void> {
    this.options={...this.options,...settings}; this.iceServers=settings.iceServers??this.iceServers;
    if (!this.stopped) { await this.stop(); await this.start(); }
  }
  async rename(name:string):Promise<void> { this.localDevice.name=name; this.options.name=name; this.notify(); if(this.signalReady)this.socket?.close(); }
  createInvitation(): {code:string;url:string;expiresAt:string} {
    if (!this.options.signalingUrl) throw new Error('Configure a self-hosted signaling URL before pairing devices');
    const invitation:Invitation={v:1,deviceId:this.identity.id,name:this.localDevice.name,publicKey:this.identity.publicKey,
      signalingUrl:this.options.signalingUrl,secret:randomBytes(32).toString('base64url'),expiresAt:new Date(Date.now()+10*60_000).toISOString()};
    this.invitations.set(invitation.secret,invitation);
    const code=Buffer.from(JSON.stringify(invitation)).toString('base64url');
    return {code,url:'enoughfactory://pair?code='+code,expiresAt:invitation.expiresAt};
  }
  async pair(codeOrUrl:string):Promise<Device> {
    let code=codeOrUrl.trim(); if (code.includes('://')) code=new URL(code).searchParams.get('code')??'';
    const invitation=JSON.parse(Buffer.from(code,'base64url').toString()) as Invitation;
    if(invitation.v!==1 || !invitation.secret || invitation.deviceId!==identityId(invitation.publicKey) || Date.parse(invitation.expiresAt)<Date.now()) throw new Error('Pairing invitation is invalid or expired');
    if(invitation.deviceId===this.identity.id)throw new Error('This invitation belongs to this device');
    this.validateSignalingUrl(invitation.signalingUrl);
    if(this.options.signalingUrl!==invitation.signalingUrl)await this.configure({signalingUrl:invitation.signalingUrl});
    await this.waitSignaling();
    const requestId=randomUUID();
    return new Promise<Device>((resolve,reject)=> {
      const timer=setTimeout(()=> {this.pendingPairs.delete(requestId);reject(new Error('Pairing timed out. The inviting device must be online.'));},20_000);
      this.pendingPairs.set(requestId,{invitation,resolve,reject,timer});
      this.signal(invitation.deviceId,'pair:'+requestId,{kind:'pair-request',requestId,secretId:createHash('sha256').update(invitation.secret).digest('hex'),
        box:encrypt(secretKey(invitation.secret),{device:this.localDevice},requestId)});
    });
  }
  async forget(peerId:string):Promise<void> {this.disconnect(peerId,'Device unpaired');this.catalog.delete(peerId);await this.persist();this.discoverPeers();this.notify();}
  private discoverPeers():void {
    if(this.deliveryAcknowledgments && this.socket?.readyState===WebSocket.OPEN)
      this.socket.send(JSON.stringify({v:1,type:'discover',devices:[...this.catalog.keys()]}));
  }
  private validateSignalingUrl(url:string):void {
    const parsed=new URL(url); if(parsed.protocol!=='wss:' && !(parsed.protocol==='ws:' && ['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)))
      throw new Error('Signaling must use WSS, or WS on localhost for development');
  }
  private connectSignaling():void {
    if(this.stopped || !this.options.signalingUrl)return;
    try {
      this.validateSignalingUrl(this.options.signalingUrl); const socket=new WebSocket(this.options.signalingUrl,{maxPayload:2*1024*1024}); this.socket=socket;
      socket.on('message',data=> {try{
        if(this.socket!==socket)return;
        const wire=data.toString();if(wire==='pong'){this.signalingPongAt=Date.now();return;}
        const message=JSON.parse(wire);
        void this.handleSignal(message).then(()=>{
          if(this.socket===socket && this.deliveryAcknowledgments && socket.readyState===WebSocket.OPEN && typeof message.deliveryId==='string' && message.deliveryId.length<=128)
            socket.send(JSON.stringify({v:1,type:'delivery-ack',id:message.deliveryId}));
        }).catch(error=>this.error(error));
      }catch(error){this.error(error);}});
      socket.on('error',error=>this.error(error));
      socket.on('close',()=> {
        if(this.socket!==socket)return; this.signalReady=false;this.deliveryAcknowledgments=false;this.signalingPongAt=0;this.socket=undefined;
        this.relayLimits=undefined;this.nextRelaySendAt=0;
        for(const link of this.links.values())if(link.transport==='relay')this.disconnect(link.id,'Signaling relay disconnected');
        if(!this.stopped){this.reconnect=setTimeout(()=>this.connectSignaling(),this.reconnectDelay);this.reconnectDelay=Math.min(15_000,this.reconnectDelay*2);this.reconnect.unref();}
      });
    } catch(error) {this.error(error);}
  }
  private async handleSignal(message:any):Promise<void> {
    if(message.type==='challenge') {
      const auth={v:1,type:'auth',deviceId:this.identity.id,publicKey:this.identity.publicKey,name:this.localDevice.name,platform:this.localDevice.platform,arch:this.localDevice.arch,nonce:message.nonce};
      this.socket?.send(JSON.stringify({...auth,signature:signValue(this.identity.privateKey,auth),deliveryAcknowledgments:true,discoverPeers:[...this.catalog.keys()]}));return;
    }
    if(message.type==='auth-ok') {this.signalReady=true;this.deliveryAcknowledgments=message.deliveryAcknowledgments===true;this.signalingPongAt=Date.now();this.relayLimits=negotiatedRelayLimits(message.relayLimits);this.nextRelaySendAt=0;if(message.relay===false)this.options.relayFallback=false;this.reconnectDelay=500;this.updateIceServers(message.iceServers??[]);this.emit('signaling',true);return;}
    if(message.type==='ice'){this.updateIceServers(message.iceServers??[]);return;}
    if(message.type==='presence') {
      const present=new Set((message.devices??[]).filter((entry:any)=>entry.online).map((entry:any)=>entry.deviceId));
      for(const link of this.links.values())if(link.transport==='relay' && !present.has(link.id))this.disconnect(link.id,'Peer offline');
      for(const entry of message.devices??[]) {
        const peer=this.catalog.get(entry.deviceId); if(!peer || peer.publicKey!==entry.publicKey)continue;
        if(entry.online && this.identity.id<peer.id && !this.links.has(peer.id))this.initiate(peer.id);
        if(!entry.online && this.links.get(peer.id)?.transport==='relay')this.disconnect(peer.id,'Peer offline');
      } return;
    }
    if(message.type==='error'){this.error(new Error(message.error??message.message??'Signaling error'));return;}
    if(message.type!=='signal' && message.type!=='relay')return;
    const envelope=message as SignedEnvelope;
    if(envelope.v!==1 || envelope.to!==this.identity.id || Math.abs(Date.now()-envelope.at)>120_000)return;
    const payload=envelope.payload as any; const known=this.catalog.get(envelope.from);
    let key=known?.publicKey;
    if(payload.kind==='pair-request') {
      // Public key is outside the sealed invitation only to verify the sender; enrollment needs its secret proof below.
      key=payload.publicKey;
    } else if(payload.kind==='pair-accepted')key=this.pendingPairs.get(payload.requestId)?.invitation.publicKey;
    if(!key || identityId(key)!==envelope.from || !verifyValue(key,signedPart(envelope),envelope.signature))return;
    const sequenceKey=envelope.from+':'+envelope.type+':'+envelope.session;
    if(envelope.seq<=(this.receiveSequences.get(sequenceKey)??-1))return; this.receiveSequences.set(sequenceKey,envelope.seq);
    if(payload.kind==='pair-request') {await this.acceptPair(envelope,payload);return;}
    if(payload.kind==='pair-accepted') {await this.finishPair(envelope,payload);return;}
    if(!known)return;
    if(envelope.type==='relay') {
      const link=this.links.get(envelope.from);if(!link || link.session!==envelope.session || !link.relayKey)return;
      const frame=decrypt<Frame>(link.relayKey,payload.box,link.session+':'+envelope.from+':'+envelope.seq);
      if(!link.transport)this.online(link,'relay'); await this.frame(link,frame);return;
    }
    await this.negotiate(envelope.from,envelope.session,payload);
  }
  private async acceptPair(envelope:SignedEnvelope,payload:any):Promise<void> {
    const invitation=[...this.invitations.values()].find(inv=>createHash('sha256').update(inv.secret).digest('hex')===payload.secretId);
    if(!invitation || Date.parse(invitation.expiresAt)<Date.now())return;
    const decoded=decrypt<{device:PairedDevice}>(secretKey(invitation.secret),payload.box,payload.requestId);
    if(decoded.device.id!==envelope.from || decoded.device.publicKey!==payload.publicKey)return;
    this.invitations.delete(invitation.secret);
    this.catalog.set(envelope.from,{...decoded.device,online:false,local:false});await this.persist();this.discoverPeers();this.notify();
    this.signal(envelope.from,envelope.session,{kind:'pair-accepted',requestId:payload.requestId,
      box:encrypt(secretKey(invitation.secret),{device:this.localDevice},payload.requestId)});
    if(this.identity.id<envelope.from)this.initiate(envelope.from);
  }
  private async finishPair(envelope:SignedEnvelope,payload:any):Promise<void> {
    const pending=this.pendingPairs.get(payload.requestId);if(!pending)return;
    const decoded=decrypt<{device:PairedDevice}>(secretKey(pending.invitation.secret),payload.box,payload.requestId);
    if(decoded.device.id!==envelope.from || decoded.device.publicKey!==pending.invitation.publicKey)return;
    clearTimeout(pending.timer);this.pendingPairs.delete(payload.requestId);this.catalog.set(envelope.from,{...decoded.device,online:false,local:false});await this.persist();this.discoverPeers();this.notify();
    pending.resolve({...decoded.device,online:false,local:false});if(this.identity.id<envelope.from)this.initiate(envelope.from);
  }
  private signal(to:string,session:string,payload:unknown):void {
    if(!this.signalReady || this.socket?.readyState!==WebSocket.OPEN)return;
    const enriched=(payload as any).kind==='pair-request'?{...(payload as object),publicKey:this.identity.publicKey}:payload;
    const envelope:Omit<SignedEnvelope,'signature'>={v:1,type:'signal',from:this.identity.id,to,session,seq:++this.signalSequence,at:Date.now(),payload:enriched};
    this.socket.send(JSON.stringify({...envelope,signature:signValue(this.identity.privateKey,envelope)}));
  }
  private newLink(id:string,session:string,initiator:boolean):Link {
    const link:Link={id,session,initiator,ephemeral:generateKeyPairSync('x25519'),seq:0,remoteSeq:new Map(),queue:{control:[],events:[],bulk:[]},queueBytes:{control:0,events:0,bulk:0},candidates:[],described:false};
    this.links.set(id,link);return link;
  }
  private initiate(id:string):void {
    if(!this.signalReady || !this.catalog.has(id))return;
    const prior=this.links.get(id);if(prior?.transport || prior?.connecting)return;
    if(prior)this.disconnect(id,'Negotiation restarted');
    const link=this.newLink(id,randomUUID(),true);this.sendHello(link);
    if(this.options.transport!=='relay')void this.native(link,true).catch(error=>this.error(error));
    // A relay hello activates immediately; its failure deadline must still allow a WAN round trip.
    link.connecting=setTimeout(()=> {
      if(this.links.get(id)!==link)return;
      link.connecting=undefined;if(link.transport)return;
      if(this.options.transport!=='webrtc' && this.options.relayFallback!==false && link.relayKey) {this.signal(id,link.session,{kind:'use-relay'});this.online(link,'relay');}
      else this.disconnect(id,'No direct or relay connection');
    },5000);link.connecting.unref();
  }
  private sendHello(link:Link):void {this.signal(link.id,link.session,{kind:'hello',publicKey:link.ephemeral.publicKey.export({format:'pem',type:'spki'}).toString()});}
  private async negotiate(id:string,session:string,payload:any):Promise<void> {
    let link=this.links.get(id);
    if(payload.kind==='hello') {
      if(link && link.session!==session) {
        // Deterministic offer ownership avoids crossed negotiations after both endpoints wake.
        if(this.identity.id<id && link.initiator)return;this.disconnect(id,'New peer negotiation');link=undefined;
      }
      if(!link) {link=this.newLink(id,session,false);this.sendHello(link);}
      const shared=diffieHellman({privateKey:link.ephemeral.privateKey,publicKey:createPublicKey(payload.publicKey)});
      link.relayKey=createHash('sha256').update(shared).update(session).update([id,this.identity.id].sort().join(':')).digest();
      if(this.options.transport==='relay' && link.initiator){this.signal(id,session,{kind:'use-relay'});this.online(link,'relay');}return;
    }
    if(!link || link.session!==session)return;
    if(payload.kind==='use-relay') {if(this.options.transport!=='webrtc' && this.options.relayFallback!==false && link.relayKey)this.online(link,'relay');return;}
    if(payload.kind==='description') {
      if(this.options.transport==='relay')return;
      const native=await this.native(link,false);native.description(payload.sdp,payload.type);link.described=true;
      for(const candidate of link.candidates.splice(0))native.candidate(candidate.candidate,candidate.mid);return;
    }
    if(payload.kind==='candidate') {if(link.native && link.described)link.native.candidate(payload.candidate,payload.mid);else link.candidates.push(payload);}
  }
  private updateIceServers(servers:IceServer[]):void {
    const next=[...this.options.iceServers??[],...servers];
    const credentials=(values:IceServer[])=>JSON.stringify(values.map(({expiresAt:_expiry,...server})=>server));
    const changed=credentials(this.iceServers)!==credentials(next);this.iceServers=next;
    if(!changed)return;
    // Pinned libdatachannel has no live TURN credential setter. Recreate only
    // observable local TURN allocations; established direct paths stay live.
    for(const link of [...this.links.values()])if(link.transport==='webrtc' && link.native){
      let localType:string|undefined;try{localType=link.native.connectionInfo().localType;}catch{continue;}
      if(localType==='relay')this.disconnect(link.id,'Temporary TURN credentials renewed; reconnecting relay');
    }
  }
  private native(link:Link,initiator:boolean):Promise<NativeConnection> {
    if(link.native)return Promise.resolve(link.native);if(link.creating)return link.creating;
    link.creating=NativeConnection.create(link.id,liveRtcIceServers(this.iceServers),{
      onDescription:(sdp,type)=>{if(this.links.get(link.id)===link)this.signal(link.id,link.session,{kind:'description',sdp,type});},
      onCandidate:(candidate,mid)=>{if(this.links.get(link.id)===link)this.signal(link.id,link.session,{kind:'candidate',candidate,mid});},
      onOpen:lane=>{if(lane==='control' && this.links.get(link.id)===link)this.online(link,'webrtc');},
      onMessage:(_lane,wire)=> {if(this.links.get(link.id)===link)try{void this.frame(link,JSON.parse(wire)).catch(error=>this.error(error));}catch(error){this.error(error);}},
      onClosed:()=> {if(this.links.get(link.id)===link && link.transport==='webrtc')this.disconnect(link.id,'WebRTC disconnected');},
      onError:error=>this.error(error),
    },initiator,this.options.relayOnlyIce).then(native=> {if(this.links.get(link.id)!==link || this.stopped){native.close();throw new Error('Peer negotiation superseded');}link.native=native;return native;});return link.creating;
  }
  private online(link:Link,transport:'webrtc'|'relay'):void {
    if(this.links.get(link.id)!==link || !this.catalog.has(link.id))return;
    if(link.connecting)clearTimeout(link.connecting);link.connecting=undefined;link.transport=transport;
    const peer=this.catalog.get(link.id);if(peer){peer.online=true;peer.transport=transport;peer.lastSeen=now();this.notify();void this.persist();}
    void this.drain(link);this.emit('online',link.id,transport);
  }
  private disconnect(id:string,reason:string):void {
    const link=this.links.get(id);if(link){this.links.delete(id);if(link.connecting)clearTimeout(link.connecting);link.native?.close();
      for(const lane of Object.values(link.queue))for(const item of lane)item.reject(new Error(reason));}
    const peer=this.catalog.get(id);if(peer){peer.online=false;peer.transport=undefined;this.notify();void this.persist();}
    for(const [requestId,pending] of this.rpc)if(pending.peerId===id){clearTimeout(pending.timer);pending.reject(new Error(reason));this.rpc.delete(requestId);}
    for(const {peerId,stream}of this.streams.values())if(peerId===id)stream.remoteClose(reason);
    for(const key of this.fragments.keys())if(key.startsWith(id+':'))this.fragments.delete(key);
    this.emit('offline',id,reason);
    if(!this.stopped && this.signalReady && this.identity.id<id && this.catalog.has(id))setTimeout(()=>{if(!this.links.has(id))this.initiate(id);},1000).unref();
  }
  private async waitSignaling():Promise<void> {
    if(this.stopped)await this.start();const until=Date.now()+10_000;
    while(!this.signalReady && Date.now()<until)await sleep(50);if(!this.signalReady)throw new Error('Signaling is unavailable');
  }
  private async waitLink(id:string,timeout=10_000):Promise<Link> {
    if(!this.catalog.has(id))throw new Error('Device is not paired');
    if(!this.links.has(id) && this.signalReady)this.initiate(id);
    const until=Date.now()+timeout;while(Date.now()<until){const link=this.links.get(id);if(link?.transport)return link;await sleep(25);}
    throw new Error('Device is offline or connection is unavailable');
  }
  private async send(id:string,frame:Frame,lane:Lane='control'):Promise<void> {
    const link=await this.waitLink(id);const wire=JSON.stringify(frame);
    const size=Buffer.byteLength(wire);const limit=lane==='control'?2*1024*1024:8*1024*1024;
    if(size>60*1024) {
      if(size>16*1024*1024)throw new Error('Peer message exceeds 16MiB; use streams or artifact transfer');
      const bytes=Buffer.from(wire);const fragmentId=randomUUID();const total=Math.ceil(bytes.length/(32*1024));
      for(let part=0;part<total;part++)await this.send(id,{v:1,type:'fragment',id:fragmentId,part,total,data:bytes.subarray(part*32*1024,(part+1)*32*1024).toString('base64')},lane);
      return;
    }
    if(link.queueBytes[lane]+size>limit)throw new Error('Peer transport queue is full');
    return new Promise((resolve,reject)=>{link.queue[lane].push({wire,resolve,reject});link.queueBytes[lane]+=size;void this.drain(link);});
  }
  private async drain(link:Link):Promise<void> {
    if(link.draining)return;link.draining=true;
    try {
      while(this.links.get(link.id)===link && link.transport) {
        // At most one bulk frame per pass; control always gets the first opportunity.
        let progress=false;
        for(const lane of ['control','events','bulk'] as Lane[]) {
          const item=link.queue[lane][0];if(!item)continue;
          if(link.transport==='webrtc') {
            if(!link.native?.open(lane) || link.native.buffered(lane)>256*1024)continue;
            if(!link.native.send(lane,item.wire))continue;
          } else {
            if(!link.relayKey || !this.signalReady || this.socket?.readyState!==WebSocket.OPEN || this.socket.bufferedAmount>256*1024)continue;
            if(this.relayLimits && Date.now()<this.nextRelaySendAt)continue;
            const seq=++link.seq;const payload={box:encrypt(link.relayKey,JSON.parse(item.wire),link.session+':'+this.identity.id+':'+seq)};
            const envelope:Omit<SignedEnvelope,'signature'>={v:1,type:'relay',from:this.identity.id,to:link.id,session:link.session,seq,at:Date.now(),payload};
            const relayWire=JSON.stringify({...envelope,signature:signValue(this.identity.privateKey,envelope)});
            this.socket.send(relayWire);
            if(this.relayLimits)this.nextRelaySendAt=Date.now()+Math.max(Buffer.byteLength(relayWire)/this.relayLimits.bytesPerSecond*1000,1000/this.relayLimits.messagesPerSecond);
          }
          progress=true;link.queue[lane].shift();link.queueBytes[lane]-=Buffer.byteLength(item.wire);item.resolve();
        }
        if(!Object.values(link.queue).some(queue=>queue.length))break;
        await sleep(progress?0:10);
      }
    }finally{link.draining=false;}
  }
  async request(peerId:string,request:Omit<RpcRequest,'v'|'id'>,timeout=30_000):Promise<RpcResponse> {
    const id=randomUUID();return new Promise((resolve,reject)=> {
      const timer=setTimeout(()=>{this.rpc.delete(id);reject(new Error('Remote request timed out; execution outcome may be unknown'));},timeout);timer.unref();
      this.rpc.set(id,{resolve,reject,timer,peerId});void this.send(peerId,{v:1,id,...request},request.path.endsWith('/transfers/chunk')?'bulk':'control').catch(error=>{clearTimeout(timer);this.rpc.delete(id);reject(error);});
    });
  }
  async publishTo(peerId:string,topic:string,data:unknown,cursor?:number):Promise<void> {
    await this.send(peerId,{v:1,type:'event',topic,cursor:cursor??++this.eventCursor,data},'events');
  }
  async publish(topic:string,data:unknown,cursor?:number):Promise<void> {
    const event:StreamEvent={v:1,type:'event',topic,cursor:cursor??++this.eventCursor,data};
    await Promise.allSettled([...this.links.values()].filter(link=>link.transport).map(link=>this.send(link.id,event,'events')));
  }
  private async frame(link:Link,frame:Frame):Promise<void> {
    if(frame.v!==1)return;const peer=this.catalog.get(link.id);if(peer)peer.lastSeen=now();
    if('type'in frame && frame.type==='fragment') {
      for(const [key,value] of this.fragments)if(value.expires<Date.now())this.fragments.delete(key);
      const key=link.id+':'+frame.id;let assembly=this.fragments.get(key);
      if(!assembly) {
        if(frame.part!==0 || !Number.isInteger(frame.total) || frame.total<1 || frame.total>512 || [...this.fragments.keys()].filter(key=>key.startsWith(link.id+':')).length>=4)return;
        assembly={parts:[],total:frame.total,bytes:0,expires:Date.now()+30_000};this.fragments.set(key,assembly);
      }
      const bytes=Buffer.from(frame.data,'base64');
      if(bytes.length>32*1024 || frame.total!==assembly.total || frame.part!==assembly.parts.length || assembly.bytes+bytes.length>16*1024*1024){this.fragments.delete(key);return;}
      assembly.parts.push(bytes);assembly.bytes+=bytes.length;
      if(assembly.parts.length===assembly.total){this.fragments.delete(key);const complete=JSON.parse(Buffer.concat(assembly.parts).toString());if(complete.type!=='fragment')await this.frame(link,complete);}
      return;
    }
    if('status'in frame && 'id'in frame) {const pending=this.rpc.get(frame.id);if(pending?.peerId===link.id){clearTimeout(pending.timer);this.rpc.delete(frame.id);pending.resolve(frame);}return;}
    if('method'in frame) {
      const key=link.id+':'+frame.id;const cached=this.receipts.get(key);if(cached){await this.send(link.id,cached);return;}
      let execution=this.processing.get(key);
      if(!execution){execution=this.handleRequest(link.id,frame);this.processing.set(key,execution);}
      const response=await execution;this.processing.delete(key);this.receipts.set(key,response);
      if(this.receipts.size>500)this.receipts.delete(this.receipts.keys().next().value!);await this.send(link.id,response);return;
    }
    if(!('type'in frame))return;
    if(frame.type==='event'){this.options.onEvent?.(link.id,frame);this.emit('event',link.id,frame);return;}
    if(frame.type==='stream-open') {
      if(this.streams.size>=128){await this.send(link.id,{v:1,type:'stream-close',id:frame.id,error:'Stream capacity reached'});return;}
      const stream=this.makeStream(link.id,frame.id);
      try{if(!this.options.onStreamOpen)throw new Error('Device does not support remote streams');
        await this.options.onStreamOpen(link.id,frame.options,stream);await this.send(link.id,{v:1,type:'stream-ready',id:frame.id});
      }catch(error){stream.close((error as Error).message);}return;
    }
    if(frame.type==='stream-ready'){const pending=this.streamReady.get(frame.id);if(pending){clearTimeout(pending.timer);this.streamReady.delete(frame.id);pending.resolve();}return;}
    const entry=this.streams.get(frame.id);if(!entry || entry.peerId!==link.id)return;
    if(frame.type==='stream-data')entry.stream.receive(frame.data,frame.binary,frame.cursor);
    if(frame.type==='stream-close'){const pending=this.streamReady.get(frame.id);if(pending){clearTimeout(pending.timer);this.streamReady.delete(frame.id);pending.reject(new Error(frame.error??'Remote stream closed'));}entry.stream.remoteClose(frame.error);}
  }
  private async handleRequest(peerId:string,request:RpcRequest):Promise<RpcResponse> {
    try {
      if(request.path==='/__peers/ping')return {v:1,id:request.id,status:200,body:{deviceId:this.identity.id,at:now()}};
      if(request.path.startsWith('/__peers/transfers/')) {
        if(this.serviceHandoff)return {v:1,id:request.id,status:409,body:{error:'The device service is updating.',code:'SERVICE_UPDATING'}};
        this.transferProcessing++;
        try{return {v:1,id:request.id,status:200,body:await this.transferRequest(peerId,request)};}
        finally{this.transferProcessing--;}
      }
      if(!this.options.onRequest)return {v:1,id:request.id,status:404,body:{error:'Remote API unavailable'}};
      return {...await this.options.onRequest(peerId,request),v:1,id:request.id};
    }catch(error){return {v:1,id:request.id,status:500,body:{error:(error as Error).message}};}
  }
  private makeStream(peerId:string,id:string):PeerStream {
    const stream=new PeerStream(id,(frame,lane)=>this.send(peerId,frame,lane),()=>this.streams.delete(id));this.streams.set(id,{peerId,stream});return stream;
  }
  async openStream(peerId:string,options:StreamOptions):Promise<PeerStream> {
    if(this.serviceHandoff)throw new Error('The device service is updating.');
    const id=randomUUID();const stream=this.makeStream(peerId,id);
    await new Promise<void>((resolve,reject)=> {
      const timer=setTimeout(()=>{this.streamReady.delete(id);stream.remoteClose('Stream open timed out');reject(new Error('Stream open timed out'));},15_000);timer.unref();
      this.streamReady.set(id,{resolve,reject,timer});void this.send(peerId,{v:1,type:'stream-open',id,options}).catch(error=>{clearTimeout(timer);this.streamReady.delete(id);stream.remoteClose(error.message);reject(error);});
    });return stream;
  }
  async uploadArtifact(peerId:string,path:string,manifest:ArtifactManifest):Promise<void> {
    if(this.serviceHandoff)throw new Error('The device service is updating.');
    this.uploads++;
    try {const file=await open(path,'r');try {
      const size=(await file.stat()).size;if(size!==manifest.size)throw new Error('Artifact size does not match manifest');
      let response=await this.request(peerId,{method:'POST',path:'/__peers/transfers/start',body:manifest});if(response.status!==200)throw new Error(JSON.stringify(response.body));
      let offset=Number((response.body as any).offset??0);const chunk=Buffer.alloc(24*1024);
      while(offset<size){const {bytesRead}=await file.read(chunk,0,Math.min(chunk.length,size-offset),offset);if(!bytesRead)throw new Error('Artifact ended before its manifest size');
        response=await this.request(peerId,{method:'POST',path:'/__peers/transfers/chunk',body:{id:manifest.id,offset,data:chunk.subarray(0,bytesRead).toString('base64')}});
        if(response.status!==200)throw new Error(JSON.stringify(response.body));offset=Number((response.body as any).offset);
      }
      response=await this.request(peerId,{method:'POST',path:'/__peers/transfers/finish',body:{id:manifest.id}});if(response.status!==200)throw new Error(JSON.stringify(response.body));
    }finally{await file.close();}}
    finally{this.uploads--;}
  }
  private async transferRequest(peerId:string,request:RpcRequest):Promise<unknown> {
    const body=request.body as any;const root=join(this.options.dataDir,'peers','transfers');await mkdir(root,{recursive:true,mode:0o700});
    const key=peerId+':'+body.id;
    if(request.path.endsWith('/start')) {
      const manifest=body as ArtifactManifest;
      if(!/^[a-zA-Z0-9_-]{1,128}$/.test(manifest.id) || !/^[a-f\d]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.size) || manifest.size<0 || manifest.size>10*1024**3)throw new Error('Invalid artifact manifest');
      const path=join(root,peerId+'-'+manifest.id+'.partial');const meta=path+'.json';
      try {const previous=JSON.parse(await readFile(meta,'utf8'));if(previous.sha256!==manifest.sha256 || previous.size!==manifest.size){await unlink(path).catch(()=>{});}}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const offset=await stat(path).then(info=>info.size).catch(()=>0);if(offset>manifest.size)throw new Error('Transfer file exceeds expected size');
      // An empty artifact has no chunks; materialize its file before final verification.
      const partial=await open(path,'a',0o600);await partial.close();
      await saveJson(meta,manifest);this.transfers.set(key,{peerId,manifest,path,offset});return {offset};
    }
    const transfer=this.transfers.get(key);if(!transfer)throw new Error('Transfer must be started or resumed');
    if(request.path.endsWith('/chunk')) {
      const data=Buffer.from(body.data,'base64');if(data.length>24*1024 || body.offset!==transfer.offset || transfer.offset+data.length>transfer.manifest.size)throw new Error('Invalid transfer chunk offset or size');
      const file=await open(transfer.path,'a');try{await file.write(data);}finally{await file.close();}transfer.offset+=data.length;return {offset:transfer.offset};
    }
    if(request.path.endsWith('/finish')) {
      if(transfer.offset!==transfer.manifest.size)throw new Error('Artifact transfer is incomplete');
      const hash=createHash('sha256');const file=await open(transfer.path,'r');try{for await(const chunk of file.createReadStream())hash.update(chunk);}finally{await file.close().catch(()=>{});}
      if(hash.digest('hex')!==transfer.manifest.sha256) {
        this.transfers.delete(key);await unlink(transfer.path).catch(()=>{});await unlink(transfer.path+'.json').catch(()=>{});
        throw new Error('Artifact integrity check failed; restart the transfer');
      }
      const complete=transfer.path.replace(/\.partial$/,'.artifact');await rename(transfer.path,complete);await unlink(transfer.path+'.json');this.transfers.delete(key);
      await this.options.onArtifact?.(peerId,transfer.manifest,complete);return {complete:true,path:complete};
    }
    throw new Error('Unknown artifact transfer action');
  }
  private notify():void {this.options.onDevices?.(this.devices());this.emit('devices',this.devices());}
  private persist():Promise<void> {this.saveChain=this.saveChain.catch(()=>{}).then(()=>saveJson(join(this.options.dataDir,'peers','devices.json'),[...this.catalog.values()]));return this.saveChain;}
  private error(error:unknown):void {const value=error instanceof Error?error:new Error(String(error));this.options.onError?.(value);this.emit('diagnostic',value);}
}
