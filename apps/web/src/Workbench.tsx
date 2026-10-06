import { useState } from 'react';
import type { FactoryState, Goal, Project } from '@enoughfactory/contracts';
import { ArrowUpRight, Box, Folder, FolderPlus, Plus, Settings2, Target } from 'lucide-react';
import type { DeviceClient } from './api';
import { relativeTime } from './hooks';
import { RuntimePanel } from './RuntimePanel';
import { RemoveEnvironmentAction, RemovedItemsPanel } from './WorkspaceRemoval';
import { Button, EmptyState, PageHeader, Panel, Status } from './ui';
import './goal-workbench.css';

type Run = (action: () => Promise<unknown>) => Promise<void>;

function GoalRow({ goal, state, onOpen, showProject }: { goal: Goal; state: FactoryState; onOpen: (id: string) => void; showProject: boolean }) {
  const tasks = state.tasks.filter(task => task.goalId === goal.id);
  const accepted = tasks.filter(task => task.status === 'completed').length;
  const inFlight = tasks.filter(task => task.status === 'running' || task.status === 'review').length;
  const unknown = state.attempts.filter(attempt => attempt.status === 'unknown' && tasks.some(task => task.currentAttemptId === attempt.id)).length;
  const owner = state.devices.find(device => device.id === goal.coordinatorId);
  return <button className="workbench-goal-row" onClick={() => onOpen(goal.id)} aria-label={`Open goal ${goal.title || 'Untitled goal'}`}>
    <div className="workbench-goal-identity"><strong>{goal.title || 'Untitled goal'}</strong><span>{showProject ? `${state.projects.find(project => project.id === goal.projectId)?.name ?? 'Project outside current catalog'} · ` : ''}{goal.objective.split('\n')[0]}</span><p>{goal.error || goal.nextAction || 'No next action recorded.'}</p></div>
    <div className="workbench-goal-progress"><Status state={goal.status} /><span>{accepted} / {tasks.length} tasks accepted</span>{unknown > 0 && <span className="workbench-goal-attention">{unknown} outcome{unknown === 1 ? '' : 's'} unknown</span>}</div>
    <div className="workbench-goal-agents"><strong>{inFlight} / {goal.concurrency}</strong><span>Tasks in flight / agent limit</span>{owner && <span>{owner.name}{owner.online === false ? ' · offline' : ''}</span>}</div><ArrowUpRight size={14} />
  </button>;
}

export function Workbench({ state, client, run, project, onProject, onSession, onOpenGoal, onAdd, onStart, onGoal, onSettings }: {
  state: FactoryState; client: DeviceClient; run: Run; project?: Project;
  onProject: (id: string) => void; onSession: (id: string) => void; onOpenGoal: (id: string) => void;
  onAdd: () => void; onStart: (id: string) => void; onGoal: (id?: string) => void; onSettings: () => void;
}) {
  const [showRemoved, setShowRemoved] = useState(false);
  const goals = state.goals.filter(goal => !project || goal.projectId === project.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const current = goals.filter(goal => !['completed', 'canceled'].includes(goal.status));
  const finished = goals.filter(goal => ['completed', 'canceled'].includes(goal.status));
  const goalIds = new Set(goals.map(goal => goal.id));
  const taskIds = new Set(state.tasks.filter(task => goalIds.has(task.goalId)).map(task => task.id));
  const managedSessionIds = new Set([...state.tasks.filter(task => taskIds.has(task.id)).map(task => task.sessionId), ...state.attempts.filter(attempt => taskIds.has(attempt.taskId)).map(attempt => attempt.sessionId)].filter((id): id is string => !!id));
  const sessions = state.sessions.filter(session => !project || session.projectId === project.id || managedSessionIds.has(session.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const activeSessions = sessions.filter(session => !['stopped', 'failed'].includes(session.status));
  const runtime = state.diagnostics.containerRuntime;
  const onlineDevices = state.devices.filter(device => device.online);
  const slots = onlineDevices.reduce((sum, device) => sum + (device.capacity ?? 2), 0);
  const inFlight = state.tasks.filter(task => goalIds.has(task.goalId) && ['running', 'review'].includes(task.status)).length;
  const needsRuntimeAttention = runtime && ['unavailable', 'failed', 'starting', 'stopping'].includes(runtime.state);

  return <div className="goal-workbench">
    <PageHeader title={project?.name ?? 'Workbench'} actions={<>{project ? <Button variant="ghost" size="icon" aria-label="Project settings" onClick={onSettings}><Settings2 size={16} /></Button> : <Button variant="ghost" onClick={onAdd}><FolderPlus size={15} />Add project</Button>}<Button disabled={!state.projects.length} onClick={() => onGoal(project?.id)}><Plus size={15} />Start goal</Button></>} />
    <div className="workbench-facts"><span>{current.length} current goal{current.length === 1 ? '' : 's'}</span><span>{inFlight} tasks in flight</span><span title="Configured worker slots on online devices. Placement also checks task resources and dependencies.">{slots} worker slots · {onlineDevices.length} online device{onlineDevices.length === 1 ? '' : 's'}</span>{project && <code title={project.path}>{project.path}</code>}</div>
    {needsRuntimeAttention && <RuntimePanel state={state} client={client} run={run} compact />}
    {!state.projects.length ? <Panel><EmptyState icon={<Folder size={24} />} title="Add a project" action={<Button onClick={onAdd}><FolderPlus size={15} />Add project</Button>}>Choose a repository, then give the factory a goal.</EmptyState></Panel> : <>
      <Panel title={project ? 'Goals' : 'Current goals'} actions={<span>{current.length}</span>} className="workbench-goals-panel">{current.length ? <div className="workbench-goals">{current.map(goal => <GoalRow key={goal.id} goal={goal} state={state} onOpen={onOpenGoal} showProject={!project} />)}</div> : <EmptyState icon={<Target size={24} />} title={project ? 'No current goals' : 'Start a goal'} action={<Button onClick={() => onGoal(project?.id)}><Plus size={15} />Start goal</Button>}>Describe the outcome and choose the maximum number of agents.</EmptyState>}</Panel>
      {finished.length > 0 && <details className="workbench-goal-history"><summary>Completed and canceled goals <span>{finished.length}</span></summary><div className="workbench-goals">{finished.map(goal => <GoalRow key={goal.id} goal={goal} state={state} onOpen={onOpenGoal} showProject={!project} />)}</div></details>}
      {!project && <Panel title="Projects" className="workbench-projects-panel"><div className="workbench-project-list">{state.projects.map(item => { const projectGoals = state.goals.filter(goal => goal.projectId === item.id); const currentGoals = projectGoals.filter(goal => !['completed', 'canceled'].includes(goal.status)); const owner = state.devices.find(device => device.id === item.deviceId); return <article className="workbench-project-row" key={item.id}><button onClick={() => onProject(item.id)}><Folder size={16} /><div><strong>{item.name}</strong><span>{projectGoals.length} goal{projectGoals.length === 1 ? '' : 's'} · {currentGoals.length} current{owner ? ` · ${owner.name}${owner.online === false ? ' · offline' : ''}` : ''}</span></div><ArrowUpRight size={13} /></button><Button variant="ghost" size="sm" onClick={() => onGoal(item.id)}><Plus size={13} />Start goal</Button></article>; })}</div></Panel>}
    </>}
    <details className="workbench-diagnostics"><summary>Inspect environments and runtime <span>{activeSessions.length} active · {sessions.length} recorded</span></summary><div className="workbench-diagnostics-body">
      {!needsRuntimeAttention && runtime?.state !== 'ready' && <RuntimePanel state={state} client={client} run={run} compact />}
      {!state.diagnostics.envmux.available && <div className="notice"><Box size={15} /><span>{state.diagnostics.envmux.error || 'Environment tools are unavailable.'}</span></div>}
      <Panel title="Environments" actions={state.projects.length > 0 && <Button variant="ghost" size="sm" onClick={() => onStart(project?.id ?? state.projects[0]!.id)}><Plus size={13} />Start manually</Button>}>{sessions.length ? <div className="session-list">{sessions.map(session => <article className="session-list-row" key={session.id}><button className="session-row-main" onClick={() => onSession(session.id)}><div className="session-row-icon"><Box size={16} /></div><div className="session-row-info"><strong>{session.name}</strong><span>{state.devices.find(device => device.id === session.deviceId)?.name ?? 'Device'}</span></div><Status state={session.status} /><span className="session-row-time">{relativeTime(session.updatedAt)}</span><ArrowUpRight size={13} /></button><RemoveEnvironmentAction session={session} client={client} run={run} compact disabled={state.devices.find(device => device.id === session.deviceId)?.online === false} /></article>)}</div> : <p className="workbench-diagnostics-empty">No environments recorded.</p>}</Panel>
      <Button variant="ghost" size="sm" onClick={() => setShowRemoved(value => !value)} aria-expanded={showRemoved}>Removed items</Button>{showRemoved && <RemovedItemsPanel key={`${state.projects.length}:${state.sessions.length}`} client={client} run={run} />}
    </div></details>
  </div>;
}
