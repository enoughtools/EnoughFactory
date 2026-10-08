import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { WorkspaceManager, WorkingDirectoryManager, type CheckContext, type CheckExecutor, type FrozenCheckInputs, type WorkingDirectoryCapture } from '@enoughfactory/workspaces';
import { git, run } from '../../../packages/workspaces/src/process.ts';
import { hostCheckExecutor } from './host-checks.ts';

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const nodeCommand = (source: string) => `${quote(process.execPath)} -e ${quote(source)}`;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t: { after: (fn: () => Promise<void>) => void }, input: { evidence?: boolean; executor?: CheckExecutor } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'enough-host-checks-')), project = path.join(root, 'project'), dataDir = path.join(root, 'data');
  await mkdir(project);
  assert.equal((await run('git', ['init', '-b', 'main', project])).exitCode, 0);
  await git(project, 'config', 'user.name', 'Host Check Test');
  await git(project, 'config', 'user.email', 'factory@example.test');
  await writeFile(path.join(project, 'source.txt'), 'original\n');
  await git(project, 'add', '.'); await git(project, 'commit', '-m', 'Original source');
  const executor = input.executor ?? hostCheckExecutor({ checksRoot: path.join(dataDir, 'checks'), integrationRoot: path.join(dataDir, 'integration'), platform: 'darwin' });
  const manager = new WorkspaceManager({ dataDir, deviceId: 'test-mac', checkExecutor: executor });
  const directories = new WorkingDirectoryManager({ dataDir, artifacts: manager.artifacts });
  const captures: WorkingDirectoryCapture[] = [];
  let checkInputs: FrozenCheckInputs | undefined;
  if (input.evidence) {
    const source = path.join(root, 'evidence'); await mkdir(path.join(source, 'native evidence'), { recursive: true });
    await writeFile(path.join(source, 'native evidence', "ui 'receipt' $(literal).json"), '{"verified":true}\n');
    const [snapshot] = await directories.prepare({ identity: 'evidence-baseline', sources: [{ id: 'evidence-id', name: 'evidence', path: source }] });
    captures.push(await directories.captureFromPath(snapshot!, snapshot!.path));
    checkInputs = { configurationRevision: 4, workingDirectoryIds: ['evidence-id'], environment: { ENOUGH_EVIDENCE_ROOT: '/workspaces/evidence/native evidence', ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR: "/workspaces/evidence/native evidence/ui 'receipt' $(literal).json", ENOUGH_NATIVE_INDEX_SHA256: 'a'.repeat(64) } };
  }
  const identity = { projectPath: project, goalId: 'goal', taskId: 'task', attemptId: 'attempt', executionTargetKind: 'host-macos' as const, checkInputs };
  const workspace = await manager.create(identity);
  await writeFile(path.join(workspace.path, 'source.txt'), 'authored\n');
  await git(workspace.path, 'add', '.'); await git(workspace.path, 'commit', '-m', 'Authored source');
  const candidate = await manager.capture({ workspaceId: workspace.id, workingDirectories: captures });
  const contexts: CheckContext[] = [];
  const context = async (command: string, timeoutMs = 3000, branch: 'checks' | 'integration' = 'checks'): Promise<CheckContext> => {
    const selected = path.join(dataDir, branch, randomUUID());
    await manager.importSource({ artifact: candidate.bundleArtifact, targetPath: selected });
    const workingDirectories = [];
    for (const capture of captures) {
      const target = path.join(`${selected}-working-directories`, capture.id);
      await directories.importCapture(capture, target);
      workingDirectories.push({ path: target, containerPath: capture.containerPath, commit: capture.commit });
    }
    const result = { path: selected, commit: candidate.commit, candidate, command, timeoutMs, executionTargetKind: 'host-macos' as const, workingDirectories };
    contexts.push(result); return result;
  };
  t.after(async () => {
    for (const selected of contexts) await executor.release?.(selected.path).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return { root, project, dataDir, manager, workspace, candidate, context, executor, identity };
}

test('ordinary host checks preserve frozen target through capture, verification and exact integration', async t => {
  const contexts: CheckContext[] = [];
  let host: CheckExecutor;
  const executor: CheckExecutor = async context => { contexts.push(context); return host(context); };
  executor.release = async selected => host.release?.(selected);
  const f = await fixture(t, { executor });
  host = hostCheckExecutor({ checksRoot: path.join(f.dataDir, 'checks'), integrationRoot: path.join(f.dataDir, 'integration'), platform: 'darwin' });
  assert.equal(f.workspace.executionTargetKind, 'host-macos');
  assert.equal(f.candidate.executionTargetKind, 'host-macos');
  assert.equal(f.candidate.bundleArtifact.metadata?.executionTargetKind, 'host-macos');
  assert.equal(f.candidate.diffArtifact.metadata?.executionTargetKind, 'host-macos');
  await assert.rejects(f.manager.create({ ...f.identity, executionTargetKind: 'container' }), /different frozen execution target/);
  const verificationAuthority = Object.freeze({ taskId: 'task', attemptId: 'attempt', quality: 'candidate' });
  const integrationAuthority = Object.freeze({ taskId: 'task', attemptId: 'attempt', quality: 'combined' });
  const verification = await f.manager.verify({ candidateId: f.candidate.id, commands: ['test "$(cat source.txt)" = authored'], verification: verificationAuthority });
  assert.equal(verification.status, 'passed', JSON.stringify(verification));
  assert.equal(verification.commands[0]!.executionTargetKind, 'host-macos');
  assert.equal(verification.commands[0]!.hostPermissions, 'full-host');
  assert.equal(JSON.parse((await f.manager.artifacts.read(verification.logArtifact)).toString()).commands[0].hostPermissions, 'full-host');
  const integrated = await f.manager.integrate({ candidateId: f.candidate.id, projectPath: f.project, commands: ['test "$(cat source.txt)" = authored'], isCurrent: () => true, verification: integrationAuthority });
  assert.equal(integrated.status, 'integrated');
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0]!.commit, f.candidate.commit);
  assert.equal(contexts[1]!.commit, integrated.commit);
  assert.notEqual(contexts[1]!.commit, f.candidate.commit, 'integration checks the combined merge identity');
  assert.ok(contexts.every(context => context.executionTargetKind === 'host-macos'));
  assert.equal(contexts[0]!.verification, verificationAuthority);
  assert.equal(contexts[1]!.verification, integrationAuthority);
  assert.ok(path.dirname(contexts[1]!.path).endsWith('/integration'));
  const tampered = { ...f.candidate, executionTargetKind: 'container' as const };
  await assert.rejects(f.manager.acceptCandidate(tampered, await f.manager.artifacts.path(f.candidate.bundleArtifact)), /immutable source evidence/);
});

test('private host environment omits personal credentials and maps exact frozen snapshot paths without shell interpolation', async t => {
  const f = await fixture(t, { evidence: true });
  const key = 'ENOUGH_HOST_CHECK_PRIVATE_SENTINEL', previous = process.env[key]; process.env[key] = 'must-not-leak';
  t.after(async () => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const context = await f.context(nodeCommand(`const fs=require('node:fs'); console.log(JSON.stringify({ sentinel: process.env.${key}, home: process.env.HOME, evidence: process.env.ENOUGH_EVIDENCE_ROOT, descriptor: process.env.ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR, digest: process.env.ENOUGH_NATIVE_INDEX_SHA256, contents: fs.readFileSync(process.env.ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR,'utf8'), shellEnv: process.env.BASH_ENV, auth: process.env.SSH_AUTH_SOCK }));`));
  const result = await f.executor(context);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.cleanupErrors, undefined);
  const data = JSON.parse(result.stdout);
  assert.equal(data.sentinel, undefined); assert.equal(data.auth, undefined); assert.equal(data.shellEnv, undefined);
  assert.ok(data.home.startsWith(`${context.path}-host-checks/`));
  assert.equal(data.evidence, path.join(context.workingDirectories![0]!.path, 'native evidence'));
  assert.equal(data.descriptor, path.join(data.evidence, "ui 'receipt' $(literal).json"));
  assert.equal(data.digest, 'a'.repeat(64)); assert.equal(JSON.parse(data.contents).verified, true);
});

test('host route rejects non-host candidates, outside paths, symlink roots and mismatched captured evidence', async t => {
  const f = await fixture(t, { evidence: true }), context = await f.context('true');
  for (const target of [undefined, 'container'] as const) {
    await assert.rejects(f.executor({ ...context, executionTargetKind: target }), /frozen host-macos/);
    await assert.rejects(f.executor({ ...context, candidate: { ...context.candidate, executionTargetKind: target } }), /frozen host-macos/);
  }
  await assert.rejects(f.executor({ ...context, candidate: { ...context.candidate, bundleArtifact: { ...context.candidate.bundleArtifact, metadata: {} } } }), /frozen host-macos/);
  await assert.rejects(f.executor({ ...context, path: f.project }), /exact private check snapshot/);
  const link = path.join(f.dataDir, 'checks', randomUUID()); await symlink(f.project, link);
  await assert.rejects(f.executor({ ...context, path: link }), /unsafe directory|symlink/);
  await assert.rejects(f.executor({ ...context, workingDirectories: [] }), /every exact captured/);
  await assert.rejects(f.executor({ ...context, workingDirectories: [{ ...context.workingDirectories![0]!, commit: '0'.repeat(40) }] }), /exact private captured roots/);
  await assert.rejects(f.executor({ ...context, workingDirectories: [{ ...context.workingDirectories![0]!, path: f.project }] }), /exact private captured roots/);
  await symlink(f.project, path.join(context.path, 'outside-source'));
  await assert.rejects(f.executor(context), /symlink outside/);
});

test('pre-aborted check starts no process and timeout kills a TERM-ignoring child before returning', async t => {
  const f = await fixture(t), before = new AbortController(); before.abort();
  const pre = await f.context('touch should-not-exist');
  const preResult = await f.executor({ ...pre, signal: before.signal });
  assert.equal(preResult.exitCode, 130);
  await assert.rejects(readFile(path.join(pre.path, 'should-not-exist')), /ENOENT/);
  const context = await f.context(nodeCommand(`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('child-pid',String(process.pid));setInterval(()=>fs.appendFileSync('heartbeat','x'),20);`), 600);
  const result = await f.executor(context);
  assert.equal(result.exitCode, 124); assert.equal(result.timedOut, true); assert.equal(result.cleanupErrors, undefined);
  const heartbeat = await readFile(path.join(context.path, 'heartbeat'), 'utf8');
  await wait(150);
  assert.equal(await readFile(path.join(context.path, 'heartbeat'), 'utf8'), heartbeat, 'the timed-out child has stopped writing');
});

test('explicit cancellation stops its whole group while a concurrent check completes normally', async t => {
  const f = await fixture(t), controller = new AbortController();
  const canceled = await f.context(nodeCommand(`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('ready','yes');setInterval(()=>fs.appendFileSync('heartbeat','x'),20);`));
  const other = await f.context('sleep 0.5; printf other-completed');
  const canceledPromise = f.executor({ ...canceled, signal: controller.signal }), otherPromise = f.executor(other);
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await readFile(path.join(canceled.path, 'ready'), 'utf8').catch(() => '') === 'yes') break;
    await wait(25);
  }
  controller.abort();
  const [canceledResult, otherResult] = await Promise.all([canceledPromise, otherPromise]);
  assert.equal(canceledResult.exitCode, 130); assert.equal(canceledResult.cleanupErrors, undefined);
  assert.equal(otherResult.exitCode, 0); assert.equal(otherResult.stdout, 'other-completed');
});

test('normal command exit also terminates background descendants that retain output pipes', async t => {
  const f = await fixture(t);
  const context = await f.context(`${nodeCommand(`const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync('background-heartbeat','x'),20);`)} & printf foreground-completed`);
  const result = await f.executor(context);
  assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stdout, 'foreground-completed'); assert.equal(result.cleanupErrors, undefined);
  const heartbeat = await readFile(path.join(context.path, 'background-heartbeat'), 'utf8').catch(() => '');
  await wait(150);
  assert.equal(await readFile(path.join(context.path, 'background-heartbeat'), 'utf8').catch(() => ''), heartbeat);
});

test('an escaped descendant retaining output pipes preserves uncertain cleanup evidence and fences release', async t => {
  const f = await fixture(t), context = await f.context('true');
  const heartbeat = path.join(context.path, 'escaped-heartbeat');
  const descendant = `const fs=require('node:fs');const target=${JSON.stringify(heartbeat)};process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(target,'x'),20);`;
  context.command = nodeCommand(`const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','inherit','inherit']});fs.writeFileSync('escaped-pid',String(child.pid));child.unref();`);
  let pid: number | undefined;
  try {
    const result = await f.executor(context);
    pid = Number(await readFile(path.join(context.path, 'escaped-pid'), 'utf8'));
    assert.ok(result.cleanupErrors?.some(error => /output pipes remain open/.test(error)));
    await assert.rejects(f.executor.release!(context.path), /execution is uncertain/);
    const [journal] = await readdir(`${context.path}-host-checks`);
    const completed = JSON.parse(await readFile(path.join(`${context.path}-host-checks`, journal!, 'completed.json'), 'utf8')) as { terminationConfirmed: boolean; result: { cleanupErrors?: string[] } };
    assert.equal(completed.terminationConfirmed, false);
    assert.ok(completed.result.cleanupErrors?.some(error => /output pipes remain open/.test(error)), 'the pipe warning stays durable even if later identity cleanup stops the descendant');
    assert.equal(await readFile(path.join(context.path, 'source.txt'), 'utf8'), 'authored\n');
  } finally {
    pid ??= Number(await readFile(path.join(context.path, 'escaped-pid'), 'utf8').catch(() => ''));
    if (Number.isSafeInteger(pid) && pid! > 1) {
      const identity = (await run('/bin/ps', ['-p', String(pid), '-o', 'command='])).stdout;
      if (identity.includes(heartbeat)) try { process.kill(pid!, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await wait(100);
  }
});

test('a rapid detached writer with ignored output cannot outlive a falsely confirmed check', async t => {
  const f = await fixture(t), context = await f.context('true');
  const descendant = `const fs=require('node:fs');const target=${JSON.stringify(path.join(context.path, 'detached-heartbeat'))};process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(target,'x'),20);`;
  context.command = nodeCommand(`const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});fs.writeFileSync('detached-pid',String(child.pid));child.unref();`);
  let pid: number | undefined;
  try {
    const result = await f.executor(context);
    pid = Number(await readFile(path.join(context.path, 'detached-pid'), 'utf8'));
    const before = await readFile(path.join(context.path, 'detached-heartbeat'), 'utf8').catch(() => '');
    await wait(150);
    const after = await readFile(path.join(context.path, 'detached-heartbeat'), 'utf8').catch(() => '');
    const [journal] = await readdir(`${context.path}-host-checks`);
    const completed = JSON.parse(await readFile(path.join(`${context.path}-host-checks`, journal!, 'completed.json'), 'utf8')) as { terminationConfirmed: boolean };
    if (result.cleanupErrors?.length) {
      assert.equal(completed.terminationConfirmed, false);
      await assert.rejects(f.executor.release!(context.path), /uncertain|retained/);
    } else {
      assert.equal(after, before, 'a clean outcome requires the ignored-output writer to stop');
      assert.equal(completed.terminationConfirmed, true);
    }
  } finally {
    pid ??= Number(await readFile(path.join(context.path, 'detached-pid'), 'utf8').catch(() => ''));
    if (Number.isSafeInteger(pid) && pid! > 1) {
      const identity = (await run('/bin/ps', ['-p', String(pid), '-o', 'command='])).stdout;
      if (identity.includes(path.join(context.path, 'detached-heartbeat'))) try { process.kill(pid!, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await wait(100);
  }
});

test('an observed detached writer with ignored output is terminated by its retained process identity', async t => {
  const f = await fixture(t), context = await f.context('true');
  const heartbeat = path.join(context.path, 'observed-detached-heartbeat');
  const descendant = `const fs=require('node:fs');const target=${JSON.stringify(heartbeat)};process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(target,'x'),20);`;
  // Keep the authoring parent alive across inventories, then let the detached
  // process survive its original group. Cleanup must use its retained identity.
  context.command = nodeCommand(`const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});fs.writeFileSync('observed-detached-pid',String(child.pid));child.unref();setTimeout(()=>{},400);`);
  let pid: number | undefined;
  try {
    const result = await f.executor(context);
    pid = Number(await readFile(path.join(context.path, 'observed-detached-pid'), 'utf8'));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.cleanupErrors, undefined, JSON.stringify(result.cleanupErrors));
    const before = await readFile(heartbeat, 'utf8');
    await wait(150);
    assert.equal(await readFile(heartbeat, 'utf8'), before);
    await f.executor.release!(context.path);
  } finally {
    pid ??= Number(await readFile(path.join(context.path, 'observed-detached-pid'), 'utf8').catch(() => ''));
    if (Number.isSafeInteger(pid) && pid! > 1) {
      const identity = (await run('/bin/ps', ['-p', String(pid), '-o', 'command='])).stdout;
      if (identity.includes(heartbeat)) try { process.kill(pid!, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await wait(100);
  }
});

test('a reparented writer that execs and changes cwd retains uncertainty instead of confirming a stale identity', async t => {
  const f = await fixture(t), context = await f.context('true');
  const heartbeat = path.join(context.path, 'exec-detached-heartbeat');
  const descendant = `const fs=require('node:fs');const target=${JSON.stringify(heartbeat)};process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(target,'x'),20);`;
  const detached = `sleep 0.35; cd /; exec ${nodeCommand(descendant)}`;
  // The initial shell is observed, then its parent exits. Exec changes its
  // command after reparenting and removes its private cwd as a fallback signal.
  context.command = nodeCommand(`const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn('/bin/bash',['--noprofile','--norc','-c',${JSON.stringify(detached)}],{detached:true,stdio:'ignore'});fs.writeFileSync('exec-detached-pid',String(child.pid));child.unref();setTimeout(()=>{},250);`);
  let pid: number | undefined;
  try {
    const result = await f.executor(context);
    pid = Number(await readFile(path.join(context.path, 'exec-detached-pid'), 'utf8'));
    assert.ok(result.cleanupErrors?.some(error => /changed process identity/.test(error)), JSON.stringify(result));
    const before = await readFile(heartbeat, 'utf8');
    await wait(100);
    assert.ok((await readFile(heartbeat, 'utf8')).length > before.length, 'changed identity is not signaled by guesswork');
    const [journal] = await readdir(`${context.path}-host-checks`);
    const completed = JSON.parse(await readFile(path.join(`${context.path}-host-checks`, journal!, 'completed.json'), 'utf8')) as { terminationConfirmed: boolean };
    assert.equal(completed.terminationConfirmed, false);
    await assert.rejects(f.executor.release!(context.path), /uncertain|retained/);
  } finally {
    pid ??= Number(await readFile(path.join(context.path, 'exec-detached-pid'), 'utf8').catch(() => ''));
    if (Number.isSafeInteger(pid) && pid! > 1) {
      const identity = (await run('/bin/ps', ['-p', String(pid), '-o', 'command='])).stdout;
      if (identity.includes(heartbeat)) try { process.kill(pid!, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await wait(100);
  }
});

test('successful commands near the deadline retain success during bounded process cleanup', async t => {
  const f = await fixture(t), context = await f.context('sleep 0.3; printf completed-before-deadline', 450);
  const result = await f.executor(context);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'completed-before-deadline');
});

test('snapshot ownership is reserved during asynchronous setup and release can cancel that setup', async t => {
  const f = await fixture(t), context = await f.context('touch must-not-start');
  const executing = f.executor(context);
  await assert.rejects(f.executor(context), /already running against these exact snapshots/);
  await f.executor.release!(context.path);
  const result = await executing;
  assert.equal(result.exitCode, 130);
  await assert.rejects(readFile(path.join(context.path, 'must-not-start')), /ENOENT/);
  assert.equal((await f.executor({ ...context, command: 'printf new-check' })).stdout, 'new-check');
});

test('uncertain durable process journals fence replacements and preserve private snapshots', async t => {
  const f = await fixture(t), context = await f.context('printf must-not-run');
  const journal = path.join(`${context.path}-host-checks`, randomUUID()); await mkdir(journal, { recursive: true });
  await writeFile(path.join(journal, 'owner.json'), JSON.stringify({ version: 1, key: path.basename(journal), pid: 1234 }));
  await assert.rejects(f.executor(context), /earlier host check outcome is uncertain/);
  await assert.rejects(f.executor.release!(context.path), /execution outcome is uncertain/);
  assert.equal(await readFile(path.join(context.path, 'source.txt'), 'utf8'), 'authored\n');
  const recovered = hostCheckExecutor({ checksRoot: path.join(f.dataDir, 'checks'), platform: 'darwin' });
  await assert.rejects(recovered.release!(context.path), /execution outcome is uncertain/);
});
