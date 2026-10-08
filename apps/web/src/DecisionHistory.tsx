import type { ControllerRun, Decision, FactoryState } from '@enoughfactory/contracts';
import { Popover, PopoverContent, PopoverTrigger } from '@enoughtools/ui-react';
import { MessageSquare } from 'lucide-react';
import { relativeTime } from './hooks';
import { HistoryPanel } from './HistoryPanel';
import { Button, Loading, Status } from './ui';

export function DecisionHistory({ decisions, controllers, state, loading, error, onSelectTask, onShowChat, onShowController }: {
  decisions: Decision[] | null; controllers: ControllerRun[]; state: FactoryState; loading: boolean; error: string | null;
  onSelectTask: (id: string) => void; onShowChat: (sessionId: string, chatId: string) => void; onShowController: (id: string) => void;
}) {
  const chronological = [...(decisions ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const runs = [...controllers].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <HistoryPanel title="Decision history" label="Decision timeline, oldest to newest" version={decisions} ready={!loading} actions={runs.length > 0 && <Popover><PopoverTrigger asChild><Button size="sm" variant="ghost"><MessageSquare size={13} />Factory conversations</Button></PopoverTrigger><PopoverContent align="end" className="decision-runs"><h3>Factory conversations</h3>{runs.map(record => <div key={record.id}><strong>{record.role}</strong><Status state={record.status} /><time dateTime={record.updatedAt}>{relativeTime(record.updatedAt)}</time><Button size="sm" variant="ghost" onClick={() => onShowController(record.id)}>Inspect</Button></div>)}</PopoverContent></Popover>}>
      {loading && !decisions ? <Loading>Opening decision history…</Loading> : error && !decisions ? <div className="error-banner">{error}</div> : chronological.length ? <ol className="decision-list">{chronological.map(decision => {
        const references = decision.data && typeof decision.data === 'object' && !Array.isArray(decision.data) ? decision.data as Record<string, unknown> : undefined;
        const taskId = typeof references?.taskId === 'string' ? references.taskId : undefined;
        const chatId = typeof references?.chatId === 'string' ? references.chatId : undefined;
        const chat = state.chats.find(item => item.id === chatId);
        return <li className="decision-item" key={decision.id}><div><span className="eyebrow">{decision.kind.replaceAll('_', ' ')}</span><time dateTime={decision.at} title={new Date(decision.at).toLocaleString()}>{relativeTime(decision.at)}</time></div><p>{decision.text}</p><div className="decision-actions">{taskId && <Button size="sm" variant="ghost" onClick={() => onSelectTask(taskId)}>Inspect task</Button>}{chat && <Button size="sm" variant="ghost" onClick={() => onShowChat(chat.sessionId, chat.id)}>Conversation</Button>}</div>{references && <details><summary>Recorded references</summary><pre className="code-output">{JSON.stringify(references, null, 2)}</pre></details>}</li>;
      })}</ol> : <p>No decisions recorded.</p>}{error && decisions && <div className="error-banner">History could not be refreshed. {error}</div>}
  </HistoryPanel>;
}
