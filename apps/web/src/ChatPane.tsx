import { useEffect, useRef, useState } from 'react';
import type { Approval, Chat, ChatEvent, FactoryState, RuntimeCapability, RuntimeKind, Session } from '@enoughfactory/contracts';
import { Message, MessageContent, MessageGroup, MessageHeader, Popover, PopoverContent, PopoverTrigger } from '@enoughtools/ui-react';
import { ArrowUp, Bot, Check, CircleStop, FileText, KeyRound, MessageSquare, Plus, Settings2, ShieldCheck, Wrench } from 'lucide-react';
import type { DeviceClient } from './api';
import { useResource } from './hooks';
import { parseGoalProposal } from './goal-draft';
import { controllerTimeline } from './controller-events';
import { FactoryResponse } from './FactoryResponse';
import { Button, EmptyState, Field, Input, Loading, Modal, Status } from './ui';
import './conversation-activity.css';

export function ApprovalCard({ approval, run, client }: { approval: Approval; run: (action: () => Promise<unknown>) => Promise<void>; client: DeviceClient }) {
  return <div className="approval-card"><div className="task-heading"><ShieldCheck size={18} /><strong>{approval.action}</strong><Status state={approval.status} /></div><p>{approval.description}</p><details><summary>Requested action</summary><pre className="code-output">{JSON.stringify(approval.arguments, null, 2)}</pre></details>{approval.status === 'pending' && <div className="header-actions"><Button variant="outline" size="sm" onClick={() => void run(() => client.post(`/api/approvals/${approval.id}/decision`, { decision: 'deny' }))}>Deny</Button><Button size="sm" onClick={() => void run(() => client.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' }))}><Check size={14} />Allow</Button></div>}</div>;
}

function EventMessage({ event, runtime, onUseMessage, readOnly }: { event: ChatEvent; runtime: RuntimeKind; onUseMessage?: (text: string) => void; readOnly?: boolean }) {
  if (event.kind === 'error') {
    const interrupted = event.data?.interrupted === true || /interrupt|revok|cancel/i.test(event.text ?? '');
    const preparing = event.data?.agentStarted === false || event.data?.phase === 'preparation';
    return <details className="chat-event-error"><summary>{interrupted ? 'This agent turn was interrupted' : preparing ? 'Agent setup did not finish' : 'This agent turn reported an error'}</summary>{preparing && /curl: \(\d+\)|unexpected eof|SSL_read/i.test(event.text ?? '') && <p>The download connection ended unexpectedly before the agent started.</p>}<pre className="code-output">{event.text ?? JSON.stringify(event.data, null, 2)}</pre></details>;
  }
  if (event.kind === 'tool' || event.kind === 'artifact' || event.kind === 'status' || event.kind === 'usage') return <div className={`chat-activity kind-${event.kind}`}><span>{event.kind === 'tool' ? <Wrench size={14} /> : event.kind === 'artifact' ? <FileText size={14} /> : <Bot size={14} />}</span><div><strong>{event.data?.outputDelta === true ? 'Command output' : event.text ?? event.kind}</strong>{event.data?.outputDelta === true && <pre className="code-output factory-command-output">{event.text}</pre>}{event.data && <details><summary>Details</summary><pre className="code-output">{JSON.stringify(event.data, null, 2)}</pre></details>}</div></div>;
  const proposal = onUseMessage && event.kind === 'message' && event.role === 'assistant' && event.data?.delta !== true && event.text ? parseGoalProposal(event.text) : null;
  return <Message className={`chat-message role-${event.role ?? 'system'}`} align={event.role === 'user' ? 'end' : 'start'}><MessageContent>
    <MessageHeader><span>{event.role === 'user' ? readOnly ? 'Factory prompt' : 'You' : event.role === 'assistant' ? runtime : 'EnoughFactory'}</span><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></MessageHeader>
    {proposal ? <div className="goal-proposal">
      <strong>{proposal.title || 'Proposed goal'}</strong>{proposal.objective && <p>{proposal.objective}</p>}
      {proposal.specification && <details><summary>Specification</summary><p>{proposal.specification}</p></details>}
      {proposal.criteria && <ul>{proposal.criteria.split('\n').map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>}
      <Button type="button" variant="outline" size="sm" onClick={() => onUseMessage!(event.text!)}><FileText size={13} />Use draft</Button>
      <details className="goal-proposal-raw"><summary>Raw response</summary><pre className="code-output">{event.text}</pre></details>
    </div> : readOnly && (event.role === 'user' || event.role === 'system') ? <details className="factory-prompt"><summary>{event.role === 'system' ? 'Factory instructions' : 'Factory prompt'}{event.text ? ` · ${event.text.split('\n')[0].slice(0, 90)}` : ''}</summary><div className="message-text">{event.text}</div></details> : readOnly && event.role === 'assistant' && event.text ? <FactoryResponse source={event.text} /> : <div className="message-text">{event.text}</div>}
    {event.data && !event.text && <pre className="code-output">{JSON.stringify(event.data, null, 2)}</pre>}
  </MessageContent></Message>;
}

export function Conversation({ client, chat, approvals, run, offline, onUseMessage, readOnly }: { client: DeviceClient; chat: Chat; approvals: Approval[]; run: (action: () => Promise<unknown>) => Promise<void>; offline: boolean; onUseMessage?: (text: string) => void; readOnly?: boolean }) {
  const { data: events, error, loading, refresh } = useResource<ChatEvent[]>(client, offline ? null : `/api/chats/${chat.id}/messages`, chat.status === 'running' || chat.status === 'waiting' ? 1200 : 5000);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const messages = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  useEffect(() => {
    const pane = messages.current;
    if (pane && followLatest.current) pane.scrollTo({ top: pane.scrollHeight, behavior: 'smooth' });
  }, [events]);
  const visibleEvents = controllerTimeline(events ?? [], chat.runtime);
  async function send() {
    if (!text.trim() || sending) return;
    setSending(true);
    const message = text;
    try { await client.post(`/api/chats/${chat.id}/messages`, { text: message }); setText(''); await refresh(); }
    catch (cause) { await run(() => Promise.reject(cause)); }
    finally { setSending(false); }
  }
  if (offline) return <EmptyState icon={<MessageSquare size={32} />} title="This conversation is on another device">Its history and running tools will return when that device reconnects. The conversation has not been deleted.</EmptyState>;
  return <div className={`conversation${readOnly ? ' factory-conversation' : ''}`}>{!readOnly && <div className="conversation-meta"><Status state={chat.status} /><div className="conversation-controls"><Popover><PopoverTrigger asChild><Button variant="ghost" size="sm"><Settings2 size={13} />Conversation details</Button></PopoverTrigger><PopoverContent align="end" className="conversation-details"><h2>Conversation details</h2><dl><dt>Agent</dt><dd>{chat.runtime}</dd><dt>Access</dt><dd>Full container access</dd><dt>State</dt><dd>{chat.status}</dd></dl><Field label="Approval policy"><select aria-label="Conversation approval policy" value={chat.approvalMode} disabled={chat.status === 'running' || chat.status === 'waiting'} onChange={event => void run(() => client.patch(`/api/chats/${chat.id}`, { approvalMode: event.target.value }))}><option value="approve-all">Approve all</option><option value="rules">Use project rules</option><option value="manual">Ask me</option></select></Field></PopoverContent></Popover>{chat.status === 'running' && <Button variant="ghost" size="sm" onClick={() => void run(() => client.post(`/api/chats/${chat.id}/interrupt`))}><CircleStop size={14} />Interrupt</Button>}</div></div>}<div className="message-list" ref={messages} role="log" aria-label={readOnly ? 'Factory conversation and tool activity' : 'Agent conversation'} onScroll={event => { const pane = event.currentTarget; followLatest.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80; }}>{loading ? <Loading>Opening conversation…</Loading> : error ? <div className="conversation-failure"><div><p>Conversation history could not be loaded.</p><details><summary>Connection details</summary><pre className="code-output">{error}</pre></details></div><Button variant="outline" size="sm" onClick={() => void refresh()}>Try again</Button></div> : visibleEvents.length ? <MessageGroup>{visibleEvents.map(event => <EventMessage key={event.id} event={event} runtime={chat.runtime} onUseMessage={onUseMessage} readOnly={readOnly} />)}</MessageGroup> : <div className="conversation-empty"><Bot size={28} /><h3>{readOnly ? 'Waiting for agent activity' : 'No messages'}</h3>{!readOnly && <p>Send instructions to start this conversation.</p>}</div>}{chat.error && !readOnly && <div className="conversation-failure"><div><p>{chat.status === 'interrupted' ? 'The agent turn was interrupted. The conversation is saved.' : 'The agent turn stopped. Review the details before continuing.'}</p><details><summary>Failure details</summary><pre className="code-output">{chat.error}</pre></details></div></div>}{approvals.filter(approval => approval.status === 'pending').map(approval => <ApprovalCard key={approval.id} approval={approval} client={client} run={run} />)}</div>{!readOnly && <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}><textarea className="chat-textarea" aria-label="Message your agent" placeholder={chat.status === 'running' ? 'Add instructions or context…' : 'Message the agent…'} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} rows={3} /><div className="composer-footer"><span>Enter to send · Shift+Enter for a new line</span><Button type="submit" size="icon" aria-label="Send message" disabled={!text.trim() || sending}><ArrowUp size={18} /></Button></div></form>}</div>;
}

export function ChatPane({ client, session, state, run, initialChatId, drafting }: { client: DeviceClient; session: Session; state: FactoryState; run: (action: () => Promise<unknown>) => Promise<void>; initialChatId?: string; drafting?: { prompt: string; onChatCreated: (id: string) => void; onUseMessage: (text: string) => void } }) {
  const [selected, setSelected] = useState<string | null>(initialChatId ?? null);
  const chats = state.chats.filter(chat => chat.sessionId === session.id && (!drafting || chat.id === initialChatId || chat.id === selected));
  const [runtime, setRuntime] = useState<RuntimeKind>(state.settings.defaultRuntime);
  const [creating, setCreating] = useState(false);
  const [setup, setSetup] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [importAuth, setImportAuth] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const { data: capabilities, error: capabilityError, refresh: refreshCapabilities } = useResource<RuntimeCapability[]>(client, session.status === 'ready' ? `/api/sessions/${session.id}/runtimes` : null);
  const chat = chats.find(item => item.id === selected) ?? chats.at(-1);
  const device = state.devices.find(item => item.id === session.deviceId);
  async function create() {
    setCreating(true);
    await run(async () => { const result = await client.post<Chat>('/api/chats', { sessionId: session.id, runtime, approvalMode: state.projects.find(project => project.id === session.projectId)?.approvalMode ?? state.settings.defaultApprovalMode, ...(drafting ? { title: 'Goal specification' } : {}) }); setSelected(result.id); if (drafting) { drafting.onChatCreated(result.id); await client.post(`/api/chats/${result.id}/messages`, { text: drafting.prompt }); } });
    setCreating(false);
  }
  async function prepare() {
    setPreparing(true);
    await run(async () => {
      await client.post(`/api/sessions/${session.id}/runtimes/${runtime}/provision`, { copyHostAuth: importAuth });
      if (apiKey.trim()) await client.post(`/api/sessions/${session.id}/runtimes/${runtime}/connect`, { apiKey: apiKey.trim() });
      setApiKey(''); await refreshCapabilities(); setSetup(false);
    });
    setPreparing(false);
  }
  const capability = capabilities?.find(item => item.kind === runtime);
  return <div className="chat-pane"><div className="chat-tabs">{chats.map(item => <button key={item.id} className={`chat-tab ${item.id === chat?.id ? 'active' : ''}`} onClick={() => setSelected(item.id)}><MessageSquare size={14} />{item.title || item.runtime}</button>)}<div className="chat-new"><select aria-label="Agent runtime" value={runtime} onChange={event => setRuntime(event.target.value as RuntimeKind)}><option value="codex">Codex</option><option value="antigravity">Antigravity</option><option value="claude">Claude</option></select><Button variant="ghost" size="icon" aria-label="Prepare agent runtime" disabled={session.status !== 'ready'} onClick={() => setSetup(true)}><Settings2 size={15} /></Button><Button variant="ghost" size="sm" disabled={creating || session.status !== 'ready'} onClick={() => void create()}><Plus size={14} />New chat</Button></div></div>{capability?.available === false && <div className="notice"><KeyRound size={16} /><span>{runtime} needs to be prepared in this environment.</span><Button variant="ghost" size="sm" onClick={() => setSetup(true)}>Prepare agent</Button></div>}{chat ? <Conversation key={chat.id} chat={chat} client={client} approvals={state.approvals.filter(approval => approval.chatId === chat.id)} run={run} offline={device?.online === false} onUseMessage={drafting?.onUseMessage} /> : <EmptyState icon={<MessageSquare size={32} />} title={drafting ? "Draft with an agent" : "No conversations"}>{drafting ? "Describe your idea in the draft, then start the conversation." : "Start an agent conversation in this environment."}<Button disabled={creating || session.status !== 'ready'} onClick={() => void create()}><Plus size={16} />Start {runtime}</Button></EmptyState>}<Modal open={setup} onClose={() => setSetup(false)} title={`Prepare ${runtime}`} description="Install the selected runtime in this container and connect your provider account."><form className="modal-form" onSubmit={event => { event.preventDefault(); void prepare(); }}>{capability && <div className="notice"><Status state={capability.available ? 'ready' : 'unknown'} label={capability.available ? 'Installed' : 'Not installed'} /><span>{capability.version || capability.details}</span></div>}{capabilityError && <div className="error-banner">{capabilityError}</div>}<label className="checkbox-field"><input type="checkbox" checked={importAuth} onChange={event => setImportAuth(event.target.checked)} /><span>Use the provider account already connected on this device</span></label><Field label="Provider API key" hint="Optional when using an existing signed-in account. Sent to this container, never included in chat history."><Input type="password" autoComplete="off" value={apiKey} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setApiKey(event.target.value)} placeholder="Paste an API key if needed" /></Field><p className="field-hint">The agent runs with full container access. Runtime capability details in Settings explain which typed approvals and resume features it supports.</p><Button type="submit" disabled={preparing}><KeyRound size={15} />{preparing ? 'Preparing agent…' : 'Prepare & connect'}</Button></form></Modal></div>;
}
