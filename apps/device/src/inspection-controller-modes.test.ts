import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercise the actual service-owned subprocess script with deterministic file
// replacement at its open boundary; no production race hooks are installed.
test('controller mode preparation refuses replaced parent or leaf inodes before changing permissions', async t=>{
  const source=await fs.readFile(new URL('./inspection-service.ts',import.meta.url),'utf8');
  const script=source.match(/const controllerModesScript=`([\s\S]*?)`;/)?.[1];assert(script);
  for(const stage of ['unchanged','parent-before-open','parent-after-open','leaf-after-open'] as const)await t.test(stage,async t=>{
    const directory=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'ef-controller-mode-race-')));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const root=path.join(directory,'private'),parent=path.join(root,'source'),external=path.join(directory,'canonical'),target=path.join(parent,'app.txt'),foreign=path.join(external,'app.txt'),saved=path.join(root,'original-source');
    await fs.mkdir(parent,{recursive:true});await fs.mkdir(external);
    const bytes=Buffer.from('Identical product source bytes.');
    for(const file of [target,foreign]){await fs.writeFile(file,bytes);await fs.chmod(file,0o666);}
    const swapParent=async()=>{await fs.rename(parent,saved);await fs.symlink(external,parent);};
    let replaced=false,stderr='';const receipt={argv:['node',JSON.stringify([{root,entry:{path:'source/app.txt',kind:'file',mode:0o644,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}])],stderr:{write:(message:string)=>{stderr+=message;}},exitCode:0};
    const instrumented={...fs,open:async(...args:Parameters<typeof fs.open>)=>{
      if(replaced||stage==='unchanged')return fs.open(...args);
      replaced=true;if(stage==='parent-before-open')await swapParent();
      const handle=await fs.open(...args);
      if(stage==='parent-after-open')await swapParent();
      if(stage==='leaf-after-open'){await fs.rename(target,path.join(parent,'original-app.txt'));await fs.copyFile(foreign,target);}
      return handle;
    }};
    const modules:Record<string,unknown>={'node:fs/promises':instrumented,'node:fs':{constants},'node:path':path,'node:crypto':{createHash}};
    await runInNewContext(script,{require:(name:string)=>{assert(name in modules);return modules[name];},process:receipt});
    assert.equal((await fs.lstat(foreign)).mode&0o777,0o666,'Byte-identical external source must never receive the private permission change');
    if(stage==='unchanged'){assert.equal(receipt.exitCode,0);assert.equal((await fs.lstat(target)).mode&0o777,0o644);}
    else{
      assert.equal(receipt.exitCode,1);assert.match(stderr,/Changed controller source (inode|parent)/);
      const original=stage==='leaf-after-open'?path.join(parent,'original-app.txt'):path.join(saved,'app.txt');
      assert.equal((await fs.lstat(original)).mode&0o777,0o666,'Rejected source remains unmodified even when its open descriptor was originally valid');
    }
  });
});
