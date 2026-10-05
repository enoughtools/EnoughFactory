import { Duplex } from 'node:stream';
import type { PeerStream } from './stream.js';
/** Adapt a paired stream to HTTP/WebSocket/TCP consumers without involving a renderer. */
export function streamToDuplex(stream: PeerStream): Duplex {
  const duplex=new Duplex({
    read() { /* Incoming paired frames push bytes below. */ },
    write(chunk:Buffer,_encoding,callback) {void stream.send(chunk).then(()=>callback(),callback);},
    final(callback) {stream.close();callback();},
    destroy(error,callback) {stream.close(error?.message);callback(error);},
  });
  stream.on('data',(data:Buffer)=> {if(!duplex.destroyed && !duplex.push(data)) {
    // The paired sender is bounded and TCP consumers normally drain promptly. A stalled
    // consumer must not retain an unbounded remote terminal or preview buffer.
    if(duplex.readableLength>2*1024*1024)duplex.destroy(new Error('Remote preview consumer exceeded its buffer'));
  }});
  stream.on('end',(error?:string)=> {if(error)duplex.destroy(new Error(error));else duplex.push(null);});
  return duplex;
}
