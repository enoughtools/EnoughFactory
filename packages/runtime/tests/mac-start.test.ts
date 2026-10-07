import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MacRuntime } from '../src/mac.ts';

test('concurrent restart after an external VM stop requires fresh owned Docker readiness', async () => {
  const directory = await mkdtemp('/tmp/enough-mac-start-');
  const stateDirectory = join(directory, 'state'), assetsDirectory = join(directory, 'assets');
  const owner = createHash('sha256').update(stateDirectory).digest('hex').slice(0, 24);
  const runtime = new MacRuntime({ stateDirectory, assetsDirectory });
  const server = createServer((request, response) => {
    assert.equal(request.url, '/info');
    response.end(JSON.stringify({ ID: `owned-engine-${starts}`, ServerVersion: `fixture-${starts}`, Labels: ['enoughfactory.managed=true', `enoughfactory.owner=${owner}`] }));
  });
  let starts = 0, vm = 'Stopped', releaseStart = () => {}, observedStart = () => {};
  let startGate = Promise.resolve();
  const commands: string[][] = [];
  // Keep the real Docker probe and ownership validation; replace only Lima so
  // this regression never invokes host virtualization or an installed engine.
  (runtime as unknown as { command(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> }).command = async args => {
    commands.push(args);
    if (args[0] === 'list') return { code: 0, stdout: JSON.stringify({ name: 'factory', status: vm }), stderr: '' };
    if (args[0] === 'start') { starts++; observedStart(); await startGate; vm = 'Running'; }
    else assert.equal(args[0], 'edit');
    return { code: 0, stdout: '', stderr: '' };
  };
  function armStart() {
    startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    const observed = new Promise<void>(resolve => { observedStart = resolve; });
    return async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([observed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Restart returned without invoking Lima start')), 2_000); })]); }
      finally { clearTimeout(timer); }
    };
  }
  const listen = () => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(runtime.endpoint().host.slice(7), () => { server.removeListener('error', reject); resolve(); }); });
  const close = () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
  try {
    for (const path of ['docker/bin', 'lima/bin', 'images']) await mkdir(join(assetsDirectory, path), { recursive: true });
    for (const path of ['docker/bin/docker', 'lima/bin/limactl', 'docker/guest-engine.tgz', 'images/guest.img']) await writeFile(join(assetsDirectory, path), 'fixture');
    await writeFile(join(assetsDirectory, 'pins.json'), JSON.stringify({ images: { [process.arch]: { arch: process.arch, sha256: '0'.repeat(64) } } }));
    await mkdir(join(runtime.storageDirectory(), 'factory/sock'), { recursive: true });
    await writeFile(join(runtime.storageDirectory(), 'factory/lima.yaml'), '{}');

    const firstStarted = armStart(), first = runtime.start();
    await firstStarted(); await listen(); releaseStart(); await first;
    assert.equal((await runtime.status()).version, 'fixture-1');

    // This deliberately bypasses runtime.stop(), leaving its last phase ready.
    await close(); vm = 'Stopped';
    const restarted = armStart(), one = runtime.start(), two = runtime.start();
    await restarted();
    assert.equal((await runtime.status()).phase, 'starting');
    assert.equal(starts, 2);
    await listen(); releaseStart();
    assert.deepEqual(await Promise.all([one, two]), [runtime.endpoint(), runtime.endpoint()]);
    assert.equal((await runtime.status()).version, 'fixture-2');
    assert.equal(commands.filter(args => args[0] === 'start').length, 2);
  } finally {
    releaseStart();
    if (server.listening) await close();
    await rm(directory, { recursive: true, force: true });
  }
});
