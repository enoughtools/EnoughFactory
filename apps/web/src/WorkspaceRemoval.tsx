import { useEffect, useState } from 'react';
import type { Project, Session } from '@enoughfactory/contracts';
import { Archive, ArrowLeft, Box, Folder, LoaderCircle, RotateCcw, Square, Trash2 } from 'lucide-react';
import type { DeviceClient } from './api';
import { relativeTime, useResource } from './hooks';
import { Button, EmptyState, Loading, Modal, Panel } from './ui';
import './workspace-removal.css';

type Run = (action: () => Promise<unknown>) => Promise<void>;
type RemovedProject = Project & { archivedAt?: string };
type RemovedSession = Session & { archivedAt?: string };

export function RemoveEnvironmentAction({ session, client, run, onRemoved, onOpenChange, disabled = false, compact = false }: {
  session: Session; client: DeviceClient; run: Run; onRemoved?: () => void; onOpenChange?: (open: boolean) => void; disabled?: boolean; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'remove' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopped = session.status === 'stopped' || session.status === 'failed';
  const canStop = ['ready', 'starting', 'failed', 'unknown'].includes(session.status);
  function changeOpen(next: boolean) { setOpen(next); onOpenChange?.(next); }
  async function act(action: 'remove' | 'stop') {
    setBusy(action); setError(null);
    try {
      await run(async () => {
        try {
          if (action === 'stop') await client.post(`/api/sessions/${session.id}/stop`);
          else {
            await client.post(`/api/sessions/${session.id}/archive`);
            changeOpen(false); onRemoved?.();
          }
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      });
    } finally { setBusy(null); }
  }
  return <>
    <Button variant="ghost" size={compact ? 'icon' : 'sm'} disabled={disabled}
      aria-label={`Remove environment ${session.name}`} title={disabled ? 'Connect this environment’s device to remove it.' : `Remove environment ${session.name}`}
      onClick={() => { setError(null); changeOpen(true); }}>
      <Trash2 size={15} />{!compact && 'Remove environment'}
    </Button>
    <Modal open={open} onClose={() => { if (!busy) changeOpen(false); }} title={`Remove environment “${session.name}”?`}
      description="Remove it from your workbench. Its repository, branch, chats and history remain on the device; you can restore it from Removed.">
      <div className="modal-form removal-confirmation">
        {!stopped && <p className="notice">{session.status === 'unknown'
          ? 'Its execution state is unknown. Reconnect the owning device and reconcile the environment before removing it.'
          : session.status === 'stopping' ? 'Waiting for the environment to stop. Remove it when the device confirms it is stopped.'
            : 'Stop this environment before removing it. Stopping returns its work through the normal repository workflow.'}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="header-actions">
          <Button variant="outline" disabled={!!busy} onClick={() => changeOpen(false)}>Cancel</Button>
          {canStop && <Button variant="outline" disabled={!!busy || disabled} onClick={() => void act('stop')}>
            {busy === 'stop' ? <LoaderCircle className="loading-spinner" size={15} /> : <Square size={13} />}
            {busy === 'stop' ? 'Stopping…' : 'Stop environment'}
          </Button>}
          <Button disabled={!stopped || !!busy || disabled} onClick={() => void act('remove')}>
            {busy === 'remove' ? <LoaderCircle className="loading-spinner" size={15} /> : <Trash2 size={15} />}
            {busy === 'remove' ? 'Removing…' : 'Remove environment'}
          </Button>
        </div>
      </div>
    </Modal>
  </>;
}

export function RemoveProjectAction({ project, client, run, onRemoved }: {
  project: Project; client: DeviceClient; run: Run; onRemoved?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    setBusy(true); setError(null);
    try {
      await run(async () => {
        try {
          await client.post(`/api/projects/${project.id}/archive`);
          setOpen(false); onRemoved?.();
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      });
    } finally { setBusy(false); }
  }
  return <>
    <Button variant="outline" onClick={() => { setError(null); setOpen(true); }}><Trash2 size={15} />Remove project</Button>
    <Modal open={open} onClose={() => { if (!busy) setOpen(false); }} title={`Remove project “${project.name}”?`}
      description="Remove the project and its environment list from your workbench. Its repository files, branches, chats and history remain on the device; you can restore it from Removed.">
      <div className="modal-form removal-confirmation">
        <p className="field-hint">Stop its environments and finish or cancel its goals before removing the project.</p>
        <code className="removal-repository-path">{project.path}</code>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="header-actions">
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={busy} onClick={() => void remove()}>{busy ? <LoaderCircle className="loading-spinner" size={15} /> : <Trash2 size={15} />}{busy ? 'Removing…' : 'Remove project'}</Button>
        </div>
      </div>
    </Modal>
  </>;
}

export function RemovedEnvironmentNotice({ sessionId, client, run, onRestored, onBack }: {
  sessionId: string; client: DeviceClient; run: Run; onRestored?: () => void; onBack?: () => void;
}) {
  const session = useResource<RemovedSession>(client, `/api/sessions/${sessionId}`);
  const project = useResource<RemovedProject>(client, session.data ? `/api/projects/${session.data.projectId}` : null);
  const [source, setSource] = useState<{ record: RemovedProject | null; error: string | null; loading: boolean }>({ record: null, error: null, loading: false });
  useEffect(() => {
    let active = true;
    setSource({ record: null, error: null, loading: !!project.data?.internal });
    if (project.data?.internal) void (async () => {
      try {
        let current = project.data!;
        const visited = new Set<string>();
        while (current.internal) {
          if (!current.sourceProjectId || visited.has(current.id) || visited.size >= 32) throw new Error('The source project could not be resolved. Restore it from Workbench → Removed.');
          visited.add(current.id);
          current = await client.get<RemovedProject>(`/api/projects/${current.sourceProjectId}`);
        }
        if (active) setSource({ record: current, error: null, loading: false });
      } catch (cause) { if (active) setSource({ record: null, error: cause instanceof Error ? cause.message : String(cause), loading: false }); }
    })();
    return () => { active = false; };
  }, [client, project.data]);
  const restorableProject = project.data?.internal ? source.record : project.data;
  const projectLoading = project.loading || source.loading || (!!project.data?.internal && !source.record && !source.error);
  const projectError = project.error ?? source.error;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function restore() {
    setBusy(true); setError(null);
    try {
      await run(async () => {
        try {
          if (restorableProject?.archivedAt) await client.post(`/api/projects/${restorableProject.id}/restore`);
          else if (session.data?.archivedAt) await client.post(`/api/sessions/${sessionId}/restore`);
          await Promise.all([session.refresh(), project.refresh()]);
          const current = await client.get<RemovedSession>(`/api/sessions/${sessionId}`);
          if (!current.archivedAt) onRestored?.();
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      });
    } finally { setBusy(false); }
  }
  return <div className="removed-environment-notice">
    {session.loading ? <Loading>Reading environment history…</Loading> : <>
      <strong>{session.data?.name ?? 'Environment unavailable'}</strong>
      <p>{restorableProject?.archivedAt ? `Its project “${restorableProject.name}” was removed. Restore the project to inspect this environment and its chats.`
        : session.data?.archivedAt ? 'This environment was removed from the workbench. Restore it to inspect its workspace and chats.'
          : session.error ? 'Open Workbench → Removed to restore this environment, or reconnect its owning device.'
            : 'Refresh the workbench to inspect this environment and its chats.'}</p>
      {(error || session.error || projectError) && <div className="error-banner" role="alert">{error ?? session.error ?? projectError}</div>}
      <div className="header-actions">{onBack && <Button variant="ghost" size="sm" disabled={busy} onClick={onBack}><ArrowLeft size={14} />Workbench</Button>}
      {session.data && !projectLoading && !projectError && <Button variant="outline" size="sm" disabled={busy} onClick={() => void restore()}>
        {busy ? <LoaderCircle className="loading-spinner" size={14} /> : <RotateCcw size={14} />}
        {busy ? 'Restoring…' : restorableProject?.archivedAt ? 'Restore project' : session.data.archivedAt ? 'Restore environment' : 'Refresh workspace'}
      </Button>}</div>
    </>}
  </div>;
}

export function RemovedItemsPanel({ client, run }: { client: DeviceClient; run: Run }) {
  const projects = useResource<RemovedProject[]>(client, '/api/projects?archived=1');
  const sessions = useResource<RemovedSession[]>(client, '/api/sessions?archived=1');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  async function restore(kind: 'projects' | 'sessions', id: string) {
    setBusy(`${kind}:${id}`); setActionError(null);
    try {
      await run(async () => {
        try {
          await client.post(`/api/${kind}/${id}/restore`);
          await Promise.all([projects.refresh(), sessions.refresh()]);
        } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
      });
    } finally { setBusy(null); }
  }
  const items = [
    ...(projects.data ?? []).filter(project => project.archivedAt).map(project => ({ ...project, kind: 'projects' as const, detail: project.path, icon: Folder })),
    ...(sessions.data ?? []).filter(session => session.archivedAt).map(session => ({ ...session, kind: 'sessions' as const, detail: session.branch ?? session.status, icon: Box })),
  ].sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));
  return <Panel title="Removed" actions={<Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void Promise.all([projects.refresh(), sessions.refresh()])}><RotateCcw size={14} />Refresh</Button>}>
    <p className="field-hint removed-items-hint">Restore a project before restoring its environments. Repository files, branches, chats and history are retained.</p>
    {actionError && <div className="error-banner" role="alert">{actionError}</div>}
    {projects.error && <div className="error-banner" role="alert">Projects: {projects.error}</div>}
    {sessions.error && <div className="error-banner" role="alert">Environments: {sessions.error}</div>}
    {projects.loading || sessions.loading ? <Loading>Reading removed items…</Loading> : items.length ? <div className="removed-items-list">
      {items.map(item => <article className="removed-item" key={`${item.kind}:${item.id}`}>
        <item.icon size={18} />
        <div className="removed-item-info"><strong>{item.name}</strong><span>{item.kind === 'projects' ? 'Project' : 'Environment'} · {item.detail}</span></div>
        {item.archivedAt && <span className="removed-item-time">{relativeTime(item.archivedAt)}</span>}
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void restore(item.kind, item.id)}>
          {busy === `${item.kind}:${item.id}` ? <LoaderCircle className="loading-spinner" size={14} /> : <RotateCcw size={14} />}
          {busy === `${item.kind}:${item.id}` ? 'Restoring…' : 'Restore'}
        </Button>
      </article>)}
    </div> : !projects.error && !sessions.error && <EmptyState icon={<Archive size={24} />} title="Nothing removed">Projects and environments you remove appear here.</EmptyState>}
  </Panel>;
}
