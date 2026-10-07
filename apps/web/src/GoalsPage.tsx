import type { ChangeEvent } from 'react';
import { useEffect, useState } from 'react';
import type { Artifact, Decision, FactoryState, FactoryTask, Goal, GoalInspection, TaskInspection, TaskOverview, TaskWorkState } from '@enoughfactory/contracts';
import { Activity, ArrowLeft, ArrowUpRight, CirclePause, Download, EyeOff, FileText, GitBranch, LayoutGrid, ListTodo, Play, Plus, Search, Send, SlidersHorizontal, Square, Table2, Workflow, X } from 'lucide-react';
import type { DeviceClient } from './api';
import { useResource, relativeTime } from './hooks';
import { GoalControls } from './GoalControls';
import { ControllerActivity } from './ControllerActivity';
import { downloadArtifact } from './artifacts';
import { SessionWorkspace } from './SessionWorkspace';
import { RemovedEnvironmentNotice } from './WorkspaceRemoval';
import { TaskInspector } from './TaskInspector';
import { TaskGraph } from './TaskGraph';
import { filterTaskWork, readHideCompletedPreference, saveHideCompletedPreference } from './task-work-filter';
import { Button, EmptyState, Field, Input, Loading, Modal, PageHeader, Panel, Status } from './ui';
import './task-workspace.css';

type Run = (action: () => Promise<unknown>) => Promise<void>;
export interface GoalSelection { goalId?: string; taskId?: string; attemptId?: string }
const labels: Record<TaskWorkState, string> = { blocked: 'Blocked', ready: 'Ready', queued: 'Queued', running: 'Running', review: 'Review', preparing: 'Preparing environment', executing: 'Working', capturing: 'Preserving candidate', checking: 'Checking candidate', integrating: 'Integrating', accepted: 'Accepted', failed: 'Failed', canceled: 'Canceled', unknown: 'Outcome unknown', waiting: 'Waiting' };
const boardGroups: { label: string; states: TaskWorkState[]; always?: boolean }[] = [
  { label: 'Planned', states: ['ready', 'queued', 'blocked', 'waiting'], always: true },
  { label: 'Execution', states: ['preparing', 'executing'], always: true },
  { label: 'Capture', states: ['capturing'], always: true },
  { label: 'Checks', states: ['checking'], always: true },
  { label: 'Integration', states: ['integrating'], always: true },
  { label: 'Accepted', states: ['accepted'], always: true },
  { label: 'Attention', states: ['failed', 'unknown'] },
  { label: 'Reported state', states: ['running', 'review'] },
  { label: 'Superseded / canceled', states: ['canceled'] },
];
const kindLabels = { feature: 'Feature', unit: 'Unit', architecture: 'Architecture', test: 'Test' };

function cancellationInfo(task: FactoryTask, decisions: Decision[], control?: GoalInspection['control']): { label: string; reason: string } | undefined {
  if (task.status !== 'canceled') return;
  const matching = decisions.slice().sort((a, b) => b.at.localeCompare(a.at)).find(decision => {
    if (!['replan', 'plan-requested', 'steering', 'canceled'].includes(decision.kind)) return false;
    const data = decision.data && typeof decision.data === 'object' && !Array.isArray(decision.data) ? decision.data as Record<string, unknown> : undefined;
    return data?.taskId === task.id || (Array.isArray(data?.taskIds) && data.taskIds.includes(task.id));
  });
  if (!matching) {
    if (control?.replanTaskIds?.includes(task.id) && control.replanReason) return { label: 'Superseded', reason: `Replaced during replanning. ${control.replanReason}` };
    const context = decisions.slice().sort((a, b) => b.at.localeCompare(a.at)).find(decision => ['canceled', 'steering', 'plan-requested'].includes(decision.kind) && Date.parse(decision.at) >= Date.parse(task.updatedAt));
    return { label: 'Canceled', reason: `No task-specific cancellation reason was recorded.${context ? ` Recorded goal ${context.kind === 'plan-requested' ? 'plan request' : context.kind === 'canceled' ? 'cancellation' : 'steering'}: ${context.text}` : ''}` };
  }
  return matching.kind === 'canceled'
    ? { label: 'Canceled', reason: `The goal was canceled. ${matching.text}` }
    : { label: 'Superseded', reason: `Replaced during ${matching.kind === 'steering' ? 'goal steering' : 'replanning'}. ${matching.text}` };
}

function waitSummary(reason: string | undefined, condition: string | undefined) {
  if (reason && /curl:|SSL_read|unexpected eof|SSL routines/i.test(reason)) return { title: 'Agent setup interrupted', detail: 'A download connection closed before setup finished. Retry from saved state to continue.' };
  if (condition === 'runtime-available') return { title: 'Waiting for the device runtime', detail: 'Open Devices to check the container runtime, then retry from saved state.' };
  if (condition === 'credentials-available') return { title: 'Agent sign-in required', detail: 'Open Devices to check agent access, then retry from saved state.' };
  if (condition === 'budget-changed') return { title: 'Execution limit reached', detail: 'Review the goal limits before continuing.' };
  return { title: 'Factory needs attention', detail: reason && !/[\n{}]|\b(?:bash|curl):/i.test(reason) && reason.length < 180 ? reason : 'Open activity for the recorded failure and the factory’s next action.' };
}

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

function GoalWorkspace({ goal, state, client, run, selection, select, openSession, onOpenChat, onOpenDevices }: {
  goal: Goal; state: FactoryState; client: DeviceClient; run: Run; selection: GoalSelection; select: (value: GoalSelection) => void;
  openSession: (id: string) => void; onOpenChat?: (sessionId: string, chatId: string) => void; onOpenDevices?: () => void;
}) {
  const active = !['completed', 'canceled', 'failed'].includes(goal.status);
  const poll = active ? 3000 : 0;
  const inspection = useResource<GoalInspection>(client, `/api/goals/${goal.id}/inspection`, poll);
  const legacyDetails = useResource<{ control?: GoalInspection['control'] }>(client, `/api/goals/${goal.id}`, poll);
  const decisions = useResource<Decision[]>(client, `/api/goals/${goal.id}/decisions`, poll);
  const artifacts = useResource<Artifact[]>(client, `/api/goals/${goal.id}/artifacts`, active ? 8000 : 0);
  const evaluations = useResource<{ id: string; at: string; head: string; evaluation: { summary: string; complete: boolean; criteria: { criterion: string; satisfied: boolean; evidence: string[] }[] } }[]>(client, `/api/goals/${goal.id}/evaluations`, poll);
  const [section, setSection] = useState<'work' | 'activity' | 'decisions' | 'completion' | 'artifacts'>(goal.status === 'planning' ? 'activity' : 'work');
  const [controllerId, setControllerId] = useState<string | undefined>();
  const [view, setView] = useState<'board' | 'table' | 'graph'>('board');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [hideCompleted, setHideCompleted] = useState(readHideCompletedPreference);
  const [steering, setSteering] = useState('');
  const [controlsOpen, setControlsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [download, setDownload] = useState<{ id: string; received: number } | null>(null);
  const [toolFocus, setToolFocus] = useState<{ sessionId: string; chatId?: string } | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const control = inspection.data?.control ?? legacyDetails.data?.control;
  const catalogTasks = state.tasks.filter(task => task.goalId === goal.id);
  const overview = (inspection.data?.tasks ?? catalogTasks.map(task => basicOverview(task, state))).map(item => ({ ...item, reason: cancellationInfo(item.task, decisions.data ?? [], control)?.reason ?? item.reason }));
  const tasks = overview.map(item => item.task);
  const selected = tasks.find(task => task.id === selection.taskId);
  const taskDetails = useResource<TaskInspection>(client, selected ? `/api/tasks/${selected.id}` : null, poll);
  const task = selected ? (taskDetails.data?.task.id === selected.id ? taskDetails.data : basicInspection(selected, state, artifacts.data ?? [])) : undefined;
  const selectedAttempt = task?.attempts.find(item => item.attempt.id === selection.attemptId) ?? task?.attempts.find(item => item.attempt.id === selected?.currentAttemptId) ?? task?.attempts[0];
  const attemptSessionId = selectedAttempt ? selectedAttempt.attempt.sessionId ?? selectedAttempt.workspace?.sessionId : selected?.sessionId;
  const attemptChatId = selectedAttempt?.attempt.chatId ?? state.chats.find(chat => chat.sessionId === attemptSessionId)?.id;
  const toolSessionId = toolFocus?.sessionId ?? attemptSessionId;
  const toolSession = state.sessions.find(session => session.id === toolSessionId);
  const toolChatId = toolFocus?.chatId ?? attemptChatId;
  const project = state.projects.find(item => item.id === goal.projectId);
  const accepted = tasks.filter(item => item.status === 'completed').length;
  const latestEvaluation = evaluations.data?.slice().sort((a, b) => b.at.localeCompare(a.at))[0];
  const filtered = filterTaskWork(overview, { hideCompleted, kind, query });
  const canceled = tasks.filter(item => item.status === 'canceled');
  const allTerminal = tasks.length > 0 && tasks.every(item => ['completed', 'canceled'].includes(item.status));
  const superseded = canceled.filter(item => cancellationInfo(item, decisions.data ?? [], control)?.label === 'Superseded');
  const latestController = inspection.data?.controllers.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find(item => !control?.stage || !['plan', 'diagnose', 'evaluate'].includes(control.stage) || item.role === ({ plan: 'planner', diagnose: 'diagnosis', evaluate: 'evaluator' } as Record<string, string>)[control.stage]);
  const needsRuntimeStart = goal.coordinatorId === state.device.id && state.diagnostics.containerRuntime?.state === 'stopped';
  const failureReason = control?.waitReason ?? goal.error;
  const failure = failureReason || control?.waitingFor ? waitSummary(failureReason, control?.waitingFor) : undefined;
  const controllerStage = control?.stage && ['plan', 'diagnose', 'evaluate'].includes(control.stage) ? control.stage : undefined;
  const stageTitle = controllerStage === 'plan' ? 'Planning work' : controllerStage === 'diagnose' ? 'Investigating failed work' : 'Checking goal completion';
  const stageDetail = latestController?.status === 'interrupted' || latestController?.status === 'failed' ? 'The agent stopped before returning its decision.' : controllerStage === 'plan' ? 'The planner is defining tasks and dependencies.' : controllerStage === 'diagnose' ? 'The factory is deciding whether to retry or revise the plan.' : 'The evaluator is checking accepted work against the goal criteria.';
  useEffect(() => { setToolFocus(null); }, [selection.taskId, selection.attemptId]);
  useEffect(() => { saveHideCompletedPreference(hideCompleted); }, [hideCompleted]);
  const emptyFiltered = <div className="task-empty-filter"><span>{hideCompleted && accepted === tasks.length ? 'All tasks are completed.' : 'No tasks match these filters.'}</span>{hideCompleted && accepted > 0 && <Button size="sm" variant="ghost" onClick={() => setHideCompleted(false)}>Show completed</Button>}</div>;
  const selectTask = (id: string) => { select({ goalId: goal.id, taskId: id }); setToolFocus(null); };
  const showChat = (sessionId: string, chatId: string) => { setToolFocus({ sessionId, chatId }); setToolsOpen(true); setSection('work'); };
  const showController = (id: string) => { setControllerId(id); setSection('activity'); };
  useEffect(() => { if (goal.status === 'planning' && !tasks.length) setSection('activity'); }, [goal.status, tasks.length]);

  return <div className={`goal-workspace ${section === 'work' ? 'work-view' : section === 'activity' ? 'activity-view' : ''} ${selected && section === 'work' ? 'task-detail-view' : ''}`}>
    <PageHeader eyebrow={project?.name} title={goal.title || 'Untitled goal'} actions={<>
      <Status state={goal.status} />
      <Button variant="ghost" size="sm" onClick={() => setDetailsOpen(true)}><FileText size={14} />Goal details</Button>
      {goal.status === 'draft' && <Button size="sm" onClick={() => void run(() => client.post(`/api/goals/${goal.id}/plan`))}><Play size={14} />Plan</Button>}
      {['running', 'planning', 'waiting'].includes(goal.status) && <Button size="sm" variant="outline" onClick={() => void run(() => client.post(`/api/goals/${goal.id}/pause`))}><CirclePause size={14} />Pause</Button>}
      {goal.status === 'paused' && <Button size="sm" disabled={resuming} onClick={() => { setResuming(true); void run(async () => { if (needsRuntimeStart) await client.post('/api/runtime/start'); await client.post(`/api/goals/${goal.id}/resume`); }).finally(() => setResuming(false)); }}><Play size={14} />{resuming ? (needsRuntimeStart ? 'Starting runtime…' : 'Resuming…') : needsRuntimeStart ? 'Start runtime & resume' : 'Resume'}</Button>}
    </>} />
    {section === 'work' && !selected && (failure || (controllerStage && goal.status !== 'paused') || (goal.status === 'paused' && needsRuntimeStart)) && <section className={`goal-action-notice ${failure && goal.status !== 'paused' ? 'needs-attention' : ''}`} aria-label="Factory progress">
      <div className="goal-action-summary"><strong>{goal.status === 'paused' ? 'Paused' : failure?.title ?? stageTitle}</strong><span>{goal.status === 'paused' ? needsRuntimeStart ? 'The private runtime is stopped. Start runtime & resume to continue from saved state.' : 'The last setup attempt stopped. The goal will stay paused until you resume it.' : failure?.detail ?? stageDetail}</span></div>
      <div className="goal-action-buttons"><Button variant="ghost" size="sm" onClick={() => latestController ? showController(latestController.id) : setSection('activity')}><Activity size={13} />{controllerStage === 'plan' && !failure ? 'View planner' : 'View activity'}</Button>
        {(failure || needsRuntimeStart) && onOpenDevices && <Button variant="ghost" size="sm" onClick={onOpenDevices}>Inspect device</Button>}
        {failure && active && goal.status !== 'paused' && <Button variant="outline" size="sm" disabled={control?.waitingFor === 'runtime-available' && state.diagnostics.containerRuntime?.state !== 'ready'} onClick={() => void run(() => control?.waitingFor ? client.post(`/api/goals/${goal.id}/wake`, { condition: control.waitingFor }) : client.post(`/api/goals/${goal.id}/resume`))}><Play size={13} />{control?.stage === 'plan' ? 'Retry planning' : 'Retry from saved state'}</Button>}
      </div>
      {(failureReason || control?.waitingFor) && <details className="goal-error-details"><summary>Technical details</summary>{failureReason && <pre>{failureReason}</pre>}{control?.waitingFor && <p>Recorded recovery condition: <code>{control.waitingFor}</code></p>}{goal.nextAction && <p>Recorded next action: {goal.nextAction}</p>}</details>}
    </section>}
    <div className="session-tabs goal-view-tabs" role="tablist" aria-label="Goal views">{(['work', 'activity', 'completion', 'decisions', 'artifacts'] as const).map(item => <button className={`session-tab ${section === item ? 'active' : ''}`} key={item} role="tab" aria-selected={section === item} onClick={() => setSection(item)}>{item === 'work' ? <ListTodo size={14} /> : item === 'activity' ? <Activity size={14} /> : item === 'decisions' ? <GitBranch size={14} /> : <FileText size={14} />}{item.charAt(0).toUpperCase() + item.slice(1)}</button>)}</div>
    {section === 'activity' && <ControllerActivity goal={goal} state={state} client={client} run={run} controllers={inspection.data?.controllers ?? []} selectedId={controllerId} onSelect={setControllerId} loading={inspection.loading} error={inspection.error} openSession={openSession} onOpenChat={onOpenChat} />}
    {section === 'work' && <>
      {task || (toolsOpen && toolSessionId) ? <>
        <div className="task-detail-toolbar"><Button variant="ghost" size="sm" onClick={() => { select({ goalId: goal.id }); setToolsOpen(false); setToolFocus(null); }}><ArrowLeft size={14} />Back to work</Button>{task && toolSessionId && <Button size="sm" variant="outline" onClick={() => setToolsOpen(!toolsOpen)} aria-pressed={toolsOpen}>{toolsOpen ? 'Hide agent workspace' : 'Open agent workspace'}</Button>}</div>
        <div className={`task-detail-layout ${toolsOpen && toolSession && task ? 'with-tools' : ''}`}>
          {task && <div className="task-inspection-pane">{taskDetails.error && <div className="task-service-notice">Recorded task details are unavailable. <details><summary>Technical details</summary><pre>{taskDetails.error}</pre></details></div>}<TaskInspector inspection={task} state={state} goal={goal} cancellationReason={cancellationInfo(task.task, decisions.data ?? [], control)?.reason} dispatchAllowed={control?.stage === 'dispatch' && ['draft', 'running', 'waiting'].includes(goal.status)} selectedAttemptId={selectedAttempt?.attempt.id} onSelectAttempt={id => select({ goalId: goal.id, taskId: task.task.id, attemptId: id })} onSelectTask={selectTask} onOpenGoalActivity={() => setSection('activity')} client={client} run={run} openSession={openSession} onOpenChat={showChat} /></div>}
          {toolsOpen && toolSession && <section className="task-runtime-pane" aria-label="Selected agent workspace"><div className="task-runtime-heading"><strong>{toolFocus ? 'Factory conversation' : 'Agent workspace'}</strong><div><Button size="sm" variant="ghost" onClick={() => toolChatId && onOpenChat ? onOpenChat(toolSession.id, toolChatId) : openSession(toolSession.id)}>Open full workspace<ArrowUpRight size={12} /></Button><Button size="icon" variant="ghost" aria-label="Close agent workspace" onClick={() => setToolsOpen(false)}><X size={13} /></Button></div></div><SessionWorkspace key={`${toolSession.id}:${toolChatId ?? ''}`} session={toolSession} state={state} client={client} run={run} modalOpen={controlsOpen || detailsOpen} onOpenTask={id => { selectTask(id); setToolsOpen(false); }} compact initialChatId={toolChatId} initialTab={toolChatId ? 'agent' : 'overview'} /></section>}
          {toolsOpen && toolSessionId && !toolSession && <RemovedEnvironmentNotice key={toolSessionId} sessionId={toolSessionId} client={client} run={run} />}
        </div>
      </> : <>
        <div className="task-work-toolbar"><div className="task-view-buttons" role="group" aria-label="Task view"><Button variant={view === 'board' ? 'outline' : 'ghost'} size="sm" onClick={() => setView('board')} aria-pressed={view === 'board'}><LayoutGrid size={14} />Board</Button><Button variant={view === 'table' ? 'outline' : 'ghost'} size="sm" onClick={() => setView('table')} aria-pressed={view === 'table'}><Table2 size={14} />Table</Button><Button variant={view === 'graph' ? 'outline' : 'ghost'} size="sm" onClick={() => setView('graph')} aria-pressed={view === 'graph'}><Workflow size={14} />Graph</Button></div><div className="task-search"><Search size={14} /><Input aria-label="Find a task" placeholder="Find a task" value={query} onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)} /></div><select aria-label="Filter task type" value={kind} onChange={event => setKind(event.target.value)}><option value="all">All types</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="generic">Generic</option></select><Button variant={hideCompleted ? 'outline' : 'ghost'} size="sm" aria-pressed={hideCompleted} onClick={() => setHideCompleted(!hideCompleted)}><EyeOff size={14} />Hide completed</Button><span className="task-work-count">{accepted}/{tasks.length} accepted</span></div>
        {canceled.length > 0 && <div className="task-cancellation-summary" role="status"><span>{superseded.length ? `${superseded.length} task${superseded.length === 1 ? ' was' : 's were'} superseded by replanning.` : `${canceled.length} task${canceled.length === 1 ? ' is' : 's are'} canceled.`}{superseded.length > 0 && control?.stage === 'plan' && inspection.data?.plan?.revision !== goal.revision ? ' A replacement plan has not been recorded yet.' : ''}{superseded.length < canceled.length ? ' Some tasks have no task-specific cancellation reason.' : ''}</span><Button size="sm" variant="ghost" onClick={() => setSection('decisions')}>View decisions</Button></div>}
        {inspection.error && <div className="task-service-notice" role="status">Detailed workflow is unavailable from this service. Showing recorded task status.<details><summary>Technical details</summary><pre>{inspection.error}</pre></details></div>}
        {inspection.loading && !tasks.length ? <Loading>Loading the plan…</Loading> : !tasks.length ? <EmptyState icon={<ListTodo size={28} />} title={goal.status === 'planning' ? 'Planning work' : 'No planned tasks'}>{goal.status === 'planning' ? 'The planner is inspecting the project and defining deliverables.' : 'Plan this goal to create work and dependencies.'}{(goal.status === 'planning' || !!inspection.data?.controllers.length) && <Button variant="outline" size="sm" onClick={() => setSection('activity')}><Activity size={14} />View factory activity</Button>}</EmptyState> : <div className={`task-work-layout full-work-area ${view}-mode`}>
          {hideCompleted && accepted === tasks.length ? emptyFiltered : view === 'graph' ? <TaskGraph hideCompleted={hideCompleted} tasks={overview} devices={state.devices} matchingIds={filtered.map(item => item.task.id)} concurrency={goal.concurrency} onSelect={selectTask} /> : view === 'table' ? <div className="task-table-scroll"><table className="task-work-table"><thead><tr><th scope="col">Task</th><th scope="col">State</th><th scope="col">Type</th><th scope="col">Device</th><th scope="col">Dependencies</th><th scope="col">Updated</th></tr></thead><tbody>{filtered.map(item => { const cancellation = cancellationInfo(item.task, decisions.data ?? [], control); return <tr key={item.task.id}><td><button className="task-table-title" onClick={() => selectTask(item.task.id)}>{item.task.title}<ArrowUpRight size={13} /></button>{item.reason && <span className="task-table-reason" title={item.reason}>{item.reason}</span>}</td><td><Status state={item.state} label={cancellation?.label ?? labels[item.state]} /></td><td>{item.task.kind ? kindLabels[item.task.kind] : 'Task'}</td><td>{state.devices.find(device => device.id === item.task.deviceId)?.name ?? 'Unassigned'}</td><td>{item.task.dependsOn.length ? `${item.task.dependsOn.length} prerequisites` : 'Independent'}</td><td><time dateTime={item.task.updatedAt}>{relativeTime(item.task.updatedAt)}</time></td></tr>; })}</tbody></table>{!filtered.length && emptyFiltered}</div> : <aside className="task-index" aria-label="Goal tasks">{boardGroups.filter(group => !hideCompleted || !group.states.includes('accepted')).map(group => { const items = filtered.filter(item => group.states.includes(item.state)); return items.length || (group.always && !allTerminal) ? <section className="task-state-group" key={group.label}><h2>{group.label}<span>{items.length}</span></h2>{!items.length && <p className="task-column-empty">No work</p>}{items.map(item => <button key={item.task.id} className="task-index-card" onClick={() => selectTask(item.task.id)}><div className="task-index-state"><span className={`status-dot state-${item.state}`} /><span>{cancellationInfo(item.task, decisions.data ?? [], control)?.label ?? labels[item.state]}</span><span className="task-kind">{item.task.kind ? kindLabels[item.task.kind] : 'Task'}</span></div><strong>{item.task.title}</strong><span className="task-index-owner">{state.devices.find(device => device.id === item.task.deviceId)?.name ?? 'Unassigned'}{item.task.dependsOn.length > 0 ? ` · ${item.task.dependsOn.length} prerequisites` : ''}</span>{item.reason && <span className="task-index-reason" title={item.reason}>{item.reason}</span>}</button>)}</section> : null; })}{!filtered.length && emptyFiltered}</aside>}
        </div>}
      </>}
    </>}
    {section === 'decisions' && <Panel title="Decision history">{decisions.error ? <div className="error-banner">{decisions.error}</div> : decisions.data?.length ? <ol className="decision-list">{decisions.data.map(decision => { const references = decision.data && typeof decision.data === 'object' && !Array.isArray(decision.data) ? decision.data as Record<string, unknown> : undefined; const taskId = typeof references?.taskId === 'string' ? references.taskId : undefined; const chatId = typeof references?.chatId === 'string' ? references.chatId : undefined; const chat = state.chats.find(item => item.id === chatId); return <li className="decision-item" key={decision.id}><div><span className="eyebrow">{decision.kind.replaceAll('_', ' ')}</span><time dateTime={decision.at}>{relativeTime(decision.at)}</time></div><p>{decision.text}</p><div className="decision-actions">{taskId && <Button size="sm" variant="ghost" onClick={() => { selectTask(taskId); setSection('work'); }}>Inspect task</Button>}{chat && <Button size="sm" variant="ghost" onClick={() => showChat(chat.sessionId, chat.id)}>Conversation</Button>}</div>{references && <details><summary>Recorded references</summary><pre className="code-output">{JSON.stringify(references, null, 2)}</pre></details>}</li>; })}</ol> : <p>No decisions recorded.</p>}{!!inspection.data?.controllers.length && <div className="factory-controller-history"><h3>Factory conversations</h3>{inspection.data.controllers.map(record => <div key={record.id}><strong>{record.role}</strong><Status state={record.status} /><time>{relativeTime(record.updatedAt)}</time><Button size="sm" variant="ghost" onClick={() => showController(record.id)}>Inspect</Button>{record.error && <p>{record.error}</p>}</div>)}</div>}</Panel>}
    {section === 'artifacts' && <Panel title="Evidence & artifacts">{artifacts.error ? <div className="error-banner">{artifacts.error}</div> : artifacts.data?.length ? <div className="artifact-list">{artifacts.data.map(artifact => <article key={artifact.id} className="artifact-row"><FileText size={16} /><div><strong>{artifact.name}</strong><span>{artifact.mime} · {(artifact.size / 1024).toFixed(1)} KB · {relativeTime(artifact.createdAt)}</span>{artifact.taskId && <button className="artifact-task-link" onClick={() => { selectTask(artifact.taskId!); setSection('work'); }}>{tasks.find(item => item.id === artifact.taskId)?.title ?? 'Inspect task'}</button>}</div><span title={artifact.sha256}>{artifact.sha256.slice(0, 8)}</span><Button variant="ghost" size="sm" disabled={download !== null} onClick={() => { setDownload({ id: artifact.id, received: 0 }); void run(() => downloadArtifact(client, artifact, goal.coordinatorId, received => setDownload({ id: artifact.id, received }))).finally(() => setDownload(null)); }}><Download size={14} />{download?.id === artifact.id ? `${Math.round((download.received / Math.max(1, artifact.size)) * 100)}%` : 'Download'}</Button></article>)}</div> : <p>No retained artifacts.</p>}</Panel>}
    {section === 'completion' && <Panel title="Completion evidence" actions={active && goal.status !== 'paused' && goal.autonomy === 'manual' && tasks.length > 0 && tasks.every(task => ['completed', 'canceled'].includes(task.status)) ? <Button size="sm" onClick={() => void run(() => client.post(`/api/goals/${goal.id}/evaluate`))}>Evaluate completion</Button> : undefined}>{evaluations.error ? <div className="error-banner">{evaluations.error}</div> : latestEvaluation ? <div className="completion-evidence"><p>{latestEvaluation.evaluation.summary}</p><div className="goal-facts"><Status state={latestEvaluation.evaluation.complete ? 'completed' : 'review'} label={latestEvaluation.evaluation.complete ? 'Criteria met' : 'More work required'} /><span>Evaluated {relativeTime(latestEvaluation.at)}</span><code>{latestEvaluation.head}</code></div>{latestEvaluation.evaluation.criteria.map((criterion, index) => <article className="criterion-evidence" key={index}><div className="task-heading"><Status state={criterion.satisfied ? 'completed' : 'waiting'} label={criterion.satisfied ? 'Satisfied' : 'Outstanding'} /><strong>{criterion.criterion}</strong></div><ul>{criterion.evidence.map((item, evidenceIndex) => <li key={evidenceIndex}>{item}</li>)}</ul></article>)}</div> : <p>No completion evaluation has been recorded. The evaluator checks the goal criteria against accepted source and evidence.</p>}</Panel>}
    <Modal open={detailsOpen} onClose={() => setDetailsOpen(false)} title="Goal details" description="The objective, completion criteria and current execution settings." className="goal-details-modal">
      <div className="goal-details-content"><section><h3>Objective</h3><p>{goal.objective}</p></section>{goal.criteria.length > 0 && <section><h3>Completion criteria</h3><ul>{goal.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></section>}
        <section><h3>Execution</h3><dl className="goal-details-facts"><dt>Project</dt><dd>{project?.name ?? 'Project'}</dd><dt>Autonomy</dt><dd>{goal.autonomy}</dd><dt>Approvals</dt><dd>{goal.approvalMode === 'approve-all' ? 'Approve all' : goal.approvalMode}</dd><dt>Agent</dt><dd>{goal.runtime}</dd><dt>Maximum agents</dt><dd>{goal.concurrency}</dd><dt>Workspace</dt><dd>{goal.workspaceProvider === 'artifactfs' ? 'ArtifactFS' : 'Git'}</dd><dt>Goal revision</dt><dd>{goal.revision}</dd>{control && <><dt>Recorded cost</dt><dd>${control.spent.toFixed(2)}{control.unpricedTurns ? ` · ${control.unpricedTurns} unpriced turns` : ''}</dd></>}</dl>{active && <Button size="sm" variant="outline" onClick={() => { setDetailsOpen(false); setControlsOpen(true); }}><SlidersHorizontal size={14} />Execution settings</Button>}</section>
        {inspection.data?.plan && <details className="goal-plan-details"><summary>Recorded plan · revision {inspection.data.plan.revision}</summary><p>{inspection.data.plan.summary}</p>{inspection.data.plan.checks.length > 0 && <><strong>Goal checks</strong><ul>{inspection.data.plan.checks.map(command => <li key={command}><code>{command}</code></li>)}</ul></>}</details>}
        {active && <form className="goal-steering" onSubmit={event => { event.preventDefault(); if (steering.trim()) void run(async () => { await client.post(`/api/goals/${goal.id}/steer`, { context: steering }); setSteering(''); setDetailsOpen(false); }); }}><Field label="Add guidance" hint="Changes the goal context and asks the factory to revise outstanding work."><div className="steering-input"><Input value={steering} onChange={(event: ChangeEvent<HTMLInputElement>) => setSteering(event.target.value)} placeholder="Add requirements or change direction" /><Button type="submit" variant="outline" disabled={!steering.trim()}><Send size={14} />Send</Button></div></Field></form>}
        {active && <div className="goal-details-danger"><Button size="sm" variant="ghost" onClick={() => void run(async () => { await client.post(`/api/goals/${goal.id}/cancel`); setDetailsOpen(false); })}><Square size={13} />Cancel goal</Button><span>Stops new work and integration; retained work stays inspectable.</span></div>}
      </div>
    </Modal>
    <GoalControls goal={goal} maxDurationMs={control?.maxDurationMs} client={client} open={controlsOpen} close={() => setControlsOpen(false)} run={run} />
  </div>;
}

export function GoalsPage({ state, client, run, onNew, openSession, onOpenChat, selection, onSelectionChange, onOpenDevices }: { state: FactoryState; client: DeviceClient; run: Run; onNew: () => void; openSession: (id: string) => void; onOpenChat?: (sessionId: string, chatId: string) => void; selection?: GoalSelection; onSelectionChange?: (value: GoalSelection) => void; onOpenDevices?: () => void }) {
  const [localSelection, setLocalSelection] = useState<GoalSelection>({});
  const selected = selection ?? localSelection;
  const select = (value: GoalSelection) => { setLocalSelection(value); onSelectionChange?.(value); };
  const goal = state.goals.find(item => item.id === selected.goalId);
  if (goal) return <GoalWorkspace key={goal.id} goal={goal} state={state} client={client} run={run} selection={selected} select={select} openSession={openSession} onOpenChat={onOpenChat} onOpenDevices={onOpenDevices} />;
  return <div className="goals-index"><PageHeader title="Goals" actions={<Button disabled={!state.projects.length} onClick={onNew}><Plus size={15} />New goal</Button>} />{state.goals.length ? <div className="goal-table">{state.goals.map(item => { const tasks = state.tasks.filter(task => task.goalId === item.id); return <button className="goal-table-row" key={item.id} onClick={() => select({ goalId: item.id })}><div><strong>{item.title || 'Untitled goal'}</strong><span>{state.projects.find(project => project.id === item.projectId)?.name ?? 'Project'} · {item.objective.split('\n')[0]}</span></div><Status state={item.status} /><span>{tasks.filter(task => task.status === 'completed').length}/{tasks.length} accepted</span><ArrowUpRight size={14} /></button>; })}</div> : <EmptyState icon={<ListTodo size={28} />} title="No goals">Create a goal to plan tasks and coordinate work across your devices.</EmptyState>}</div>;
}
