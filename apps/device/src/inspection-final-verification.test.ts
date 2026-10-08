import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Attempt, ControllerRun, FactoryTask, Goal, InspectionAuthority, InspectionSourceIdentity, InspectionVerificationRun, Project, TaskQualityRequirements } from '@enoughfactory/contracts';
import type { AttemptDetail } from '@enoughfactory/factory';
import type { DeviceApp } from './app.ts';
import type { AgentToolBridgeContext, ChatController } from './chats.ts';
import { inspectionGoalQuality } from './inspection-goal-quality.ts';
import { InspectionService } from './inspection-service.ts';
import { inspectionVerificationKey } from './inspection-verifier.ts';
import { Store } from './store.ts';

const firstQuality: TaskQualityRequirements = { platforms: ['macos'], workflows: [{ id: 'compose', platform: 'macos' }], referenceIds: ['enough-ui'] };
const secondQuality: TaskQualityRequirements = { platforms: ['macos'], workflows: [{ id: 'search', platform: 'macos' }], referenceIds: ['enough-ui'] };

/** Real Git C/M identities, immutable source copies, retained report artifacts and SQLite verifier ownership. */
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ef-final-verification-')));
  const dataDir = path.join(directory, 'service'), canonicalPath = path.join(directory, 'integrated'), workdir = path.join(directory, 'evaluator'), referencePath = path.join(directory, 'enough-ui');
  await mkdir(canonicalPath); await mkdir(referencePath);
  await writeFile(path.join(referencePath, 'Tokens.swift'), 'let spacing = 12\n');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', '-C', canonicalPath, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' },
  }).trim();
  git('init', '--quiet');
  const commit = async (text: string, message: string) => {
    await writeFile(path.join(canonicalPath, 'Mail.swift'), text);
    git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const initial = await commit('let screen = "Inbox"\n', 'Initial app');
  const firstC = await commit('let screen = "Composer"\n', 'First retained candidate');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'First integrated result');
  const firstM = git('rev-parse', 'HEAD');
  const store = new Store(dataDir), goal = { id: 'goal', projectId: 'project', revision: 12, status: 'running' } as Goal;
  const run: ControllerRun = { id: 'evaluator', goalId: goal.id, role: 'evaluator', status: 'completed', sessionId: 'review-session', chatId: 'review-chat', updatedAt: new Date().toISOString() };
  const context = { chat: { id: run.chatId, sessionId: run.sessionId, runtime: 'codex' }, session: { id: run.sessionId, projectId: 'project', workingDirectories: [{ id: 'enough-ui', name: 'enough-ui', path: referencePath }] }, execution: { kind: 'host-macos', targetId: 'mac-host', workdir }, signal: new AbortController().signal } as AgentToolBridgeContext;
  const project = { id: 'project', path: canonicalPath, deviceId: 'mac', name: 'Mail', workingDirectories: [{ id: 'enough-ui', name: 'enough-ui', path: referencePath }] } as Project;
  store.set('goals', goal); store.set('projects', project); store.set('factory-controller-runs', run); store.set('chats', context.chat);
  const accepted = (id: string, candidateCommit: string, mergedCommit: string, quality: TaskQualityRequirements, revision: number, at: string) => {
    const task = { id, goalId: goal.id, status: 'completed', currentAttemptId: `${id}-author`, quality, updatedAt: at } as FactoryTask;
    const attempt = { id: task.currentAttemptId!, taskId: id, generation: revision, deviceId: 'mac', status: 'succeeded', endedAt: at } as Attempt;
    const detail: AttemptDetail = { id: attempt.id, goalId: goal.id, goalRevision: revision, assignmentGoalRevision: revision, contract: { title: id, description: `Implement ${id}`, dependsOn: [], checks: [], planRevision: revision, quality }, candidate: { id: `${id}-candidate`, commit: candidateCommit, baseCommit: initial }, integration: { candidateCommit, commit: mergedCommit, previousHead: initial, checks: [] }, phase: 'done', cancellation: 'none' };
    store.set('tasks', task); store.set('attempts', attempt); store.set('factory-attempt-details', detail);
    return { task, attempt, detail, authority: { goalId: goal.id, goalRevision: revision, taskId: id, attemptId: attempt.id, authorityGeneration: revision, policyRevision: revision } satisfies InspectionAuthority };
  };
  const first = accepted('compose', firstC, firstM, firstQuality, 3, '2026-10-01T10:00:00.000Z');
  const app = { dataDir, device: { id: 'mac', capacity: 0 }, store,
    runtime: { endpoint: { host: 'unix:///no-runtime', cliPath: '/usr/bin/false', configDirectory: path.join(directory, 'private-docker') } },
    sessions: { record: () => context.session, execution: () => context.execution }, emit() {}, changed() {},
  } as unknown as DeviceApp;
  const service = new InspectionService(app, {} as ChatController);
  service.readiness = async () => [];
  const oldSnapshot = await service.snapshots.create({ roots: [{ id: 'primary', name: 'primary', path: canonicalPath }, { id: 'enough-ui', name: 'enough-ui', path: referencePath }] });
  const oldSource: InspectionSourceIdentity = { snapshotId: oldSnapshot.id, sha256: oldSnapshot.sourceDigest, candidateId: first.detail.candidate!.id, candidateCommit: firstC, checkedCommit: firstM, roots: oldSnapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest, ...(root.sourceCommit ? { commit: root.sourceCommit } : {}) })) };
  const oldReport = await service.quality.submit({ authority: first.authority, quality: firstQuality, report: { version: 1, source: oldSource, workflows: [], reviews: [] } });
  const secondC = await commit('let screen = "Inbox with search and compose"\n', 'Latest retained candidate');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Latest integrated result');
  const secondM = git('rev-parse', 'HEAD'), second = accepted('search', secondC, secondM, secondQuality, 7, '2026-10-01T11:00:00.000Z');
  await cp(canonicalPath, workdir, { recursive: true });
  t.after(async () => { await service.verifier.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const review = () => service.reviewController({ goal, run, resultText: JSON.stringify({ complete: true }) });
  return { service, store, goal, run, review, first, second, firstC, firstM, secondC, secondM, canonicalPath, workdir, oldReport, oldSource };
}

test('stale task reports create one independent final verifier for the frozen union and real latest C/M', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  // A later task edit cannot silently remove an accepted author's frozen criterion.
  f.store.set('tasks', { ...f.first.task, quality: undefined });
  const before = f.store.list<Attempt>('attempts');
  const checked = await f.review();
  assert.equal(checked.ready, false); assert.match(checked.reason!, /Final app verification waiting/);
  const runs = f.store.list<InspectionVerificationRun>('inspection-verifier-runs'); assert.equal(runs.length, 1);
  const run = runs[0]!;
  assert.equal(run.purpose, 'goal-final'); assert.equal(run.goalRevision, 12);
  assert.deepEqual(run.authority, f.second.authority, 'The latest accepted author keeps its original assignment authority.');
  assert.equal(run.source.candidateId, f.second.detail.candidate!.id);
  assert.equal(run.source.candidateCommit, f.secondC); assert.equal(run.source.checkedCommit, f.secondM);
  assert.notEqual(f.secondC, f.secondM); assert.notEqual(run.source.sha256, f.oldSource.sha256);
  assert.deepEqual(run.quality, { platforms: ['macos'], workflows: [{ id: 'compose', platform: 'macos' }, { id: 'search', platform: 'macos' }], referenceIds: ['enough-ui'] });
  assert.deepEqual(run.quality, inspectionGoalQuality(f.store, f.goal.id));
  assert.deepEqual(f.store.list<Attempt>('attempts'), before, 'Verification never allocates or reopens an author attempt.');
  assert.deepEqual(f.store.get('inspection-quality-reports', f.oldReport.id), f.oldReport, 'Historical evidence and its failed criteria remain intact.');
});

test('dirty canonical source cannot be relabeled with HEAD or dispatched for final verification', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  for (const root of [f.canonicalPath, f.workdir]) await writeFile(path.join(root, 'Mail.swift'), 'let screen = "Unsaved edit"\n');
  const checked = await f.review();
  assert.equal(checked.ready, false); assert.match(checked.reason!, /uncommitted changes|working tree/);
  assert.equal(f.store.list('inspection-verifier-runs').length, 0);
  assert.equal(f.store.list('inspection-quality-equivalences').length, 0);
  assert.equal(f.store.get<Attempt>('attempts', f.second.attempt.id)!.status, 'succeeded');
});

test('a missing native capability waits under the same final verifier key across fresh captures', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.review();
  const original = f.store.list<InspectionVerificationRun>('inspection-verifier-runs')[0]!;
  const retained = f.store.get<{ transfer: { sourceManifest: { id: string } }; snapshot: { path: string } }>('inspection-verifier-inputs', original.id)!;
  assert.equal(original.status, 'waiting'); assert.match(original.reason!, /ready|capability|available|target/i);
  assert.equal(original.id, inspectionVerificationKey(original));
  const second = await f.review();
  assert.equal(second.ready, false);
  const runs = f.store.list<InspectionVerificationRun>('inspection-verifier-runs'); assert.equal(runs.length, 1);
  assert.equal(runs[0]!.id, original.id); assert.equal(runs[0]!.source.snapshotId, original.source.snapshotId);
  const recovered = f.store.get<typeof retained>('inspection-verifier-inputs', original.id)!;
  assert.equal(recovered.transfer.sourceManifest.id, retained.transfer.sourceManifest.id);
  assert.equal(recovered.snapshot.path, retained.snapshot.path);
  assert.equal(f.store.list<Attempt>('attempts').length, 2);
  assert.equal(f.store.list('chats').length, 1, 'A setup wait creates no provider process or author replacement.');
});

test('an absent accepted integration identity produces an actionable wait rather than invented commits', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  for (const owner of [f.first, f.second]) f.store.set('factory-attempt-details', { ...owner.detail, integration: undefined });
  const checked = await f.review();
  assert.equal(checked.ready, false); assert.match(checked.reason!, /retained accepted candidate|integration record/);
  assert.equal(f.store.list('inspection-verifier-runs').length, 0);
});
