import { useEffect, useRef, useState } from 'react';
import type { Chat, ControllerRun, FactoryState, Goal, Session } from '@enoughfactory/contracts';
import { Activity, ArrowUpRight, MessageSquare } from 'lucide-react';
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
  return <div className="factory-environment-output"><div><strong>Environment output</strong><label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />Follow</label></div>{output.error ? <div className="error-banner">{output.error}</div> : output.loading ? <Loading>Reading environment output…</Loading> : <pre className="code-output" ref={pane}>{output.data || 'No output recorded yet.'}</pre>}</div>;
}

export function ControllerActivity({ goal, state, client, run, controllers, selectedId, onSelect, loading, error, openSession, onOpenChat }: {
  goal: Goal; state: FactoryState; client: DeviceClient; run: Run; controllers: ControllerRun[];
  selectedId?: string; onSelect: (id: string) => void; loading: boolean; error?: string | null;
  openSession: (id: string) => void; onOpenChat?: (sessionId: string, chatId: string) => void;
}) {
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
  const errors = [...new Set([error, record?.error, session?.error, sessionDetails.error, chatDetails.error].filter((value): value is string => !!value))];

  return <section className="factory-activity" aria-label="Factory planning and decision activity">
    <header className="factory-activity-heading"><strong><Activity size={14} />{record ? roles[record.role] : goal.status === 'planning' ? 'Planner' : 'Factory activity'}</strong>{record && <Status state={record.status} />}{device && <span>{device.name}{device.online === false ? ' · offline' : ''}</span>}{record && <time dateTime={record.updatedAt}>Updated {relativeTime(record.updatedAt)}</time>}<div>{record && <Button size="sm" variant="ghost" onClick={() => openSession(record.sessionId)}>Environment<ArrowUpRight size={12} /></Button>}{record?.chatId && onOpenChat && <Button size="sm" variant="ghost" onClick={() => onOpenChat(record.sessionId, record.chatId!)}><MessageSquare size={13} />Open conversation</Button>}</div></header>
    {sorted.length > 1 && <label className="factory-activity-picker">Recorded run<select aria-label="Factory controller run" value={record?.id ?? ''} onChange={event => onSelect(event.target.value)}>{sorted.map(item => <option key={item.id} value={item.id}>{roles[item.role]} · {item.status} · {new Date(item.updatedAt).toLocaleString()}</option>)}</select></label>}
    {(phase || (!record && runtime?.phase)) && <div className="factory-activity-phase" role="status">{phase ?? runtime?.phase}</div>}
    {errors.map(message => <div className="error-banner" key={message}>{message}</div>)}
    <div className="factory-activity-body">{chat ? <Conversation key={chat.id} client={client} chat={chat} approvals={state.approvals.filter(approval => approval.chatId === chat.id)} run={run} offline={device?.online === false} readOnly /> : session ? <><div className="factory-activity-pending"><Status state={session.status} /><span>{record?.status === 'starting' ? 'Preparing the controller conversation.' : record?.status === 'failed' || record?.status === 'interrupted' ? 'This run ended before a conversation was recorded.' : 'No conversation recorded for this run.'}</span></div>{device?.online === false ? <p className="factory-activity-pending">Environment output will return when {device.name} reconnects.</p> : <EnvironmentOutput session={session} client={client} />}</> : <div className="factory-activity-pending">{loading || sessionDetails.loading ? <Loading>Loading factory activity…</Loading> : <><Status state={goal.status} /><span>{record ? 'The controller environment is unavailable.' : goal.status === 'planning' ? 'Waiting for the planner environment to be recorded.' : 'No factory controller runs recorded.'}</span></>}</div>}</div>
  </section>;
}
