import { useEffect, useState } from 'react';
import type { ApprovalMode, AutonomyMode, FactoryState, RuntimeKind, Session } from '@enoughfactory/contracts';
import { FileText, LoaderCircle, MessageSquare, Plus, Send, Target, Upload } from 'lucide-react';
import type { DeviceClient } from './api';
import { ChatPane } from './ChatPane';
import { clearGoalDraft, goalObjective, parseGoalProposal, readGoalDraft, saveGoalDraft, type GoalDraft } from './goal-draft';
import { policies } from './SettingsPage';
import { Button, Field, Input, Status } from './ui';
import './goal-composer.css';

type Run = (action: () => Promise<unknown>) => Promise<void>;
interface Props {
  state: FactoryState; client: DeviceClient; run: Run; projectId: string | null; busy: boolean;
  creationError?: string | null;
  onSubmit: (values: Record<string, unknown>) => Promise<boolean>;
}

function assistantPrompt(draft: GoalDraft) {
  return `Help me define the initial goal and specification for this project. This is a specification conversation before factory execution. Inspect source as useful, ask me focused questions when information is missing, and discuss scope, constraints, user behavior and observable completion criteria. Do not implement the product, change source or start execution. When you have a useful draft, include one JSON code block with {"title":"short goal name","objective":"desired outcome","specification":"complete Markdown specification","criteria":["observable completion criterion"]}. Keep this draft current as we discuss it. EnoughFactory lets me explicitly apply it and edit it before creating the goal.\n\nCurrent draft:\n${JSON.stringify({ title: draft.title, objective: draft.objective, specification: draft.specification, criteria: draft.criteria.split('\n').filter(value => value.trim()) }, null, 2)}`;
}

export function GoalComposer(props: Props) {
  const [projectId, setProjectId] = useState(props.projectId ?? props.state.projects[0]?.id ?? '');
  const project = props.state.projects.find(item => item.id === projectId);
  return <div className="goal-composer">
    <Field label="Project" hint={projectId && !project ? 'This project is no longer available. Its local draft is retained.' : undefined}><select required value={project ? projectId : ''} onChange={event => setProjectId(event.target.value)}><option value="" disabled>Choose a project</option>{props.state.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
    {project ? <ProjectDraft key={`${project.deviceId}:${projectId}`} {...props} projectId={projectId} /> : <p className="field-hint">{props.state.projects.length ? 'Choose a project to draft its goal.' : 'Add a project before creating a goal.'}</p>}
  </div>;
}

function ProjectDraft({ state, client, run, projectId, busy, onSubmit, creationError }: Omit<Props, 'projectId'> & { projectId: string }) {
  const project = state.projects.find(item => item.id === projectId)!;
  const draftKey = `enoughfactory.goal-draft.${project.deviceId}.${projectId}`;
  const [draft, setDraft] = useState(() => readGoalDraft(draftKey));
  const [saved, setSaved] = useState(true);
  const [autonomy, setAutonomy] = useState<AutonomyMode>('autonomous');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(state.settings.defaultApprovalMode);
  const [runtime, setRuntime] = useState<RuntimeKind>(state.settings.defaultRuntime);
  const [concurrency, setConcurrency] = useState(8);
  const [workspaceProvider, setWorkspaceProvider] = useState<'git' | 'artifactfs'>('git');
  const [starting, setStarting] = useState(false);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const sessions = state.sessions.filter(session => session.projectId === projectId);
  const session = sessions.find(item => item.id === draft.sessionId);
  const chat = state.chats.find(item => item.id === draft.chatId && item.sessionId === session?.id);
  const artifactFsAvailable = state.devices.some(device => device.online && device.workspaceProviders?.includes('artifactfs')) || (project.deviceId === state.device.id && state.diagnostics.containerRuntime?.artifactFsSupported === true);
  const workspaceAvailable = workspaceProvider === 'git' || artifactFsAvailable;
  const ownerOnline = state.devices.find(device => device.id === project.deviceId)?.online !== false;
  const readyToCreate = !!projectId && !!(draft.objective.trim() || draft.specification.trim()) && workspaceAvailable && Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 32;
  useEffect(() => { setSaved(saveGoalDraft(draftKey, draft)); }, [draftKey, draft]);
  const update = (fields: Partial<GoalDraft>) => { setDraft(value => ({ ...value, ...fields })); setDraftNotice(null); };
  const assistantRun: Run = async action => {
    setAssistantError(null);
    await run(async () => { try { return await action(); } catch (cause) { setAssistantError(cause instanceof Error ? cause.message : String(cause)); throw cause; } });
  };
  async function startEnvironment() {
    setStarting(true);
    await assistantRun(async () => {
      const name = `spec-${project.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 36)}-${Date.now().toString(36)}`;
      const result = await client.post<Session>('/api/sessions', { projectId, name });
      update({ sessionId: result.id, chatId: undefined });
    });
    setStarting(false);
  }
  function useProposal(text: string) {
    const proposal = parseGoalProposal(text);
    if (!proposal) { setAssistantError('This reply has no structured draft. Ask the agent to include the title, objective, specification and criteria in a JSON code block.'); return; }
    setAssistantError(null);
    setDraft(value => ({ ...value, ...proposal }));
    setDraftNotice('Agent draft applied. Edit the specification before creating the goal.');
  }
  async function importSpec(file?: File) {
    if (!file) return;
    if (file.size > 1024 * 1024) { setAssistantError('Choose a specification smaller than 1 MB.'); return; }
    try { update({ specification: await file.text() }); }
    catch { setAssistantError('The specification file could not be read.'); }
  }
  return <div className="goal-draft-layout">
    <form className="goal-draft-editor modal-form" onSubmit={event => { event.preventDefault(); if (!readyToCreate) return; void onSubmit({ projectId, title: draft.title.trim(), objective: goalObjective(draft), criteria: draft.criteria.split('\n').map(value => value.trim()).filter(Boolean), autonomy, approvalMode, runtime, concurrency, workspaceProvider }).then(created => { if (created) clearGoalDraft(draftKey, draft); }); }}>
      <div className="goal-draft-fields">
        <Field label="Goal name" hint="Optional. Defaults to the first line of your outcome."><Input value={draft.title} onChange={event => update({ title: event.target.value })} placeholder="Goal name" /></Field>
        <Field label="Outcome"><textarea autoFocus rows={2} value={draft.objective} onChange={event => update({ objective: event.target.value })} placeholder="What should exist when this goal is complete?" /></Field>
        <Field label="Maximum agents" hint="The factory plans and assigns parallel tasks within this limit and your devices’ capacity."><Input required type="number" min={1} max={32} value={concurrency} onChange={event => setConcurrency(Number(event.target.value))} /></Field>
        <div className="specification-heading"><span><FileText size={14} />Specification</span><label className="spec-import"><Upload size={13} />Import .md<input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" onChange={event => { void importSpec(event.target.files?.[0]); event.target.value = ''; }} /></label></div>
        <textarea className="specification-editor" aria-label="Specification" value={draft.specification} onChange={event => update({ specification: event.target.value })} placeholder={'## Users and behavior\n\n## Scope\n\n## Constraints\n\n## Deliverables'} spellCheck={false} />
        <Field label="Completion criteria" hint="One observable result per line."><textarea rows={3} value={draft.criteria} onChange={event => update({ criteria: event.target.value })} placeholder="One completion criterion per line…" /></Field>
        <details className="goal-execution-options"><summary>Execution settings · {autonomy} · {runtime}</summary><div className="form-grid">
          <Field label="Autonomy"><select value={autonomy} onChange={event => setAutonomy(event.target.value as AutonomyMode)}><option value="autonomous">Autonomous</option><option value="assisted">Assisted</option><option value="manual">Manual</option></select></Field>
          <Field label="Approval policy"><select value={approvalMode} onChange={event => setApprovalMode(event.target.value as ApprovalMode)}>{policies.map(policy => <option key={policy.mode} value={policy.mode}>{policy.label}</option>)}</select></Field>
          <Field label="Execution agent"><select value={runtime} onChange={event => setRuntime(event.target.value as RuntimeKind)}><option value="codex">Codex</option><option value="antigravity">Antigravity</option><option value="claude">Claude</option></select></Field>
          <Field label="Repository workspace"><select value={workspaceProvider} onChange={event => setWorkspaceProvider(event.target.value as 'git' | 'artifactfs')}><option value="git">Git — isolated worktree</option><option value="artifactfs" disabled={!artifactFsAvailable}>ArtifactFS — lazy Git mount</option></select></Field>
        </div></details>
      </div>
      {creationError && <div className="error-banner" role="alert">{creationError}</div>}
      <footer className="goal-draft-footer"><span role="status">{!saved ? 'Draft storage unavailable; keep this window open' : draftNotice ?? 'Draft saved on this device'}</span><Button type="submit" disabled={busy || !readyToCreate}><Target size={15} />{busy ? 'Starting…' : autonomy === 'manual' ? 'Create goal' : 'Start goal'}</Button></footer>
    </form>
    <section className="goal-draft-assistant" aria-label="Goal assistant">
      <header><strong><MessageSquare size={15} />Goal assistant</strong>{chat && <Button type="button" size="sm" variant="ghost" disabled={chat.status === 'running' || chat.status === 'waiting'} onClick={() => void assistantRun(() => client.post(`/api/chats/${chat.id}/messages`, { text: assistantPrompt(draft) }))}><Send size={13} />Send current draft</Button>}</header>
      {!!sessions.length && <details className="goal-execution-options"><summary>Assistant workspace</summary><Field label="Workspace"><select value={session?.id ?? ''} disabled={starting} onChange={event => update({ sessionId: event.target.value || undefined, chatId: undefined })}><option value="">Create an isolated workspace</option>{sessions.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></Field></details>}
      {assistantError && <div className="error-banner" role="alert">{assistantError}</div>}
      {!session ? <div className="draft-assistant-start"><p>Use an agent to explore the project, refine the spec and propose completion criteria.</p><Button type="button" variant="outline" disabled={starting || !ownerOnline} onClick={() => void startEnvironment()}>{starting ? <LoaderCircle className="loading-spinner" size={15} /> : <Plus size={15} />}{starting ? 'Preparing assistant…' : 'Start goal assistant'}</Button>{!ownerOnline && <p className="field-hint">The project’s device is offline.</p>}</div>
        : session.status === 'ready' ? <ChatPane key={session.id} state={state} client={client} session={session} run={assistantRun} initialChatId={draft.chatId} drafting={{ prompt: assistantPrompt(draft), onChatCreated: id => update({ chatId: id }), onUseMessage: useProposal }} />
        : <div className="draft-assistant-start"><Status state={session.status} /><p>{session.error ?? session.phase ?? (session.status === 'starting' ? 'Preparing the assistant workspace…' : 'Resume the assistant to continue.')}</p>{session.status === 'starting' ? <LoaderCircle className="loading-spinner" size={24} /> : ['stopped', 'failed'].includes(session.status) && <Button type="button" variant="outline" disabled={!ownerOnline} onClick={() => void assistantRun(() => client.post(`/api/sessions/${session.id}/restart`))}>Resume assistant</Button>}</div>}
    </section>
  </div>;
}
