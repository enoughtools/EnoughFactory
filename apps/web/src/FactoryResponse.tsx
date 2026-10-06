import { Check, GitBranch, ListChecks, Pause, RotateCcw } from 'lucide-react';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Read a provider response without importing the device coordinator into the browser. */
function readResponseObject(source: string): JsonObject | null {
  const candidates = [source.trim(), ...[...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1])];
  const embedded: string[] = [];
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < source.length; end++) {
      const character = source[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) { embedded.push(source.slice(start, end + 1)); start = end; break; }
    }
  }
  for (const candidate of [...candidates, ...embedded.reverse()]) {
    try { const parsed: unknown = JSON.parse(candidate); if (object(parsed)) return parsed; } catch { /* Partial streams and prose remain normal messages. */ }
  }
  return null;
}

/** Only recognize the factory's response shapes; arbitrary JSON stays an ordinary message. */
export function readFactoryResponse(source: string): { kind: 'decision' | 'plan' | 'evaluation'; data: JsonObject } | null {
  const data = readResponseObject(source);
  if (!data) return null;
  if (['retry', 'replan', 'wait'].includes(String(data.action)) && text(data.reason)) return { kind: 'decision', data };
  if (typeof data.complete === 'boolean' && text(data.summary) && Array.isArray(data.criteria) && data.criteria.every(item => object(item) && typeof item.criterion === 'string' && typeof item.satisfied === 'boolean')) return { kind: 'evaluation', data };
  if (text(data.summary) && Array.isArray(data.criteria) && data.criteria.every(item => typeof item === 'string') && Array.isArray(data.tasks) && data.tasks.every(item => object(item) && text(item.title) && text(item.key))) return { kind: 'plan', data };
  return null;
}

function PlannedWork({ tasks }: { tasks: unknown }) {
  if (!Array.isArray(tasks) || !tasks.length) return null;
  return <details className="factory-result-section"><summary>{tasks.length} proposed {tasks.length === 1 ? 'task' : 'tasks'}</summary><ol className="factory-result-tasks">{tasks.filter(object).map((task, index) => <li key={String(task.key ?? index)}><strong>{text(task.title) ?? `Task ${index + 1}`}</strong>{text(task.description) && <p>{text(task.description)}</p>}{strings(task.dependsOn).length > 0 && <small>After: {strings(task.dependsOn).join(', ')}</small>}</li>)}</ol></details>;
}

export function FactoryResponse({ source }: { source: string }) {
  const response = readFactoryResponse(source);
  if (!response) return <div className="message-text">{source}</div>;
  const { kind, data } = response;
  const action = String(data.action);
  const decisionLabel = action === 'replan' ? 'Replan work' : action === 'retry' ? 'Retry with corrections' : 'Wait for a condition';
  const Icon = kind === 'plan' || action === 'replan' ? GitBranch : kind === 'evaluation' ? ListChecks : action === 'wait' ? Pause : RotateCcw;
  const criteria = Array.isArray(data.criteria) ? data.criteria : [];
  return <article className={`factory-result factory-result-${kind}`} aria-label={kind === 'decision' ? 'Factory decision' : kind === 'plan' ? 'Proposed factory plan' : 'Goal evaluation'}>
    <header><Icon size={14} aria-hidden="true" /><strong>{kind === 'decision' ? decisionLabel : kind === 'plan' ? 'Proposed plan' : data.complete ? 'Goal criteria satisfied' : 'More work needed'}</strong><span>{kind === 'decision' ? 'Factory decision' : kind === 'evaluation' ? 'Goal evaluation' : 'Factory plan'}</span></header>
    <p>{text(kind === 'decision' ? data.reason : data.summary)}</p>
    {text(data.instructions) && <details className="factory-result-section"><summary>Repair instructions</summary><p>{text(data.instructions)}</p></details>}
    {text(data.waitReason) && <p className="factory-result-wait"><strong>Waiting for:</strong> {text(data.waitReason)}</p>}
    {text(data.wakeCondition) && <details className="factory-result-section"><summary>Resume condition</summary><code>{text(data.wakeCondition)}</code></details>}
    {criteria.length > 0 && <details className="factory-result-section"><summary>{kind === 'evaluation' ? `${criteria.filter(item => object(item) && item.satisfied).length} of ${criteria.length} criteria satisfied` : `${criteria.length} completion criteria`}</summary><ul className="factory-result-criteria">{criteria.map((criterion, index) => <li key={index}>{object(criterion) ? <><span className={criterion.satisfied ? 'criterion-satisfied' : 'criterion-pending'}>{criterion.satisfied ? <Check size={12} aria-hidden="true" /> : <span aria-hidden="true">○</span>}{text(criterion.criterion)}</span>{strings(criterion.evidence).length > 0 && <ul>{strings(criterion.evidence).map((evidence, evidenceIndex) => <li key={evidenceIndex}>{evidence}</li>)}</ul>}</> : String(criterion)}</li>)}</ul></details>}
    <PlannedWork tasks={kind === 'evaluation' ? data.additionalTasks : data.tasks} />
    {strings(data.checks).length > 0 && <details className="factory-result-section"><summary>{strings(data.checks).length} goal checks</summary><ul className="factory-result-checks">{strings(data.checks).map((command, index) => <li key={index}><code>{command}</code></li>)}</ul></details>}
    <details className="factory-result-section factory-result-raw"><summary>Raw response</summary><pre className="code-output">{source}</pre></details>
  </article>;
}
