import { useEffect, useRef, useState } from 'react';
import type { Chat, ControllerRun, FactoryState, Goal, Session } from '@enoughfactory/contracts';
import { Popover, PopoverContent, PopoverTrigger } from '@enoughtools/ui-react';
import { Activity, ArrowUpRight, Info, MessageSquare } from 'lucide-react';
import type { DeviceClient } from './api';
import { Conversation } from './ChatPane';
import { relativeTime, useResource } from './hooks';
import { Button, Loading, Status } from './ui';
import './controller-activity.css';

type Run = (action: () => Promise<unknown>) => Promise<void>;
const roles = { planner: 'Planner', diagnosis: 'Diagnosis', evaluator: 'Evaluator' };

function EnvironmentOutput({ session, client }: { session: Session; client: DeviceClient }) {
  const output = useResource<string>(client, `/api/sessions/${encodeURIComponent(session.id)}/output`, ['starting', 'ready'].includes(session.status) ? 2000 : 0);
  const pane = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => { if (follow && pane.current) pane.current.scrollTop = pane.current.scrollHeight; }, [output.data, follow]);
  return <div className="factory-environment-output"><div><strong>Runtime output</strong><label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />Follow</label></div>{output.error ? <div className="conversation-failure"><div><p>Runtime output could not be loaded.</p><details><summary>Connection details</summary><pre className="code-output">{output.error}</pre></details></div><Button variant="outline" size="sm" onClick={() => void output.refresh()}>Try again</Button></div> : output.loading ? <Loading>Reading runtime output…</Loading> : <pre className="code-output" ref={pane}>{output.data || 'No output recorded yet.'}</pre>}</div>;
}

export function ControllerActivity({ goal, state, client, run, controllers, selectedId, onSelect, loading, error, openSession, onOpenChat }: {
  goal: Goal; state: FactoryState; client: DeviceClient; run: Run; controllers: ControllerRun[];
  selectedId?: string; onSelect: (id: string) => void; loading: boolean; error?: string | null;
  openSession: (id: string) => void; onOpenChat?: (sessionId: string, chatId: string) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const sorted = [...controllers].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const record = sorted.find(item => item.id === selectedId) ?? sorted.find(item => ['starting', 'running'].includes(item.status)) ?? sorted[0];
  const catalogSession = state.sessions.find(item => item.id === record?.sessionId);
  const sessionDetails = useResource<Session>(client, record && !catalogSession ? `/api/sessions/${encodeURIComponent(record.sessionId)}` : null, record && ['starting', 'running'].includes(record.status) ? 3000 : 0);
  const session = catalogSession ?? (sessionDetails.data?.id === record?.sessionId ? sessionDetails.data : undefined);
  const catalogChat = state.chats.find(item => item.id === record?.chatId);
  const chatDetails = useResource<Chat>(client, record?.chatId && !catalogChat ? `/api/chats/${encodeURIComponent(record.chatId)}` : null, record && ['starting', 'running'].includes(record.status) ? 3000 : 0);
  const chat = catalogChat ?? (chatDetails.data?.id === record?.chatId ? chatDetails.data : undefined);
  const device = state.devices.find(item => item.id === (session?.deviceId ?? chat?.deviceId ?? goal.coordinatorId));
  const runtime = goal.coordinatorId === state.device.id ? state.diagnostics.containerRuntime : undefined;
  const phase = session?.phase ?? (session?.status === 'ready' && !chat ? 'Environment ready · waiting for conversation' : session?.status);
  const errors = [...new Set([error, record?.error, chat?.error, session?.error, sessionDetails.error, chatDetails.error].filter((value): value is string => !!value))];
  const role = record ? roles[record.role] : goal.status === 'planning' ? 'Planner' : 'Factory activity';
  const interrupted = record?.status === 'interrupted';
  const failed = record?.status === 'failed';
  const preparationFailed = failed && !chat?.threadId && errors.some(message => /^curl: \(\d+\)/.test(message.trim()));
  const runNotice = interrupted ? 'This run was interrupted. Its recorded activity is preserved.' : preparationFailed ? 'Agent setup did not finish because the download connection ended unexpectedly.' : failed ? 'This run stopped before it produced a completed decision.' : errors.length ? 'Some run details could not be loaded.' : undefined;

  return <section className="factory-activity" aria-label="Factory planning and decision activity">
    <header className="factory-activity-heading"><strong><Activity size={14} />{role}</strong>{record && <Status state={record.status} />}<div>
      <Popover open={detailsOpen} onOpenChange={setDetailsOpen}><PopoverTrigger asChild><Button size="sm" variant="ghost"><Info size={13} />Run details</Button></PopoverTrigger><PopoverContent align="end" className="factory-run-details"><h2>{role} run</h2>
        {sorted.length > 1 && <label className="factory-activity-picker">Recorded run<select aria-label="Factory controller run" value={record?.id ?? ''} onChange={event => { onSelect(event.target.value); setDetailsOpen(false); }}>{sorted.map(item => <option key={item.id} value={item.id}>{roles[item.role]} · {item.status} · {new Date(item.updatedAt).toLocaleString()}</option>)}</select></label>}
        <dl>{record && <><dt>State</dt><dd>{record.status}</dd><dt>Updated</dt><dd><time dateTime={record.updatedAt} title={new Date(record.updatedAt).toLocaleString()}>{relativeTime(record.updatedAt)}</time></dd></>}{device && <><dt>Device</dt><dd>{device.name}{device.online === false ? ' · offline' : ''}</dd></>}<dt>Agent</dt><dd>{chat?.runtime ?? goal.runtime}</dd><dt>Access</dt><dd>Full container access</dd><dt>Approvals</dt><dd>{(chat?.approvalMode ?? goal.approvalMode) === 'approve-all' ? 'Approve all' : chat?.approvalMode ?? goal.approvalMode}</dd>{phase && <><dt>Runtime</dt><dd>{phase}</dd></>}</dl>
        {errors.length > 0 && <details className="factory-run-errors"><summary>Technical details ({errors.length})</summary>{errors.map(message => <pre className="code-output" key={message}>{message}</pre>)}</details>}
        {record && <Button size="sm" variant="outline" onClick={() => openSession(record.sessionId)}>Inspect runtime<ArrowUpRight size={12} /></Button>}
      </PopoverContent></Popover>
      {record?.chatId && onOpenChat && <Button size="sm" variant="ghost" onClick={() => onOpenChat(record.sessionId, record.chatId!)}><MessageSquare size={13} />Open conversation</Button>}
    </div></header>
    {!chat && (record?.status === 'starting' || !record) && (phase || runtime?.phase) && <div className="factory-activity-phase" role="status">{phase ?? runtime?.phase}</div>}
    {runNotice && <div className="factory-run-notice"><span>{runNotice}</span><Button size="sm" variant="ghost" onClick={() => setDetailsOpen(true)}>Inspect details</Button></div>}
    <div className="factory-activity-body">{chat ? <Conversation key={chat.id} client={client} chat={chat} approvals={state.approvals.filter(approval => approval.chatId === chat.id)} run={run} offline={device?.online === false} readOnly /> : session ? <><div className="factory-activity-pending"><Status state={session.status} /><span>{record?.status === 'starting' ? 'Preparing the controller conversation.' : record?.status === 'failed' || record?.status === 'interrupted' ? 'This run ended before a conversation was recorded.' : 'No conversation recorded for this run.'}</span></div>{device?.online === false ? <p className="factory-activity-pending">Environment output will return when {device.name} reconnects.</p> : <EnvironmentOutput session={session} client={client} />}</> : <div className="factory-activity-pending">{loading || sessionDetails.loading ? <Loading>Loading factory activity…</Loading> : <><Status state={goal.status} /><span>{record ? 'The controller environment is unavailable.' : goal.status === 'planning' ? 'Waiting for the planner environment to be recorded.' : 'No factory controller runs recorded.'}</span></>}</div>}</div>
  </section>;
}
