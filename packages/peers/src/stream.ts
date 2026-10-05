import { EventEmitter } from 'node:events';
import type { Frame, Lane } from './protocol.js';
/** A duplex stream, with sends resolving only after the transport accepts the frame. */
export class PeerStream extends EventEmitter {
  private ended = false;
  constructor(public readonly id: string,private transmit: (frame: Frame,lane: Lane)=>Promise<void>,private remove:()=>void) { super(); }
  async send(data: string | Buffer,cursor?: number,binaryOverride?:boolean): Promise<void> {
    if (this.ended) throw new Error('Peer stream is closed');
    const binary = binaryOverride??Buffer.isBuffer(data); const bytes = Buffer.isBuffer(data)?data:Buffer.from(data);
    if (bytes.length===0) return;
    for (let offset=0; offset<bytes.length; offset+=24*1024) {
      const part=bytes.subarray(offset,offset+24*1024);
      // UTF-8 text may cross a chunk boundary; base64 preserves every byte.
      await this.transmit({v:1,type:'stream-data',id:this.id,data:part.toString('base64'),binary,cursor},'events');
    }
  }
  close(error?: string,lane:Lane='control'): void {
    if (this.ended) return; this.ended=true; this.remove();
    void this.transmit({v:1,type:'stream-close',id:this.id,error},lane).catch(()=>{});
    this.emit('end',error);
  }
  receive(data: string,binary: boolean,cursor?: number): void { if (!this.ended) this.emit('data',Buffer.from(data,'base64'),{binary,cursor}); }
  remoteClose(error?: string): void { if (this.ended) return; this.ended=true; this.remove(); this.emit('end',error); }
}

/** Proxy an enrolled worker's stream through its coordinator, retaining cursor metadata. */
export function bridgePeerStreams(a: PeerStream,b: PeerStream):()=>void {
  let closed=false;let cleanSource:PeerStream|undefined;
  const remove: Array<()=>void>=[];
  const finish=(error?:string,lane:Lane='control')=> {
    if(closed)return;closed=true;for(const cleanup of remove)cleanup();a.close(error,lane);b.close(error,lane);
  };
  for(const [source,target] of [[a,b],[b,a]]) {
    let bytes=0;let sendChain:Promise<void>=Promise.resolve();
    const onData=(data:Buffer,meta:{cursor?:number;binary?:boolean}={})=> {
      if(closed || cleanSource)return;
      if(bytes+data.length>2*1024*1024){finish('Remote stream proxy exceeded its bounded queue');return;}
      bytes+=data.length;
      sendChain=sendChain.then(async()=> {
        if(closed || cleanSource && cleanSource!==source)return;
        await target.send(data,meta.cursor,meta.binary);
      }).catch(error=> {if(!closed && (!cleanSource || cleanSource===source))finish((error as Error).message);})
        .finally(()=>{bytes-=data.length;});
    };
    const onEnd=(error?:string)=> {
      if(closed)return;if(error){finish(error);return;}if(cleanSource)return;
      cleanSource=source;
      // Flush final worker bytes before ordered EOF. The opposite direction may
      // have stale input queued for an already-ended worker; it cannot abort this flush.
      void sendChain.then(()=>finish(undefined,'events'));
    };
    source.on('data',onData);source.on('end',onEnd);
    remove.push(()=>{source.off('data',onData);source.off('end',onEnd);});
  }
  return ()=>finish();
}
