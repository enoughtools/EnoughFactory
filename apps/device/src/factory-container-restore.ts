import { spawn } from 'node:child_process';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { dockerInvocation, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { openPreservedContainerTar, validateStoppedFactoryContainerArchives, type EphemeralContainerReceipt, type RetirementIdentity } from './factory-container-retirement.ts';
import { exec } from './util.ts';

const shellQuote=(value:string)=>`'${value.replaceAll("'",`'"'"'`)}'`;
function exactPath(value:string):string {if(!value.startsWith('/')||value==='/'||value!==path.posix.normalize(value)||value.includes('\0'))throw new Error('Recovery requires exact non-root container paths.');return value;}
const overlaps=(left:string,right:string)=>left===right||left.startsWith(`${right}/`)||right.startsWith(`${left}/`);

/** Recreate application state only inside a newly owned container, never on the host. */
export async function restoreFactoryContainerArchives(input: {
  endpoint: DockerRuntimeEndpoint; dataDir: string;
  receipt: { version: number };
  identity: RetirementIdentity; assertCurrent: () => void;
}): Promise<void> {
  if(input.receipt.version!==2)throw new Error('This environment has conversation history only. Start a fresh environment from its retained candidate.');
  const receipt=input.receipt as EphemeralContainerReceipt,expected=input.identity;
  if(receipt.identity.sessionId!==expected.sessionId||receipt.identity.workdir!==expected.workdir)throw new Error('Preserved work belongs to a different environment.');
  input.assertCurrent();
  await validateStoppedFactoryContainerArchives(receipt,input.dataDir);
  input.assertCurrent();
  type Mount={Type:string;Name?:string;Destination:string;RW:boolean};
  const inspect=async()=>{
    const invocation=dockerInvocation(input.endpoint,['inspect','--type','container',expected.container]);
    const entries=JSON.parse((await exec(invocation.command,invocation.args,{env:invocation.env,timeout:30_000,maxBuffer:4*1024**2})).stdout) as Array<{Id:string;Name:string;Created:string;State:{Running:boolean;Paused:boolean;Restarting:boolean;Dead:boolean;Pid:number};Config:{Labels:Record<string,string>};Mounts?:Mount[]}>;
    const container=entries[0],labels=container?.Config?.Labels;
    if(entries.length!==1||!container||!/^[a-f0-9]{64}$/.test(container.Id)||container.Id===receipt.containerId||container.Name!==`/${expected.name}`||!container.Created
      ||!container.State.Running||container.State.Paused||container.State.Restarting||container.State.Dead||container.State.Pid<=0
      ||labels?.['envmux.schema']!=='2'||labels['envmux.kind']!=='session'||labels['envmux.service']||labels['envmux.instance']!==expected.name
      ||labels['envmux.project']!==expected.project||labels['envmux.session']!==expected.sessionName||labels['envmux.directory']!==expected.projectPath
      ||labels['envmux.branch']!==expected.branch||labels['envmux.workdir']!==expected.workdir)throw new Error('The fresh environment no longer has its expected owned container.');
    if(!Array.isArray(container.Mounts))throw new Error('The fresh environment mount ownership is unavailable.');
    for(const mount of container.Mounts){
      exactPath(mount.Destination);
      if(receipt.archives.some(archive=>overlaps(archive.source,mount.Destination))&&(mount.Type!=='volume'||!mount.RW||![`${expected.name}-work`,`${expected.name}-home`].includes(mount.Name??'')))throw new Error('Recovery cannot replace files in a bind, shared, read-only or unowned mount. The original archive is retained.');
    }
    return {id:container.Id,mounts:container.Mounts};
  };
  const initial=await inspect(),containerId=initial.id;
  for(const volume of new Set(initial.mounts.filter(mount=>receipt.archives.some(archive=>overlaps(archive.source,mount.Destination))).map(mount=>mount.Name!))){
    const invocation=dockerInvocation(input.endpoint,['ps','--all','--no-trunc','--filter',`volume=${volume}`,'--format','{{.ID}}']);
    const references=(await exec(invocation.command,invocation.args,{env:invocation.env,timeout:30_000,maxBuffer:1024**2})).stdout.trim().split('\n').filter(Boolean);
    if(references.length!==1||references[0]!==containerId)throw new Error('A fresh environment volume is shared with another container; recovery has not changed its files.');
  }
  const currentDestination=async()=>{const actual=await inspect();if(actual.id!==containerId||JSON.stringify(actual.mounts)!==JSON.stringify(initial.mounts))throw new Error('The destination container or its mounts changed during recovery.');};
  // A fresh checkout contains files and refs that may have been deleted in the
  // archived work. Clear each owned writable target before overlaying its exact
  // archive. Keep nested mount roots and intentionally omitted cache trees.
  for(const archive of [...receipt.archives].sort((left,right)=>left.source.split('/').length-right.source.split('/').length)){
    input.assertCurrent();await currentDestination();
    const source=exactPath(archive.source),parent=path.posix.dirname(source);
    const kept=[...new Set([...initial.mounts.filter(mount=>mount.Destination!==source&&mount.Destination.startsWith(`${source}/`)).map(mount=>mount.Destination),...archive.exclusions.map(excluded=>exactPath(path.posix.join(parent,excluded)))])];
    const skip=kept.map(keep=>`case "$entry" in ${shellQuote(keep)}|${shellQuote(keep)}/*) continue;; esac\ncase ${shellQuote(keep)} in "$entry"/*) continue;; esac`).join('\n');
    const remove=`for entry do\n${skip}\nif [ -d "$entry" ] && [ ! -L "$entry" ]; then rmdir -- "$entry"; else rm -f -- "$entry"; fi\ndone`;
    const script=`target=${shellQuote(source)}\nwhile [ ! -e "$target" ] && [ ! -L "$target" ]; do target=\${target%/*}; [ -n "$target" ] || target=/; done\n[ ! -L "$target" ] && [ "$(readlink -f -- "$target")" = "$target" ] || exit 41\nmkdir -p -- ${shellQuote(source)}\n[ "$(readlink -f -- ${shellQuote(source)})" = ${shellQuote(source)} ] || exit 41\nfind ${shellQuote(source)} -mindepth 1 -xdev -depth -exec sh -eu -c ${shellQuote(remove)} enoughfactory-clear {} +`;
    const invocation=dockerInvocation(input.endpoint,['exec','--user','0',containerId,'sh','-eu','-c',script,'enoughfactory-clear-preserved-target',source,...kept]);
    await exec(invocation.command,invocation.args,{env:invocation.env,timeout:120_000,maxBuffer:1024**2});
    input.assertCurrent();await currentDestination();
  }
  // Restore parents before deeper mount targets; each archive was captured from
  // the same stopped container and validated in full before any write begins.
  for(const archive of [...receipt.archives].sort((left,right)=>left.source.split('/').length-right.source.split('/').length)){
    input.assertCurrent();await currentDestination();
    const parent=path.posix.dirname(archive.source),directory=dockerInvocation(input.endpoint,['exec','--user','0',containerId,'mkdir','-p','--',parent]);
    await exec(directory.command,directory.args,{env:directory.env,timeout:30_000,maxBuffer:1024**2});
    input.assertCurrent();
    const invocation=dockerInvocation(input.endpoint,['cp','-',`${containerId}:${parent}`]),child=spawn(invocation.command,invocation.args,{env:invocation.env,stdio:['pipe','ignore','pipe'],timeout:120_000});
    child.stderr.resume();
    const exited=new Promise<void>((resolve,reject)=>{child.once('error',()=>reject(new Error('Could not restore preserved environment files.')));child.once('close',code=>code===0?resolve():reject(new Error('Environment restoration was not confirmed. Its original archive is retained.')));});
    try{await Promise.all([pipeline(await openPreservedContainerTar(archive,input.dataDir),child.stdin),exited]);}
    catch(error){child.kill('SIGTERM');await exited.catch(()=>{});throw error;}
    input.assertCurrent();await currentDestination();
  }
}
