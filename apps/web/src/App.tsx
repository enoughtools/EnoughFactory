import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FactoryState, Goal, Project, RuntimeKind, Session } from '@enoughfactory/contracts';
import { SidebarProvider } from '@enoughtools/ui-react';
import { ArrowLeft, ArrowUpRight, Box, Folder, FolderPlus, Plus, ShieldCheck, X } from 'lucide-react';
import { useFactory } from './api';
import { useResource } from './hooks';
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
import { WorkingDirectoriesEditor, normalizeWorkingDirectories, workingDirectoryError, type WorkingDirectory } from './WorkingDirectoriesEditor';
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
  const isGoalView = view === 'goals' && !!selectedGoal;
  const isWorkbenchView = view === 'workbench' || (view === 'goals' && !selectedGoal);
  const health = useResource<{ deviceId?: string; capabilities?: { workingDirectories?: boolean } }>(client, state ? '/api/health' : null, state ? 10000 : 0);
  const workingDirectoriesSupported = health.data?.deviceId === state?.device.id && health.data?.capabilities?.workingDirectories === true;
  const localDirectoryPicker = !!window.enoughFactory && client.connection.mode !== 'peer' && /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(client.connection.url);
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
  function navigate(next: View) {
    initialNavigationDone.current = true;
    setView(next === 'goals' ? 'workbench' : next); setSessionId(null); setRequestedChatId(null); setGoalSelection({});
    if (next === 'workbench' || next === 'goals') setProjectId(null);
  }
  const openProject = (id: string) => { navigate('workbench'); setProjectId(id); };
  const openGoal = (id: string) => { const goal = state?.goals.find(item => item.id === id); setGoalSelection({ goalId: id }); setProjectId(goal?.projectId ?? null); setSessionId(null); setRequestedChatId(null); setView('goals'); };
  const startGoal = (id?: string) => { setProjectId(id ?? null); setDialog('goal'); };
  const selectGoal = (value: { goalId?: string; taskId?: string; attemptId?: string }) => { setGoalSelection(value); setProjectId(state?.goals.find(goal => goal.id === value.goalId)?.projectId ?? null); };
  const returnToGoal = () => { setSessionId(null); setRequestedChatId(null); setView('goals'); };
  return <SidebarProvider className="factory-shell" persistState={false}><FactorySidebar state={state} view={view} projectId={projectId} goalId={goalSelection.goalId} sessionSelected={!!sessionId} error={error} desktopVersion={connection.appVersion} onNavigate={next => navigate(next as View)} onProject={openProject} onGoal={openGoal} onStartGoal={startGoal} onAddProject={() => setDialog('project')} onConnect={() => setDialog('connection')} onRefresh={() => void refresh()} /><div className="main-shell">{session && selectedGoal && <div className="workspace-return"><Button variant="ghost" size="sm" onClick={returnToGoal}><ArrowLeft size={14} />Back to goal</Button></div>}{error && state && <div className="connection-banner"><span>The device connection is unavailable. Last known state remains visible.</span><Button variant="ghost" size="sm" onClick={() => setDialog('connection')}>Reconnect</Button></div>}{actionError && <div className="error-banner" role="alert"><span>{actionError}</span><button aria-label="Dismiss error" onClick={() => setActionError(null)}><X size={15} /></button></div>}<main className={`workspace-content ${session && view === 'workbench' ? 'has-session' : isGoalView ? 'has-goal' : ''}`}>
    {loading && !state ? <Loading /> : !state ? <div className="onboarding-workspace"><PageHeader title="Connect a device" /><Panel title="Device service"><ConnectionForm connection={connection} onConnect={setConnection} />{error && <p className="error-banner">{deviceConnectionError(error)}</p>}<DesktopServiceRecovery error={error} onConnect={setConnection} /></Panel><p className="connection-help"><a href="https://factory.enoughtools.com/docs" target="_blank" rel="noreferrer">Installation guide <ArrowUpRight size={12} /></a></p></div> : isWorkbenchView ? session ? <SessionWorkspace key={`${session.id}:${requestedChatId ?? 'overview'}`} client={client} session={session} state={state} run={run} modalOpen={dialog !== null} initialChatId={requestedChatId ?? undefined} onRemoved={() => navigate('workbench')} /> : sessionId ? <RemovedEnvironmentNotice key={sessionId} sessionId={sessionId} client={client} run={run} onBack={() => navigate('workbench')} /> : <Workbench state={state} client={client} run={run} project={selectedProject} onProject={openProject} onOpenGoal={openGoal} onSession={openSession} onAdd={() => setDialog('project')} onStart={id => { setProjectId(id); setDialog('session'); }} onGoal={startGoal} onSettings={() => setDialog('project-settings')} /> : isGoalView ? <GoalsPage state={state} client={client} run={run} onNew={() => startGoal()} openSession={openSession} onOpenChat={openChat} selection={goalSelection} onSelectionChange={selectGoal} onOpenDevices={() => navigate('devices')} /> : view === 'devices' ? <DevicesPage state={state} client={client} run={run} onOpenSettings={() => navigate('settings')} /> : view === 'approvals' ? <><PageHeader title="Approvals" />{state.approvals.some(approval => approval.status === 'pending') ? <div className="approval-list">{state.approvals.filter(approval => approval.status === 'pending').map(approval => <ApprovalCard key={approval.id} approval={approval} client={client} run={run} />)}</div> : <Panel><EmptyState icon={<ShieldCheck size={34} />} title="No pending approvals">Requests needing a decision appear here.</EmptyState></Panel>}</> : <SettingsPage state={state} client={client} run={run} connection={connection} setConnection={setConnection} refresh={refresh} onOpenDevices={() => navigate('devices')} />}
  </main></div>
  <Modal open={dialog === 'connection'} onClose={() => setDialog(null)} title="Connect your device" description="Choose the service that owns this workspace."><ConnectionForm connection={connection} onConnect={value => { setConnection(value); setDialog(null); }} /></Modal>
  {state && <><Modal open={dialog === 'project'} onClose={() => setDialog(null)} title="Add project" description="Choose the primary repository and any additional working folders." className="project-folders-dialog"><ProjectForm busy={busy} canBrowse={localDirectoryPicker} deviceName={state.device.name} creationError={actionError} workingDirectoriesSupported={workingDirectoriesSupported} checkingCapabilities={health.loading} onSubmit={async values => { setBusy(true); await run(async () => { const project = await client.post<Project>('/api/projects', values); setProjectId(project.id); setDialog(null); setView('workbench'); }); setBusy(false); }} defaultRuntime={state.settings.defaultRuntime} /></Modal><Modal open={dialog === 'session'} onClose={() => setDialog(null)} title="Start an environment" description="Create an isolated session for this project."><SessionForm state={state} projectId={projectId} busy={busy} onSubmit={async values => { setBusy(true); await run(async () => { const result = await client.post<Session>('/api/sessions', values); openSession(result.id); setDialog(null); }); setBusy(false); }} /></Modal><Modal open={dialog === 'goal'} onClose={() => setDialog(null)} title="Start a goal" description="Describe the outcome and choose the maximum number of agents." className="goal-composer-dialog"><GoalComposer state={state} client={client} run={run} projectId={projectId} busy={busy} creationError={actionError} onSubmit={async values => { setBusy(true); let created = false; await run(async () => { const goal = await client.post<Goal>('/api/goals', values); created = true; openGoal(goal.id); setProjectId(goal.projectId); setDialog(null); }); setBusy(false); return created; }} /></Modal></>}
  {selectedProject && <ProjectSettings key={selectedProject.id} project={selectedProject} client={client} canBrowse={localDirectoryPicker && selectedProject.deviceId === state?.device.id} deviceName={state?.devices.find(device => device.id === selectedProject.deviceId)?.name} open={dialog === 'project-settings'} close={() => setDialog(null)} run={run} onRemoved={() => navigate('workbench')} />}
  </SidebarProvider>;
}

function ProjectForm({ defaultRuntime, busy, onSubmit, canBrowse, deviceName, creationError, workingDirectoriesSupported, checkingCapabilities }: { defaultRuntime: RuntimeKind; busy: boolean; canBrowse: boolean; deviceName: string; creationError?: string | null; workingDirectoriesSupported: boolean; checkingCapabilities: boolean; onSubmit: (values: { path: string; name?: string; runtime: RuntimeKind; workingDirectories: WorkingDirectory[] }) => Promise<void> }) {
  const [path, setPath] = useState(''); const [name, setName] = useState(''); const [runtime, setRuntime] = useState(defaultRuntime);
  const [workingDirectories, setWorkingDirectories] = useState<WorkingDirectory[]>([]);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const directoriesError = workingDirectoryError(workingDirectories, path);
  return <form className="modal-form" onSubmit={event => {
    event.preventDefault();
    if (directoriesError || (!workingDirectoriesSupported && workingDirectories.length)) return;
    void onSubmit({ path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}), runtime, workingDirectories: normalizeWorkingDirectories(workingDirectories) });
  }}><Field label="Primary repository" hint={`Git repository on ${deviceName}. This repository receives automatically integrated changes.`}><div className="path-input"><Input autoFocus required value={path} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setPath(event.target.value)} placeholder="/home/you/code/project" />{canBrowse && <Button variant="outline" type="button" aria-label="Choose primary repository folder" onClick={() => { setPickerError(null); void window.enoughFactory!.pickDirectory().then(value => { if (value) setPath(value); }).catch(cause => setPickerError(cause instanceof Error ? cause.message : String(cause))); }}><Folder size={16} /></Button>}</div></Field>{pickerError && <div className="error-banner" role="alert">{pickerError}</div>}<Field label="Project name" hint="Optional. Defaults to your repository’s folder name."><Input value={name} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setName(event.target.value)} placeholder="Your project" /></Field><WorkingDirectoriesEditor value={workingDirectories} onChange={setWorkingDirectories} canBrowse={canBrowse} disabled={busy || !workingDirectoriesSupported} deviceName={deviceName} />{!workingDirectoriesSupported && <p className="field-hint" role="status">{checkingCapabilities ? 'Checking support for additional working folders…' : 'Additional working folders require an updated device service. You can add the primary repository now.'}</p>}{directoriesError && <div className="error-banner" role="alert">{directoriesError}</div>}<Field label="Default agent"><select value={runtime} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setRuntime(event.target.value as RuntimeKind)}><option value="codex">Codex</option><option value="antigravity">Antigravity</option><option value="claude">Claude</option></select></Field>{creationError && <div className="error-banner" role="alert">{creationError}</div>}<Button type="submit" disabled={busy || !path.trim() || !!directoriesError || (!workingDirectoriesSupported && workingDirectories.length > 0)}><FolderPlus size={16} />{busy ? 'Adding project…' : 'Add project'}</Button></form>;
}

function SessionForm({ state, projectId, busy, onSubmit }: { state: FactoryState; projectId: string | null; busy: boolean; onSubmit: (values: { projectId: string; name: string }) => Promise<void> }) {
  const [project, setProject] = useState(projectId ?? state.projects[0]?.id ?? ''); const [name, setName] = useState('');
  return <form className="modal-form" onSubmit={event => { event.preventDefault(); void onSubmit({ projectId: project, name: name.trim() }); }}><Field label="Project"><select required value={project} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setProject(event.target.value)}>{state.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Environment name"><Input autoFocus required value={name} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setName(event.target.value)} placeholder="Environment name" /></Field><div className="notice"><Box size={18} /><span>Full agent permissions inside an isolated container. Work keeps running when you close the window.</span></div><Button type="submit" disabled={busy || !project || !name.trim()}><Plus size={16} />{busy ? 'Starting…' : 'Start environment'}</Button></form>;
}
