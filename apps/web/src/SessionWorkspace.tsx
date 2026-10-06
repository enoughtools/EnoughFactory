import type { ChangeEvent } from "react";
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { FactoryState, RepositoryChanges, Session } from '@enoughfactory/contracts';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@enoughtools/ui-react';
import { Activity, ArrowLeft, ArrowRight, ArrowUpRight, Box, GitBranch, Globe, LoaderCircle, MessageSquare, Play, RotateCcw, Square, TerminalSquare } from 'lucide-react';
import type { DeviceClient } from './api';
import { useResource } from './hooks';
import { ChatPane } from './ChatPane';
import { RuntimePanel } from './RuntimePanel';
import { RemoveEnvironmentAction } from './WorkspaceRemoval';
import { Button, EmptyState, Input, Loading, PageHeader, Panel, Status } from './ui';

type Run = (action: () => Promise<unknown>) => Promise<void>;
type SessionTab = 'overview' | 'agent' | 'terminal' | 'preview' | 'changes';
const TerminalPane = lazy(() => import('./TerminalPane').then(module => ({ default: module.TerminalPane })));

function Output({ client, session, task }: { client: DeviceClient; session: Session; task: string }) {
  const { data, error, loading } = useResource<string>(client, `/api/sessions/${session.id}/output${task === 'stdout' ? '' : `?task=${encodeURIComponent(task)}`}`, session.status === 'ready' || session.status === 'starting' ? 2000 : 0);
  const output = useRef<HTMLPreElement>(null);
  const [following, setFollowing] = useState(true);
  useEffect(() => { if (following && output.current) output.current.scrollTop = output.current.scrollHeight; }, [data, following]);
  return <div className="output-pane"><div className="output-toolbar"><span><Activity size={14} />{task === 'stdout' ? 'Environment output' : task}</span><label><input type="checkbox" checked={following} onChange={(event: ChangeEvent<HTMLInputElement>) => setFollowing(event.target.checked)} />Follow output</label></div>{loading ? <Loading>Loading output…</Loading> : error ? <div className="error-banner">{error}</div> : <pre ref={output} className="code-output live-output">{data || 'No output yet.'}</pre>}</div>;
}

function Changes({ client, session }: { client: DeviceClient; session: Session }) {
  const { data, error, loading } = useResource<RepositoryChanges>(client, `/api/sessions/${session.id}/changes`, session.status === 'ready' ? 5000 : 0);
  if (loading) return <Loading>Reading repository changes…</Loading>;
  if (error) return <EmptyState icon={<GitBranch size={32} />} title="Changes are unavailable">{error}</EmptyState>;
  return <div className="changes-pane"><div className="changes-header"><GitBranch size={16} /><strong>{data?.branch || session.branch || 'Working tree'}</strong>{data?.head && <span>{data.head.slice(0, 8)}</span>}</div>{data?.status && <pre className="code-output git-status">{data.status}</pre>}{data?.diff ? <pre className="code-output git-diff">{data.diff.split('\n').map((line, index) => <span className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-added' : line.startsWith('-') && !line.startsWith('---') ? 'diff-removed' : line.startsWith('@@') ? 'diff-context' : ''} key={index}>{line}{'\n'}</span>)}</pre> : <EmptyState icon={<GitBranch size={32} />} title="No uncommitted diff">Repository changes appear here as you work.</EmptyState>}</div>;
}

function Preview({ client, session, hidden }: { client: DeviceClient; session: Session; hidden: boolean }) {
  const [address, setAddress] = useState(session.services.find(service => service.url)?.url ?? 'http://localhost:3000');
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const lastTarget = useRef<string | null>(null);
  const desktop = Boolean(window.enoughFactory?.openPreview);
  const bounds = () => { const rect = viewport.current?.getBoundingClientRect(); return rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) } : undefined; };
  async function navigate() {
    setLoading(true); setError(null);
    try {
      const parsed = new URL(address);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Previews support HTTP and HTTPS addresses.');
      if (desktop) { await window.enoughFactory!.openPreview!({ sessionId: session.id, url: parsed.href, bounds: bounds() }); lastTarget.current = parsed.href; setTarget(parsed.href); }
      else { const result = await client.post<{ url: string }>(`/api/sessions/${session.id}/${client.connection.mode === 'peer' ? 'browser-preview' : 'preview'}`, { url: parsed.href }); setTarget(result.url); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    if (!desktop || !viewport.current) return;
    const observer = new ResizeObserver(() => { const rect = bounds(); if (rect && !hidden) void window.enoughFactory?.setPreviewBounds?.(rect); });
    observer.observe(viewport.current);
    const reposition = () => { const rect = bounds(); if (rect && !hidden) void window.enoughFactory?.setPreviewBounds?.(rect); };
    window.addEventListener('resize', reposition);
    return () => { observer.disconnect(); window.removeEventListener('resize', reposition); void window.enoughFactory?.closePreview?.(); };
  }, [desktop, hidden]);
  useEffect(() => { if (hidden) void window.enoughFactory?.closePreview?.(); else if (desktop && lastTarget.current) void window.enoughFactory?.openPreview?.({ sessionId: session.id, url: lastTarget.current, bounds: bounds() }); }, [hidden, desktop, session.id]);
  useEffect(() => window.enoughFactory?.onPreviewStatus?.(status => { if (status.sessionId && status.sessionId !== session.id) return; if (status.status === 'failed') setError(status.error || 'The application could not be opened.'); else { setError(null); setAddress(status.url); lastTarget.current = status.url; } }), [session.id]);
  return <div className="preview-pane"><form className="preview-toolbar" onSubmit={event => { event.preventDefault(); void navigate(); }}><Globe size={16} />{desktop && target && <><Button type="button" variant="ghost" size="icon" aria-label="Previous preview page" onClick={() => void window.enoughFactory?.previewNavigation?.('back')}><ArrowLeft size={14} /></Button><Button type="button" variant="ghost" size="icon" aria-label="Next preview page" onClick={() => void window.enoughFactory?.previewNavigation?.('forward')}><ArrowRight size={14} /></Button></>}<Input aria-label="Preview address" value={address} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setAddress(event.target.value)} placeholder="http://localhost:3000" /><Button variant="outline" size="sm" disabled={loading || session.status !== 'ready'} type="submit">{loading ? 'Opening…' : 'Open'}</Button>{target && <Button type="button" variant="ghost" size="icon" aria-label="Open preview in a separate window" onClick={() => { if (desktop) void window.enoughFactory?.openPreview?.({ sessionId: session.id, url: address }); else window.open(target, '_blank', 'noopener,noreferrer'); }}><ArrowUpRight size={16} /></Button>}</form>{error && <div className="error-banner">{error}</div>}<div className="preview-viewport" ref={viewport}>{target ? !desktop && <iframe title={`${session.name} preview`} src={target} className="preview-frame" referrerPolicy="no-referrer" /> : <EmptyState icon={<Globe size={32} />} title="Open a preview">Enter the URL of a service running in this environment.</EmptyState>}</div><p className="preview-hint">If this site blocks embedding, open it in a separate window.</p></div>;
}

export function SessionWorkspace({ client, session, state, run, modalOpen, initialChatId, compact, initialTab, onRemoved }: { client: DeviceClient; session: Session; state: FactoryState; run: Run; modalOpen: boolean; initialChatId?: string; compact?: boolean; initialTab?: SessionTab; onRemoved?: () => void }) {
  const [tab, setTab] = useState<SessionTab>(initialChatId ? 'agent' : initialTab ?? 'overview');
  const [outputTask, setOutputTask] = useState('stdout');
  const [removalOpen, setRemovalOpen] = useState(false);
  const [panelOrientation, setPanelOrientation] = useState<'horizontal' | 'vertical'>(() => window.matchMedia('(max-width: 900px)').matches ? 'vertical' : 'horizontal');
  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const update = () => setPanelOrientation(query.matches ? 'vertical' : 'horizontal');
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const project = state.projects.find(item => item.id === session.projectId);
  const device = state.devices.find(item => item.id === session.deviceId);
  const tabs: { id: SessionTab; label: string; icon: typeof Box }[] = [{ id: 'overview', label: 'Environment', icon: Box }, { id: 'agent', label: 'Agent', icon: MessageSquare }, { id: 'terminal', label: 'Terminal', icon: TerminalSquare }, { id: 'preview', label: 'Preview', icon: Globe }, { id: 'changes', label: 'Changes', icon: GitBranch }];
  const metadata = [project?.name, device?.name ?? 'Unknown device', session.branch].filter(Boolean).join(' · ');
  return <div className={`session-workspace${compact ? ' is-compact' : ''}`}>
    <PageHeader title={session.name} description={compact ? undefined : metadata} actions={<>
      <Status state={device?.online === false ? 'unknown' : session.status} label={device?.online === false ? 'Device offline' : undefined} />
      {session.status === 'stopped' || session.status === 'failed'
        ? <Button disabled={device?.online === false} onClick={() => void run(() => client.post(`/api/sessions/${session.id}/restart`))}><Play size={15} />Start environment</Button>
        : <Button variant="outline" disabled={session.status === 'stopping' || device?.online === false} onClick={() => void run(() => client.post(`/api/sessions/${session.id}/stop`))}><Square size={13} />Stop</Button>}
      <RemoveEnvironmentAction session={session} client={client} run={run} disabled={device?.online === false} onRemoved={onRemoved} onOpenChange={setRemovalOpen} />
    </>} />
    {session.deviceId === state.device.id && state.diagnostics.containerRuntime && state.diagnostics.containerRuntime.state !== 'ready' && <RuntimePanel state={state} client={client} run={run} compact />}
    {session.error && <div className="error-banner">{session.error}</div>}
    {session.status === 'starting' && <div className="notice"><LoaderCircle className="loading-spinner" size={15} aria-hidden="true" /><strong>Starting environment</strong><span>{session.phase || 'Preparing image and starting services…'}</span></div>}
    {device?.online === false && <div className="connection-banner">{device.name} is offline. Showing its last reported environment state.</div>}
    <div className="session-tabs" role="tablist" aria-label="Session workspace">{tabs.map(item => <button
      key={item.id}
      role="tab"
      id={`tab-${item.id}`}
      aria-selected={tab === item.id}
      aria-controls={`panel-${item.id}`}
      tabIndex={tab === item.id ? 0 : -1}
      className={`session-tab ${tab === item.id ? 'active' : ''}`}
      onClick={() => setTab(item.id)}
      onKeyDown={event => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          const next = tabs[(tabs.findIndex(value => value.id === tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
          setTab(next.id);
          document.getElementById(`tab-${next.id}`)?.focus();
        }
      }}
    ><item.icon size={15} />{item.label}</button>)}</div>
    <div className="session-content" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      {tab === 'overview' && <ResizablePanelGroup orientation={panelOrientation} className="split-workspace session-split-workspace">
        <ResizablePanel className="session-services-panel" defaultSize="35%" minSize={panelOrientation === 'vertical' ? '160px' : '220px'}>
          <Panel title="Services">
            {session.services.length ? <div className="service-list">{session.services.map(service => <div className="service-row" key={service.name}>
              <div className="service-info">
                <button className="service-title" aria-pressed={outputTask === service.name} onClick={() => setOutputTask(outputTask === service.name ? 'stdout' : service.name)}><span className={`status-dot state-${service.status}`} /><strong>{service.name}</strong></button>
                <span>{service.command || service.status}{service.port ? ` · :${service.port}` : ''}</span>
              </div>
              <div className="service-actions">
                <Button variant="ghost" size="icon" aria-label={`Restart ${service.name}`} disabled={session.status !== 'ready' || device?.online === false} onClick={() => void run(() => client.post(`/api/sessions/${session.id}/services/${encodeURIComponent(service.name)}/restart`))}><RotateCcw size={14} /></Button>
                <Button variant="ghost" size="icon" aria-label={service.status === 'running' ? `Stop ${service.name}` : `Start ${service.name}`} disabled={session.status !== 'ready' || device?.online === false} onClick={() => void run(() => client.post(`/api/sessions/${session.id}/services/${encodeURIComponent(service.name)}/${service.status === 'running' ? 'stop' : 'start'}`))}>{service.status === 'running' ? <Square size={12} /> : <Play size={14} />}</Button>
              </div>
            </div>)}</div> : <EmptyState icon={<Box size={26} />} title="No services">{session.status === 'starting' ? 'Waiting for service startup.' : 'This environment has no configured services.'}</EmptyState>}
          </Panel>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel className="session-output-panel" defaultSize="65%" minSize={panelOrientation === 'vertical' ? '220px' : '280px'}>
          <Output client={client} session={session} task={outputTask} />
        </ResizablePanel>
      </ResizablePanelGroup>}
      {tab === 'agent' && <ChatPane client={client} session={session} state={state} run={run} initialChatId={initialChatId} />}
      {tab === 'terminal' && <Suspense fallback={<Loading>Opening terminal…</Loading>}><TerminalPane client={client} session={session} /></Suspense>}
      {tab === 'preview' && <Preview client={client} session={session} hidden={modalOpen || removalOpen} />}
      {tab === 'changes' && <Changes client={client} session={session} />}
    </div>
  </div>;
}
