import { useState } from 'react';
import type { Device, ExecutionTargetPreference, RuntimeKind, TaskExecutionRequirements } from '@enoughfactory/contracts';
import { RefreshCw } from 'lucide-react';
import type { DeviceClient } from './api';
import { executionPreference, readyMacTarget, withExecutionPreference } from './execution-preference';
import { Button, Field } from './ui';

export function GoalExecutionPreference({ execution, onChange, coordinator, runtime, provider, client, run }: {
  execution?: TaskExecutionRequirements; onChange: (value: TaskExecutionRequirements) => void;
  coordinator?: Device; runtime: RuntimeKind; provider: 'git' | 'artifactfs'; client: DeviceClient;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const preference = executionPreference(execution);
  const mac = readyMacTarget(coordinator, execution, runtime, provider);
  async function check() {
    if (!coordinator || checking) return;
    setChecking(true); setError(undefined);
    try { await run(async () => {
      try { await client.get(`/api/inspection/readiness?deviceId=${encodeURIComponent(coordinator.id)}`); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Readiness could not be checked.'); throw cause; }
    }); } finally { setChecking(false); }
  }
  return <div className="goal-execution-preference">
    <Field label="Run agents on" hint={preference === 'host-macos' ? 'Mac agents work in private project snapshots with the same access as your user account. Testing tools have their own readiness.' : preference === 'auto' ? 'The factory chooses compatible targets, preferring containers when available. Tasks can request the tools they need.' : 'Agents run in the private Linux runtime. Native testing can use a configured Mac.'}>
      <select value={preference} onChange={event => onChange(withExecutionPreference(execution, event.target.value as ExecutionTargetPreference))}>
        <option value="auto">Automatic</option><option value="container">Container</option><option value="host-macos" disabled={!mac}>Mac{mac ? ` · ${coordinator?.name}` : ' · unavailable'}</option>
      </select>
    </Field>
    {!mac && <p className="field-hint">Mac authoring requires a ready Mac on the project’s coordinating device, using an available agent and workspace type.{coordinator?.online !== false && <Button type="button" size="sm" variant="ghost" disabled={!coordinator || checking} onClick={() => void check()}><RefreshCw size={12} />{checking ? 'Checking…' : 'Check readiness'}</Button>}</p>}
    {preference === 'host-macos' && !mac && <p className="field-hint" role="status">This saved preference is currently unavailable. New work will wait until a compatible Mac is ready.</p>}
    {error && <p className="field-hint" role="alert">{error}</p>}
  </div>;
}
