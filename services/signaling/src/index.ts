import { configFromEnvironment, createSignalingService } from './server.ts';

const service = createSignalingService(configFromEnvironment());
const address = await service.listen();
console.log(JSON.stringify({ event: 'listening', service: 'enoughfactory-signaling', ...address }));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (closing) return;
  closing = true;
  service.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
});
