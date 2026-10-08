import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { InspectionAction, InspectionAuthority, InspectionEvidence, InspectionJob, InspectionSourceIdentity, TaskQualityRequirements } from '@enoughfactory/contracts';
import { UI_QUALITY_CHECK_COMMAND, type CheckResult } from '@enoughfactory/factory';
import type { ArtifactManifest, ArtifactStore } from '@enoughfactory/workspaces';
import type { Store } from './store.ts';
import type { InspectionObservation } from './inspection-jobs.ts';
import { factoryQualityEvidenceContext, parseQualityEvidenceReport, validateQualityEvidence, type QualityEvidenceReport, type QualityEvidenceResolver, type QualityGateResult, type QualityObservationReceipt, type QualityPlatform } from './factory-quality.ts';

type QualityStore = Pick<Store, 'get' | 'set' | 'list' | 'events' | 'append' | 'transaction'>;
export interface InspectionImageDelivery {
  id: string; chatId: string; eventId: string; artifactSha256: string;
  authority: InspectionAuthority; route: 'tool-image' | 'image-input' | 'image-view';
}
/** Written by the reference tool after returning the original reference content. */
export interface InspectionReferenceView {
  id: string; referenceId: string; authority: InspectionAuthority;
  source: InspectionSourceIdentity; artifacts?: ArtifactManifest[]; artifactIds?: string[]; inspectedAt: string;
}
export interface InspectionQualityRecord {
  id: string; authority: InspectionAuthority; quality: TaskQualityRequirements;
  source: InspectionSourceIdentity; reportArtifact: ArtifactManifest;
  gate: QualityGateResult; createdAt: string; sequence: number;
}
export interface InspectionQualityEquivalence {
  id: string; reportId: string; authority: InspectionAuthority;
  testedSource: InspectionSourceIdentity; checkedSource: InspectionSourceIdentity;
  candidateCommit: string; checkedCommit: string; createdAt: string;
  basis: 'exact-source-digest-and-all-root-digests';
}
export interface ControllerInspectionImageDelivery {
  id: string; controllerRunId: string; goalId: string; goalRevision: number;
  chatId: string; eventId: string; artifactSha256: string;
}
export interface ControllerInspectionReferenceView {
  id: string; controllerRunId: string; goalId: string;
  source: InspectionSourceIdentity; referenceId: string; artifacts: ArtifactManifest[];
}
export interface ControllerInspectionEvidenceView {
  id: string; controllerRunId: string; goalId: string; evidenceId: string;
  source: InspectionSourceIdentity; artifact: ArtifactManifest; viewedAt: string;
}
export interface InspectionReviewCheckResult { ready: boolean; reason?: string; evidenceIds: string[]; }
export type InspectionQualityCheckResult = CheckResult & { recovery?: { condition: 'inspection-evidence'; reason: string } };
const B = { reports: 'inspection-quality-reports', equivalences: 'inspection-quality-equivalences', evidence: 'inspection-evidence', observations: 'inspection-observations', actions: 'inspection-actions', jobs: 'inspection-jobs', deliveries: 'provider-image-deliveries', references: 'inspection-reference-views' } as const;
const platform = (value: unknown): value is QualityPlatform => value === 'web' || value === 'macos' || value === 'ios-simulator';
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const delivered = (value: InspectionImageDelivery, authority: InspectionAuthority, digest: string): boolean => value.artifactSha256 === digest
  && isDeepStrictEqual(value.authority, authority) && typeof value.chatId === 'string' && !!value.chatId.trim()
  && typeof value.eventId === 'string' && !!value.eventId.trim() && ['tool-image', 'image-input', 'image-view'].includes(value.route);

/** Explicit content equivalence, never an assertion that two Git commits are the same identity. */
export function inspectionSourceContentMatches(tested: InspectionSourceIdentity, checked: InspectionSourceIdentity): boolean {
  if (!tested || !checked || !sha(tested.sha256) || tested.sha256 !== checked.sha256) return false;
  if ([tested, checked].some(source => source.roots !== undefined && (!Array.isArray(source.roots) || source.roots.some(root => !root || typeof root.id !== 'string' || !root.id || !sha(root.sha256))))) return false;
  const roots = (source: InspectionSourceIdentity) => (source.roots ?? []).map(root => ({ id: root.id, sha256: root.sha256 })).sort((a, b) => a.id.localeCompare(b.id));
  const left = roots(tested), right = roots(checked);
  if (left.some(root => !root.id || !sha(root.sha256)) || new Set(left.map(root => root.id)).size !== left.length
    || right.some(root => !root.id || !sha(root.sha256)) || new Set(right.map(root => root.id)).size !== right.length) return false;
  return isDeepStrictEqual(left, right);
}

/** Service-owned provenance adapter. Authored report data can never create inspection receipts. */
export class InspectionQualityService {
  constructor(private readonly options: {
    store: QualityStore;
    artifacts: Pick<ArtifactStore, 'get' | 'path' | 'read' | 'put'>;
    authorityCurrent: (authority: InspectionAuthority) => boolean;
    now?: () => string;
  }) {}
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
  private assertCurrent(authority: InspectionAuthority): void {
    if (!this.options.authorityCurrent(authority)) throw new Error('Quality submission belongs to stale inspection authority.');
  }

  async submit(input: { authority: InspectionAuthority; quality: TaskQualityRequirements; report: unknown }): Promise<InspectionQualityRecord> {
    this.assertCurrent(input.authority);
    const report = parseQualityEvidenceReport(input.report);
    const quality = structuredClone(input.quality), authority = structuredClone(input.authority);
    const gate = await this.validate(report, authority, quality);
    this.assertCurrent(authority);
    const reportArtifact = await this.options.artifacts.put(JSON.stringify(report), { name: 'app-quality-review.json', mime: 'application/json', goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId, metadata: { source: report.source, gateStatus: gate.status } });
    this.assertCurrent(authority);
    return this.options.store.transaction(() => {
      this.assertCurrent(authority);
      const id = randomUUID(), createdAt = this.now();
      const next = this.options.store.append('inspection-journal', id, { kind: 'quality-submitted', at: createdAt, value: { authority, reportArtifactId: reportArtifact.id, gateStatus: gate.status } });
      const record: InspectionQualityRecord = { id, authority, quality, source: report.source, reportArtifact, gate, createdAt, sequence: next };
      this.options.store.set(B.reports, record); this.options.store.set('artifacts', reportArtifact);
      return record;
    });
  }

  /** Revalidate original evidence and exact current content on every candidate/integration check. */
  async check(input: {
    authority: InspectionAuthority; quality: TaskQualityRequirements; source: InspectionSourceIdentity;
    candidateCommit: string; checkedCommit?: string;
  }): Promise<InspectionQualityCheckResult> {
    this.assertCurrent(input.authority);
    const reports = this.options.store.list<InspectionQualityRecord>(B.reports).filter(record => isDeepStrictEqual(record.authority, input.authority)
      && isDeepStrictEqual(record.quality, input.quality) && inspectionSourceContentMatches(record.source, input.source)).sort((a, b) => b.sequence - a.sequence);
    const record = reports[0];
    const base = { command: UI_QUALITY_CHECK_COMMAND, candidateCommit: input.candidateCommit, checkedCommit: input.checkedCommit ?? input.candidateCommit };
    if (!record) {
      const reason = 'Current-source app quality evidence is missing. Open the app through its inspection tools, view the screenshots, verify the required workflows and submit the visual review.';
      return { ...base, passed: false, exitCode: 1, output: reason, recovery: { condition: 'inspection-evidence', reason } };
    }
    const ledger = this.ledgerFingerprint(input.authority);
    let report: QualityEvidenceReport;
    try {
      const manifest = await this.options.artifacts.get(record.reportArtifact.id);
      if (!isDeepStrictEqual(manifest, record.reportArtifact)) throw new Error('Quality report manifest changed.');
      report = parseQualityEvidenceReport(JSON.parse((await this.options.artifacts.read(manifest)).toString('utf8')));
      if (!isDeepStrictEqual(report.source, record.source)) throw new Error('Quality report source changed.');
    } catch {
      const reason = `Quality report ${record.id} is unavailable or failed retained artifact verification. Inspect again or restore the original evidence.`;
      return { ...base, passed: false, exitCode: 1, output: reason, recovery: { condition: 'inspection-evidence', reason } };
    }
    const gate = await this.validate(report, input.authority, input.quality);
    this.assertCurrent(input.authority);
    if (this.ledgerFingerprint(input.authority) !== ledger) {
      const reason = 'Inspection evidence changed during quality verification. Verify the latest recorded outcomes before accepting this source.';
      return { ...base, passed: false, exitCode: 1, output: reason, recovery: { condition: 'inspection-evidence', reason } };
    }
    const equivalence: InspectionQualityEquivalence = { id: randomUUID(), reportId: record.id, authority: input.authority, testedSource: record.source, checkedSource: input.source, candidateCommit: input.candidateCommit, checkedCommit: base.checkedCommit, createdAt: this.now(), basis: 'exact-source-digest-and-all-root-digests' };
    this.options.store.transaction(() => {
      this.assertCurrent(input.authority);
      this.options.store.set(B.equivalences, equivalence);
      this.options.store.append('inspection-journal', equivalence.id, { kind: 'quality-checked', at: equivalence.createdAt, value: { reportId: record.id, gateStatus: gate.status, candidateCommit: input.candidateCommit, checkedCommit: base.checkedCommit } });
    });
    return { ...base, passed: gate.status === 'ready-for-review', exitCode: gate.status === 'ready-for-review' ? 0 : 1, output: JSON.stringify({ status: gate.status, issues: gate.issues, evidenceIds: gate.evidenceIds, reportId: record.id, reportArtifactId: record.reportArtifact.id, equivalence }),
      ...(gate.status === 'evidence-required' ? { recovery: { condition: 'inspection-evidence' as const, reason: gate.issues.join(' ') } } : {}) };
  }

  async context(input: { source: InspectionSourceIdentity; authority?: InspectionAuthority; referenceIds?: string[] }): Promise<string> {
    const evidence = this.options.store.list<InspectionEvidence>(B.evidence).filter(record => record.kind === 'screenshot' && isDeepStrictEqual(record.source, input.source) && (!input.authority || isDeepStrictEqual(record.authority, input.authority)));
    const observations: QualityObservationReceipt[] = [], uiTrees: Record<string, string> = {};
    for (const item of evidence.slice(-16)) {
      const receipt = await this.observation(item.id, item.authority, item.source);
      if (!receipt) continue;
      observations.push(receipt);
      const observed = this.options.store.get<InspectionObservation>(B.observations, receipt.observationId);
      if (observed?.uiTree) uiTrees[observed.id] = observed.uiTree;
    }
    return factoryQualityEvidenceContext({ source: input.source, observations, referenceIds: input.referenceIds, uiTrees });
  }

  /** Original report content is bounded and verified before being exposed to a controller. */
  async controllerReport(input: { goalId: string; reportId: string }): Promise<{ record: InspectionQualityRecord; report: QualityEvidenceReport; original: string }> {
    const record = this.options.store.get<InspectionQualityRecord>(B.reports, input.reportId);
    if (!record || record.authority.goalId !== input.goalId) throw new Error('This quality report is not retained for your goal.');
    const manifest = await this.options.artifacts.get(record.reportArtifact.id);
    if (manifest.mime !== 'application/json' || manifest.size > 128 * 1024 || !isDeepStrictEqual(manifest, record.reportArtifact)
      || manifest.goalId !== record.authority.goalId || manifest.taskId !== record.authority.taskId || manifest.attemptId !== record.authority.attemptId) throw new Error('The original quality report manifest changed.');
    const original = (await this.options.artifacts.read(manifest)).toString('utf8');
    const report = parseQualityEvidenceReport(JSON.parse(original));
    if (!isDeepStrictEqual(report.source, record.source)) throw new Error('Quality report source changed.');
    return { record, report, original };
  }

  async controllerReportContext(input: { goalId: string; source: InspectionSourceIdentity }): Promise<{ reports: Array<Record<string, unknown>>; omitted: number }> {
    const records = this.options.store.list<InspectionQualityRecord>(B.reports).filter(record => record.authority.goalId === input.goalId)
      .sort((left, right) => Number(inspectionSourceContentMatches(right.source, input.source)) - Number(inspectionSourceContentMatches(left.source, input.source)) || right.sequence - left.sequence);
    const reports: Array<Record<string, unknown>> = [];
    const policies = new Set<string>();
    let bytes = 0;
    for (const record of records.slice(0, 24)) {
      const policy = JSON.stringify([record.authority, record.quality, record.source.sha256]);
      const base = { id: record.id, taskId: record.authority.taskId, source: record.source, currentSource: inspectionSourceContentMatches(record.source, input.source), currentAuthority: this.options.authorityCurrent(record.authority), latestForPolicy: !policies.has(policy), createdAt: record.createdAt, sequence: record.sequence, reportArtifact: record.reportArtifact };
      policies.add(policy);
      let summary: Record<string, unknown>;
      try {
        const { report } = await this.controllerReport({ goalId: input.goalId, reportId: record.id });
        summary = { ...base, recordedStatus: record.gate.status, quality: record.quality,
          workflows: report.workflows.slice(0, 24).map(workflow => ({ id: workflow.id, platform: workflow.platform, before: workflow.before, action: workflow.action, after: workflow.after, outcome: workflow.outcome, assertionEvidenceId: workflow.assertionEvidenceId, assertion: workflow.assertion.slice(0, 200) })),
          omittedWorkflows: Math.max(0, report.workflows.length - 24), reviews: report.reviews.map(review => ({ platform: review.platform, observations: review.observations, openSeriousDefects: review.defects.filter(defect => defect.status === 'open' && defect.severity !== 'minor').map(defect => ({ id: defect.id, description: defect.description.slice(0, 200) })) })) };
      } catch { summary = { ...base, unavailable: true, reason: 'The original quality report could not be verified. Read or restore the original before accepting it.' }; }
      const length = Buffer.byteLength(JSON.stringify(summary));
      if (bytes + length > 48 * 1024) break;
      reports.push(summary); bytes += length;
    }
    return { reports, omitted: records.length - reports.length };
  }

  /** Independent evaluator viewing is required before a UI goal may claim completion. */
  async reviewCheck(input: {
    goalId: string; controllerRunId: string; source: InspectionSourceIdentity;
    quality: TaskQualityRequirements; review: unknown;
  }): Promise<InspectionReviewCheckResult> {
    const issues: string[] = [], evidenceIds = new Set<string>();
    const controller = this.options.store.get<{ id: string; goalId: string; role: string; status: string; chatId?: string }>('factory-controller-runs', input.controllerRunId);
    const goal = this.options.store.get<{ id: string; revision: number; status: string }>('goals', input.goalId);
    if (!controller || controller.goalId !== input.goalId || controller.role !== 'evaluator' || !['running', 'completed'].includes(controller.status) || !controller.chatId?.trim()
      || !goal || ['canceled', 'completed'].includes(goal.status)) return { ready: false, reason: 'The visual review does not belong to the current goal evaluator.', evidenceIds: [] };
    let parsed: QualityEvidenceReport;
    try {
      if (!input.review || typeof input.review !== 'object' || Array.isArray(input.review)) throw new Error('Missing visualReview.');
      const review = input.review as Record<string, unknown>;
      parsed = parseQualityEvidenceReport({ version: 1, source: review.source, workflows: [], reviews: review.reviews });
      if (!inspectionSourceContentMatches(parsed.source, input.source)) throw new Error('Visual review belongs to a different integrated source.');
    } catch (error) { return { ready: false, reason: `Inspect the current integrated product and return visualReview {source,reviews}: ${(error as Error).message}`, evidenceIds: [] }; }
    const fingerprint = () => {
      const jobs = this.options.store.list<InspectionJob>(B.jobs).filter(record => record.authority.goalId === goal.id);
      const jobIds = new Set(jobs.map(job => job.id)), sessionIds = new Set(jobs.flatMap(job => job.sessionId ? [job.sessionId] : []));
      return createHash('sha256').update(JSON.stringify([
        this.options.store.get('factory-controller-runs', controller.id), this.options.store.get('goals', goal.id),
        this.options.store.list<ControllerInspectionImageDelivery>('controller-image-deliveries').filter(record => record.controllerRunId === controller.id),
        this.options.store.list<ControllerInspectionReferenceView>('controller-reference-views').filter(record => record.controllerRunId === controller.id),
        this.options.store.list<ControllerInspectionEvidenceView>('controller-evidence-views').filter(record => record.controllerRunId === controller.id),
        this.options.store.list<InspectionQualityRecord>(B.reports).filter(record => record.authority.goalId === goal.id),
        this.options.store.list<InspectionEvidence>(B.evidence).filter(record => record.authority.goalId === goal.id), jobs,
        this.options.store.list<InspectionAction>(B.actions).filter(action => jobIds.has(action.jobId)),
        this.options.store.list<InspectionObservation>(B.observations).filter(observation => sessionIds.has(observation.sessionId)),
      ])).digest('hex');
    };
    const ledger = fingerprint();
    const imageSeen = (digest: string) => this.options.store.list<ControllerInspectionImageDelivery>('controller-image-deliveries').some(record => record.controllerRunId === controller.id
      && record.goalId === goal.id && record.goalRevision === goal.revision && record.chatId === controller.chatId && typeof record.eventId === 'string' && !!record.eventId.trim() && record.artifactSha256 === digest);
    for (const review of parsed.reviews) for (const defect of review.defects) {
      if (!review.observations.includes(defect.observation)) issues.push(`Visual defect ${defect.id} lacks its reviewed screenshot.`);
      if (defect.status === 'open' && defect.severity !== 'minor') issues.push(`Repair ${defect.id} before completion: ${defect.description}`);
    }
    // Current accepted authors may each cover only part of the integrated journey.
    // Inspect every latest relevant policy, so an older success or another author's
    // success cannot hide a newer failure on the same integrated source.
    const latest = new Map<string, InspectionQualityRecord>();
    for (const record of this.options.store.list<InspectionQualityRecord>(B.reports).filter(record => record.authority.goalId === goal.id
      && inspectionSourceContentMatches(record.source, input.source) && this.options.authorityCurrent(record.authority)).sort((left, right) => right.sequence - left.sequence)) {
      const key = JSON.stringify([record.authority, record.quality]);
      if (!latest.has(key)) latest.set(key, record);
    }
    const validated = new Map<string, { report: QualityEvidenceReport; gate: QualityGateResult } | undefined>();
    for (const record of latest.values()) {
      if (!record.quality.platforms.some(target => input.quality.platforms.includes(target))) continue;
      try {
        if (!sequence(record.sequence)) throw new Error('Quality report sequence is unavailable.');
        const { report } = await this.controllerReport({ goalId: goal.id, reportId: record.id });
        const gate = await this.validate(report, record.authority, record.quality);
        validated.set(record.id, { report, gate });
        if (gate.status !== 'ready-for-review') issues.push(`Latest current-source quality report ${record.id} is ${gate.status}: ${gate.issues.slice(0, 3).join(' ')}`);
      } catch { validated.set(record.id, undefined); issues.push(`Latest current-source quality report ${record.id} is unavailable or failed original artifact verification.`); }
    }
    for (const target of input.quality.platforms) if (![...latest.values()].some(record => record.quality.platforms.includes(target))) issues.push(`Current integrated ${target} product needs a retained quality report before completion.`);
    for (const required of input.quality.workflows) {
      const records = [...latest.values()].filter(record => record.quality.workflows.some(workflow => workflow.id === required.id && workflow.platform === required.platform));
      if (!records.length) { issues.push(`Current integrated ${required.platform} workflow ${required.id} needs a retained passing quality report.`); continue; }
      for (const record of records) {
        const checked = validated.get(record.id);
        if (!checked || checked.gate.status !== 'ready-for-review') {
          issues.push(`Current integrated ${required.platform} workflow ${required.id} is not verified by latest report ${record.id}${checked?.gate.issues.length ? `: ${checked.gate.issues.slice(0, 3).join(' ')}` : '.'}`);
          continue;
        }
        const workflow = checked.report.workflows.find(workflow => workflow.id === required.id && workflow.platform === required.platform);
        const assertion = workflow?.assertionEvidenceId && this.options.store.get<InspectionEvidence>(B.evidence, workflow.assertionEvidenceId);
        const viewed = assertion && this.options.store.list<ControllerInspectionEvidenceView>('controller-evidence-views').some(view => view.controllerRunId === controller.id && view.goalId === goal.id
          && view.evidenceId === assertion.id && typeof view.viewedAt === 'string' && !!view.viewedAt.trim()
          && inspectionSourceContentMatches(view.source, input.source) && isDeepStrictEqual(view.artifact, assertion.artifact));
        if (!viewed || !assertion) issues.push(`Read original resulting assertion${assertion ? ` ${assertion.id}` : ''} for ${required.platform} workflow ${required.id} through factory_review_evidence in this evaluator.`);
        else evidenceIds.add(assertion.id);
      }
    }
    for (const target of input.quality.platforms) {
      const review = parsed.reviews.find(record => record.platform === target);
      if (!review) { issues.push(`Inspect the integrated ${target} interface and supply its visual review.`); continue; }
      for (const id of review.observations) {
        try {
          const evidence = this.options.store.get<InspectionEvidence>(B.evidence, id);
          if (!evidence || evidence.authority.goalId !== goal.id || !inspectionSourceContentMatches(evidence.source, input.source)) throw new Error('Different source.');
          const observation = await this.observation(id, evidence.authority, evidence.source);
          if (!observation || observation.platform !== target || !imageSeen(evidence.artifact.sha256)) throw new Error('Unseen image.');
          evidenceIds.add(id);
        } catch { issues.push(`View original current-source ${target} screenshot ${id} through this evaluator's image tool before claiming completion.`); }
      }
      for (const referenceId of input.quality.referenceIds) {
        if (!review.references.some(reference => reference.id === referenceId)) { issues.push(`Compare the ${target} interface with inspected reference ${referenceId}.`); continue; }
        const views = this.options.store.list<ControllerInspectionReferenceView>('controller-reference-views').filter(view => view.controllerRunId === controller.id && view.goalId === goal.id
          && view.referenceId === referenceId && inspectionSourceContentMatches(view.source, input.source)).reverse();
        let valid = false;
        for (const view of views) {
          if (!view.artifacts?.length || view.artifacts.length > 16 || new Set(view.artifacts.map(artifact => artifact.id)).size !== view.artifacts.length) continue;
          try {
            for (const original of view.artifacts) {
              const manifest = await this.options.artifacts.get(original.id);
              if (!isDeepStrictEqual(manifest, original) || manifest.goalId !== goal.id) throw new Error('Reference changed.');
              await this.options.artifacts.path(manifest);
              if (manifest.mime.startsWith('image/') && !imageSeen(manifest.sha256)) throw new Error('Reference pixels were not viewed.');
            }
            valid = true; break;
          } catch { /* Later reference inspection can recover from an unavailable older view. */ }
        }
        if (!valid) issues.push(`This evaluator must inspect the original current-source reference ${referenceId} before completion.`);
      }
    }
    if ([...latest.values()].some(record => !this.options.authorityCurrent(record.authority))) issues.push('Workflow inspection authority changed during evaluator verification; review the current accepted attempts before completion.');
    if (fingerprint() !== ledger) issues.push('Inspection evidence changed during evaluator verification; review the latest outcomes before completion.');
    const unique = [...new Set(issues)];
    const reason = unique.slice(0, 12).map(issue => issue.slice(0, 600)).join(' ') + (unique.length > 12 ? ` ${unique.length - 12} additional review gaps remain in the original receipts.` : '');
    return { ready: issues.length === 0, ...(issues.length ? { reason } : {}), evidenceIds: [...evidenceIds] };
  }

  private eventSequence(id: string, kind: string): number | undefined {
    return this.options.store.events<{ kind?: string }>('inspection-journal', id).find(event => event.value.kind === kind)?.seq;
  }
  /** Fence trusted-record changes across asynchronous artifact hashing/peer retrieval. */
  private ledgerFingerprint(authority: InspectionAuthority): string {
    const buckets = [B.reports, B.evidence, B.actions, B.jobs, B.deliveries, B.references];
    const records = buckets.map(bucket => ({ bucket, records: this.options.store.list<{ id: string; authority?: InspectionAuthority }>(bucket).filter(record => isDeepStrictEqual(record.authority, authority)) }));
    const sessionIds = new Set(this.options.store.list<InspectionJob>(B.jobs).filter(job => isDeepStrictEqual(job.authority, authority)).flatMap(job => job.sessionId ? [job.sessionId] : []));
    return createHash('sha256').update(JSON.stringify([records, this.options.store.list<InspectionObservation>(B.observations).filter(observation => sessionIds.has(observation.sessionId))])).digest('hex');
  }
  private async validate(report: QualityEvidenceReport, authority: InspectionAuthority, quality: TaskQualityRequirements): Promise<QualityGateResult> {
    const gate = await validateQualityEvidence(report, { ...quality, authority, source: report.source }, this.resolver(authority, report.source));
    for (const required of quality.workflows) {
      const workflow = report.workflows.find(value => value.id === required.id && value.platform === required.platform);
      if (!workflow || workflow.outcome !== 'passed') continue;
      try {
        const after = await this.observation(workflow.after, authority, report.source);
        const assertion = workflow.assertionEvidenceId && this.options.store.get<InspectionEvidence>(B.evidence, workflow.assertionEvidenceId);
        const order = assertion && this.eventSequence(assertion.id, 'evidence-published');
        if (!after || !assertion || assertion.kind !== 'assertion' || assertion.jobId !== after.evidence.jobId || assertion.sessionId !== after.evidence.sessionId
          || !isDeepStrictEqual(assertion.authority, authority) || !isDeepStrictEqual(assertion.source, report.source)
          || typeof assertion.metadata?.passed !== 'boolean' || assertion.metadata.observationId !== after.observationId || !sequence(order) || order <= after.sequence
          || assertion.artifact.mime !== 'application/json' || assertion.artifact.size > 32 * 1024) throw new Error('Missing original passed assertion.');
        const manifest = await this.options.artifacts.get(assertion.artifact.id);
        if (!isDeepStrictEqual(manifest, assertion.artifact)) throw new Error('Assertion manifest changed.');
        const value = JSON.parse((await this.options.artifacts.read(manifest)).toString('utf8')) as { passed?: unknown; observationId?: unknown };
        if (typeof value.passed !== 'boolean' || value.passed !== assertion.metadata.passed || value.observationId !== after.observationId) throw new Error('Assertion outcome does not match its original result.');
        if (!gate.evidenceIds.includes(assertion.id)) gate.evidenceIds.push(assertion.id);
        if (!value.passed) { gate.status = 'repair-required'; gate.issues.push(`Workflow ${required.id} has a failed broker assertion on its resulting observation.`); }
      } catch {
        gate.issues.push(`Workflow ${required.id} lacks an original passed assertionEvidenceId for its resulting observation.`);
        if (gate.status !== 'repair-required') gate.status = 'evidence-required';
      }
    }
    return gate;
  }
  private resolver(authority: InspectionAuthority, source: InspectionSourceIdentity): QualityEvidenceResolver {
    return {
      observation: id => this.observation(id, authority, source),
      action: async id => {
        const action = this.options.store.get<InspectionAction>(B.actions, id);
        const job = action && this.options.store.get<InspectionJob>(B.jobs, action.jobId);
        const order = this.eventSequence(id, 'action-requested');
        const targetPlatform = job && this.jobPlatform(job);
        if (!action || !job || !['running', 'waiting', 'succeeded'].includes(job.status) || !sequence(order) || !targetPlatform || !isDeepStrictEqual(job.authority, authority) || !isDeepStrictEqual(job.source, source)) return undefined;
        return { action, source: job.source, platform: targetPlatform, sequence: order };
      },
      reference: async id => {
        const views = this.options.store.list<InspectionReferenceView>(B.references).filter(view => view.referenceId === id && isDeepStrictEqual(view.authority, authority) && isDeepStrictEqual(view.source, source)).reverse();
        for (const view of views) {
          if (!view.inspectedAt || !view.artifacts?.length || view.artifacts.length > 16 || new Set(view.artifacts.map(artifact => artifact.id)).size !== view.artifacts.length) continue;
          try {
            for (const original of view.artifacts) {
              const artifact = await this.options.artifacts.get(original.id);
              if (!isDeepStrictEqual(artifact, original) || artifact.goalId !== authority.goalId || artifact.taskId !== authority.taskId || artifact.attemptId !== authority.attemptId) throw new Error('Reference manifest changed.');
              await this.options.artifacts.path(artifact);
              if (artifact.mime.startsWith('image/') && !this.options.store.list<InspectionImageDelivery>(B.deliveries).some(delivery => delivered(delivery, authority, artifact.sha256))) throw new Error('Reference pixels were not delivered.');
            }
            return true;
          } catch {
            // An older unavailable view must not prevent fresh inspection from recovering.
          }
        }
        return false;
      },
    };
  }

  private jobPlatform(job: InspectionJob): QualityPlatform | undefined {
    return job.capability === 'chromium-inspection' ? 'web' : job.capability === 'macos-app-inspection' ? 'macos' : job.capability === 'ios-simulator-inspection' ? 'ios-simulator' : undefined;
  }
  private async observation(id: string, authority: InspectionAuthority, source: InspectionSourceIdentity): Promise<QualityObservationReceipt | undefined> {
    const evidence = this.options.store.get<InspectionEvidence>(B.evidence, id);
    if (!evidence || evidence.kind !== 'screenshot' || !isDeepStrictEqual(evidence.authority, authority) || !isDeepStrictEqual(evidence.source, source)) return undefined;
    const observed = typeof evidence.metadata?.observationId === 'string' ? this.options.store.get<InspectionObservation>(B.observations, evidence.metadata.observationId)
      : this.options.store.list<InspectionObservation>(B.observations).find(value => value.screenshotEvidenceId === id);
    const job = this.options.store.get<InspectionJob>(B.jobs, evidence.jobId);
    const observingAction = observed && this.options.store.get<InspectionAction>(B.actions, observed.actionId);
    const targetPlatform = evidence.metadata?.platform ?? (job && this.jobPlatform(job));
    const order = observed && this.eventSequence(observed.id, 'observation-recorded');
    if (!observed || !job || !observingAction || observingAction.status !== 'succeeded' || !['observe', 'screenshot'].includes(observingAction.kind)
      || observingAction.jobId !== job.id || observingAction.sessionId !== observed.sessionId || !isDeepStrictEqual(observingAction.authority, authority)
      || !['running', 'waiting', 'succeeded'].includes(job.status) || observed.screenshotEvidenceId !== id || observed.sessionId !== evidence.sessionId || !sequence(order) || !platform(targetPlatform)
      || !isDeepStrictEqual(job.authority, authority) || !isDeepStrictEqual(job.source, source)) return undefined;
    if (this.options.store.list<InspectionAction>(B.actions).some(action => action.jobId === job.id && action.sessionId === observed.sessionId && !['succeeded', 'failed', 'canceled'].includes(action.status))) return undefined;
    const manifest = await this.options.artifacts.get(evidence.artifact.id);
    if (!isDeepStrictEqual(manifest, evidence.artifact)) return undefined;
    await this.options.artifacts.path(manifest);
    const delivery = this.options.store.list<InspectionImageDelivery>(B.deliveries).find(value => delivered(value, authority, manifest.sha256));
    return { evidence, observationId: observed.id, platform: targetPlatform, sequence: order, ...(delivery ? { imageDelivery: { chatId: delivery.chatId, eventId: delivery.eventId, artifactSha256: delivery.artifactSha256, route: delivery.route } } : {}) };
  }
}
