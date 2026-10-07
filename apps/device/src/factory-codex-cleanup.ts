import type { Chat, ControllerRun } from '@enoughfactory/contracts';
import type { FactoryStore } from '@enoughfactory/factory';
import type { ChatController } from './chats.ts';
import type { SessionController } from './sessions.ts';

interface CleanupWorker {
  id: string; sessionId?: string; chatId?: string; status: string;
  workspace?: { id: string; provider: string };
}
interface CompletedTurn { id: string; attemptId?: string; result: unknown; }
interface PayloadCleanup { releaseCodexPayload(containerId: string): Promise<{ status: 'released' | 'deferred'; reason?: string }>; }

/** Runs only in the session's post-capture/pre-stop phase, never on ordinary chats. */
export async function releaseFactoryCodexPayload(input: {
  store: FactoryStore;
  sessions: Pick<SessionController, 'record' | 'owns' | 'get'>;
  chats: Pick<ChatController, 'event' | 'isRunning'>;
  manager: PayloadCleanup;
}, sessionId: string): Promise<void> {
  const controller = input.store.list<ControllerRun>('factory-controller-runs').find(run => run.sessionId === sessionId && run.status === 'completed');
  const worker = input.store.list<CleanupWorker>('factory-workers').find(run => run.sessionId === sessionId && run.status === 'succeeded');
  const chatId = controller?.chatId ?? worker?.chatId;
  if (!chatId) return;
  const chat = input.store.get<Chat>('chats', chatId);
  const completed = input.store.get<CompletedTurn>('chat-results', chatId);
  // A final response is durable before these factory records become completed.
  if (!chat || chat.runtime !== 'codex' || chat.sessionId !== sessionId || chat.status !== 'idle' || !completed?.result
    || worker && completed.attemptId !== worker.id) return;
  let result: { status: 'released' | 'deferred'; reason?: string };
  try {
    const session = input.sessions.record(sessionId);
    const owner = controller?.id ?? worker?.workspace?.id;
    const commit = worker ? input.store.get<{ id: string; commit: string }>('factory-capture-input', worker.id)?.commit : undefined;
    if (!owner || session.projectId !== `workspace-${owner}` || !input.sessions.owns(sessionId)) result = { status: 'deferred', reason: 'Factory environment ownership could not be confirmed.' };
    else if (session.status !== 'stopping' || input.chats.isRunning(chatId)) result = { status: 'deferred', reason: 'An agent turn or environment operation is still active.' };
    else if (worker && (worker.workspace?.provider !== 'git' || !commit || !/^[a-f0-9]{40,64}$/.test(commit))) result = { status: 'deferred', reason: 'The factory source capture has not been confirmed.' };
    else {
      const engine = input.sessions.get(sessionId);
      if (!session.containerId || engine.ready.instance !== session.containerId) result = { status: 'deferred', reason: 'The connected container identity changed.' };
      else result = await input.manager.releaseCodexPayload(engine.ready.instance);
    }
  } catch (error) {
    result = { status: 'deferred', reason: (error instanceof Error ? error.message : String(error)).slice(0, 2048) };
  }
  input.store.set('session-runtime-cleanup', { id: sessionId, runtime: 'codex', ...result, updatedAt: new Date().toISOString() });
  if (result.status === 'deferred') input.chats.event(chatId, { kind: 'status', text: `Codex installation cleanup deferred: ${result.reason || 'The installation remains in this environment.'} Source and conversation history are preserved.`, data: { status: 'cleanup-deferred', runtime: 'codex' } });
}
