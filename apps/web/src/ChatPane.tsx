import { useEffect, useRef, useState } from 'react';
import type { Approval, Chat, ChatEvent, FactoryState, RuntimeCapability, RuntimeKind, Session } from '@enoughfactory/contracts';
import { Message, MessageContent, MessageGroup, MessageHeader } from '@enoughtools/ui-react';
import { ArrowUp, Bot, Check, CircleStop, FileText, KeyRound, MessageSquare, Plus, Settings2, ShieldCheck, Wrench } from 'lucide-react';
import type { DeviceClient } from './api';
import { useResource } from './hooks';
import { Button, EmptyState, Field, Input, Loading, Modal, Status } from './ui';

export function ApprovalCard({ approval, run, client }: { approval: Approval; run: (action: () => Promise<unknown>) => Promise<void>; client: DeviceClient }) {
  return <div className="approval-card"><div className="task-heading"><ShieldCheck size={18} /><strong>{approval.action}</strong><Status state={approval.status} /></div><p>{approval.description}</p><details><summary>Requested action</summary><pre className="code-output">{JSON.stringify(approval.arguments, null, 2)}</pre></details>{approval.status === 'pending' && <div className="header-actions"><Button variant="outline" size="sm" onClick={() => void run(() => client.post(`/api/approvals/${approval.id}/decision`, { decision: 'deny' }))}>Deny</Button><Button size="sm" onClick={() => void run(() => client.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' }))}><Check size={14} />Allow</Button></div>}</div>;
}

function EventMessage({ event, runtime }: { event: ChatEvent; runtime: RuntimeKind }) {
  if (event.kind === 'tool' || event.kind === 'artifact' || event.kind === 'status' || event.kind === 'usage') return <div className={`chat-activity kind-${event.kind}`}><span>{event.kind === 'tool' ? <Wrench size={14} /> : event.kind === 'artifact' ? <FileText size={14} /> : <Bot size={14} />}</span><div><strong>{event.text ?? event.kind}</strong>{event.data && <details><summary>Details</summary><pre className="code-output">{JSON.stringify(event.data, null, 2)}</pre></details>}</div></div>;
  return <Message className={`chat-message role-${event.role ?? 'system'}`} align={event.role === 'user' ? 'end' : 'start'}><MessageContent><MessageHeader><span>{event.role === 'user' ? 'You' : event.role === 'assistant' ? runtime : 'EnoughFactory'}</span><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></MessageHeader><div className="message-text">{event.text}</div>{event.data && !event.text && <pre className="code-output">{JSON.stringify(event.data, null, 2)}</pre>}</MessageContent></Message>;
}

function Conversation({ client, chat, approvals, run, offline }: { client: DeviceClient; chat: Chat; approvals: Approval[]; run: (action: () => Promise<unknown>) => Promise<void>; offline: boolean }) {
  const { data: events, error, loading, refresh } = useResource<ChatEvent[]>(client, offline ? null : `/api/chats/${chat.id}/messages`, chat.status === 'running' || chat.status === 'waiting' ? 1200 : 5000);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const messages = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  useEffect(() => {
    const pane = messages.current;
    if (pane && followLatest.current) pane.scrollTo({ top: pane.scrollHeight, behavior: 'smooth' });
  }, [events?.length]);
  async function send() {
    if (!text.trim() || sending) return;
    setSending(true);
    const message = text;
    try { await client.post(`/api/chats/${chat.id}/messages`, { text: message }); setText(''); await refresh(); }
    catch (cause) { await run(() => Promise.reject(cause)); }
    finally { setSending(false); }
  }
  if (offline) return <EmptyState icon={<MessageSquare size={32} />} title="This conversation is on another device">Its history and running tools will return when that device reconnects. The conversation has not been deleted.</EmptyState>;
  return <div className="conversation"><div className="conversation-meta"><Status state={chat.status} /><span>{chat.runtime} · full container access</span><select aria-label="Conversation approval policy" value={chat.approvalMode} disabled={chat.status === 'running' || chat.status === 'waiting'} onChange={event => void run(() => client.patch(`/api/chats/${chat.id}`, { approvalMode: event.target.value }))}><option value="approve-all">Approve all</option><option value="rules">Use project rules</option><option value="manual">Ask me</option></select>{chat.status === 'running' && <Button variant="ghost" size="sm" onClick={() => void run(() => client.post(`/api/chats/${chat.id}/interrupt`))}><CircleStop size={14} />Interrupt</Button>}</div><div className="message-list" ref={messages} role="log" aria-label="Agent conversation" onScroll={event => { const pane = event.currentTarget; followLatest.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80; }}>{loading ? <Loading>Opening conversation…</Loading> : error ? <div className="error-banner">{error}</div> : events?.length ? <MessageGroup>{events.map(event => <EventMessage key={event.id} event={event} runtime={chat.runtime} />)}</MessageGroup> : <div className="conversation-empty"><Bot size={28} /><h3>No messages</h3><p>Send instructions to start this conversation.</p></div>}{chat.error && <div className="error-banner">{chat.error}</div>}{approvals.filter(approval => approval.status === 'pending').map(approval => <ApprovalCard key={approval.id} approval={approval} client={client} run={run} />)}</div><form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}><textarea className="chat-textarea" aria-label="Message your agent" placeholder={chat.status === 'running' ? 'Add instructions or context…' : 'Message the agent…'} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} rows={3} /><div className="composer-footer"><span>Enter to send · Shift+Enter for a new line</span><Button type="submit" size="icon" aria-label="Send message" disabled={!text.trim() || sending}><ArrowUp size={18} /></Button></div></form></div>;
}

export function ChatPane({ client, session, state, run, initialChatId }: { client: DeviceClient; session: Session; state: FactoryState; run: (action: () => Promise<unknown>) => Promise<void>; initialChatId?: string }) {
  const chats = state.chats.filter(chat => chat.sessionId === session.id);
  const [selected, setSelected] = useState<string | null>(initialChatId ?? null);
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
    await run(async () => { const result = await client.post<Chat>('/api/chats', { sessionId: session.id, runtime, approvalMode: state.projects.find(project => project.id === session.projectId)?.approvalMode ?? state.settings.defaultApprovalMode }); setSelected(result.id); });
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
  return <div className="chat-pane"><div className="chat-tabs">{chats.map(item => <button key={item.id} className={`chat-tab ${item.id === chat?.id ? 'active' : ''}`} onClick={() => setSelected(item.id)}><MessageSquare size={14} />{item.title || item.runtime}</button>)}<div className="chat-new"><select aria-label="Agent runtime" value={runtime} onChange={event => setRuntime(event.target.value as RuntimeKind)}><option value="codex">Codex</option><option value="antigravity">Antigravity</option><option value="claude">Claude</option></select><Button variant="ghost" size="icon" aria-label="Prepare agent runtime" disabled={session.status !== 'ready'} onClick={() => setSetup(true)}><Settings2 size={15} /></Button><Button variant="ghost" size="sm" disabled={creating || session.status !== 'ready'} onClick={() => void create()}><Plus size={14} />New chat</Button></div></div>{capability?.available === false && <div className="notice"><KeyRound size={16} /><span>{runtime} needs to be prepared in this environment.</span><Button variant="ghost" size="sm" onClick={() => setSetup(true)}>Prepare agent</Button></div>}{chat ? <Conversation key={chat.id} chat={chat} client={client} approvals={state.approvals.filter(approval => approval.chatId === chat.id)} run={run} offline={device?.online === false} /> : <EmptyState icon={<MessageSquare size={32} />} title="No conversations">Start an agent conversation in this environment.<Button disabled={creating || session.status !== 'ready'} onClick={() => void create()}><Plus size={16} />Start {runtime}</Button></EmptyState>}<Modal open={setup} onClose={() => setSetup(false)} title={`Prepare ${runtime}`} description="Install the selected runtime in this container and connect your provider account."><form className="modal-form" onSubmit={event => { event.preventDefault(); void prepare(); }}>{capability && <div className="notice"><Status state={capability.available ? 'ready' : 'unknown'} label={capability.available ? 'Installed' : 'Not installed'} /><span>{capability.version || capability.details}</span></div>}{capabilityError && <div className="error-banner">{capabilityError}</div>}<label className="checkbox-field"><input type="checkbox" checked={importAuth} onChange={event => setImportAuth(event.target.checked)} /><span>Use the provider account already connected on this device</span></label><Field label="Provider API key" hint="Optional when using an existing signed-in account. Sent to this container, never included in chat history."><Input type="password" autoComplete="off" value={apiKey} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setApiKey(event.target.value)} placeholder="Paste an API key if needed" /></Field><p className="field-hint">The agent runs with full container access. Runtime capability details in Settings explain which typed approvals and resume features it supports.</p><Button type="submit" disabled={preparing}><KeyRound size={15} />{preparing ? 'Preparing agent…' : 'Prepare & connect'}</Button></form></Modal></div>;
}
