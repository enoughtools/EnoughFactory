import { useEffect, useState } from 'react';
import type { ApprovalMode, AutonomyMode, FactoryState, Goal } from '@enoughfactory/contracts';
import { SlidersHorizontal } from 'lucide-react';
import type { DeviceClient } from './api';
import { policies } from './SettingsPage';
import { GoalExecutionPreference } from './GoalExecutionPreference';
import { executionPreference, withExecutionPreference } from './execution-preference';
import { ProjectNativeProfiles } from './ProjectNativeProfiles';
import { Button, Field, Input, Modal } from './ui';

export function GoalControls({ goal, state, maxDurationMs, client, open, close, run }: { goal: Goal; state: FactoryState; maxDurationMs?: number; client: DeviceClient; open: boolean; close: () => void; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [autonomy, setAutonomy] = useState(goal.autonomy);
  const [approvalMode, setApprovalMode] = useState(goal.approvalMode);
  const [concurrency, setConcurrency] = useState(goal.concurrency);
  const [attempts, setAttempts] = useState(goal.maxAttempts?.toString() ?? '');
  const [duration, setDuration] = useState(maxDurationMs ? (maxDurationMs / 60_000).toString() : '');
  const [execution, setExecution] = useState(goal.execution);
  const [executionChanged, setExecutionChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setAutonomy(goal.autonomy); setApprovalMode(goal.approvalMode); setConcurrency(goal.concurrency); setAttempts(goal.maxAttempts?.toString() ?? ''); setDuration(maxDurationMs ? (maxDurationMs / 60_000).toString() : ''); setExecution(goal.execution); setExecutionChanged(false); } }, [open, goal.id]);
  return <Modal open={open} onClose={close} title="Goal execution settings" description="Choose how the factory continues, how it decides approvals and any explicit limits.">
    <form className="modal-form" onSubmit={event => { event.preventDefault(); setBusy(true); void run(async () => {
      await client.patch(`/api/goals/${goal.id}`, { autonomy, approvalMode, concurrency, maxAttempts: attempts ? Number(attempts) : null, maxDurationMs: duration ? Number(duration) * 60_000 : null, ...(executionChanged ? { execution: withExecutionPreference(goal.execution, executionPreference(execution)) } : {}) }); close();
    }).finally(() => setBusy(false)); }}>
      <div className="form-grid">
        <Field label="Autonomy"><select value={autonomy} onChange={event => setAutonomy(event.target.value as AutonomyMode)}><option value="autonomous">Autonomous</option><option value="assisted">Assisted</option><option value="manual">Manual</option></select></Field>
        <Field label="Approval policy"><select value={approvalMode} onChange={event => setApprovalMode(event.target.value as ApprovalMode)}>{policies.map(policy => <option key={policy.mode} value={policy.mode}>{policy.label}</option>)}</select></Field>
        <Field label="Concurrent workers"><Input required type="number" min={1} max={32} value={concurrency} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setConcurrency(Number(event.target.value))} /></Field>
        <Field label="Attempt budget" hint="Optional. Limits new worker attempts."><Input type="number" min={1} step={1} value={attempts} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAttempts(event.target.value)} placeholder="No explicit limit" /></Field>
        <Field label="Time budget (minutes)" hint="Optional. Reaching a limit waits; it never marks the goal complete."><Input type="number" min={1} value={duration} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDuration(event.target.value)} placeholder="No explicit limit" /></Field>
      </div>
      <GoalExecutionPreference execution={executionChanged ? withExecutionPreference(goal.execution, executionPreference(execution)) : goal.execution} onChange={value => { setExecution(value); setExecutionChanged(true); }} coordinator={state.devices.find(device => device.id === goal.coordinatorId)} runtime={goal.runtime} provider={goal.workspaceProvider ?? 'git'} client={client} run={run} />
      <p className="field-hint">Placement changes apply to future work. Running attempts keep their assigned target, and task-specific requirements still apply.</p>
      <p className="field-hint">Autonomous + Approve all gives the factory responsibility for ongoing planning, execution, repair and configured release actions. Approval changes apply to new turns.</p>
      <ProjectNativeProfiles project={state.projects.find(project => project.id === goal.projectId)} devices={state.devices} client={client} run={run} />
      <Button type="submit" disabled={busy}><SlidersHorizontal size={15} />{busy ? 'Saving settings…' : 'Save execution settings'}</Button>
    </form>
  </Modal>;
}
