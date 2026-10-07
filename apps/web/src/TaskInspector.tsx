import { useEffect, useMemo, useState } from 'react';
import type { Artifact, AttemptInspection, FactoryState, FactoryTask, Goal, TaskCheck, TaskInspection } from '@enoughfactory/contracts';
import { criticalPathMinutes } from '@enoughfactory/factory/scheduler';
import { ArrowRight, ArrowUpRight, Clock3, Download, FileText, History, ListChecks, MessageSquare, Play, RotateCcw, ShieldOff } from 'lucide-react';
import type { DeviceClient } from './api';
import { downloadArtifact } from './artifacts';
import { relativeTime } from './hooks';
import { Button, Field, Modal, Status } from './ui';
import { taskGraphLayout } from './task-graph-layout';
import { WorkingDirectoryMounts } from './WorkingDirectoryMounts';
import './task-inspector.css';

type InspectorTab = 'overview' | 'contract' | 'evidence' | 'activity';
type Run = (action: () => Promise<unknown>) => Promise<void>;
interface RetryDraft { taskId: string; goalRevision: number; attemptId: string | null; instructions: string; originalInstructions: string }
const retryInstructionsLimit = 8_000;
export interface TaskInspectorProps {
  inspection: TaskInspection;
  state: FactoryState;
  goal: Goal;
  selectedAttemptId?: string;
  dispatchAllowed: boolean;
  cancellationReason?: string;
  onSelectAttempt: (id: string) => void;
  onSelectTask: (id: string) => void;
  client: DeviceClient;
  run: Run;
  openSession: (id: string) => void;
  onOpenChat?: (sessionId: string, chatId: string) => void;
  onOpenGoalActivity?: () => void;
}

const tabs: { id: InspectorTab; label: string; icon: typeof FileText }[] = [
  { id: 'overview', label: 'Overview', icon: ListChecks },
  { id: 'contract', label: 'Requirements', icon: FileText },
  { id: 'evidence', label: 'Evidence', icon: ListChecks },
  { id: 'activity', label: 'Attempts', icon: History },
];
const phaseLabels: Record<string, string> = {
  preparing: 'Preparing workspace', prepared: 'Workspace prepared', executing: 'Agent executing',
  capturing: 'Capturing changes', captured: 'Changes captured', checking: 'Checking candidate',
  checked: 'Candidate checked', integrating: 'Integrating changes', integrated: 'Changes integrated', done: 'Attempt finished',
};

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function size(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`; }
function Phase({ item }: { item: AttemptInspection }) {
  return item.phase ? <span className="ti-phase">Last recorded activity: {phaseLabels[item.phase] ?? item.phase.replaceAll('-', ' ')}</span> : <span className="ti-muted">No execution activity recorded.</span>;
}
function RecordedError({ text, label = 'Technical details' }: { text?: string; label?: string }) {
  return text ? <details className="ti-technical-error"><summary>{label}</summary><pre className="ti-output">{text}</pre></details> : null;
}
function executionSummary(item: AttemptInspection | undefined) {
  if (!item) return 'No attempt has started.';
  const status = item.attempt.status;
  if (status === 'retired') return 'This attempt was retired. Its saved work and verification results are still available.';
  if (status === 'unknown') return 'The owning device has not confirmed whether this attempt finished.';
  if (item.integration) return 'This attempt’s saved changes were merged into the project.';
  if (item.checks?.some(check => !check.passed)) return 'The saved candidate did not pass verification.';
  if (status === 'failed') return 'This attempt stopped before its work could be accepted.';
  if (item.result?.status === 'waiting') return item.result.waitReason || 'The agent is waiting for an external condition.';
  if (status === 'succeeded') return 'The agent finished its turn. Acceptance depends on the recorded checks and integration.';
  return item.phase ? phaseLabels[item.phase] ?? 'An attempt is in progress.' : 'An attempt is in progress.';
}
function ExecutionOverview({ inspection, item, cancellationReason, historical, showEvidence, showRequirements, showRecovery }: {
  inspection: TaskInspection; item?: AttemptInspection; cancellationReason?: string; historical: boolean;
  showEvidence: () => void; showRequirements: () => void; showRecovery?: () => void;
}) {
  const canceled = inspection.task.status === 'canceled';
  const checks = item?.checks ?? [];
  const candidate = item?.candidate?.commit ?? item?.attempt.candidate;
  const configured = item?.contract?.checks ?? (historical ? [] : inspection.checks);
  const missing = configured.filter(command => !checks.some(check => check.command === command && (!candidate || check.candidateCommit === candidate))).length;
  const passed = checks.filter(check => check.passed).length;
  const failed = checks.length - passed;
  const technicalError = item?.attempt.error ?? item?.result?.error ?? (historical ? undefined : inspection.lastError);
  const reason = !canceled && !historical && inspection.reason !== technicalError ? inspection.reason : undefined;
  const technicalReason = reason && /\n|curl:|openssl|candidate checks failed|enoent|traceback|error:\s/i.test(reason);
  return <div className="ti-content ti-overview">
    {canceled && <section className="ti-summary-notice"><h3>Removed from active work</h3><p className="ti-preserve">{cancellationReason || 'This task was canceled. The coordinator did not record a cancellation reason.'}</p><p className="ti-muted">This task will not run again in its current state. Previous attempts remain available for inspection.</p>{showRecovery && <Button size="sm" variant="ghost" onClick={showRecovery}><History size={13} />View goal recovery</Button>}</section>}
    {historical && <p className="ti-historical">Viewing a previous attempt. These results describe that attempt, not the current execution.</p>}
    <section className="ti-section"><h3>{item ? `Attempt ${item.attempt.generation}` : 'Execution'}</h3><p>{executionSummary(item)}</p>{reason && <p className="ti-preserve">{technicalReason ? 'The factory cannot continue this task until its current recovery condition is resolved.' : reason}</p>}
      <dl className="ti-execution-record">
        <div><dt>Agent</dt><dd>{item?.result ? `Turn ${item.result.status}` : item ? item.attempt.status === 'running' ? 'Running' : item.attempt.status === 'created' ? 'Waiting to start' : 'No turn result recorded' : 'Not started'}</dd></div>
        <div><dt>Saved work</dt><dd>{candidate ? <><code>{candidate.slice(0, 12)}</code> · exact source retained</> : 'No candidate saved'}</dd></div>
        <div><dt>Verification</dt><dd>{inspection.detailsAvailable === false ? 'Details unavailable from this device service' : checks.length ? <>{passed} passed{failed > 0 && ` · ${failed} failed`}{missing > 0 && ` · ${missing} without a result`}</> : configured.length ? `${configured.length} checks without a result` : 'No command checks configured'}</dd></div>
        <div><dt>Integration</dt><dd>{item?.integration ? <>Merged as <code>{item.integration.commit.slice(0, 12)}</code></> : 'No merge recorded'}</dd></div>
      </dl>
      {failed > 0 && checks.some(check => !check.passed && /no such file or directory/i.test(check.output)) && <p>A verification command could not find a required file in this saved candidate.</p>}
      <div className="ti-summary-actions">{item && <Button size="sm" variant="outline" onClick={showEvidence}><ListChecks size={13} />{failed ? 'Inspect failed checks' : 'Inspect evidence'}</Button>}<Button size="sm" variant="ghost" onClick={showRequirements}><FileText size={13} />Task requirements</Button>{!canceled && (failed > 0 || inspection.state === 'failed') && showRecovery && <Button size="sm" variant="ghost" onClick={showRecovery}><History size={13} />View goal recovery</Button>}</div>
      <RecordedError text={technicalError} label={canceled || historical ? 'Previous failure details' : 'Failure details'} />
      {technicalReason && <RecordedError text={reason} label="Coordinator details" />}
    </section>
    <details className="ti-execution-explainer"><summary>How execution and acceptance work</summary><p>The agent works in an isolated workspace. EnoughFactory saves an exact candidate, runs the task’s configured commands against that source, then merges eligible changes into the project and checks the combined result. Verification records command results; it does not indicate a pull request review.</p><p>A finished agent turn, saved candidate, or completed command does not by itself mean the task has been accepted.</p>{item?.workspace && <p className="ti-muted">Attempt started on {time(item.attempt.startedAt)}.</p>}</details>
  </div>;
}
function Commit({ label, value }: { label: string; value?: string }) {
  return value ? <div className="ti-reference"><dt>{label}</dt><dd><code>{value}</code></dd></div> : null;
}
function TaskLinks({ label, tasks, onSelect }: { label: string; tasks: FactoryTask[]; onSelect: (id: string) => void }) {
  return <section className="ti-section"><h3>{label} <span>{tasks.length}</span></h3>{tasks.length ? <ul className="ti-linked-tasks">{tasks.map(task => <li key={task.id}><button onClick={() => onSelect(task.id)}><span>{task.title}</span><Status state={task.status} /><ArrowRight size={13} /></button></li>)}</ul> : <p className="ti-muted">None recorded.</p>}</section>;
}
function Contract({ inspection, onSelectTask, criticalMinutes }: Pick<TaskInspectorProps, 'inspection' | 'onSelectTask'> & { criticalMinutes?: number }) {
  const { task } = inspection;
  return <div className="ti-content"><section className="ti-section"><h3>Task description</h3><p className="ti-preserve">{task.description || 'No description recorded.'}</p></section>
    <section className="ti-section"><h3>Acceptance criteria</h3>{task.acceptanceCriteria?.length ? <ul className="ti-contract-list">{task.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul> : <p className="ti-muted">No task-specific criteria recorded.</p>}</section>
    <section className="ti-section"><h3>Expected outputs</h3>{task.expectedOutputs?.length ? <ul className="ti-contract-list">{task.expectedOutputs.map((output, index) => <li key={index}>{output}</li>)}</ul> : <p className="ti-muted">No explicit outputs recorded.</p>}</section>
    <details className="ti-secondary-details"><summary>Scheduling and workspace scope</summary><section className="ti-section"><dl className="ti-references"><div><dt>Estimated work</dt><dd>{task.estimatedMinutes ? `${task.estimatedMinutes} minutes` : 'No estimate recorded · scheduling uses 1 minute'}</dd></div>{criticalMinutes !== undefined && criticalMinutes > 0 && <div><dt>Remaining dependency path</dt><dd>{criticalMinutes} minutes estimated</dd></div>}<div><dt>Requested resources</dt><dd>{task.resources?.cpus || task.resources?.memoryGiB ? [task.resources.cpus ? `${task.resources.cpus} CPUs` : undefined, task.resources.memoryGiB ? `${task.resources.memoryGiB} GiB memory` : undefined].filter(Boolean).join(' · ') : 'Device placement defaults'}</dd></div></dl><h4 className="ti-scope-heading">Expected write scope</h4>{task.writePaths?.length ? <ul className="ti-command-list">{task.writePaths.map(path => <li key={path}><code>{path}</code></li>)}</ul> : <p className="ti-muted">No write scope declared.</p>}<p className="ti-muted ti-scheduling-caption">Planner estimates guide priority, placement and overlap avoidance. Resource requests are scheduling reservations, not container limits.</p></section></details>
    <div className="ti-dependencies"><TaskLinks label="Prerequisites" tasks={inspection.dependencies} onSelect={onSelectTask} /><TaskLinks label="Dependents" tasks={inspection.dependents} onSelect={onSelectTask} /></div>
    <section className="ti-section"><h3>Configured checks</h3>{inspection.detailsAvailable === false ? <p className="ti-muted">Configured checks and receipts are unavailable from this service.</p> : inspection.checks.length ? <ul className="ti-command-list">{inspection.checks.map((command, index) => <li key={index}><code>{command}</code></li>)}</ul> : <p className="ti-muted">No command checks configured for this task.</p>}</section>
    {inspection.repairInstructions && <section className="ti-section ti-repair"><h3>Instructions for the next attempt</h3><p className="ti-preserve">{inspection.repairInstructions}</p></section>}
    <details className="ti-secondary-details"><summary>Task identity and timing</summary><dl className="ti-record-meta"><div><dt>Task identity</dt><dd>{task.id}</dd></div><div><dt>Created</dt><dd>{time(task.createdAt)}</dd></div><div><dt>Updated</dt><dd>{time(task.updatedAt)}</dd></div></dl></details>
  </div>;
}
function CheckResults({ checks, title }: { checks: TaskCheck[]; title: string }) {
  return <section className="ti-section"><h3>{title} <span>{checks.length}</span></h3>
    <p className="ti-muted">Recorded command results on the saved source. Open a result to inspect its output.</p>
    {checks.length ? <div className="ti-check-list">{checks.map((check, index) => <details className="ti-check" key={`${check.command}-${index}`}>
      <summary><Status state={check.passed ? 'completed' : 'failed'} label={check.passed ? 'Passed' : 'Failed'} /><code>{check.command}</code><span>{check.exitCode === undefined ? 'Exit not recorded' : `Exit ${check.exitCode}`}{check.outputTruncated && ' · output truncated'}</span></summary>
      <pre className="ti-output">{check.output || 'No command output recorded.'}</pre>
      <details className="ti-check-source"><summary>Verified source</summary><dl className="ti-references"><Commit label="Candidate" value={check.candidateCommit} /><Commit label="Checked source" value={check.checkedCommit} /></dl></details>
    </details>)}</div> : <p className="ti-muted">No check results recorded.</p>}
  </section>;
}
function AttemptEvidence({ item, configuredChecks, detailsAvailable, client, run, offline }: { item?: AttemptInspection; configuredChecks: string[]; detailsAvailable: boolean; client: DeviceClient; run: Run; offline?: boolean }) {
  if (!detailsAvailable) return <section className="ti-section"><h3>Basic attempt evidence</h3>{item ? <><Status state={item.attempt.status} /><dl className="ti-references"><Commit label="Recorded base" value={item.attempt.baseCommit} /><Commit label="Recorded candidate" value={item.attempt.candidate} /></dl></> : <p className="ti-muted">No attempt is present in the device catalog.</p>}<p className="ti-muted">Configured checks and receipts are unavailable from this service.</p></section>;
  if (!item) return <p className="ti-empty">No attempt has been recorded for this task.</p>;
  const candidateCommit = item.candidate?.commit ?? item.attempt.candidate;
  const checks = item.checks ?? [];
  const unrecorded = configuredChecks.filter(command => !checks.some(check => check.command === command && (!candidateCommit || check.candidateCommit === candidateCommit)));
  return <>
    <section className="ti-section"><div className="ti-section-heading"><h3>Attempt {item.attempt.generation}</h3><Status state={item.attempt.status} /></div><Phase item={item} />
      <details className="ti-secondary-details"><summary>Source and workspace references</summary><dl className="ti-references"><Commit label="Workspace base" value={item.workspace?.baseCommit ?? item.attempt.baseCommit} /><Commit label="Candidate commit" value={candidateCommit} /><Commit label="Candidate base" value={item.candidate?.baseCommit} /><Commit label="Candidate tree" value={item.candidate?.tree} />{item.candidate?.branch && <div className="ti-reference"><dt>Candidate branch</dt><dd>{item.candidate.branch}</dd></div>}{item.workspace && <div className="ti-reference"><dt>Workspace</dt><dd>{item.workspace.provider === 'artifactfs' ? 'ArtifactFS' : 'Git'} · {item.workspace.id}</dd></div>}</dl></details>
      {!candidateCommit && <p className="ti-muted">No captured candidate recorded.</p>}
    </section>
    {!!item.workspace?.workingDirectories?.length && <WorkingDirectoryMounts key={item.attempt.id} mounts={item.workspace.workingDirectories} deviceId={item.workspace.deviceId ?? item.attempt.deviceId} client={client} run={run} offline={offline} />}
    <CheckResults title="Candidate checks" checks={checks} />
    {unrecorded.length > 0 && <section className="ti-section"><h3>Checks without a result for this candidate</h3><ul className="ti-command-list">{unrecorded.map((command, index) => <li key={index}><Clock3 size={13} /><code>{command}</code><span>Not recorded</span></li>)}</ul></section>}
    <section className="ti-section"><h3>Integration</h3><p className="ti-muted">Integration merges the saved candidate into the project target branch.</p>{item.integration ? <><details className="ti-secondary-details"><summary>Merge references</summary><dl className="ti-references"><Commit label="Integrated commit" value={item.integration.commit} /><Commit label="Previous target head" value={item.integration.previousHead} /><Commit label="Integrated candidate" value={item.integration.candidateCommit} /></dl></details><CheckResults title="Integration checks" checks={item.integration.checks} /></> : <p className="ti-muted">No integration receipt recorded.</p>}</section>
    {item.result && <section className="ti-section"><div className="ti-section-heading"><h3>Agent result</h3><Status state={item.result.status} /></div>{item.result.text && <details className="ti-result"><summary>Recorded response</summary><p className="ti-preserve">{item.result.text}</p></details>}<RecordedError text={item.result.error} label="Agent error output" />{item.result.waitReason && <p className="ti-preserve">Waiting: {item.result.waitReason}</p>}{item.result.wakeCondition && <p className="ti-muted">Wake condition: {item.result.wakeCondition}</p>}</section>}
  </>;
}
function AttemptHistory({ attempts, selectedId, state, onSelect }: { attempts: AttemptInspection[]; selectedId?: string; state: FactoryState; onSelect: (id: string) => void }) {
  return <section className="ti-section"><h3>Recorded attempts <span>{attempts.length}</span></h3>{attempts.length ? <ol className="ti-attempts">{attempts.map(item => {
    const { attempt } = item;
    const device = state.devices.find(value => value.id === attempt.deviceId);
    return <li key={attempt.id} className={selectedId === attempt.id ? 'selected' : ''}><button className="ti-attempt-button" onClick={() => onSelect(attempt.id)} aria-pressed={selectedId === attempt.id}><span><strong>Attempt {attempt.generation}</strong><Status state={attempt.status} /></span><span className="ti-muted">{device?.name ?? attempt.deviceId}{device?.online === false ? ' · offline' : ''} · {relativeTime(attempt.startedAt)}</span><Phase item={item} /></button>
      <div className="ti-evidence-marks" aria-label="Retained attempt evidence">{item.workspace && <span>Workspace retained</span>}{item.result && <span>Turn result: {item.result.status}</span>}{(item.candidate || attempt.candidate) && <span>Candidate recorded</span>}{item.checks?.length ? <span>{item.checks.length} check results</span> : null}{item.integration && <span>Integration receipt</span>}</div>
      <RecordedError text={attempt.error} label="Attempt error output" />{item.cancellation && item.cancellation !== 'none' && <p className="ti-muted">{item.cancellation === 'acknowledged' ? 'Owning device acknowledged cancellation.' : 'Cancellation requested; termination has not been confirmed.'}</p>}
      <details className="ti-attempt-details"><summary>Attempt identity and timing</summary><dl className="ti-record-meta"><div><dt>Identity</dt><dd>{attempt.id}</dd></div><div><dt>Started</dt><dd>{time(attempt.startedAt)}</dd></div>{attempt.endedAt && <div><dt>Ended</dt><dd>{time(attempt.endedAt)}</dd></div>}</dl></details>
    </li>;
  })}</ol> : <p className="ti-muted">No attempts recorded.</p>}</section>;
}
function ArtifactList({ artifacts, goal, client, run }: { artifacts: Artifact[]; goal: Goal; client: DeviceClient; run: Run }) {
  const [download, setDownload] = useState<{ id: string; received: number } | null>(null);
  return <section className="ti-section"><h3>Task artifacts <span>{artifacts.length}</span></h3>{artifacts.length ? <ul className="ti-artifacts">{artifacts.map(artifact => <li key={artifact.id}><FileText size={15} /><div><strong>{artifact.name}</strong><span>{size(artifact.size)} · {artifact.mime}</span><details className="ti-artifact-hash"><summary>Checksum</summary><code>{artifact.sha256}</code></details></div><Button size="sm" variant="ghost" disabled={download !== null} onClick={() => {
    setDownload({ id: artifact.id, received: 0 });
    void run(() => downloadArtifact(client, artifact, goal.coordinatorId, received => setDownload({ id: artifact.id, received }))).finally(() => setDownload(null));
  }}><Download size={13} />{download?.id === artifact.id ? `${Math.round(download.received / Math.max(1, artifact.size) * 100)}%` : 'Download'}</Button></li>)}</ul> : <p className="ti-muted">No artifacts attached to this task.</p>}</section>;
}

export function TaskInspector({ inspection, state, goal, selectedAttemptId, dispatchAllowed, cancellationReason, onSelectAttempt, onSelectTask, client, run, openSession, onOpenChat, onOpenGoalActivity }: TaskInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('overview');
  const [busy, setBusy] = useState<string | null>(null);
  const [retryOpen, setRetryOpen] = useState(false);
  const [retryDraft, setRetryDraft] = useState<RetryDraft | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  useEffect(() => { setTab('overview'); setRetryOpen(false); setRetryDraft(null); setRetryError(null); }, [inspection.task.id]);
  const { task } = inspection;
  const criticalMinutes = useMemo(() => {
    const tasks = state.tasks.filter(item => item.goalId === goal.id).map(item => item.id === task.id ? task : item);
    const graph = taskGraphLayout(tasks);
    return !graph.unresolved.length && !graph.missing.length && !graph.duplicates.length ? criticalPathMinutes(tasks).get(task.id) : undefined;
  }, [state.tasks, task, goal.id]);
  const attempts = [...inspection.attempts].sort((a, b) => b.attempt.generation - a.attempt.generation);
  const item = attempts.find(value => value.attempt.id === selectedAttemptId) ?? attempts.find(value => value.attempt.id === task.currentAttemptId) ?? attempts[0];
  const attempt = item?.attempt;
  const sessionId = attempt ? attempt.sessionId ?? item?.workspace?.sessionId : task.sessionId;
  const chat = attempt?.chatId ? state.chats.find(value => value.id === attempt.chatId) : state.chats.find(value => value.sessionId === sessionId);
  const chatId = attempt?.chatId ?? chat?.id;
  const chatSessionId = sessionId ?? chat?.sessionId;
  const device = state.devices.find(value => value.id === (attempt?.deviceId ?? task.deviceId));
  const historical = !!attempt && attempt.id !== task.currentAttemptId;
  const terminal = ['completed', 'canceled', 'failed'].includes(goal.status);
  const canRun = (!task.currentAttemptId || !historical) && dispatchAllowed && !terminal && ['ready', 'queued'].includes(inspection.state) && inspection.dependencies.every(value => value.status === 'completed');
  const canRetry = !historical && dispatchAllowed && !terminal && task.status === 'failed' && inspection.state === 'failed' && (!attempt || attempt.status === 'failed');
  const retryChanged = !canRetry || !retryDraft || retryDraft.taskId !== task.id || retryDraft.goalRevision !== goal.revision || retryDraft.attemptId !== (task.currentAttemptId ?? null);
  const canRetire = !terminal && task.status !== 'completed' && attempt && attempt.id === task.currentAttemptId && (['created', 'running', 'unknown', 'failed'].includes(attempt.status) || (task.status === 'review' && attempt.status === 'succeeded'));
  async function act(name: string, action: () => Promise<unknown>) { if (busy) return; setBusy(name); try { await run(action); } finally { setBusy(null); } }
  function openRetry() {
    setRetryDraft(current => current?.taskId === task.id && current.goalRevision === goal.revision && current.attemptId === (task.currentAttemptId ?? null) ? current : {
      taskId: task.id, goalRevision: goal.revision, attemptId: task.currentAttemptId ?? null,
      instructions: current?.taskId === task.id ? current.instructions : inspection.repairInstructions ?? '', originalInstructions: inspection.repairInstructions ?? '',
    });
    setRetryError(null); setRetryOpen(true);
  }
  async function retry() {
    if (busy || !retryDraft || retryChanged || retryDraft.instructions.length > retryInstructionsLimit) return;
    const draft = retryDraft, instructions = draft.instructions.trim();
    setRetryError(null);
    await act('retry', async () => {
      try {
        await client.post(`/api/tasks/${encodeURIComponent(draft.taskId)}/retry`, {
          expectedGoalRevision: draft.goalRevision, expectedAttemptId: draft.attemptId,
          ...(instructions !== draft.originalInstructions.trim() ? { repairInstructions: instructions } : {}),
        });
        setRetryOpen(false); setRetryDraft(null);
      } catch (cause) {
        setRetryError(cause instanceof Error ? cause.message : 'The task could not be retried. Your instructions are kept here.');
        throw cause;
      }
    });
  }
  const selectAttempt = (id: string) => onSelectAttempt(id);
  return <section className="task-inspector" aria-label={`Inspect ${task.title}`} aria-busy={busy !== null}>
    <header className="ti-header"><div><p className="ti-eyebrow">{task.kind ?? 'Task'}{inspection.planRevision !== undefined ? ` · Plan ${inspection.planRevision}` : ''}</p><h2>{task.title}</h2><div className="ti-header-meta"><Status state={inspection.state} label={task.status === 'canceled' ? 'Canceled task' : undefined} /><span>{device?.name ?? 'Unassigned'}{device?.online === false ? ' · offline' : ''}</span>{attempt && <span>Attempt {attempt.generation}{historical ? ' · previous' : ''}</span>}</div></div>
      <div className="ti-actions">{canRun && <Button size="sm" disabled={busy !== null} onClick={() => void act('run', () => client.post(`/api/tasks/${encodeURIComponent(task.id)}/run`, { expectedGoalRevision: goal.revision }))}><Play size={13} />{busy === 'run' ? 'Starting…' : 'Run task'}</Button>}{canRetry && <Button size="sm" variant="outline" disabled={busy !== null} onClick={openRetry}><RotateCcw size={13} />Retry task with instructions</Button>}{sessionId && <Button size="sm" variant="ghost" onClick={() => openSession(sessionId)}><ArrowUpRight size={13} />Workspace</Button>}{chatId && chatSessionId && onOpenChat && <Button size="sm" variant="ghost" onClick={() => onOpenChat(chatSessionId, chatId)}><MessageSquare size={13} />Agent chat</Button>}</div>
    </header>
    {(inspection.state === 'unknown' || attempt?.status === 'unknown' || item?.cancellation === 'requested') && <div className="ti-authority"><ShieldOff size={16} /><div><strong>{item?.cancellation === 'requested' ? 'Cancellation is awaiting acknowledgment' : 'Execution outcome is unknown'}</strong><p>The owning device has not confirmed termination or all effects. Retiring revokes this attempt’s EnoughFactory authority and permits replacement work. Direct external effects may still need reconciliation.</p></div></div>}
    {canRetire && attempt && <details className="ti-retire"><summary>Attempt authority</summary><div><p>{attempt.status === 'unknown' ? 'A lost connection does not prove this attempt failed. Retire only when you intend to permit a replacement.' : 'Retire this attempt to revoke integration authority and request cancellation from its owning device.'}</p><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act('retire', () => client.post(`/api/attempts/${encodeURIComponent(attempt.id)}/retire`))}><ShieldOff size={13} />{busy === 'retire' ? 'Retiring…' : 'Retire attempt'}</Button></div></details>}
    <div className="ti-tabs" role="tablist" aria-label="Task inspection">{tabs.map(({ id, label, icon: Icon }, index) => <button key={id} id={`ti-tab-${task.id}-${id}`} role="tab" aria-selected={tab === id} aria-controls={`ti-panel-${task.id}-${id}`} tabIndex={tab === id ? 0 : -1} className={tab === id ? 'active' : ''} onClick={() => setTab(id)} onKeyDown={event => {
      let next: number | undefined;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); setTab(tabs[next].id); (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus(); }
    }}><Icon size={14} />{label}{id === 'activity' && attempts.length > 0 && <span>{attempts.length}</span>}</button>)}</div>
    <div role="tabpanel" id={`ti-panel-${task.id}-${tab}`} aria-labelledby={`ti-tab-${task.id}-${tab}`} tabIndex={0}>
      {tab === 'overview' && <ExecutionOverview inspection={inspection} item={item} historical={historical} cancellationReason={cancellationReason} showEvidence={() => setTab('evidence')} showRequirements={() => setTab('contract')} showRecovery={onOpenGoalActivity} />}
      {tab === 'contract' && <>{item?.contract && <p className="ti-contract-revision">Requirements used by attempt {attempt?.generation} · plan {item.contract.planRevision}</p>}<Contract inspection={item?.contract ? { ...inspection, task: { ...task, ...item.contract }, dependencies: state.tasks.filter(dependency => item.contract!.dependsOn.includes(dependency.id)), checks: item.contract.checks } : inspection} criticalMinutes={!attempt || attempt.id === task.currentAttemptId ? criticalMinutes : undefined} onSelectTask={onSelectTask} /></>}
      {tab === 'evidence' && <div className="ti-content">{attempts.length > 1 && <label className="ti-attempt-picker">Evidence for<select value={attempt?.id ?? ''} onChange={event => selectAttempt(event.target.value)}>{attempts.map(value => <option key={value.attempt.id} value={value.attempt.id}>Attempt {value.attempt.generation} · {value.attempt.status}</option>)}</select></label>}<AttemptEvidence item={item} configuredChecks={item?.contract?.checks ?? (attempt?.id === task.currentAttemptId ? inspection.checks : [])} detailsAvailable={inspection.detailsAvailable !== false} client={client} run={run} offline={device?.online === false} />{inspection.detailsAvailable !== false && <ArtifactList artifacts={inspection.artifacts} goal={goal} client={client} run={run} />}</div>}
      {tab === 'activity' && <div className="ti-content"><AttemptHistory attempts={attempts} selectedId={attempt?.id} state={state} onSelect={selectAttempt} />{item?.result?.status === 'waiting' && item.result.wakeCondition && attempt?.id === task.currentAttemptId && attempt?.status !== 'retired' && goal.status === 'waiting' && <div className="ti-wake"><p>Waiting for <strong>{item.result.wakeCondition}</strong>{item.result.waitReason ? `: ${item.result.waitReason}` : ''}</p><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act('wake', () => client.post(`/api/goals/${encodeURIComponent(goal.id)}/wake`, { condition: item?.result?.wakeCondition }))}><Play size={13} />Condition satisfied · Resume</Button></div>}{device?.online === false && <p className="ti-muted">Live tools and device-local chats are unavailable while {device.name} is offline. Recorded task evidence remains here.</p>}</div>}
    </div>
    <Modal open={retryOpen} onClose={() => { if (busy !== 'retry') setRetryOpen(false); }} title="Retry task with instructions" description="Start a fresh attempt using the current goal policy. The previous attempt, its chat and saved evidence remain available.">
      <form className="modal-form" onSubmit={event => { event.preventDefault(); void retry(); }}>
        <p><strong>{task.title}</strong></p>
        <Field label="Instructions for the next attempt (optional)" hint={`Edit the existing instructions or add feedback. ${retryDraft?.instructions.length ?? 0} / ${retryInstructionsLimit.toLocaleString()} characters.`}>
          <textarea autoFocus rows={7} maxLength={retryInstructionsLimit} value={retryDraft?.instructions ?? ''} disabled={busy === 'retry'} onChange={event => setRetryDraft(current => current ? { ...current, instructions: event.target.value } : current)} placeholder="Explain what to change or what the previous attempt missed…" />
        </Field>
        {retryChanged && <p className="error-banner" role="alert">The task or goal changed. Your instructions are kept here. Close this dialog and inspect the current attempt before retrying.</p>}
        {retryError && <p className="error-banner" role="alert">{retryError}</p>}
        <div className="header-actions"><Button type="button" variant="ghost" disabled={busy === 'retry'} onClick={() => setRetryOpen(false)}>Cancel</Button><Button type="submit" disabled={busy !== null || retryChanged || !retryDraft || retryDraft.instructions.length > retryInstructionsLimit}><RotateCcw size={14} />{busy === 'retry' ? 'Retrying…' : 'Retry task'}</Button></div>
      </form>
    </Modal>
  </section>;
}
