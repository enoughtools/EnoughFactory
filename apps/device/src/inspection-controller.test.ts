import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
import type { ControllerRun, Goal, InspectionAuthority, InspectionEvidence, InspectionJob, InspectionSourceIdentity, InspectionVerificationAcceptance, InspectionVerificationRun, Project, TaskQualityRequirements } from '@enoughfactory/contracts';
import { WorkingDirectoryManager, WorkspaceManager } from '@enoughfactory/workspaces';
import type { DeviceApp } from './app.ts';
import type { AgentToolBridge, AgentToolBridgeContext, ChatController } from './chats.ts';
import type { QualityEvidenceReport } from './factory-quality.ts';
import { InspectionService } from './inspection-service.ts';
import type { VerificationInput } from './inspection-verifier.ts';
import { Store } from './store.ts';
import { prepareControllerContext } from './controller-context.ts';
import { inspectionAcceptanceContractSha256, inspectionQualityPolicySha256, inspectionVerificationKey } from './inspection-verification-identity.ts';
import { inspectionSourceContentMatches } from './inspection-quality.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Wj4sAAAAASUVORK5CYII=', 'base64');
const referencePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
interface ToolResult { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; }
interface ReviewList { source: InspectionSourceIdentity; controllerSource: InspectionSourceIdentity; controllerSourceMatchesCanonical: boolean; quality: TaskQualityRequirements; roots: Array<{ id: string; name: string }>; qualityReports: { reports: Array<{ id: string; currentSource: boolean; workflows?: Array<{ id: string; assertionEvidenceId: string }>; unavailable?: boolean }>; omitted: number }; screens: Array<{ id: string; source: InspectionSourceIdentity; currentSource: boolean }>; assertions: Array<{ id: string }>; }
interface ControllerSeam { controllerBridge(context: AgentToolBridgeContext): Promise<AgentToolBridge | undefined>; }
const value = <T>(result: ToolResult): T => JSON.parse(result.content.find(item => item.type === 'text')!.text!) as T;

/** Actual stdio provider client and service handler; this does not simulate a model seeing pixels. */
function client(bridge: AgentToolBridge) {
  const server = bridge.mcpServers!.factory_review!;
  assert('command' in server);
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: 'pipe' });
  child.stdin.on('error', () => {});
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const lines = createInterface({ input: child.stdout });
  let stderr = '', nextId = 0;
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  lines.on('line', line => {
    const packet = JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } };
    const waiting = pending.get(packet.id); if (!waiting) return;
    pending.delete(packet.id);
    if (packet.error) waiting.reject(new Error(packet.error.message)); else waiting.resolve(packet.result);
  });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  const request = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Controller MCP request timed out: ${stderr}`)); }, 4000);
      pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    });
  };
  return {
    request,
    call: (name: string, args: Record<string, unknown> = {}) => request('tools/call', { name, arguments: args }) as Promise<ToolResult>,
    close: async () => { child.stdin.end(); child.kill('SIGTERM'); await exited; lines.close(); },
  };
}

async function fixture(t: TestContext, options: { generatedContext?: boolean; aggregate?: boolean; acceptedFinal?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ef-inspection-controller-')));
  const workdir = path.join(directory, 'controller'), canonicalPath = path.join(directory, 'integrated'), referencePath = path.join(directory, 'enough-ui');
  await mkdir(workdir); await mkdir(canonicalPath); await mkdir(referencePath);
  await writeFile(path.join(workdir, 'README.md'), 'The integrated mail app.');
  await writeFile(path.join(canonicalPath, 'README.md'), 'The integrated mail app.');
  await writeFile(path.join(referencePath, 'Button.swift'), 'Original pinned EnoughUI component.');
  await writeFile(path.join(referencePath, 'reference.png'), referencePng);
  let acceptedCommit: string | undefined;
  if (options.acceptedFinal) {
    const git = (...args: string[]) => execFileSync('git', ['-C', canonicalPath, ...args], { encoding: 'utf8' }).trim();
    git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Accepted application');
    acceptedCommit = git('rev-parse', 'HEAD');
    await cp(path.join(canonicalPath, '.git'), path.join(workdir, '.git'), { recursive: true });
  }
  const store = new Store(path.join(directory, 'service'));
  let bridge: AgentToolBridge | undefined, provider: ReturnType<typeof client> | undefined;
  t.after(async () => { await bridge?.release?.(); await provider?.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const goal = { id: 'goal', projectId: 'project', revision: 7, status: 'running', objective: 'Build the mail app.', criteria: ['Close draft restores the inbox.'] } as Goal;
  const run: ControllerRun = { id: 'evaluator', goalId: goal.id, role: 'evaluator', status: 'running', sessionId: 'review-session', chatId: 'review-chat', updatedAt: new Date().toISOString() };
  const authority: InspectionAuthority = { goalId: goal.id, goalRevision: 4, taskId: 'task', attemptId: 'attempt', authorityGeneration: 2, policyRevision: 4 };
  const quality: TaskQualityRequirements = { platforms: ['macos'], workflows: [{ id: 'close-draft', platform: 'macos' }], referenceIds: ['enough-ui'] };
  const abort = new AbortController();
  const context = { chat: { id: run.chatId, sessionId: run.sessionId, runtime: 'codex' }, session: { id: run.sessionId, projectId: 'project', workingDirectories: [{ id: 'enough-ui', name: 'enough-ui', path: referencePath }] }, execution: { kind: 'host-macos', targetId: 'mac-host', workdir }, signal: abort.signal } as AgentToolBridgeContext;
  store.set('goals', goal); store.set('factory-controller-runs', run); store.set('chats', context.chat);
  store.set('projects', { id: 'project', path: canonicalPath, workingDirectories: [{ id: 'enough-ui', name: 'enough-ui', path: referencePath }] });
  store.set('tasks', { id: 'task', goalId: goal.id, status: 'completed', currentAttemptId: 'attempt', quality });
  store.set('attempts', { id: 'attempt', taskId: 'task', generation: 2, status: 'succeeded' });
  const contract = { title: 'Close draft', description: 'Closing the draft restores the inbox.', acceptanceCriteria: ['Close draft restores the inbox.'], expectedOutputs: ['Verified app'], dependsOn: [], checks: [], quality, planRevision: 4 };
  store.set('factory-attempt-details', { id: 'attempt', goalId: goal.id, goalRevision: 4, assignmentGoalRevision: 4, contract,
    ...(acceptedCommit ? { candidate: { id: 'accepted-C', commit: acceptedCommit, baseCommit: acceptedCommit }, integration: { candidateCommit: acceptedCommit, commit: acceptedCommit } } : {}) });
  const app = { dataDir: path.join(directory, 'service'), device: { id: 'mac', capacity: 1 }, store,
    runtime: { endpoint: { host: 'unix:///no-docker-needed', cliPath: '/usr/bin/false', configDirectory: path.join(directory, 'private-docker') } },
    sessions: { record: (id: string) => { assert.equal(id, run.sessionId); return context.session; }, execution: (id: string) => { assert.equal(id, run.sessionId); return context.execution; }, owns: (id:string)=>id===run.sessionId },
    changed: () => {}, emit: () => {}, withServiceOperation: async <T>(operation: (signal: AbortSignal) => Promise<T>) => operation(abort.signal),
  } as unknown as DeviceApp;
  const service = new InspectionService(app, {isRunning:()=>false} as unknown as ChatController);
  const snapshot = await service.snapshots.create({ roots: [{ id: 'primary', name: 'primary', path: workdir }, { id: 'enough-ui', name: 'enough-ui', path: referencePath }], context: { goalId: goal.id, taskId: authority.taskId, attemptId: authority.attemptId } });
  const source: InspectionSourceIdentity = { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest, ...(root.sourceCommit ? { commit: root.sourceCommit } : {}) })),
    ...(acceptedCommit ? { candidateId: 'accepted-C', candidateCommit: acceptedCommit, checkedCommit: acceptedCommit } : {}) };
  const { token } = service.jobs.issueAuthority(authority, { capabilities: ['macos-app-inspection'], executionTargetIds: ['mac-host'] });
  const job = service.jobs.createJob(token, { idempotencyKey: 'author-preview', executionTargetId: 'mac-host', capability: 'macos-app-inspection', source, profile: {} });
  assert.equal(service.jobs.claimNext()!.id, job.id); service.jobs.markRunning(job.id);
  const session = service.jobs.openSession(job.id); service.jobs.markSessionReady(session.id);
  const imageArtifact = await service.artifacts.put(png, { goalId: goal.id, taskId: authority.taskId, attemptId: authority.attemptId, name: 'inbox.png', mime: 'image/png' });
  const beforeAction = service.jobs.beginAction(token, session.id, { idempotencyKey: 'before-close', kind: 'observe', arguments: {} }).action;
  service.jobs.markActionRunning(beforeAction.id);
  const beforeScreenshot = service.jobs.publishEvidence(job.id, { kind: 'screenshot', sessionId: session.id, actionId: beforeAction.id, artifact: imageArtifact, metadata: { platform: 'macos' } });
  const before = service.jobs.recordObservation(beforeAction.id, { screenshotEvidenceId: beforeScreenshot.id, uiTree: 'Composer visible with Close draft.', elementIds: ['close'] });
  service.jobs.actionComplete(beforeAction.id, { status: 'succeeded', evidenceIds: [beforeScreenshot.id] });
  store.set('inspection-evidence', { ...beforeScreenshot, metadata: { ...beforeScreenshot.metadata, observationId: before.id } });
  const close = service.jobs.beginAction(token, session.id, { idempotencyKey: 'close', kind: 'click', arguments: { elementId: 'close' }, observationId: before.id }).action;
  service.jobs.markActionRunning(close.id); service.jobs.actionComplete(close.id, { status: 'succeeded' });
  const action = service.jobs.beginAction(token, session.id, { idempotencyKey: 'after-close', kind: 'observe', arguments: {} }).action;
  service.jobs.markActionRunning(action.id);
  const evidence = service.jobs.publishEvidence(job.id, { kind: 'screenshot', sessionId: session.id, actionId: action.id, artifact: imageArtifact, metadata: { platform: 'macos' } });
  const observation = service.jobs.recordObservation(action.id, { screenshotEvidenceId: evidence.id, uiTree: 'Inbox visible. Composer absent.', elementIds: ['inbox'] });
  service.jobs.actionComplete(action.id, { status: 'succeeded', evidenceIds: [evidence.id] });
  const screenshot = { ...evidence, metadata: { ...evidence.metadata, observationId: observation.id } };
  store.set('inspection-evidence', screenshot);
  const assertionOriginal = JSON.stringify({ passed: true, observationId: observation.id, condition: { absent: true, labelIncludes: 'Composer' } });
  const assertionArtifact = await service.artifacts.put(assertionOriginal, { goalId: goal.id, taskId: authority.taskId, attemptId: authority.attemptId, name: 'assert-close.json', mime: 'application/json' });
  const assertion = service.jobs.publishEvidence(job.id, { kind: 'assertion', sessionId: session.id, artifact: assertionArtifact, metadata: { platform: 'macos', observationId: observation.id, passed: true } });
  for (const evidence of [beforeScreenshot, screenshot]) store.set('provider-image-deliveries', { id: `author-delivery-${evidence.id}`, chatId: 'author-chat', eventId: `author-tool-${evidence.id}`, authority, artifactSha256: evidence.artifact.sha256, route: 'tool-image' });
  const authorReference = await service.artifacts.put('Original pinned EnoughUI component.', { goalId: goal.id, taskId: authority.taskId, attemptId: authority.attemptId, name: 'Button.swift', mime: 'text/plain' });
  store.set('inspection-reference-views', { id: 'author-reference', referenceId: 'enough-ui', authority, source, artifacts: [authorReference], inspectedAt: new Date().toISOString() });
  const dimensions = { hierarchy: 'Inbox leads the screen.', spacing: 'Controls keep deliberate padding.', clipping: 'No message or control is clipped.', typography: 'Heading and rows use distinct semantic styles.', controls: 'The visible controls have clear actions.', states: 'Closing the composer returns to the inbox.' };
  const report: QualityEvidenceReport = { version: 1, source, workflows: [{ id: 'close-draft', platform: 'macos', before: beforeScreenshot.id, action: close.id, after: screenshot.id, outcome: 'passed', assertion: 'Composer disappeared and inbox became visible.', assertionEvidenceId: assertion.id }], reviews: [{ platform: 'macos', observations: [beforeScreenshot.id, screenshot.id], references: [{ id: 'enough-ui', comparison: 'Inbox controls follow the pinned EnoughUI reference.' }], dimensions, defects: [] }] };
  const qualityRecord = await service.quality.submit({ authority, quality, report });
  assert.equal(qualityRecord.gate.status, 'ready-for-review');
  if (acceptedCommit) {
    // Persist the same real contract-bound report that the completion service
    // reads. Native provider dispatch is outside these controller/source tests.
    const acceptanceContract: InspectionVerificationAcceptance = { version: 1, task: contract, goal: { revision: goal.revision, objective: goal.objective, criteria: goal.criteria,
      taskContracts: [{ taskId: authority.taskId, attemptId: authority.attemptId, authorityGeneration: authority.authorityGeneration, assignmentGoalRevision: authority.goalRevision, contract }] } };
    const identity = { authority, source, quality, purpose: 'goal-final' as const, goalRevision: goal.revision, acceptanceContract };
    const id = inspectionVerificationKey(identity), chatId = 'final-verifier-chat', sessionId = 'final-verifier-session';
    const verificationRun: InspectionVerificationRun = { ...identity, id, chatId, sessionId, policySha256: inspectionQualityPolicySha256(quality), ownerDeviceId: 'mac', executionTargetKind: 'host-macos', executionTargetId: 'mac-host', status: 'running', createdAt: run.updatedAt, updatedAt: run.updatedAt, deadlineAt: new Date(Date.now() + 60000).toISOString() };
    const verification = { runId: id, chatId, acceptanceContractSha256: inspectionAcceptanceContractSha256(acceptanceContract) };
    store.set('inspection-verifier-runs', verificationRun);
    store.set('chats', { id: chatId, sessionId, verificationRunId: id, deviceId: 'mac', runtime: 'codex', status: 'running' });
    store.set('sessions', { id: sessionId, verificationRunId: id, deviceId: 'mac', executionTargetKind: 'host-macos', executionTargetId: 'mac-host', status: 'ready' });
    for (const item of [beforeScreenshot, screenshot]) store.set('provider-image-deliveries', { id: `final-delivery-${item.id}`, chatId, eventId: `final-tool-${item.id}`, authority, artifactSha256: item.artifact.sha256, route: 'tool-image' });
    store.set('inspection-reference-views', { id: 'final-reference', referenceId: 'enough-ui', authority, source, artifacts: [authorReference], verification, inspectedAt: run.updatedAt });
    const finalReport = await service.quality.submit({ authority, quality, report, verification });
    assert.equal(finalReport.gate.status, 'ready-for-review', finalReport.gate.issues.join(' '));
    const completed = { ...verificationRun, status: 'succeeded' as const };
    store.set('inspection-verifier-runs', completed);
    store.set('chats', { id: chatId, sessionId, verificationRunId: id, deviceId: 'mac', runtime: 'codex', status: 'idle' });
    store.set('sessions', { id: sessionId, verificationRunId: id, deviceId: 'mac', executionTargetKind: 'host-macos', executionTargetId: 'mac-host', status: 'stopped' });
    t.mock.method(service.verifier, 'ensure', async (input: VerificationInput) => {
      assert.equal(input.purpose, 'goal-final'); assert.equal(input.goalRevision, goal.revision);
      assert.deepEqual(input.authority, authority); assert.deepEqual(input.quality, quality);
      assert.equal(input.source.candidateId, 'accepted-C'); assert.equal(input.source.candidateCommit, acceptedCommit); assert.equal(input.source.checkedCommit, acceptedCommit);
      assert(inspectionSourceContentMatches(input.source, source));
      return completed;
    });
  }
  if (options.generatedContext) {
    const project = store.get<Project>('projects', 'project')!;
    if (options.aggregate) for (let index = 1; index < 8; index++) {
      const extraPath = path.join(directory, `input-${index}`); await mkdir(extraPath);
      await writeFile(path.join(extraPath, 'Input.swift'), `let input = ${index}\n`);
      project.workingDirectories!.push({ id: `input-${index}`, name: `input-${index}`, path: extraPath });
    }
    store.set('projects', project);
    const workspaces = new WorkspaceManager({ dataDir: path.join(app.dataDir, 'workspace-data'), deviceId: 'mac' });
    const directoryManager = new WorkingDirectoryManager({ dataDir: path.join(app.dataDir, 'workspace-data'), artifacts: workspaces.artifacts });
    const prepared = await prepareControllerContext({ operation: run.id, goalId: goal.id, role: 'evaluator', project, store, workspaces, directoryManager, dataDir: app.dataDir, selected: [] });
    store.set('session-launch', { id: run.sessionId, workingDirectorySources: prepared.workingDirectorySources });
    const transferred = await directoryManager.prepare({ identity: 'actual-evaluator-session', transferred: prepared.workingDirectorySources });
    store.set('session-host', { id: run.sessionId, deviceId: 'mac', prepared: { sessionId: run.sessionId, roots: transferred } });
    context.session.workingDirectories = transferred.map(root => ({ id: root.id, name: root.name, path: root.path, kind: root.kind, baseCommit: root.baseCommit, sourceCommit: root.sourceCommit, status: 'ready' }));
  }
  bridge = await (service as unknown as ControllerSeam).controllerBridge(context); assert(bridge);
  provider = client(bridge);
  await provider.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'controller-integration-test', version: '1' } });
  const deliver = async (result: ToolResult, itemId: string) => {
    const image = result.content.find(item => item.type === 'image'); assert(image?.data && image.mimeType);
    assert(bridge?.onToolImage);
    return bridge.onToolImage({ bytes: Buffer.from(image.data, 'base64'), mimeType: image.mimeType, itemId }, abort.signal);
  };
  const review = (actual: InspectionSourceIdentity): { source: InspectionSourceIdentity; reviews: QualityEvidenceReport['reviews'] } => ({ source: actual, reviews: [{ platform: 'macos', observations: [screenshot.id], references: [{ id: 'enough-ui', comparison: 'Inbox controls follow the pinned EnoughUI reference.' }], dimensions, defects: [] }] });
  return { directory, workdir, canonicalPath, referencePath, store, service, goal, run, source, quality, qualityRecord, context, abort, bridge, provider, job, session, action, beforeScreenshot, screenshot, assertion, assertionOriginal, observation, deliver, review };
}

test('controller MCP exposes original measured evidence and distinguishes current integrated source from old screens', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const list = value<ReviewList>(await f.provider.call('factory_review_screens'));
  assert.deepEqual(list.quality, f.quality);
  assert.notEqual(list.source.snapshotId, f.source.snapshotId);
  assert.equal(list.source.sha256, f.source.sha256);
  assert.deepEqual(list.screens.map(item => [item.id, item.currentSource]), [[f.beforeScreenshot.id, true], [f.screenshot.id, true]]);
  assert.deepEqual(list.assertions.map(item => item.id), [f.assertion.id]);
  assert.equal(list.qualityReports.reports[0]!.id, f.qualityRecord.id);
  assert.equal(list.qualityReports.reports[0]!.currentSource, true);
  assert.deepEqual(list.qualityReports.reports[0]!.workflows!.map(item => [item.id, item.assertionEvidenceId]), [['close-draft', f.assertion.id]]);
  const originalReport = value<{ qualityReport: { id: string }; original: string }>(await f.provider.call('factory_review_evidence', { evidenceId: f.qualityRecord.id }));
  assert.equal(originalReport.qualityReport.id, f.qualityRecord.id);
  assert.equal((JSON.parse(originalReport.original) as QualityEvidenceReport).workflows[0]!.assertionEvidenceId, f.assertion.id);
  const original = value<{ evidence: InspectionEvidence; job: InspectionJob; actions: Array<{ id: string; status: string }>; observation: { id: string }; original: string }>(await f.provider.call('factory_review_evidence', { evidenceId: f.assertion.id }));
  assert.deepEqual(original.evidence, f.assertion);
  assert.equal(original.job.id, f.job.id);
  assert.equal(original.actions.find(item => item.id === f.action.id)!.status, 'succeeded');
  assert.equal(original.observation.id, f.observation.id);
  assert.equal(original.original, f.assertionOriginal);
  const image = await f.provider.call('factory_review_image', { evidenceId: f.screenshot.id });
  assert.deepEqual(Buffer.from(image.content.find(item => item.type === 'image')!.data!, 'base64'), png);
  assert.match(value<{ uiTree: string }>(image).uiTree, /Composer absent/);
  const retained = await f.deliver(image, 'evaluator-image-actual-callback');
  assert.equal(retained.artifactId, f.screenshot.artifact.id);
  const deliveries = f.store.list<{ controllerRunId: string; goalRevision: number; eventId: string }>('controller-image-deliveries');
  assert.equal(deliveries[0]!.controllerRunId, f.run.id); assert.equal(deliveries[0]!.goalRevision, f.goal.revision);
  assert.equal(deliveries[0]!.eventId, 'evaluator-image-actual-callback');
  await assert.rejects(f.provider.call('factory_review_image', { evidenceId: f.assertion.id }), /screenshot/);
  await writeFile(path.join(f.workdir, 'README.md'), 'New integrated source.');
  await writeFile(path.join(f.canonicalPath, 'README.md'), 'New integrated source.');
  const secondBridge = await (f.service as unknown as ControllerSeam).controllerBridge(f.context); assert(secondBridge);
  const second = client(secondBridge);
  try {
    const changed = value<ReviewList>(await second.call('factory_review_screens'));
    assert.notEqual(changed.source.sha256, f.source.sha256);
    assert.equal(changed.screens[0]!.currentSource, false, 'Retained old pixels remain explicitly old after integration changes.');
  } finally { await secondBridge.release?.(); await second.close(); }
});

test('controller references are scoped to configured roots and pin original bytes before image delivery can count', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.provider.call('factory_review_reference', { referenceId: 'enough-ui', rootId: 'primary', relativePath: 'README.md' }), /root|reference identity/i);
  await assert.rejects(f.provider.call('factory_review_reference', { referenceId: 'other-reference', rootId: 'enough-ui', relativePath: 'Button.swift' }), /quality contract/);
  await assert.rejects(f.provider.call('factory_review_reference', { referenceId: 'enough-ui', rootId: 'enough-ui', relativePath: '../../source/README.md' }), /escapes/);
  assert.equal(f.store.list('controller-reference-views').length, 0);
  await assert.rejects(f.bridge.onToolImage!({ bytes: referencePng, mimeType: 'image/png', itemId: 'unread-reference' }, f.abort.signal), /not retained/);
  const reference = await f.provider.call('factory_review_reference', { referenceId: 'enough-ui', rootId: 'enough-ui', relativePath: 'Button.swift' });
  assert.equal(reference.content[1]!.text, 'Original pinned EnoughUI component.');
  const pinned = value<{ artifact: { id: string; sha256: string } }>(reference).artifact;
  const view = f.store.list<{ controllerRunId: string; source: InspectionSourceIdentity; artifacts: unknown[] }>('controller-reference-views')[0]!;
  assert.equal(view.controllerRunId, f.run.id); assert.deepEqual(view.artifacts[0], pinned);
  const referenceImage = await f.provider.call('factory_review_reference', { referenceId: 'enough-ui', rootId: 'enough-ui', relativePath: 'reference.png' });
  assert.deepEqual(Buffer.from(referenceImage.content[1]!.data!, 'base64'), referencePng);
  assert.equal((await f.deliver(referenceImage, 'reference-tool-image')).artifactId, value<{ artifact: { id: string } }>(referenceImage).artifact.id);
});

test('completion review requires its own image and reference reads and recaptures actual integrated source', { timeout: 15000 }, async t => {
  const f = await fixture(t, { acceptedFinal: true }), actual = value<ReviewList>(await f.provider.call('factory_review_screens')).source;
  const resultText = () => JSON.stringify({ complete: true, visualReview: f.review(actual) });
  const missing = await f.service.reviewController({ goal: f.goal, run: f.run, resultText: resultText() });
  assert.equal(missing.ready, false); assert.match(missing.reason!, /screenshot|reference/);
  await f.deliver(await f.provider.call('factory_review_image', { evidenceId: f.screenshot.id }), 'completion-screenshot');
  await f.provider.call('factory_review_reference', { referenceId: 'enough-ui', rootId: 'enough-ui', relativePath: 'Button.swift' });
  await f.provider.call('factory_review_evidence', { evidenceId: f.assertion.id });
  const completed = { ...f.run, status: 'completed' as const }; f.store.set('factory-controller-runs', completed);
  const accepted = await f.service.reviewController({ goal: f.goal, run: completed, resultText: resultText() });
  assert.equal(accepted.ready, true, accepted.reason); assert.deepEqual(accepted.evidenceIds, [f.assertion.id, f.screenshot.id]);
  await writeFile(path.join(f.workdir, 'README.md'), 'Changed after the evaluator viewed the product.');
  const changed = await f.service.reviewController({ goal: f.goal, run: completed, resultText: resultText() });
  assert.equal(changed.ready, false); assert.match(changed.reason!, /workspace differs/);
  const incomplete = await f.service.reviewController({ goal: f.goal, run: completed, resultText: JSON.stringify({ complete: false, reason: 'Work remains.' }) });
  assert.equal(incomplete.ready, false, 'An evidence-only incomplete decision still reconciles its exact source before final verification.');
  assert.match(incomplete.reason!, /workspace differs/);
});

test('controller evidence and callbacks cannot cross goals or survive retired review authority', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const foreignArtifact = await f.service.artifacts.put(Buffer.from('Other goal pixels'), { goalId: 'foreign-goal', taskId: 'foreign-task', attemptId: 'foreign-attempt', name: 'foreign.png', mime: 'image/png' });
  const foreignAuthority = { ...f.screenshot.authority, goalId: 'foreign-goal', taskId: 'foreign-task', attemptId: 'foreign-attempt' };
  f.store.set('inspection-jobs', { ...f.job, id: 'foreign-job', authority: foreignAuthority });
  f.store.set('inspection-evidence', { ...f.screenshot, id: 'foreign-screen', jobId: 'foreign-job', authority: foreignAuthority, artifact: foreignArtifact });
  const list = value<ReviewList>(await f.provider.call('factory_review_screens'));
  assert.equal(list.screens.some(item => item.id === 'foreign-screen'), false);
  await assert.rejects(f.provider.call('factory_review_evidence', { evidenceId: 'foreign-screen' }), /your goal/);
  await assert.rejects(f.provider.call('factory_review_image', { evidenceId: 'foreign-screen' }), /your goal/);
  await assert.rejects(f.bridge.onToolImage!({ bytes: Buffer.from('Other goal pixels'), mimeType: 'image/png', itemId: 'foreign-tool-result' }, f.abort.signal), /not retained/);
  f.store.set('goals', { ...f.goal, revision: f.goal.revision + 1 });
  await assert.rejects(f.provider.call('factory_review_screens'), /retired/);
  await assert.rejects(f.bridge.onToolImage!({ bytes: png, mimeType: 'image/png', itemId: 'stale-tool-result' }, f.abort.signal), /retired/);
  assert.deepEqual(f.store.list('controller-image-deliveries'), []);
});

test('an evaluator cannot certify an older private checkout while the canonical integrated app has changed', { timeout: 15000 }, async t => {
  const f = await fixture(t), actual = value<ReviewList>(await f.provider.call('factory_review_screens')).source;
  await f.deliver(await f.provider.call('factory_review_image', { evidenceId: f.screenshot.id }), 'older-source-image');
  await f.provider.call('factory_review_reference', { referenceId: 'enough-ui', rootId: 'enough-ui', relativePath: 'Button.swift' });
  await f.provider.call('factory_review_evidence', { evidenceId: f.assertion.id });
  await writeFile(path.join(f.canonicalPath, 'README.md'), 'New delivered source absent from the old screenshot.');
  // All retained evidence and the evaluator's mutable checkout still match the
  // older product. The owning project's actual source must override that claim.
  t.mock.method(f.service.quality, 'reviewCheck', async () => assert.fail('A noncanonical checkout must reject before the visual guard'));
  const checked = await f.service.reviewController({ goal: f.goal, run: f.run, resultText: JSON.stringify({ complete: true, visualReview: f.review(actual) }) });
  assert.equal(checked.ready, false); assert.match(checked.reason!, /workspace differs/);
});

test('evaluator preparation materializes exact canonical modes in primary and additional roots while retaining its original source audit', {timeout:15000},async t=>{
  const f=await fixture(t,{generatedContext:true});
  const reference=f.context.session.workingDirectories!.find(root=>root.id==='enough-ui')!;
  await chmod(path.join(f.workdir,'README.md'),0o666);await chmod(path.join(reference.path,'Button.swift'),0o666);
  await mkdir(path.join(f.workdir,'scripts'));await mkdir(path.join(f.canonicalPath,'scripts'));
  await chmod(path.join(f.workdir,'scripts'),0o777);await chmod(path.join(f.canonicalPath,'scripts'),0o755);
  const generated=f.context.session.workingDirectories!.find(root=>root.id!=='enough-ui')!;
  const preserved=path.join(generated.path,'service-evidence-retained.txt');await writeFile(preserved,'Retained generated evidence',{mode:0o666});await chmod(preserved,0o666);
  const before=value<ReviewList>(await f.provider.call('factory_review_screens'));assert.equal(before.controllerSourceMatchesCanonical,false);
  await f.service.prepareControllerReview({goal:f.goal,run:f.run});
  assert.equal((await lstat(path.join(f.workdir,'README.md'))).mode&0o777,0o644);
  assert.equal((await lstat(path.join(reference.path,'Button.swift'))).mode&0o777,0o644);
  assert.equal((await lstat(path.join(f.workdir,'scripts'))).mode&0o777,0o755);
  assert.equal((await lstat(preserved)).mode&0o777,0o666,'Generated controller evidence is outside declared source preparation');
  const audits=f.store.list<{status:string;previous:InspectionSourceIdentity;actual:InspectionSourceIdentity;canonical:InspectionSourceIdentity;previousTransfer:{sourceManifest:{id:string}}}>('controller-source-preparations');
  assert.equal(audits.length,1);assert.equal(audits[0]!.status,'ready');
  assert.notEqual(audits[0]!.previous.sha256,audits[0]!.canonical.sha256);assert.equal(audits[0]!.actual.sha256,audits[0]!.canonical.sha256);
  const retained=await f.service.artifacts.read(await f.service.artifacts.get(audits[0]!.previousTransfer.sourceManifest.id));
  assert.match(retained.toString(),/"mode":438/,'Original 0666 provenance stays retained rather than normalized');
});

test('evaluator preparation refuses changed source bytes instead of replacing them or altering canonical modes', {timeout:15000},async t=>{
  const f=await fixture(t);await chmod(path.join(f.workdir,'README.md'),0o666);
  await writeFile(path.join(f.workdir,'README.md'),'Changed evaluator source bytes');
  await assert.rejects(f.service.prepareControllerReview({goal:f.goal,run:f.run}),/Changed bytes, paths and symlink targets/);
  assert.equal((await lstat(path.join(f.workdir,'README.md'))).mode&0o777,0o666);
  assert.equal((await lstat(path.join(f.canonicalPath,'README.md'))).mode&0o777,0o644);
  assert.equal(f.store.list('controller-source-preparations').length,0);
});

test('changed symlink targets and lost ownership cannot enter evaluator permission preparation', {timeout:15000},async t=>{
  for(const defect of ['symlink','owner'] as const)await t.test(defect,async t=>{
    const f=await fixture(t);await chmod(path.join(f.workdir,'README.md'),0o666);
    if(defect==='symlink'){
      await symlink('README.md',path.join(f.canonicalPath,'source-link'));
      await symlink('different-target',path.join(f.workdir,'source-link'));
    }else Object.assign(f.service.app.sessions,{owns:()=>false});
    await assert.rejects(f.service.prepareControllerReview({goal:f.goal,run:f.run}),defect==='symlink'?/Changed bytes, paths and symlink targets/:/preparation owner changed/);
    assert.equal((await lstat(path.join(f.workdir,'README.md'))).mode&0o777,0o666);
    assert.equal(f.store.list('controller-source-preparations').length,0);
  });
});

test('an honest incomplete evaluator drives missing canonical-M verification before reviewing new evidence', {timeout:15000},async t=>{
  const f=await fixture(t),git=(...args:string[])=>execFileSync('git',['-C',f.canonicalPath,...args],{encoding:'utf8'}).trim();
  git('init','--quiet');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Accepted integration');
  const checkedCommit=git('rev-parse','HEAD'),candidateCommit='a'.repeat(40),candidateId='accepted-C';
  const detail=f.store.get<Record<string,unknown>&{id:string}>('factory-attempt-details','attempt')!;
  f.store.set('factory-attempt-details',{...detail,goalId:f.goal.id,goalRevision:f.goal.revision,candidate:{id:candidateId,commit:candidateCommit},integration:{candidateCommit,commit:checkedCommit}});
  // Historical C screenshots retain their widened container modes; M is exact
  // host canonical source and must receive a separate goal-final verifier.
  t.mock.method(f.service.quality,'controllerReportContext',async()=>({reports:[],omitted:0}));
  t.mock.method(f.service.quality,'check',async()=>({command:'enoughfactory:ui-quality',candidateCommit,checkedCommit,passed:false,output:'Current M evidence is missing.',recovery:{condition:'inspection-evidence' as const,reason:'Missing current M screenshots'}}));
  let calls=0;
  t.mock.method(f.service.verifier,'ensure',async(input:VerificationInput)=>{
    calls++;assert.equal(input.purpose,'goal-final');assert.equal(input.goalRevision,f.goal.revision);
    assert.equal(input.authority.attemptId,'attempt');assert.equal(input.authority.authorityGeneration,2);
    assert.equal(input.source.candidateCommit,candidateCommit);assert.equal(input.source.checkedCommit,checkedCommit);
    assert.deepEqual(input.quality,f.quality);assert.equal(input.snapshot.sourceDigest,input.source.sha256);
    return {id:'final-M-verifier',...input,policySha256:'b'.repeat(64),ownerDeviceId:'mac',executionTargetKind:'host-macos' as const,executionTargetId:'mac-host',status:'waiting' as const,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+60000).toISOString(),reason:'Testing the exact current M product.'};
  });
  const result=await f.service.reviewController({goal:f.goal,run:f.run,resultText:JSON.stringify({complete:false,summary:'Canonical current-source evidence is missing.',criteria:[]})});
  assert.equal(calls,1);assert.equal(result.ready,false);assert.match(result.reason!,/Final app verification waiting/);
  assert.equal(f.store.get<{generation:number}>('attempts','attempt')!.generation,2);
});

test('an actionable evaluator repair plan bypasses redundant final verification without changing its requirements', {timeout:15000},async t=>{
  const f=await fixture(t);
  t.mock.method(f.service.verifier,'ensure',async()=>assert.fail('A genuine repair plan must return to planning'));
  t.mock.method(f.service.quality,'controllerReportContext',async()=>assert.fail('A genuine repair plan does not need completion evidence'));
  const repair={complete:false,summary:'Compose controls clip and need repair.',criteria:[],additionalTasks:[{key:'repair-compose-clipping',title:'Fix compose clipping',description:'Repair the observed clipped controls.',dependsOn:[]}]};
  assert.deepEqual(await f.service.reviewController({goal:f.goal,run:f.run,resultText:JSON.stringify(repair)}),{ready:true,evidenceIds:[]});
  assert.deepEqual(f.store.get<{quality:TaskQualityRequirements}>('tasks','task')!.quality,f.quality);
});

test('canonical source changes during final evidence verification refuse completion', { timeout: 15000 }, async t => {
  const f = await fixture(t, { acceptedFinal: true }), actual = value<ReviewList>(await f.provider.call('factory_review_screens')).source;
  await f.deliver(await f.provider.call('factory_review_image', { evidenceId: f.screenshot.id }), 'final-image');
  await f.provider.call('factory_review_reference', { referenceId: 'enough-ui', rootId: 'enough-ui', relativePath: 'Button.swift' });
  await f.provider.call('factory_review_evidence', { evidenceId: f.assertion.id });
  const original = f.service.quality.reviewCheck.bind(f.service.quality);
  t.mock.method(f.service.quality, 'reviewCheck', async (input: Parameters<typeof original>[0]) => {
    const result = await original(input); assert.equal(result.ready, true, result.reason);
    await writeFile(path.join(f.canonicalPath, 'README.md'), 'Integrated concurrently during artifact verification.');
    return result;
  });
  const checked = await f.service.reviewController({ goal: f.goal, run: f.run, resultText: JSON.stringify({ complete: true, visualReview: f.review(actual) }) });
  assert.equal(checked.ready, false); assert.match(checked.reason!, /changed during its final review/);
});

test('a private reference-folder change cannot substitute for the canonical additional root', { timeout: 15000 }, async t => {
  const f = await fixture(t), actual = value<ReviewList>(await f.provider.call('factory_review_screens')).source;
  const alternate = path.join(f.directory, 'changed-private-reference'); await mkdir(alternate);
  await writeFile(path.join(alternate, 'Button.swift'), 'Locally reverted or changed EnoughUI.');
  await writeFile(path.join(alternate, 'reference.png'), referencePng);
  f.context.session.workingDirectories![0]!.path = alternate;
  const checked = await f.service.reviewController({ goal: f.goal, run: f.run, resultText: JSON.stringify({ complete: true, visualReview: f.review(actual) }) });
  assert.equal(checked.ready, false); assert.match(checked.reason!, /reference folders/);
});

test('actual generated controller evidence is excluded while declared private reference changes still reject completion', { timeout: 20000 }, async t => {
  const f = await fixture(t, { generatedContext: true, acceptedFinal: true });
  const generated = f.context.session.workingDirectories!.find(root => root.id === `controller-context-${f.run.id}`)!;
  assert(generated, 'Use the real generated source prepared and transferred by the controller context.');
  const list = value<ReviewList>(await f.provider.call('factory_review_screens'));
  assert.equal(list.controllerSourceMatchesCanonical, true);
  assert.deepEqual(list.controllerSource.roots!.map(root => root.id), ['primary', 'enough-ui']);
  await writeFile(path.join(generated.path, 'controller-notes.txt'), 'Controller-only evidence does not change app source.');
  await f.deliver(await f.provider.call('factory_review_image', { evidenceId: f.screenshot.id }), 'generated-context-image');
  await f.provider.call('factory_review_reference', { referenceId: 'enough-ui', rootId: 'enough-ui', relativePath: 'Button.swift' });
  await f.provider.call('factory_review_evidence', { evidenceId: f.assertion.id });
  const resultText = JSON.stringify({ complete: true, visualReview: f.review(list.source) });
  assert.equal((await f.service.reviewController({ goal: f.goal, run: f.run, resultText })).ready, true);
  const declared = f.context.session.workingDirectories!.find(root => root.id === 'enough-ui')!;
  await writeFile(path.join(declared.path, 'Button.swift'), 'Changed private reference cannot certify the canonical reference.');
  const rejected = await f.service.reviewController({ goal: f.goal, run: f.run, resultText });
  assert.equal(rejected.ready, false); assert.match(rejected.reason!, /workspace differs|reference folders/);
});

test('eight declared folders resolve inside actual aggregate controller evidence without counting its records as source', { timeout: 25000 }, async t => {
  const f = await fixture(t, { generatedContext: true, aggregate: true });
  assert.equal(f.context.session.workingDirectories!.length, 1);
  const aggregate = f.context.session.workingDirectories![0]!;
  assert.equal(aggregate.id, `controller-context-${f.run.id}`);
  const list = value<ReviewList>(await f.provider.call('factory_review_screens'));
  assert.equal(list.controllerSourceMatchesCanonical, true);
  assert.deepEqual(list.controllerSource.roots!.map(root => root.id), ['primary', 'enough-ui', ...Array.from({ length: 7 }, (_, index) => `input-${index + 1}`)]);
  const reference = await f.provider.call('factory_review_reference', { referenceId: 'enough-ui', rootId: 'enough-ui', relativePath: 'Button.swift' });
  assert.equal(reference.content[1]!.text, 'Original pinned EnoughUI component.');
  const privateReference = path.join(aggregate.path, 'project-directories', 'enough-ui', 'Button.swift');
  await writeFile(privateReference, 'Changed aggregate reference.');
  const changed = await f.service.reviewController({ goal: f.goal, run: f.run, resultText: JSON.stringify({ complete: true, visualReview: f.review(list.source) }) });
  assert.equal(changed.ready, false); assert.match(changed.reason!, /reference folders/);
  await rm(path.join(aggregate.path, 'project-directories', 'input-7'), { recursive: true });
  const missing = await f.service.reviewController({ goal: f.goal, run: f.run, resultText: JSON.stringify({ complete: true }) });
  assert.equal(missing.ready, false); assert.match(missing.reason!, /cannot read declared reference folder input-7/);
});

test('controller report summaries verify originals and cannot read another goal or corrupted bytes', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.store.set('inspection-quality-reports', { ...f.qualityRecord, id: 'foreign-quality-report', authority: { ...f.qualityRecord.authority, goalId: 'foreign-goal' } });
  await assert.rejects(f.provider.call('factory_review_evidence', { evidenceId: 'foreign-quality-report' }), /your goal/);
  await writeFile(await f.service.artifacts.path(f.qualityRecord.reportArtifact), '{}');
  const list = value<ReviewList>(await f.provider.call('factory_review_screens'));
  assert.equal(list.qualityReports.reports.length, 1);
  assert.equal(list.qualityReports.reports[0]!.unavailable, true);
  assert.equal(list.qualityReports.reports[0]!.workflows, undefined, 'Corrupted authored bytes must not produce trusted workflow links.');
  await assert.rejects(f.provider.call('factory_review_evidence', { evidenceId: f.qualityRecord.id }), /artifact|digest|hash|corrupt|changed/i);
});
