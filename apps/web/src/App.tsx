import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FactoryState, Goal, Project, RuntimeKind, Session } from '@enoughfactory/contracts';
import { SidebarProvider } from '@enoughtools/ui-react';
import { ArrowLeft, ArrowUpRight, Bell, Box, Folder, FolderPlus, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useFactory } from './api';
import { ApprovalCard } from './ChatPane';
import { DevicesPage } from './DevicesPage';
import { DesktopServiceRecovery, deviceConnectionError } from './BrowserConnection';
import { GoalsPage } from './GoalsPage';
import { GoalComposer } from './GoalComposer';
import { SessionWorkspace } from './SessionWorkspace';
import { ProjectSettings } from './ProjectSettings';
import { RemovedEnvironmentNotice } from './WorkspaceRemoval';
import { Workbench } from './Workbench';
import { FactorySidebar } from './FactorySidebar';
import { ConnectionForm, SettingsPage } from './SettingsPage';
import { Button, EmptyState, Field, Input, Loading, Modal, PageHeader, Panel } from './ui';

type View = 'workbench' | 'goals' | 'devices' | 'approvals' | 'settings';
type DialogName = 'project' | 'session' | 'goal' | 'connection' | 'project-settings' | null;

export function App() {
  const factory = useFactory();
  const { state, client, error, loading, connection, setConnection, refresh } = factory;
  const [view, setView] = useState<View>('workbench');
  const initialNavigationDone = useRef(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [requestedChatId, setRequestedChatId] = useState<string | null>(null);
  const [goalSelection, setGoalSelection] = useState<{ goalId?: string; taskId?: string; attemptId?: string }>({});
  const [projectId, setProjectId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setActionError(null);
    try { await action(); await refresh(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
  }, [refresh]);
  const session = state?.sessions.find(item => item.id === sessionId);
  const selectedProject = state?.projects.find(item => item.id === projectId);
  const selectedGoal = state?.goals.find(item => item.id === goalSelection.goalId);
  useEffect(() => {
    if (!state || initialNavigationDone.current) return;
    initialNavigationDone.current = true;
    const current = state.goals.filter(goal => ['planning', 'running', 'waiting', 'paused'].includes(goal.status));
    if (current.length !== 1) return;
    const goal = current[0]!;
    setGoalSelection({ goalId: goal.id }); setProjectId(goal.projectId); setView('goals');
  }, [state]);
  const openSession = (id: string) => { setSessionId(id); setRequestedChatId(null); setView('workbench'); };
  const openChat = (id: string, chatId: string) => { setSessionId(id); setRequestedChatId(chatId); setView('workbench'); };
  const pending = state?.approvals.filter(approval => approval.status === 'pending').length ?? 0;
  const running = state?.goals.filter(item => ['planning', 'running', 'waiting'].includes(item.status)).length ?? 0;
  function navigate(next: View) {
    initialNavigationDone.current = true;
    setView(next); setSessionId(null); setRequestedChatId(null); setGoalSelection({});
    if (next === 'workbench' || next === 'goals') setProjectId(null);
  }
  const openProject = (id: string) => { navigate('workbench'); setProjectId(id); };
  const openGoal = (id: string) => { const goal = state?.goals.find(item => item.id === id); setGoalSelection({ goalId: id }); setProjectId(goal?.projectId ?? null); setSessionId(null); setRequestedChatId(null); setView('goals'); };
  const startGoal = (id?: string) => { setProjectId(id ?? null); setDialog('goal'); };
  const selectGoal = (value: { goalId?: string; taskId?: string; attemptId?: string }) => { setGoalSelection(value); setProjectId(state?.goals.find(goal => goal.id === value.goalId)?.projectId ?? null); };
  const returnToGoal = () => { setSessionId(null); setRequestedChatId(null); setView('goals'); };
  return <SidebarProvider className="factory-shell" persistState={false}><FactorySidebar state={state} view={view} projectId={projectId} goalId={goalSelection.goalId} sessionSelected={!!sessionId} error={error} onNavigate={next => navigate(next as View)} onProject={openProject} onGoal={openGoal} onStartGoal={startGoal} onAddProject={() => setDialog('project')} onConnect={() => setDialog('connection')} /><div className="main-shell"><header className="topbar"><div className="breadcrumb"><strong>{session ? session.name : view === 'goals' && selectedGoal ? selectedProject?.name ?? 'Goal workspace' : view === 'workbench' && selectedProject ? selectedProject.name : view.charAt(0).toUpperCase() + view.slice(1)}</strong></div><div className="topbar-actions">{session && goalSelection.goalId && <Button variant="ghost" size="sm" onClick={returnToGoal}><ArrowLeft size={14} />Back to goal</Button>}{state && <span className="topbar-running"><span className={`status-dot state-${running ? 'running' : 'ready'}`} />{running} active goal{running === 1 ? '' : 's'}</span>}<Button variant="ghost" size="icon" aria-label="Refresh workspace" onClick={() => void refresh()}><RefreshCw size={15} /></Button>{pending > 0 && <Button variant="ghost" size="icon" aria-label={`${pending} pending approvals`} onClick={() => navigate('approvals')}><Bell size={16} /></Button>}</div></header>{error && state && <div className="connection-banner"><span>The device connection is unavailable. Last known state remains visible.</span><Button variant="ghost" size="sm" onClick={() => setDialog('connection')}>Reconnect</Button></div>}{actionError && <div className="error-banner" role="alert"><span>{actionError}</span><button aria-label="Dismiss error" onClick={() => setActionError(null)}><X size={15} /></button></div>}<main className={`workspace-content ${session && view === 'workbench' ? 'has-session' : view === 'goals' && goalSelection.goalId ? 'has-goal' : ''}`}>
    {loading && !state ? <Loading /> : !state ? <div className="onboarding-workspace"><PageHeader title="Connect a device" /><Panel title="Device service"><ConnectionForm connection={connection} onConnect={setConnection} />{error && <p className="error-banner">{deviceConnectionError(error)}</p>}<DesktopServiceRecovery error={error} onConnect={setConnection} /></Panel><p className="connection-help"><a href="https://factory.enoughtools.com/docs" target="_blank" rel="noreferrer">Installation guide <ArrowUpRight size={12} /></a></p></div> : view === 'workbench' ? session ? <SessionWorkspace key={`${session.id}:${requestedChatId ?? 'overview'}`} client={client} session={session} state={state} run={run} modalOpen={dialog !== null} initialChatId={requestedChatId ?? undefined} onRemoved={() => navigate('workbench')} /> : sessionId ? <RemovedEnvironmentNotice key={sessionId} sessionId={sessionId} client={client} run={run} onBack={() => navigate('workbench')} /> : <Workbench state={state} client={client} run={run} project={selectedProject} onProject={openProject} onOpenGoal={openGoal} onSession={openSession} onAdd={() => setDialog('project')} onStart={id => { setProjectId(id); setDialog('session'); }} onGoal={startGoal} onSettings={() => setDialog('project-settings')} /> : view === 'goals' ? <GoalsPage state={state} client={client} run={run} onNew={() => startGoal()} openSession={openSession} onOpenChat={openChat} selection={goalSelection} onSelectionChange={selectGoal} /> : view === 'devices' ? <DevicesPage state={state} client={client} run={run} onOpenSettings={() => navigate('settings')} /> : view === 'approvals' ? <><PageHeader title="Approvals" />{state.approvals.some(approval => approval.status === 'pending') ? <div className="approval-list">{state.approvals.filter(approval => approval.status === 'pending').map(approval => <ApprovalCard key={approval.id} approval={approval} client={client} run={run} />)}</div> : <Panel><EmptyState icon={<ShieldCheck size={34} />} title="No pending approvals">Requests needing a decision appear here.</EmptyState></Panel>}</> : <SettingsPage state={state} client={client} run={run} connection={connection} setConnection={setConnection} refresh={refresh} />}
  </main></div>
  <Modal open={dialog === 'connection'} onClose={() => setDialog(null)} title="Connect your device" description="Choose the service that owns this workspace."><ConnectionForm connection={connection} onConnect={value => { setConnection(value); setDialog(null); }} /></Modal>
  {state && <><Modal open={dialog === 'project'} onClose={() => setDialog(null)} title="Add project" description="Choose a local Git repository on the connected device."><ProjectForm busy={busy} onSubmit={async values => { setBusy(true); await run(async () => { const project = await client.post<Project>('/api/projects', values); setProjectId(project.id); setDialog(null); setView('workbench'); }); setBusy(false); }} defaultRuntime={state.settings.defaultRuntime} /></Modal><Modal open={dialog === 'session'} onClose={() => setDialog(null)} title="Start an environment" description="Create an isolated session for this project."><SessionForm state={state} projectId={projectId} busy={busy} onSubmit={async values => { setBusy(true); await run(async () => { const result = await client.post<Session>('/api/sessions', values); openSession(result.id); setDialog(null); }); setBusy(false); }} /></Modal><Modal open={dialog === 'goal'} onClose={() => setDialog(null)} title="Start a goal" description="Describe the outcome and choose the maximum number of agents." className="goal-composer-dialog"><GoalComposer state={state} client={client} run={run} projectId={projectId} busy={busy} creationError={actionError} onSubmit={async values => { setBusy(true); let created = false; await run(async () => { const goal = await client.post<Goal>('/api/goals', values); created = true; openGoal(goal.id); setProjectId(goal.projectId); setDialog(null); }); setBusy(false); return created; }} /></Modal></>}
  {selectedProject && <ProjectSettings key={selectedProject.id} project={selectedProject} client={client} open={dialog === 'project-settings'} close={() => setDialog(null)} run={run} onRemoved={() => navigate('workbench')} />}
  </SidebarProvider>;
}

function ProjectForm({ defaultRuntime, busy, onSubmit }: { defaultRuntime: RuntimeKind; busy: boolean; onSubmit: (values: { path: string; name?: string; runtime: RuntimeKind }) => Promise<void> }) {
  const [path, setPath] = useState(''); const [name, setName] = useState(''); const [runtime, setRuntime] = useState(defaultRuntime);
  return <form className="modal-form" onSubmit={event => { event.preventDefault(); void onSubmit({ path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}), runtime }); }}><Field label="Repository path" hint="Use an existing Git repository on the connected device."><div className="path-input"><Input autoFocus required value={path} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setPath(event.target.value)} placeholder="/home/you/code/project" />{window.enoughFactory && <Button variant="outline" type="button" aria-label="Choose repository folder" onClick={() => void window.enoughFactory!.pickDirectory().then(value => { if (value) setPath(value); })}><Folder size={16} /></Button>}</div></Field><Field label="Project name" hint="Optional. Defaults to your repository’s folder name."><Input value={name} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setName(event.target.value)} placeholder="Your project" /></Field><Field label="Default agent"><select value={runtime} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setRuntime(event.target.value as RuntimeKind)}><option value="codex">Codex</option><option value="antigravity">Antigravity</option><option value="claude">Claude</option></select></Field><Button type="submit" disabled={busy || !path.trim()}><FolderPlus size={16} />{busy ? 'Adding project…' : 'Add project'}</Button></form>;
}

function SessionForm({ state, projectId, busy, onSubmit }: { state: FactoryState; projectId: string | null; busy: boolean; onSubmit: (values: { projectId: string; name: string }) => Promise<void> }) {
  const [project, setProject] = useState(projectId ?? state.projects[0]?.id ?? ''); const [name, setName] = useState('');
  return <form className="modal-form" onSubmit={event => { event.preventDefault(); void onSubmit({ projectId: project, name: name.trim() }); }}><Field label="Project"><select required value={project} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setProject(event.target.value)}>{state.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Environment name"><Input autoFocus required value={name} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setName(event.target.value)} placeholder="Environment name" /></Field><div className="notice"><Box size={18} /><span>Full agent permissions inside an isolated container. Work keeps running when you close the window.</span></div><Button type="submit" disabled={busy || !project || !name.trim()}><Plus size={16} />{busy ? 'Starting…' : 'Start environment'}</Button></form>;
}
