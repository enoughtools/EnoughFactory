import { isDeepStrictEqual } from 'node:util';
import type { InspectionAction, InspectionAuthority, InspectionEvidence, InspectionSourceIdentity } from '@enoughfactory/contracts';

export type QualityPlatform = 'web' | 'macos' | 'ios-simulator';
export const QUALITY_DIMENSIONS = ['hierarchy', 'spacing', 'clipping', 'typography', 'controls', 'states'] as const;
export type QualityDimension = typeof QUALITY_DIMENSIONS[number];

/** Explicit acceptance scope, supplied by the coordinator rather than guessed from a task title. */
export interface QualityExpectation {
  authority: InspectionAuthority;
  source: InspectionSourceIdentity;
  platforms: QualityPlatform[];
  workflows: Array<{ id: string; platform: QualityPlatform }>;
  referenceIds: string[];
}
export interface QualityEvidenceReport {
  version: 1;
  source: InspectionSourceIdentity;
  workflows: Array<{
    id: string; platform: QualityPlatform; before: string; action: string; after: string;
    outcome: 'passed' | 'failed' | 'blocked'; assertion: string;
    /** Original broker assertion on the resulting observation; required for a passed service gate. */
    assertionEvidenceId?: string;
  }>;
  reviews: Array<{
    platform: QualityPlatform; observations: string[];
    references: Array<{ id: string; comparison: string }>;
    dimensions: Record<QualityDimension, string>;
    defects: Array<{
      id: string; severity: 'minor' | 'major' | 'blocking'; status: 'open' | 'repaired';
      description: string; observation: string;
    }>;
  }>;
}

/** These records must be read from the broker/provider journals, never from the authored report. */
export interface QualityObservationReceipt {
  evidence: InspectionEvidence;
  /** UI observation identity; distinct from its screenshot evidence/artifact identity. */
  observationId: string;
  platform: QualityPlatform;
  sequence: number;
  imageDelivery?: { chatId: string; eventId: string; artifactSha256: string; route: 'tool-image' | 'image-input' | 'image-view' };
}
export interface QualityActionReceipt {
  action: InspectionAction;
  source: InspectionSourceIdentity;
  platform: QualityPlatform;
  sequence: number;
}
export interface QualityEvidenceResolver {
  /** Also verify the retained artifact bytes against the manifest before returning. */
  observation(id: string): Promise<QualityObservationReceipt | undefined>;
  action(id: string): Promise<QualityActionReceipt | undefined>;
  /** Confirm the reference is in the current project's supplied, inspected reference context. */
  reference(id: string): Promise<boolean>;
}
export interface QualityGateResult {
  status: 'ready-for-review' | 'repair-required' | 'evidence-required';
  issues: string[];
  evidenceIds: string[];
}

/** Instructions are intentionally useful without claiming that a tool or reference is available. */
export function factoryQualityInstructions(role: 'worker' | 'planner' | 'evaluator' | 'diagnosis'): string {
  const common = 'For user-facing app work, a passing build is only compilation evidence. Inspect the actual project reference and design system; use their real components, tokens and interaction patterns. Run the app through the advertised browser/native inspection tools, view the returned screenshots, act on fresh observations and verify the resulting state. A saved screenshot path or hash does not mean you saw its image. Judge hierarchy, deliberate padding, clipping/scrolling, typography, control proportions/focus and loading/empty/error states at representative window sizes. Keep content usable; reclaim wasted framing without removing all padding or squeezing horizontally scrollable content. Record concrete observations, comparisons and workflow assertions. Repair serious visible or interaction defects, rebuild and inspect again. Keep fixture, live-service, native-build and signing results distinct. If inspection is unavailable, name the missing capability and preserve source; do not invent visual acceptance.';
  const specific = {
    worker: 'Choose representative workflows for the changed behavior, including a useful failure/recovery path. Before/after observations and the intervening action must belong to the same owned session and exact source snapshot. Run a real broker assertion against the resulting observation and retain its assertionEvidenceId for each passed workflow; prose alone cannot pass the service gate. For material UI work, retain a compact quality report with its original evidence IDs, reference comparisons, all six review dimensions and unresolved defects. Describe what users can actually do and what remains unverified.',
    planner: 'Plan explicit browser/native capabilities for material UI implementation and final delivery. Include reference inspection, representative workflow assertions and a visual repair loop in the relevant task acceptance contract. Keep architecture and backend-only work independent; do not attach a whole-product UI acceptance suite to every task. Missing tools wait before author allocation; they are not repeated implementation failures.',
    evaluator: 'Evaluate the current integrated product against the original goal and actual reference UX. Read the latest quality reports and their authenticated current-source evidence; inspect the screenshot images themselves. Use factory_review_evidence to read the original assertionEvidenceId of every required workflow yourself; a report summary cannot substitute for its measured result. Counts, accepted tasks, build success, feature inventories and prose claims cannot establish visual or functional acceptance. For explicit UI acceptance, include visualReview {source,reviews:[{platform,observations,references:[{id,comparison}],dimensions:{hierarchy,spacing,clipping,typography,controls,states},defects:[]}]} with the current integrated source and original screenshot evidence IDs. Your own image and reference reads are verified independently; the author viewing a screenshot does not establish your review. The structural quality gate checks evidence provenance and coverage; your review must still judge whether the product is coherent and pleasant. Turn concrete defects into focused repair tasks, without replacing the original criteria with a smaller demo.',
    diagnosis: 'Separate a real source defect from unavailable inspection or unknown tool outcomes. Use the actual failed action and subsequent observation to propose the smallest useful repair. A successful click is not proof that a sheet closed or data saved. Reconcile an unknown outcome and wait on a durable tool job rather than consume another author attempt for unchanged source.',
  };
  return `${common}\n\n${specific[role]}`;
}

/** Bounded metadata for continuation/controllers; images must be delivered separately. */
export function factoryQualityEvidenceContext(input: {
  source: InspectionSourceIdentity;
  observations: QualityObservationReceipt[];
  referenceIds?: string[];
  uiTrees?: Record<string, string>;
  maximumScreenshots?: number;
}): string {
  const maximum = Math.min(8, Math.max(1, Math.floor(input.maximumScreenshots ?? 4)));
  const recent = input.observations.filter(receipt => isDeepStrictEqual(receipt.evidence.source, input.source))
    .sort((a, b) => b.evidence.createdAt.localeCompare(a.evidence.createdAt) || b.sequence - a.sequence).slice(0, maximum);
  const records = recent.map(receipt => ({
    evidenceId: receipt.evidence.id, observationId: receipt.observationId, jobId: receipt.evidence.jobId,
    sessionId: receipt.evidence.sessionId, platform: receipt.platform, sequence: receipt.sequence,
    artifactId: receipt.evidence.artifact.id, sha256: receipt.evidence.artifact.sha256,
    mime: receipt.evidence.artifact.mime, size: receipt.evidence.artifact.size,
    providerImageDelivery: receipt.imageDelivery ? { chatId: receipt.imageDelivery.chatId, eventId: receipt.imageDelivery.eventId, route: receipt.imageDelivery.route } : 'not-recorded',
    ...(input.uiTrees?.[receipt.observationId] ? { uiExcerpt: input.uiTrees[receipt.observationId]!.slice(0, 900) } : {}),
  }));
  return [
    'Current-source inspection evidence references follow. They contain no image bytes and do not establish that this reviewer saw the screenshots. Request/view the original images through available tools before judging appearance; do not infer visual acceptance from metadata or UI text.',
    `Source: ${JSON.stringify(input.source)}`,
    `References to inspect: ${JSON.stringify(input.referenceIds ?? [])}`,
    records.length ? `Latest selected checkpoints: ${JSON.stringify(records)}` : 'No current-source screenshot evidence is recorded in this context. Report the concrete inspection gap.',
    'Compare actual screens with the inspected reference. State concrete findings about hierarchy, padding, clipping/scrolling, typography, control/focus behavior and visible states; verify action outcomes and request focused repairs for serious defects.',
  ].join('\n');
}

const platforms = new Set<unknown>(['web', 'macos', 'ios-simulator']);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 4000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown, maximum = 64): value is unknown[] => Array.isArray(value) && value.length <= maximum;
const source = (value: unknown): value is InspectionSourceIdentity => object(value) && text(value.snapshotId) && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
  && ['candidateId', 'candidateCommit', 'checkedCommit'].every(key => value[key] === undefined || text(value[key]))
  && (value.roots === undefined || list(value.roots) && value.roots.every(root => object(root) && text(root.id) && typeof root.sha256 === 'string' && /^[a-f0-9]{64}$/.test(root.sha256) && (root.commit === undefined || text(root.commit))));

/** Parse bounded authored content. Its references remain untrusted until resolved below. */
export function parseQualityEvidenceReport(value: unknown): QualityEvidenceReport {
  if (!object(value) || value.version !== 1 || !source(value.source) || !list(value.workflows) || !list(value.reviews, 3)) throw new Error('Invalid quality evidence report.');
  if (value.workflows.some(workflow => !object(workflow) || !text(workflow.id) || !platforms.has(workflow.platform)
    || !['before', 'action', 'after', 'assertion'].every(key => text(workflow[key])) || (workflow.assertionEvidenceId !== undefined && !text(workflow.assertionEvidenceId)) || typeof workflow.outcome !== 'string' || !['passed', 'failed', 'blocked'].includes(workflow.outcome))) throw new Error('Invalid quality workflow evidence.');
  if (value.reviews.some(review => !object(review) || !platforms.has(review.platform) || !list(review.observations) || !review.observations.length || review.observations.some(id => !text(id))
    || !list(review.references, 16) || review.references.some(reference => !object(reference) || !text(reference.id) || !text(reference.comparison))
    || !object(review.dimensions) || QUALITY_DIMENSIONS.some(key => !text((review.dimensions as Record<string, unknown>)[key]))
    || !list(review.defects) || review.defects.some(defect => !object(defect) || !['id', 'description', 'observation'].every(key => text(defect[key]))
      || typeof defect.severity !== 'string' || !['minor', 'major', 'blocking'].includes(defect.severity) || typeof defect.status !== 'string' || !['open', 'repaired'].includes(defect.status)))) throw new Error('Invalid visual review evidence.');
  const report = value as unknown as QualityEvidenceReport;
  if (new Set(report.workflows.map(workflow => `${workflow.platform}:${workflow.id}`)).size !== report.workflows.length
    || new Set(report.reviews.map(review => review.platform)).size !== report.reviews.length
    || report.reviews.some(review => new Set(review.references.map(reference => reference.id)).size !== review.references.length || new Set(review.defects.map(defect => defect.id)).size !== review.defects.length)) throw new Error('Duplicate quality evidence identity.');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 128 * 1024) throw new Error('Quality evidence report exceeds its input budget.');
  return report;
}

/**
 * Enforce current-source provenance and the requested review coverage. This cannot judge
 * aesthetics or prove an assertion's semantics; the evaluator must inspect the images.
 */
export async function validateQualityEvidence(value: unknown, expected: QualityExpectation, resolver: QualityEvidenceResolver): Promise<QualityGateResult> {
  const issues: string[] = [], evidenceIds = new Set<string>();
  let report: QualityEvidenceReport;
  try { report = parseQualityEvidenceReport(value); }
  catch (error) { return { status: 'evidence-required', issues: [(error as Error).message], evidenceIds: [] }; }
  if (!isDeepStrictEqual(report.source, expected.source)) return { status: 'evidence-required', issues: ['Quality evidence belongs to a different source snapshot.'], evidenceIds: [] };
  const observations = new Map<string, Promise<QualityObservationReceipt | undefined>>();
  const actions = new Map<string, Promise<QualityActionReceipt | undefined>>();
  const references = new Map<string, Promise<boolean>>();
  const observation = async (id: string, platform: QualityPlatform) => {
    if (!observations.has(id)) observations.set(id, Promise.resolve().then(() => resolver.observation(id)).catch(() => undefined));
    const receipt = await observations.get(id)!;
    const evidence = receipt?.evidence;
    if (!receipt || !evidence || evidence.id !== id || !text(receipt.observationId) || evidence.kind !== 'screenshot' || !evidence.sessionId || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 0
      || receipt.platform !== platform || !isDeepStrictEqual(evidence.authority, expected.authority) || !isDeepStrictEqual(evidence.source, expected.source)
      || !evidence.artifact.mime.startsWith('image/') || evidence.artifact.size <= 0
      || !receipt.imageDelivery || !text(receipt.imageDelivery.chatId) || !text(receipt.imageDelivery.eventId) || receipt.imageDelivery.artifactSha256 !== evidence.artifact.sha256) {
      issues.push(`Observation ${id} is missing verified current-source screenshot/image-delivery evidence.`); return undefined;
    }
    evidenceIds.add(id); return receipt;
  };
  let repair = false;
  for (const workflow of report.workflows) {
    if (workflow.outcome !== 'passed') { repair ||= workflow.outcome === 'failed'; issues.push(`Workflow ${workflow.id} is ${workflow.outcome}: ${workflow.assertion}`); }
  }
  for (const review of report.reviews) {
    for (const defect of review.defects) {
      if (!review.observations.includes(defect.observation)) issues.push(`Defect ${defect.id} does not identify an inspected review observation.`);
      if (defect.status === 'open' && defect.severity !== 'minor') { repair = true; issues.push(`Repair ${defect.id}: ${defect.description}`); }
    }
  }
  for (const required of expected.workflows) {
    const workflow = report.workflows.find(item => item.id === required.id && item.platform === required.platform);
    if (!workflow) { issues.push(`Missing ${required.platform} workflow: ${required.id}.`); continue; }
    const before = await observation(workflow.before, required.platform), after = await observation(workflow.after, required.platform);
    if (!actions.has(workflow.action)) actions.set(workflow.action, Promise.resolve().then(() => resolver.action(workflow.action)).catch(() => undefined));
    const receipt = await actions.get(workflow.action)!;
    const action = receipt?.action;
    if (!receipt || !action || action.id !== workflow.action || action.status !== 'succeeded' || !['navigate', 'click', 'type', 'key', 'scroll', 'run-tests', 'restart'].includes(action.kind)
      || !Number.isSafeInteger(receipt.sequence) || receipt.platform !== required.platform || !isDeepStrictEqual(action.authority, expected.authority) || !isDeepStrictEqual(receipt.source, expected.source)
      || !before || !after || action.jobId !== before.evidence.jobId || action.jobId !== after.evidence.jobId || action.sessionId !== before.evidence.sessionId || action.sessionId !== after.evidence.sessionId
      || action.observationId !== before.observationId || !(before.sequence < receipt.sequence && receipt.sequence < after.sequence)) {
      issues.push(`Workflow ${required.id} has no verified before/action/after sequence in one owned session.`);
    }
  }
  for (const platform of expected.platforms) {
    const review = report.reviews.find(item => item.platform === platform);
    if (!review) { issues.push(`Missing ${platform} visual review.`); continue; }
    for (const id of review.observations) await observation(id, platform);
    for (const id of expected.referenceIds) {
      const comparison = review.references.find(reference => reference.id === id);
      if (!references.has(id)) references.set(id, Promise.resolve().then(() => resolver.reference(id)).catch(() => false));
      if (!comparison || !await references.get(id)!) issues.push(`Visual review for ${platform} lacks inspected reference ${id}.`);
    }
  }
  return { status: repair ? 'repair-required' : issues.length ? 'evidence-required' : 'ready-for-review', issues: [...new Set(issues)], evidenceIds: [...evidenceIds] };
}
