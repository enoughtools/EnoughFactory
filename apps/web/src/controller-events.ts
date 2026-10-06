import type { ChatEvent, RuntimeKind } from '@enoughfactory/contracts';

/** Render streamed chunks as their actual message, retaining tool events and authoritative finals. */
export function controllerTimeline(events: ChatEvent[], runtime?: RuntimeKind): ChatEvent[] {
  const rendered: (ChatEvent | undefined)[] = [];
  const chunks = new Map<string, number>();
  const replacedSteps = new Set<string>();
  for (const event of events) {
    if (event.kind === 'message' && event.role === 'user') { chunks.clear(); replacedSteps.clear(); }
    const itemId = typeof event.data?.itemId === 'string' ? event.data.itemId : undefined;
    // The CLI emits step identities but its final response contains the complete turn.
    if (runtime === 'antigravity' && event.kind === 'message' && event.role === 'assistant' && itemId === 'response' && event.data?.final === true) {
      const steps = [...chunks].filter(([key, index]) => key.startsWith('message:step-') && rendered[index]?.data?.delta === true);
      if (steps.length) {
        const firstIndex = steps[0][1], first = rendered[firstIndex]!;
        for (const [key, index] of steps) { rendered[index] = undefined; chunks.delete(key); replacedSteps.add(key); }
        rendered[firstIndex] = { ...event, id: first.id };
        chunks.set('message:response', firstIndex);
        continue;
      }
    }
    const toolItem = event.data?.item && typeof event.data.item === 'object' ? event.data.item as Record<string, unknown> : undefined;
    const toolItemId = typeof toolItem?.id === 'string' ? toolItem.id : undefined;
    const stream = event.kind === 'message' && event.role === 'assistant' && itemId && (event.data?.delta === true || event.data?.final === true)
      ? `message:${itemId}` : event.kind === 'tool' && event.data?.outputDelta === true && itemId ? `output:${itemId}` : event.kind === 'tool' && toolItemId ? `tool:${toolItemId}` : undefined;
    if (stream && replacedSteps.has(stream)) continue;
    const previous = stream ? chunks.get(stream) : undefined;
    if (previous !== undefined) {
      const first = rendered[previous]!;
      if (first.data?.final === true && event.data?.delta === true) continue;
      rendered[previous] = { ...event, id: first.id, text: event.data?.final === true || toolItemId ? event.text ?? first.text : `${first.text ?? ''}${event.text ?? ''}` };
    } else {
      if (stream) chunks.set(stream, rendered.length);
      rendered.push(event);
    }
  }
  return rendered.filter((event): event is ChatEvent => event !== undefined);
}
