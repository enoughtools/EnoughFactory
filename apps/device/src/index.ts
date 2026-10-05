import { DeviceApp } from './app.ts';
import { ChatController } from './chats.ts';
import { initializeNetwork } from './network.ts';
import { initializeFactory } from './factory.ts';
async function main() {
  const app = new DeviceApp();
  const previousDeviceId=app.device.id;
  const network=await initializeNetwork(app);
  app.remoteTerminal=network.connectTerminal;
  for(const bucket of ['projects','sessions','chats'] as const){for(const record of app.store.list<{id:string;deviceId:string}>(bucket))if(record.deviceId===previousDeviceId)app.store.set(bucket,{...record,deviceId:app.device.id});}
  const chats=new ChatController(app);
  await app.listen();
  await initializeFactory(app,chats,network);
  console.log(`EnoughFactory device service ready at http://127.0.0.1:${app.port}`);
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
}
void main().catch(error=>{console.error(error.message);process.exitCode=1;});
