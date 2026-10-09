import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Attempt, Chat, FactoryTask, Goal, Project, Session, InspectionEvidence, InspectionJob, InspectionVerificationRun } from '@enoughfactory/contracts';
import type { AttemptDetail } from '@enoughfactory/factory';
import type { ArtifactManifest, ArtifactStore } from '@enoughfactory/workspaces';
import type { ChatEventPrefix, Store } from './store.ts';
import type { InspectionSourceRetention } from './inspection-retention.ts';
import { controllerRecords } from './controller-context.ts';
import { inspectionAcceptanceContractSha256 } from './inspection-verification-identity.ts';
import type { InspectionQualityService } from './inspection-quality.ts';

type Kind = 'inspection' | 'attempt' | 'candidate-diff' | 'goal-check' | 'quality-report' | 'author-trace' | 'source-manifest' | 'author-retirement';
interface AuthorOwner { goalId: string; taskId: string; attemptId: string; authorityGeneration: number; assignmentGoalRevision: number; deviceId: string; chatId: string; sessionId: string; workspaceId: string; workspacePath: string; projectId: string; completedAt: string; }
interface Entry { kind: Kind; id: string; taskId?: string; attemptId?: string; source?: unknown; artifact?: ArtifactManifest; bytes?: string; evidence?: InspectionEvidence; job?: InspectionJob; author?: AuthorOwner; prefix?: ChatEventPrefix; retention?: InspectionSourceRetention; unavailable?: string; }
interface Options { store: Store; artifacts: ArtifactStore; current: () => Promise<{ run: InspectionVerificationRun } | undefined>; qualityReports: Pick<InspectionQualityService, 'controllerReport'>; }
const text = (value: unknown) => ({ type: 'text' as const, text: JSON.stringify(value) });

/** Historical context is deliberately outside the current inspection evidence/delivery ledger. */
export class InspectionVerificationHistory {
  constructor(private options: Options) {}
  private async current() {
    const current = await this.options.current(), run = current?.run;
    if (!run || run.status !== 'running' || !run.chatId || !run.acceptanceContract) throw new Error('Historical reads require the current independent verifier conversation and original contract.');
    const saved = this.options.store.get<InspectionVerificationRun>('inspection-verifier-runs', run.id);
    if (!saved || saved.chatId !== run.chatId || saved.sessionId !== run.sessionId || saved.status !== 'running' || !isDeepStrictEqual(saved.authority, run.authority) || !isDeepStrictEqual(saved.source, run.source) || !isDeepStrictEqual(saved.acceptanceContract, run.acceptanceContract)) throw new Error('The historical verifier owner or acceptance contract changed.');
    this.entries(run);
    return run;
  }
  private entries(run: InspectionVerificationRun): Entry[] {
    const contract = run.acceptanceContract!, goalId = run.authority.goalId;
    const selections = [{ taskId: run.authority.taskId, attemptId: run.authority.attemptId, authorityGeneration: run.authority.authorityGeneration, assignmentGoalRevision: run.authority.goalRevision, contract: contract.task }, ...(contract.goal?.taskContracts ?? [])];
    const allowed = new Map<string, { detail: AttemptDetail; taskId: string; generation: number; revision: number }>();
    for (const selected of selections) {
      const task = this.options.store.get<FactoryTask>('tasks', selected.taskId), attempt = this.options.store.get<Attempt>('attempts', selected.attemptId), detail = this.options.store.get<AttemptDetail>('factory-attempt-details', selected.attemptId);
      if (!task || task.goalId !== goalId || task.currentAttemptId !== selected.attemptId || !attempt || attempt.taskId !== task.id || attempt.generation !== selected.authorityGeneration || !detail || detail.id !== attempt.id || detail.goalId !== goalId || (detail.assignmentGoalRevision ?? detail.goalRevision) !== selected.assignmentGoalRevision || !isDeepStrictEqual(detail.contract, selected.contract)) throw new Error('An original historical task/attempt contract no longer matches its verifier scope.');
      if (selected.attemptId === run.authority.attemptId && (run.source.candidateId && detail.candidate?.id !== run.source.candidateId || run.source.candidateCommit && detail.candidate?.commit !== run.source.candidateCommit)) throw new Error('Historical source does not match the original verifier candidate.');
      if (selected.attemptId !== run.authority.attemptId && (task.status !== 'completed' || task.currentAttemptId !== attempt.id || attempt.status !== 'succeeded' || !detail.integration || detail.integration.candidateCommit !== detail.candidate?.commit)) throw new Error('An accepted historical task was retired.');
      allowed.set(attempt.id, { detail, taskId: task.id, generation: attempt.generation, revision: selected.assignmentGoalRevision });
    }
    const matches = (a: InspectionJob['authority']) => { const original = allowed.get(a.attemptId); return !!original && a.goalId === goalId && a.taskId === original.taskId && a.authorityGeneration === original.generation && a.goalRevision === original.revision && a.policyRevision === original.revision; };
    const jobs = this.options.store.list<InspectionJob>('inspection-jobs').filter(job => matches(job.authority));
    const byJob = new Map(jobs.map(job => [job.id, job]));
    const entries: Entry[] = this.options.store.list<InspectionEvidence>('inspection-evidence').flatMap(evidence => {
      const job = byJob.get(evidence.jobId);
      return job && isDeepStrictEqual(evidence.authority, job.authority) && isDeepStrictEqual(evidence.source, job.source) ? [{ kind: 'inspection' as const, id: evidence.id, taskId: evidence.authority.taskId, attemptId: evidence.authority.attemptId, source: evidence.source, artifact: evidence.artifact, evidence, job }] : [];
    });
    for (const record of controllerRecords(this.options.store, goalId, contract.goal?.revision)) {
      if (record.attemptId && allowed.has(record.attemptId) && (record.record === `attempts/${record.attemptId}` || record.record === `factory-attempt-details/${record.attemptId}`)) entries.push({ kind: 'attempt', id: record.record, taskId: record.taskId, attemptId: record.attemptId, source: record.candidate, bytes: record.bytes });
      else if (record.record.startsWith('factory-goal-checks/')) entries.push({ kind: 'goal-check', id: record.record, bytes: record.bytes });
    }
    for (const [attemptId, original] of allowed) {
      let author: AuthorOwner | undefined, unavailable: string | undefined;
      try { author = this.authorOwner(original.detail); }
      catch (error) { unavailable = error instanceof Error ? error.message : String(error); }
      entries.push({ kind: 'author-trace', id: attemptId, taskId: original.taskId, attemptId, author, unavailable });
      try { if (!author) throw new Error(unavailable); entries.push({ kind: 'author-retirement', id: attemptId, taskId: original.taskId, attemptId, author, bytes: JSON.stringify(this.authorRetirement(author)) }); }
      catch (error) { entries.push({ kind: 'author-retirement', id: attemptId, taskId: original.taskId, attemptId, unavailable: error instanceof Error ? error.message : String(error) }); }
      const candidate = original.detail.candidate;
      if (!candidate) continue;
      const diff = candidate.diffArtifact as ArtifactManifest | undefined;
      if (diff && diff.goalId === goalId && diff.taskId === original.taskId && diff.attemptId === attemptId && diff.metadata?.commit === candidate.commit && diff.metadata.baseCommit === candidate.baseCommit) entries.push({ kind: 'candidate-diff', id: diff.id, taskId: original.taskId, attemptId, source: { candidateId: candidate.id, candidateCommit: candidate.commit, baseCommit: candidate.baseCommit }, artifact: diff });
    }
    for (const job of jobs) {
      const retention = this.options.store.get<InspectionSourceRetention>('inspection-source-retention', job.source.snapshotId);
      if (retention?.version === 1 && retention.id === job.source.snapshotId && retention.sourceDigest === job.source.sha256 && isDeepStrictEqual(retention.authority, job.authority) && retention.transfer.snapshotId === retention.id && retention.transfer.sourceDigest === retention.sourceDigest && !entries.some(entry => entry.kind === 'source-manifest' && entry.id === retention.transfer.sourceManifest.id)) entries.push({ kind: 'source-manifest', id: retention.transfer.sourceManifest.id, taskId: job.authority.taskId, attemptId: job.authority.attemptId, source: job.source, artifact: retention.transfer.sourceManifest, retention, job });
    }
    for (const report of this.options.store.list<{ id: string; authority: InspectionJob['authority']; source: unknown; reportArtifact: ArtifactManifest }>('inspection-quality-reports')) if (matches(report.authority)) entries.push({ kind: 'quality-report', id: report.id, taskId: report.authority.taskId, attemptId: report.authority.attemptId, source: report.source, artifact: report.reportArtifact });
    return entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  }
  private authorOwner(detail: AttemptDetail): AuthorOwner {
    const attempt = this.options.store.get<Attempt>('attempts', detail.id), workspace = detail.workspace, result = detail.result;
    const chat = attempt?.chatId && this.options.store.get<Chat>('chats', attempt.chatId), session = attempt?.sessionId && this.options.store.get<Session>('sessions', attempt.sessionId);
    const project = session && this.options.store.get<Project>('projects', session.projectId), goal = this.options.store.get<Goal>('goals', detail.goalId);
    const completed = chat && this.options.store.get<{ id: string; attemptId?: string; completedAt: string; result: { stopReason?: string; text: string; threadId?: string } }>('chat-results', chat.id);
    if (!attempt || !workspace || !result || result.status !== 'succeeded' || !chat || !session || !project || !goal || !completed || completed.id !== chat.id || completed.attemptId !== attempt.id || completed.result.stopReason !== 'completed' || completed.result.text !== result.text || !Number.isFinite(Date.parse(completed.completedAt))
      || chat.verificationRunId || session.verificationRunId || chat.attemptId !== attempt.id || chat.sessionId !== session.id || chat.id !== result.chatId || session.id !== result.sessionId || workspace.sessionId !== session.id
      || workspace.id !== attempt.id || workspace.attemptId !== attempt.id || workspace.taskId !== attempt.taskId || workspace.goalId !== goal.id || project.internal !== true || project.sourceProjectId !== goal.projectId || project.path !== workspace.path
      || [chat.deviceId, session.deviceId, project.deviceId, workspace.deviceId].some(device => device !== attempt.deviceId) || completed.result.threadId !== chat.threadId) throw new Error('The original completed author chat/session/workspace ownership is unavailable or changed.');
    return { goalId: goal.id, taskId: attempt.taskId, attemptId: attempt.id, authorityGeneration: attempt.generation, assignmentGoalRevision: detail.assignmentGoalRevision ?? detail.goalRevision, deviceId: attempt.deviceId, chatId: chat.id, sessionId: session.id, workspaceId: workspace.id, workspacePath: workspace.path, projectId: project.id, completedAt: completed.completedAt };
  }
  private authorRetirement(author: AuthorOwner) {
    type Receipt = Awaited<ReturnType<typeof import('./factory-container-retirement.ts').retireStoppedFactoryContainer>>;
    const session = this.options.store.get<Session>('sessions', author.sessionId)!;
    const retired = this.options.store.get<{ id: string; name: string; containerId: string; status: string; updatedAt: string; receipt?: Receipt }>('session-container-retirement', author.sessionId);
    const receipt = retired?.receipt;
    if (!retired || !receipt || receipt.version !== 2 || retired.status !== 'removed' || receipt.status !== 'removed' || session.status !== 'stopped' || retired.id !== author.sessionId || receipt.identity.sessionId !== author.sessionId || receipt.identity.projectPath !== author.workspacePath || receipt.identity.sessionName !== session.name || receipt.identity.branch !== session.branch || receipt.identity.name !== retired.name || receipt.identity.container !== session.containerId || receipt.containerId !== retired.containerId || !/^[a-f0-9]{64}$/.test(receipt.containerId) || !Number.isFinite(Date.parse(retired.updatedAt))) throw new Error('A positively owned original author retirement receipt is unavailable.');
    const fingerprint = receipt.fingerprint as { container?: { id: string; name: string; state: { Running: boolean; Paused: boolean; Restarting: boolean; Dead: boolean; Pid: number; Status: string }; labels: Record<string, string> } };
    const container = fingerprint.container, identity = receipt.identity;
    if (!container || container.id !== receipt.containerId || container.name !== `/${identity.name}` || container.state.Running || container.state.Paused || container.state.Restarting || container.state.Dead || container.state.Pid !== 0 || !['exited', 'created'].includes(container.state.Status)
      || !isDeepStrictEqual(container.labels, { schema: '2', kind: 'session', instance: identity.name, project: identity.project, session: identity.sessionName, directory: identity.projectPath, branch: identity.branch, workdir: identity.workdir }) || !receipt.ownedVolumes.length || receipt.ownedVolumes.some(volume => volume.status !== 'removed' || volume.identity.Name !== volume.name || !['home', 'work'].some(role => volume.name === `${identity.name}-${role}`))) throw new Error('The original author retirement fingerprint is incomplete or foreign.');
    return { originalOwner: author, originalSession: session, originalRetirement: retired, limits: 'This records owned environment retirement, not unrecorded write absence or a particular server shutdown mechanism.' };
  }
  private async artifact(entry: Entry) {
    const original = entry.artifact!;
    const manifest = await this.options.artifacts.get(original.id);
    if (!isDeepStrictEqual(manifest, original) || entry.evidence && manifest.goalId !== entry.evidence.authority.goalId || entry.attemptId && manifest.attemptId !== entry.attemptId || entry.taskId && manifest.taskId !== entry.taskId) throw new Error('The historical artifact manifest or original owner changed.');
    return { manifest, bytes: await this.options.artifacts.read(manifest) };
  }
  async call(name: string, args: Record<string, unknown>) {
    const run = await this.current(), entries = this.entries(run), digest = inspectionAcceptanceContractSha256(run.acceptanceContract!);
    const base = { historical: true, acceptanceUse: 'context-only', verificationRunId: run.id, chatId: run.chatId, acceptanceContractSha256: digest, checkedSource: run.source };
    if (name === 'factory_verification_history') {
      const offset = args.offset ?? 0, limit = args.limit ?? 24;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > entries.length || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 24) throw new Error('Select a bounded historical index range.');
      await this.current();if (!isDeepStrictEqual(this.entries(run), entries)) throw new Error('The original historical index changed during its read.');
      return { content: [text({ ...base, offset, nextOffset: Math.min(entries.length, Number(offset) + Number(limit)), total: entries.length, items: entries.slice(Number(offset), Number(offset) + Number(limit)).map(({ bytes: _bytes, evidence, job, retention: _retention, ...entry }) => ({ ...entry, ...(job ? { originalAuthority: job.authority, jobId: job.id, jobCreatedAt: job.createdAt } : {}), ...(evidence ? { evidenceKind: evidence.kind, sessionId: evidence.sessionId, createdAt: evidence.createdAt } : {}) })) })] };
    }
    const entry = entries.find(entry => entry.id === (name === 'factory_verification_image' ? args.evidenceId : args.id) && (name === 'factory_verification_image' ? entry.kind === 'inspection' : entry.kind === args.kind));
    if (!entry) throw new Error('This original evidence is not retained in the verifier’s same-goal task scope.');
    if (entry.unavailable) throw new Error(entry.unavailable);
    if (name === 'factory_verification_image') {
      if (entry.evidence?.kind !== 'screenshot' || !entry.artifact?.mime.startsWith('image/') || entry.artifact.size > 8 * 1024 * 1024) throw new Error('Choose a bounded original historical screenshot.');
      const { manifest, bytes } = await this.artifact(entry); await this.current();
      this.options.store.set('inspection-verification-history-views', { id: randomUUID(), ...base, kind: 'image', evidenceId: entry.id, originalSource: entry.source, originalAuthority: entry.evidence.authority, jobId: entry.job!.id, artifact: manifest, viewedAt: new Date().toISOString() });
      return { content: [text({ ...base, evidenceId: entry.id, originalSource: entry.source, originalAuthority: entry.evidence.authority, jobId: entry.job!.id, artifact: manifest, metadata: entry.evidence.metadata }), { type: 'image', mimeType: manifest.mime, data: bytes.toString('base64') }] };
    }
    if (name !== 'factory_verification_evidence') throw new Error('Unsupported historical verification tool.');
    let content = entry.bytes, tracePrefix: ChatEventPrefix | undefined, tracePage: { eventCursor: number; nextEventCursor: number; complete: boolean } | undefined;
    if (entry.kind === 'author-trace') {
      const eventCursor = Number(args.eventCursor ?? 0), eventLimit = Number(args.eventLimit ?? 32);
      if (typeof (args.eventCursor ?? 0) !== 'number' || typeof (args.eventLimit ?? 32) !== 'number') throw new Error('Select an original tool-event cursor and 1–32 events.');
      tracePrefix = this.options.store.chatEventPrefix(entry.author!.chatId, entry.author!.completedAt);
      const page = this.options.store.chatToolEventPage(entry.author!.chatId, eventCursor, tracePrefix.throughSeq, eventLimit);
      const anchorId = `${run.id}/${entry.attemptId}/author-trace-prefix`, anchor = this.options.store.get<{ id: string; prefix: ChatEventPrefix; author: AuthorOwner; acceptanceContractSha256: string }>('inspection-verification-history-views', anchorId);
      if (anchor && (!isDeepStrictEqual(anchor.prefix, tracePrefix) || !isDeepStrictEqual(anchor.author, entry.author) || anchor.acceptanceContractSha256 !== digest)) throw new Error('The original author journal prefix changed after its historical read.');
      tracePage = { eventCursor, nextEventCursor: page.nextEventCursor, complete: page.complete };
      content = JSON.stringify({ originalOwner: entry.author, prefix: tracePrefix, eventCursor, ...page, limits: 'complete marks only the end of this event-page sequence. Read every page starting at eventCursor 0. Original recorded tool events only; failures remain failures and unrecorded or transient write absence is not proven.' });
    }
    else if (entry.kind === 'quality-report') content = (await this.options.qualityReports.controllerReport({ goalId: run.authority.goalId, reportId: entry.id })).original;
    else if (entry.artifact) {
      if (entry.artifact.mime.startsWith('image/') && entry.artifact.size > 8 * 1024 * 1024) throw new Error('Choose a bounded original historical screenshot record.');
      const { manifest, bytes } = await this.artifact(entry);
      const image = manifest.mime.startsWith('image/');
      if (image && entry.kind !== 'inspection') throw new Error('Use factory_verification_image to view original historical pixels.');
      if (!image && bytes.length > 2 * 1024 * 1024) throw new Error('The original historical text is unavailable within its read bound.');
      if (entry.kind === 'source-manifest') {
        const pack = JSON.parse(bytes.toString('utf8')), retention = entry.retention!, source = entry.job!.source;
        if (pack.version !== 1 || pack.purpose !== 'inspection-snapshot-transfer' || pack.snapshot?.id !== source.snapshotId || pack.snapshot.sourceDigest !== source.sha256 || !Number.isFinite(Date.parse(pack.snapshot.createdAt)) || manifest.metadata?.purpose !== pack.purpose || manifest.metadata?.snapshotId !== source.snapshotId || manifest.metadata?.sourceDigest !== source.sha256 || manifest.metadata?.previewOnly !== true || !isDeepStrictEqual(pack.sourceArtifacts, retention.transfer.sourceArtifacts) || !Array.isArray(pack.snapshot.roots) || pack.snapshot.roots.length !== pack.sourceArtifacts.length
          || !isDeepStrictEqual(pack.snapshot.roots.map((root: { id: string; sourceDigest: string; commit: string }) => ({ id: root.id, sha256: root.sourceDigest, commit: root.commit })), source.roots)) throw new Error('The original source transfer manifest does not match its captured source.');
        for (const rootArtifact of retention.transfer.sourceArtifacts) {
          const saved = await this.options.artifacts.get(rootArtifact.manifest.id);
          if (!isDeepStrictEqual(saved, rootArtifact.manifest) || saved.goalId !== run.authority.goalId || saved.taskId !== entry.taskId || saved.attemptId !== entry.attemptId || saved.metadata?.snapshotId !== source.snapshotId || saved.metadata.rootId !== rootArtifact.rootId) throw new Error('The original captured root manifest or owner changed.');
          await this.options.artifacts.path(saved);
        }
        content = bytes.toString('utf8');
      }
      else if (entry.kind === 'inspection') {
        const observation = this.options.store.list<{ id: string; screenshotEvidenceId?: string }>('inspection-observations').find(value => value.screenshotEvidenceId === entry.id || value.id === entry.evidence!.metadata?.observationId);
        content = JSON.stringify({ evidence: entry.evidence, job: entry.job, session: entry.evidence!.sessionId && this.options.store.get('inspection-sessions', entry.evidence!.sessionId), actions: this.options.store.list<{ id: string; jobId: string }>('inspection-actions').filter(action => action.jobId === entry.job!.id), observation,
          ...(image ? { originalPixelsTool: 'factory_verification_image' } : { original: bytes.toString('utf8') }) });
      } else content = bytes.toString('utf8');
    }
    if (content === undefined) throw new Error('Original historical bytes are unavailable.');
    if(Buffer.byteLength(content)>4*1024*1024)throw new Error('The original historical record exceeds its complete bounded read limit.');
    const offset = args.offset, maximum = args.maxCharacters;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > content.length || !Number.isSafeInteger(maximum) || Number(maximum) < 1 || Number(maximum) > 16000) throw new Error('Read an original historical range using offset and 1–16000 characters.');
    const part = content.slice(Number(offset), Number(offset) + Number(maximum)), contentSha256 = createHash('sha256').update(content).digest('hex');
    await this.current();
    if (['author-trace', 'source-manifest', 'author-retirement'].includes(entry.kind)) {
      const currentEntry = this.entries(run).find(value => value.kind === entry.kind && value.id === entry.id);
      if (!currentEntry || currentEntry.unavailable || !isDeepStrictEqual(currentEntry, entry)) throw new Error('The original historical owner, prefix or captured source changed during its read.');
    }
    if (tracePrefix && !isDeepStrictEqual(this.options.store.chatEventPrefix(entry.author!.chatId, entry.author!.completedAt), tracePrefix)) throw new Error('The original author journal prefix changed during its historical read.');
    if (tracePrefix) this.options.store.set('inspection-verification-history-views', { id: `${run.id}/${entry.attemptId}/author-trace-prefix`, ...base, kind: 'author-trace-prefix', prefix: tracePrefix, author: entry.author });
    const receipt = { id: randomUUID(), ...base, kind: entry.kind, evidenceId: entry.id, originalSource: entry.source, originalOwner: entry.author, prefix: tracePrefix, eventPage: tracePage, artifact: entry.artifact, contentSha256, offset, nextOffset: Number(offset) + part.length, viewedAt: new Date().toISOString() };
    this.options.store.set('inspection-verification-history-views', receipt);
    return { content: [text({ ...base, kind: entry.kind, id: entry.id, originalSource: entry.source, artifact: entry.artifact, contentSha256, totalCharacters: content.length, offset, nextOffset: Number(offset) + part.length, original: part })] };
  }
  acknowledgeImage(input: { run: InspectionVerificationRun; chatId: string; sha256: string; server?: string; tool?: string; eventId: string; mimeType: string; byteLength: number }) {
    const saved=this.options.store.get<InspectionVerificationRun>('inspection-verifier-runs',input.run.id);
    if(!saved||saved.status!=='running'||saved.chatId!==input.chatId||!isDeepStrictEqual(saved.authority,input.run.authority)||!isDeepStrictEqual(saved.source,input.run.source)||!isDeepStrictEqual(saved.acceptanceContract,input.run.acceptanceContract))throw new Error('The historical image verifier owner changed.');
    const views = this.options.store.list<{ id: string; kind: string; verificationRunId: string; chatId: string; acceptanceContractSha256: string; artifact?: ArtifactManifest; evidenceId?: string }>('inspection-verification-history-views').filter(view => view.kind === 'image' && view.verificationRunId === input.run.id && view.chatId === input.chatId && view.acceptanceContractSha256 === inspectionAcceptanceContractSha256(input.run.acceptanceContract!) && view.artifact?.sha256 === input.sha256);
    if (input.tool === 'factory_verification_image') {
      if (input.server !== 'factory' || !views.length) throw new Error('The historical image has no positive original tool/view provenance.');
      const view = views.at(-1)!;
      const original=this.entries(input.run).find(entry=>entry.kind==='inspection'&&entry.id===view.evidenceId&&entry.evidence?.kind==='screenshot'&&isDeepStrictEqual(entry.artifact,view.artifact));
      if(!original)throw new Error('The historical image original scope or immutable manifest changed.');
      if (view.artifact!.mime !== input.mimeType || view.artifact!.size !== input.byteLength) throw new Error('Historical image bytes do not match their original artifact.');
      this.options.store.set('inspection-verification-history-image-deliveries', { id: randomUUID(), verificationRunId: input.run.id, chatId: input.chatId, acceptanceContractSha256: view.acceptanceContractSha256, evidenceId: view.evidenceId, artifactSha256: input.sha256, eventId: input.eventId, historical: true });
      return view.artifact;
    }
    if (input.server !== 'factory' || !['factory_observe', 'factory_browser_call', 'factory_reference'].includes(input.tool ?? '')) throw new Error('An ambiguous historical image cannot establish current inspection delivery.');
    return undefined;
  }
}
