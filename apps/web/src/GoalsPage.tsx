import type { ChangeEvent } from 'react';
import { useEffect, useState } from 'react';
import type { Artifact, Decision, FactoryState, FactoryTask, Goal, GoalInspection, TaskInspection, TaskOverview, TaskWorkState } from '@enoughfactory/contracts';
import { ArrowLeft, ArrowUpRight, CirclePause, Download, FileText, GitBranch, LayoutGrid, List, ListTodo, MessageSquare, Play, Plus, Search, Send, SlidersHorizontal, Square } from 'lucide-react';
import type { DeviceClient } from './api';
import { useResource, relativeTime } from './hooks';
import { GoalControls } from './GoalControls';
import { downloadArtifact } from './artifacts';
import { SessionWorkspace } from './SessionWorkspace';
import { TaskInspector } from './TaskInspector';
import { Button, EmptyState, Field, Input, Loading, PageHeader, Panel, Status } from './ui';
import './task-workspace.css';

type Run = (action: () => Promise<unknown>) => Promise<void>;
export interface GoalSelection { goalId?: string; taskId?: string; attemptId?: string }
const labels: Record<TaskWorkState, string> = { blocked: 'Blocked', ready: 'Ready', queued: 'Queued', running: 'Running', review: 'Review', preparing: 'Preparing environment', executing: 'Working', capturing: 'Preserving candidate', checking: 'Checking candidate', integrating: 'Integrating', accepted: 'Accepted', failed: 'Failed', canceled: 'Canceled', unknown: 'Outcome unknown', waiting: 'Waiting' };
const groups: { label: string; states: TaskWorkState[] }[] = [
  { label: 'Ready', states: ['ready'] }, { label: 'Queued', states: ['queued'] },
  { label: 'Blocked & waiting', states: ['blocked', 'waiting'] },
  { label: 'In progress', states: ['preparing', 'executing', 'capturing', 'checking', 'integrating', 'running', 'review'] },
  { label: 'Accepted', states: ['accepted'] }, { label: 'Needs attention', states: ['failed', 'unknown'] },
  { label: 'Canceled', states: ['canceled'] },
];
const boardGroups: { label: string; states: TaskWorkState[]; always?: boolean }[] = [
  { label: 'Planned', states: ['ready', 'queued', 'blocked', 'waiting'], always: true },
  { label: 'Execution', states: ['preparing', 'executing'], always: true },
  { label: 'Capture', states: ['capturing'], always: true },
  { label: 'Checks', states: ['checking'], always: true },
  { label: 'Integration', states: ['integrating'], always: true },
  { label: 'Accepted', states: ['accepted'], always: true },
  { label: 'Attention', states: ['failed', 'unknown'] },
  { label: 'Reported state', states: ['running', 'review'] },
  { label: 'Canceled', states: ['canceled'] },
];
const kindLabels = { feature: 'Feature', unit: 'Unit', architecture: 'Architecture', test: 'Test' };

/** Legacy catalogs contain task/attempt status, not a recorded execution phase. */
function basicOverview(task: FactoryTask, state: FactoryState): TaskOverview {
  const attempt = state.attempts.find(item => item.id === task.currentAttemptId);
  return { task, state: task.status === 'completed' ? 'accepted' : task.status === 'canceled' ? 'canceled' : task.status === 'failed' ? 'failed' : attempt?.status === 'unknown' ? 'unknown' : task.status,
    attemptId: attempt?.id, reason: attempt?.error };
}
function basicInspection(task: FactoryTask, state: FactoryState, artifacts: Artifact[]): TaskInspection {
  return { ...basicOverview(task, state), detailsAvailable: false, checks: [],
    dependencies: state.tasks.filter(item => task.dependsOn.includes(item.id)),
    dependents: state.tasks.filter(item => item.dependsOn.includes(task.id)),
    attempts: state.attempts.filter(item => item.taskId === task.id).sort((a, b) => b.generation - a.generation).map(attempt => ({ attempt })),
    artifacts: artifacts.filter(item => item.taskId === task.id) };
}

function GoalWorkspace({ goal, state, client, run, selection, select, back, openSession, onOpenChat }: {
  goal: Goal; state: FactoryState; client: DeviceClient; run: Run; selection: GoalSelection; select: (value: GoalSelection) => void;
  back: () => void; openSession: (id: string) => void; onOpenChat?: (sessionId: string, chatId: string) => void;
}) {
  const active = !['completed', 'canceled', 'failed'].includes(goal.status);
  const poll = active ? 3000 : 0;
  const inspection = useResource<GoalInspection>(client, `/api/goals/${goal.id}/inspection`, poll);
  const legacyDetails = useResource<{ control?: GoalInspection['control'] }>(client, `/api/goals/${goal.id}`, poll);
  const decisions = useResource<Decision[]>(client, `/api/goals/${goal.id}/decisions`, poll);
  const artifacts = useResource<Artifact[]>(client, `/api/goals/${goal.id}/artifacts`, active ? 8000 : 0);
  const evaluations = useResource<{ id: string; at: string; head: string; evaluation: { summary: string; complete: boolean; criteria: { criterion: string; satisfied: boolean; evidence: string[] }[] } }[]>(client, `/api/goals/${goal.id}/evaluations`, poll);
  const [section, setSection] = useState<'work' | 'decisions' | 'completion' | 'artifacts'>('work');
  const [board, setBoard] = useState(true);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [steering, setSteering] = useState('');
  const [controlsOpen, setControlsOpen] = useState(false);
  const [download, setDownload] = useState<{ id: string; received: number } | null>(null);
  const [toolFocus, setToolFocus] = useState<{ sessionId: string; chatId?: string } | null>(null);
  const [toolsOpen, setToolsOpen] = useState(true);
  const catalogTasks = state.tasks.filter(task => task.goalId === goal.id);
  const overview = inspection.data?.tasks ?? catalogTasks.map(task => basicOverview(task, state));
  const tasks = overview.map(item => item.task);
  const selected = tasks.find(task => task.id === selection.taskId) ?? tasks.find(task => task.status === 'running' || task.status === 'review') ?? tasks[0];
  const taskDetails = useResource<TaskInspection>(client, selected ? `/api/tasks/${selected.id}` : null, poll);
  const task = selected ? (taskDetails.data?.task.id === selected.id ? taskDetails.data : basicInspection(selected, state, artifacts.data ?? [])) : undefined;
  const selectedAttempt = task?.attempts.find(item => item.attempt.id === selection.attemptId) ?? task?.attempts.find(item => item.attempt.id === selected?.currentAttemptId) ?? task?.attempts[0];
  const attemptSessionId = selectedAttempt ? selectedAttempt.attempt.sessionId ?? selectedAttempt.workspace?.sessionId : selected?.sessionId;
  const attemptChatId = selectedAttempt?.attempt.chatId ?? state.chats.find(chat => chat.sessionId === attemptSessionId)?.id;
  const toolSession = state.sessions.find(session => session.id === (toolFocus?.sessionId ?? attemptSessionId));
  const toolChatId = toolFocus?.chatId ?? attemptChatId;
  const control = inspection.data?.control ?? legacyDetails.data?.control;
  const project = state.projects.find(item => item.id === goal.projectId);
  const accepted = tasks.filter(item => item.status === 'completed').length;
  const latestEvaluation = evaluations.data?.slice().sort((a, b) => b.at.localeCompare(a.at))[0];
  const filtered = overview.filter(item => (kind === 'all' || (kind === 'generic' ? !item.task.kind : item.task.kind === kind)) && `${item.task.title} ${item.task.description}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { setToolFocus(null); }, [selection.taskId, selection.attemptId]);
  const selectTask = (id: string) => { select({ goalId: goal.id, taskId: id }); setToolFocus(null); };
  const showChat = (sessionId: string, chatId: string) => { setToolFocus({ sessionId, chatId }); setToolsOpen(true); setSection('work'); };

  return <div className={`goal-workspace ${section === 'work' ? 'work-view' : ''}`}>
    <PageHeader title={goal.title || 'Untitled goal'} actions={<><Button variant="ghost" size="sm" onClick={back}><ArrowLeft size={14} />Goals</Button><Status state={goal.status} />{active && <Button variant="ghost" size="icon" aria-label="Goal execution settings" onClick={() => setControlsOpen(true)}><SlidersHorizontal size={16} /></Button>}{goal.status === 'draft' && <Button size="sm" onClick={() => void run(() => client.post(`/api/goals/${goal.id}/plan`))}><Play size={14} />Plan</Button>}{['running', 'planning', 'waiting'].includes(goal.status) && <Button size="sm" variant="outline" onClick={() => void run(() => client.post(`/api/goals/${goal.id}/pause`))}><CirclePause size={14} />Pause</Button>}{goal.status === 'paused' && <Button size="sm" onClick={() => void run(() => client.post(`/api/goals/${goal.id}/resume`))}><Play size={14} />Resume</Button>}{active && <Button size="sm" variant="ghost" onClick={() => void run(() => client.post(`/api/goals/${goal.id}/cancel`))}><Square size={13} />Cancel</Button>}</>} />
    <div className="goal-contract-summary"><details><summary>{goal.objective.split('\n')[0]}</summary><p>{goal.objective}</p>{goal.criteria.length > 0 && <ul>{goal.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>}</details><div className="goal-facts"><span>{project?.name ?? 'Project'}</span><span>{goal.autonomy}</span><span>{goal.approvalMode === 'approve-all' ? 'Approve all' : goal.approvalMode}</span><span>{goal.runtime}</span><span>{goal.workspaceProvider === 'artifactfs' ? 'ArtifactFS' : 'Git'}</span><span>{accepted}/{tasks.length} accepted</span><span>Revision {goal.revision}</span>{control && <span>${control.spent.toFixed(2)} recorded{control.unpricedTurns ? ` · ${control.unpricedTurns} unpriced turns` : ''}</span>}</div></div>
    {(goal.error || control?.waitReason) && <div className="error-banner">{control?.waitReason ?? goal.error}{control?.waitingFor && <span className="goal-wait-condition">Wake condition: {control.waitingFor}</span>}</div>}
    {goal.status !== 'paused' && <div className="factory-step"><strong>{goal.status === 'waiting' ? 'Waiting' : goal.status === 'completed' ? 'Complete' : goal.status === 'canceled' ? 'Canceled' : goal.status === 'failed' ? 'Failed' : control?.stage ? ({ plan: 'Planning', dispatch: 'Dispatching work', evaluate: 'Evaluating completion', diagnose: 'Diagnosing failure', wait: 'Waiting', done: 'Complete' } as const)[control.stage] : 'Factory action'}</strong><span>{goal.nextAction || 'No next action recorded'}</span>{inspection.data?.controllers.length ? <div className="controller-links">{(['planner', 'diagnosis', 'evaluator'] as const).map(role => { const record = inspection.data!.controllers.find(item => item.role === role); return record ? <button key={role} title={record.error ?? record.status} onClick={() => record.chatId ? showChat(record.sessionId, record.chatId) : openSession(record.sessionId)}><MessageSquare size={12} />{role}<span>{record.status}</span></button> : null; })}</div> : null}</div>}
    <div className="session-tabs goal-view-tabs" role="tablist" aria-label="Goal views">{(['work', 'completion', 'decisions', 'artifacts'] as const).map(item => <button className={`session-tab ${section === item ? 'active' : ''}`} key={item} role="tab" aria-selected={section === item} onClick={() => setSection(item)}>{item === 'work' ? <ListTodo size={14} /> : item === 'decisions' ? <GitBranch size={14} /> : <FileText size={14} />}{item.charAt(0).toUpperCase() + item.slice(1)}</button>)}</div>
    {section === 'work' && <>
      <div className="task-work-toolbar"><div className="task-search"><Search size={14} /><Input aria-label="Find a task" placeholder="Find a task" value={query} onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)} /></div><select aria-label="Filter task type" value={kind} onChange={event => setKind(event.target.value)}><option value="all">All types</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="generic">Generic</option></select><div className="task-view-buttons"><Button variant={board ? 'ghost' : 'outline'} size="sm" onClick={() => setBoard(false)} aria-pressed={!board}><List size={14} />List</Button><Button variant={board ? 'outline' : 'ghost'} size="sm" onClick={() => setBoard(true)} aria-pressed={board}><LayoutGrid size={14} />Board</Button></div>{task && <Button size="sm" variant="ghost" onClick={() => setToolsOpen(!toolsOpen)} aria-pressed={toolsOpen}>{toolsOpen ? 'Hide workspace' : 'Show workspace'}</Button>}</div>
      {inspection.error && <div className="task-service-notice" role="status">Detailed workflow is unavailable from this service. Showing its task catalog without inferred phases. <span>{inspection.error}</span></div>}
      {inspection.loading && !tasks.length ? <Loading>Loading the plan…</Loading> : !tasks.length ? <EmptyState icon={<ListTodo size={28} />} title={goal.status === 'planning' ? 'Planning work' : 'No planned tasks'}>{goal.status === 'planning' ? 'The planner is inspecting the project and defining deliverables.' : 'Plan this goal to create work and dependencies.'}</EmptyState> : <div className={`task-work-layout ${board ? 'board-mode' : 'list-mode'} ${toolsOpen && toolSession ? 'with-tools' : ''}`}>
        <aside className="task-index" aria-label="Goal tasks">{(board ? boardGroups : groups).map(group => { const items = filtered.filter(item => group.states.includes(item.state)); return items.length || (board && 'always' in group && group.always) ? <section className="task-state-group" key={group.label}><h2>{group.label}<span>{items.length}</span></h2>{!items.length && <p className="task-column-empty">No work</p>}{items.map(item => <button key={item.task.id} className={`task-index-card ${selected?.id === item.task.id ? 'selected' : ''}`} aria-pressed={selected?.id === item.task.id} onClick={() => selectTask(item.task.id)}><div className="task-index-state"><span className={`status-dot state-${item.state}`} /><span>{labels[item.state]}</span><span className="task-kind">{item.task.kind ? kindLabels[item.task.kind] : 'Task'}</span></div><strong>{item.task.title}</strong><span className="task-index-owner">{state.devices.find(device => device.id === item.task.deviceId)?.name ?? 'Unassigned'}{item.task.dependsOn.length > 0 ? ` · ${item.task.dependsOn.length} prerequisites` : ''}</span>{item.reason && <span className="task-index-reason">{item.reason}</span>}</button>)}</section> : null; })}{!filtered.length && <p className="task-empty-filter">No tasks match these filters.</p>}</aside>
        {task && <div className="task-inspection-pane">{taskDetails.error && <div className="task-service-notice">Retained checks and step receipts are unavailable. {taskDetails.error}</div>}<TaskInspector inspection={task} state={state} goal={goal} dispatchAllowed={control?.stage === 'dispatch' && ['draft', 'running', 'waiting'].includes(goal.status)} selectedAttemptId={selectedAttempt?.attempt.id} onSelectAttempt={id => select({ goalId: goal.id, taskId: task.task.id, attemptId: id })} onSelectTask={selectTask} client={client} run={run} openSession={openSession} onOpenChat={showChat} /></div>}
        {toolsOpen && toolSession && <section className="task-runtime-pane" aria-label="Selected agent workspace"><div className="task-runtime-heading"><strong>{toolFocus ? 'Factory conversation' : 'Attempt workspace'}</strong><Button size="sm" variant="ghost" onClick={() => toolChatId && onOpenChat ? onOpenChat(toolSession.id, toolChatId) : openSession(toolSession.id)}>Open full workspace<ArrowUpRight size={12} /></Button></div><SessionWorkspace key={`${toolSession.id}:${toolChatId ?? ''}`} session={toolSession} state={state} client={client} run={run} modalOpen={controlsOpen} compact initialChatId={toolChatId} initialTab={toolChatId ? 'agent' : 'overview'} /></section>}
      </div>}
      {inspection.data?.plan && <details className="goal-plan-details"><summary>Plan · revision {inspection.data.plan.revision}</summary><p>{inspection.data.plan.summary}</p>{inspection.data.plan.checks.length > 0 && <><strong>Plan checks</strong><ul>{inspection.data.plan.checks.map(command => <li key={command}><code>{command}</code></li>)}</ul></>}</details>}
    </>}
    {section === 'decisions' && <Panel title="Decision history">{decisions.error ? <div className="error-banner">{decisions.error}</div> : decisions.data?.length ? <ol className="decision-list">{decisions.data.map(decision => { const references = decision.data && typeof decision.data === 'object' && !Array.isArray(decision.data) ? decision.data as Record<string, unknown> : undefined; const taskId = typeof references?.taskId === 'string' ? references.taskId : undefined; const chatId = typeof references?.chatId === 'string' ? references.chatId : undefined; const chat = state.chats.find(item => item.id === chatId); return <li className="decision-item" key={decision.id}><div><span className="eyebrow">{decision.kind.replaceAll('_', ' ')}</span><time dateTime={decision.at}>{relativeTime(decision.at)}</time></div><p>{decision.text}</p><div className="decision-actions">{taskId && <Button size="sm" variant="ghost" onClick={() => { selectTask(taskId); setSection('work'); }}>Inspect task</Button>}{chat && <Button size="sm" variant="ghost" onClick={() => showChat(chat.sessionId, chat.id)}>Conversation</Button>}</div>{references && <details><summary>Recorded references</summary><pre className="code-output">{JSON.stringify(references, null, 2)}</pre></details>}</li>; })}</ol> : <p>No decisions recorded.</p>}{!!inspection.data?.controllers.length && <div className="factory-controller-history"><h3>Factory conversations</h3>{inspection.data.controllers.map(record => <div key={record.id}><strong>{record.role}</strong><Status state={record.status} /><time>{relativeTime(record.updatedAt)}</time><Button size="sm" variant="ghost" onClick={() => record.chatId ? showChat(record.sessionId, record.chatId) : openSession(record.sessionId)}>Inspect</Button>{record.error && <p>{record.error}</p>}</div>)}</div>}</Panel>}
    {section === 'artifacts' && <Panel title="Evidence & artifacts">{artifacts.error ? <div className="error-banner">{artifacts.error}</div> : artifacts.data?.length ? <div className="artifact-list">{artifacts.data.map(artifact => <article key={artifact.id} className="artifact-row"><FileText size={16} /><div><strong>{artifact.name}</strong><span>{artifact.mime} · {(artifact.size / 1024).toFixed(1)} KB · {relativeTime(artifact.createdAt)}</span>{artifact.taskId && <button className="artifact-task-link" onClick={() => { selectTask(artifact.taskId!); setSection('work'); }}>{tasks.find(item => item.id === artifact.taskId)?.title ?? 'Inspect task'}</button>}</div><span title={artifact.sha256}>{artifact.sha256.slice(0, 8)}</span><Button variant="ghost" size="sm" disabled={download !== null} onClick={() => { setDownload({ id: artifact.id, received: 0 }); void run(() => downloadArtifact(client, artifact, goal.coordinatorId, received => setDownload({ id: artifact.id, received }))).finally(() => setDownload(null)); }}><Download size={14} />{download?.id === artifact.id ? `${Math.round((download.received / Math.max(1, artifact.size)) * 100)}%` : 'Download'}</Button></article>)}</div> : <p>No retained artifacts.</p>}</Panel>}
    {section === 'completion' && <Panel title="Completion evidence" actions={active && goal.autonomy === 'manual' && tasks.length > 0 && tasks.every(task => ['completed', 'canceled'].includes(task.status)) ? <Button size="sm" onClick={() => void run(() => client.post(`/api/goals/${goal.id}/evaluate`))}>Evaluate completion</Button> : undefined}>{evaluations.error ? <div className="error-banner">{evaluations.error}</div> : latestEvaluation ? <div className="completion-evidence"><p>{latestEvaluation.evaluation.summary}</p><div className="goal-facts"><Status state={latestEvaluation.evaluation.complete ? 'completed' : 'review'} label={latestEvaluation.evaluation.complete ? 'Criteria met' : 'More work required'} /><span>Evaluated {relativeTime(latestEvaluation.at)}</span><code>{latestEvaluation.head}</code></div>{latestEvaluation.evaluation.criteria.map((criterion, index) => <article className="criterion-evidence" key={index}><div className="task-heading"><Status state={criterion.satisfied ? 'completed' : 'waiting'} label={criterion.satisfied ? 'Satisfied' : 'Outstanding'} /><strong>{criterion.criterion}</strong></div><ul>{criterion.evidence.map((item, evidenceIndex) => <li key={evidenceIndex}>{item}</li>)}</ul></article>)}</div> : <p>No completion evaluation has been recorded. The evaluator checks the goal criteria against accepted source and evidence.</p>}</Panel>}
    {active && <form className="goal-steering" onSubmit={event => { event.preventDefault(); if (steering.trim()) void run(async () => { await client.post(`/api/goals/${goal.id}/steer`, { context: steering }); setSteering(''); }); }}><Field label="Steer the goal"><div className="steering-input"><Input value={steering} onChange={(event: ChangeEvent<HTMLInputElement>) => setSteering(event.target.value)} placeholder="Add requirements or change direction" /><Button type="submit" variant="outline" disabled={!steering.trim()}><Send size={14} />Send</Button></div></Field></form>}
    <GoalControls goal={goal} maxDurationMs={control?.maxDurationMs} client={client} open={controlsOpen} close={() => setControlsOpen(false)} run={run} />
  </div>;
}

export function GoalsPage({ state, client, run, onNew, openSession, onOpenChat, selection, onSelectionChange }: { state: FactoryState; client: DeviceClient; run: Run; onNew: () => void; openSession: (id: string) => void; onOpenChat?: (sessionId: string, chatId: string) => void; selection?: GoalSelection; onSelectionChange?: (value: GoalSelection) => void }) {
  const [localSelection, setLocalSelection] = useState<GoalSelection>({});
  const selected = selection ?? localSelection;
  const select = (value: GoalSelection) => { setLocalSelection(value); onSelectionChange?.(value); };
  const goal = state.goals.find(item => item.id === selected.goalId);
  if (goal) return <GoalWorkspace key={goal.id} goal={goal} state={state} client={client} run={run} selection={selected} select={select} back={() => select({})} openSession={openSession} onOpenChat={onOpenChat} />;
  return <div className="goals-index"><PageHeader title="Goals" actions={<Button disabled={!state.projects.length} onClick={onNew}><Plus size={15} />New goal</Button>} />{state.goals.length ? <div className="goal-table">{state.goals.map(item => { const tasks = state.tasks.filter(task => task.goalId === item.id); return <button className="goal-table-row" key={item.id} onClick={() => select({ goalId: item.id })}><div><strong>{item.title || 'Untitled goal'}</strong><span>{state.projects.find(project => project.id === item.projectId)?.name ?? 'Project'} · {item.objective.split('\n')[0]}</span></div><Status state={item.status} /><span>{tasks.filter(task => task.status === 'completed').length}/{tasks.length} accepted</span><ArrowUpRight size={14} /></button>; })}</div> : <EmptyState icon={<ListTodo size={28} />} title="No goals">Create a goal to plan tasks and coordinate work across your devices.</EmptyState>}</div>;
}
