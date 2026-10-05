import type * as Native from 'node-datachannel';
import type { IceServer, Lane } from './protocol.js';
export interface NativeHandlers {
  onDescription(sdp: string,type: string): void;
  onCandidate(candidate: string,mid: string): void;
  onOpen(lane: Lane): void;
  onMessage(lane: Lane,message: string): void;
  onClosed(): void;
  onError(error: Error): void;
}
export class NativeConnection {
  private pc: Native.PeerConnection;
  private channels = new Map<Lane,Native.DataChannel>();
  private expectedFingerprint?: string;
  private authenticated = false;
  private closed = false;
  static async create(id: string,servers: IceServer[],handlers: NativeHandlers,initiator: boolean,relayOnly=false): Promise<NativeConnection> {
    const native = await import('node-datachannel');
    return new NativeConnection(native,id,servers,handlers,initiator,relayOnly);
  }
  private constructor(native: typeof Native,id: string,servers: IceServer[],private handlers: NativeHandlers,initiator: boolean,relayOnly: boolean) {
    const iceServers: (string | Native.IceServer)[] = [];
    for (const server of servers) for (const url of Array.isArray(server.urls)?server.urls:[server.urls]) {
      if (url.startsWith('stun:')) { iceServers.push(url); continue; }
      const parsed = new URL(url.replace(/^turn:/,'turn://').replace(/^turns:/,'turns://'));
      iceServers.push({hostname:parsed.hostname,port:Number(parsed.port)|| (parsed.protocol==='turns:'?5349:3478),username:server.username,
        password:server.credential,relayType:parsed.protocol==='turns:'?'TurnTls':parsed.searchParams.get('transport')==='tcp'?'TurnTcp':'TurnUdp'});
    }
    this.pc = new native.PeerConnection(id,{iceServers,iceTransportPolicy:relayOnly?'relay':'all',maxMessageSize:65536});
    this.pc.onLocalDescription((sdp,type)=>handlers.onDescription(sdp,type));
    this.pc.onLocalCandidate((candidate,mid)=>handlers.onCandidate(candidate,mid));
    this.pc.onDataChannel(dc=>this.bind(dc));
    this.pc.onStateChange(state=> { if (state==='failed' || state==='disconnected' || state==='closed') handlers.onClosed(); });
    if (initiator) for (const lane of ['control','events','bulk'] as Lane[]) this.bind(this.pc.createDataChannel(lane,{protocol:'enoughfactory.v1'}));
  }
  private bind(dc: Native.DataChannel): void {
    const lane = dc.getLabel() as Lane;
    if (!['control','events','bulk'].includes(lane)) { dc.close(); return; }
    this.channels.set(lane,dc); dc.setBufferedAmountLowThreshold(128*1024);
    dc.onOpen(()=> {
      try {
        const actual = this.pc.remoteFingerprint().value.replaceAll(':','').toLowerCase();
        if (!this.expectedFingerprint || actual!==this.expectedFingerprint) throw new Error('Peer DTLS fingerprint does not match enrolled signed negotiation');
        this.authenticated = true; this.handlers.onOpen(lane);
      } catch (error) { this.handlers.onError(error as Error); this.close(); }
    });
    dc.onMessage(message=> { if (this.authenticated && !this.closed) this.handlers.onMessage(lane,typeof message==='string'?message:message.toString()); });
    dc.onClosed(()=> { if (!this.closed && lane==='control') this.handlers.onClosed(); });
    dc.onError(error=>this.handlers.onError(new Error(error)));
  }
  description(sdp: string,type: string): void {
    const fingerprint = sdp.match(/^a=fingerprint:sha-256\s+([\dA-F:]+)\s*$/im)?.[1];
    if (!fingerprint) throw new Error('Remote SDP lacks SHA256 DTLS fingerprint');
    this.expectedFingerprint = fingerprint.replaceAll(':','').toLowerCase();
    this.pc.setRemoteDescription(sdp,type.toLowerCase()==='offer'?'offer':'answer');
  }
  candidate(candidate: string,mid: string): void { this.pc.addRemoteCandidate(candidate,mid); }
  open(lane: Lane): boolean { return this.authenticated && Boolean(this.channels.get(lane)?.isOpen()); }
  buffered(lane: Lane): number { return this.channels.get(lane)?.bufferedAmount()??0; }
  send(lane: Lane,message: string): boolean { return this.open(lane) && Boolean(this.channels.get(lane)?.sendMessage(message)); }
  connectionInfo(): {localType:string;remoteType:string;rtt:number} {const pair=this.pc.getSelectedCandidatePair();if(!pair)throw new Error('No selected RTC candidate pair');return {localType:pair.local.type,remoteType:pair.remote.type,rtt:this.pc.rtt()};}
  close(): void { if (this.closed) return; this.closed=true; this.pc.close(); }
}
