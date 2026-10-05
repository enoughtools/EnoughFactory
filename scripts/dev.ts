import { spawn } from 'node:child_process';
const children = [spawn('pnpm',['--filter','@enoughfactory/device','dev'],{stdio:'inherit'}),spawn('pnpm',['--filter','@enoughfactory/web','dev'],{stdio:'inherit'})];
const stop=()=>{for(const child of children)child.kill('SIGTERM');};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
for(const child of children)child.on('exit',code=>{if(code)stop();});
