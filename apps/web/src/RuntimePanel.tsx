import { useEffect, useState } from 'react';
import type { ContainerRuntimeStatus, FactoryState } from '@enoughfactory/contracts';
import { Box, Check, Play, RefreshCw, SlidersHorizontal, Square } from 'lucide-react';
import type { DeviceClient } from './api';
import { Button, Field, Input, Modal, Panel, Status, Spinner } from './ui';
import './settings-device.css';

type Run = (action: () => Promise<unknown>) => Promise<void>;
const labels: Record<ContainerRuntimeStatus['state'], string> = {
  unavailable: 'Setup needed', stopped: 'Stopped', starting: 'Preparing', ready: 'Ready', stopping: 'Stopping', failed: 'Error',
};
const displayState: Record<ContainerRuntimeStatus['state'], string> = {
  unavailable: 'unknown', stopped: 'stopped', starting: 'starting', ready: 'ready', stopping: 'stopping', failed: 'failed',
};

export function RuntimePanel({ state, client, run, compact = false }: { state: FactoryState; client: DeviceClient; run: Run; compact?: boolean }) {
  const runtime = state.diagnostics.containerRuntime;
  const [operation, setOperation] = useState<'start' | 'stop' | 'resources' | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [configure, setConfigure] = useState(false);
  const [cpus, setCpus] = useState(runtime?.cpus?.toString() ?? '');
  const [memory, setMemory] = useState(runtime?.memoryGiB?.toString() ?? '');
  const [saved, setSaved] = useState(false);
  const active = state.sessions.filter(session => session.deviceId === state.device.id && !['stopped', 'failed'].includes(session.status));
  const preparing = runtime?.state === 'starting' || runtime?.state === 'stopping';
  const actionsRequired = Boolean(runtime?.requiredActions?.length);
  const canConfigure = runtime?.state !== 'ready' && !preparing;
  useEffect(() => { if (configure) { setCpus(runtime?.cpus?.toString() ?? ''); setMemory(runtime?.memoryGiB?.toString() ?? ''); setSaved(false); } }, [configure, runtime?.cpus, runtime?.memoryGiB]);
  async function start() {
    setOperation('start');
    await run(async () => { await client.post('/api/runtime/start'); });
    setOperation(null);
  }
  async function stop(confirmStopEnvironments = false) {
    setOperation('stop');
    await run(async () => { await client.post('/api/runtime/stop', { confirmStopEnvironments }); setConfirmStop(false); });
    setOperation(null);
  }
  async function resources() {
    setOperation('resources');
    await run(async () => { await client.patch('/api/runtime', { cpus: Number(cpus), memoryGiB: Number(memory) }); setSaved(true); });
    setOperation(null);
  }
  const description = !runtime ? 'Checking the container runtime.'
    : runtime.state === 'ready' ? ''
      : runtime.state === 'starting' ? 'Starting the container runtime.'
        : runtime.state === 'stopping' ? 'Waiting for environments to stop.'
          : runtime.state === 'stopped' ? 'Start it to run agents on this device.'
            : 'Resolve the setup details below, then try again.';
  return <section className={`runtime-panel ${compact ? 'runtime-compact' : ''}`} aria-label="Execution resources"><Panel title={compact ? undefined : 'Execution resources'} actions={!compact && <Button variant="ghost" size="sm" disabled={operation !== null} onClick={() => void run(async () => { await client.get('/api/diagnostics'); })}><RefreshCw size={14} />Refresh</Button>}><div className="runtime-overview"><div className="runtime-icon">{preparing || !runtime ? <Spinner className="factory-spinner" style={{ width: 21, height: 21 }} aria-hidden="true" /> : <Box size={23} />}</div><div className="runtime-heading"><div>{compact && <strong>Container runtime</strong>}<Status state={runtime ? displayState[runtime.state] : 'starting'} label={runtime ? labels[runtime.state] : 'Checking'} /></div>{description && <p className="runtime-description">{description}</p>}</div><div className="runtime-actions">{runtime && !preparing && runtime.state !== 'ready' && <Button variant={compact ? 'outline' : 'default'} size="sm" disabled={operation !== null || actionsRequired} onClick={() => void start()}><Play size={14} />{operation === 'start' ? 'Starting…' : runtime.state === 'failed' ? 'Try again' : 'Start runtime'}</Button>}{!compact && runtime?.state === 'ready' && <Button variant="outline" size="sm" disabled={operation !== null} onClick={() => setConfirmStop(true)}><Square size={12} />{operation === 'stop' ? 'Stopping…' : 'Stop runtime'}</Button>}{!compact && runtime?.kind === 'lima' && runtime.cpus !== undefined && runtime.memoryGiB !== undefined && <Button variant="outline" size="sm" disabled={operation !== null || preparing} onClick={() => setConfigure(true)}><SlidersHorizontal size={15} />Change resources</Button>}</div></div>{runtime?.phase && <div className="runtime-phase" role="status">{preparing && <Spinner className="factory-spinner" style={{ width: 13, height: 13 }} aria-hidden="true" />}<span>{runtime.phase}</span></div>}{runtime?.error && <div className="error-banner" role="alert">{runtime.error}</div>}{runtime?.requiredActions?.length ? <ul className="runtime-prerequisites">{runtime.requiredActions.map((action, index) => <li key={index}><strong>{action.label}</strong><p>{action.detail}</p>{action.command && <pre className="runtime-command">{action.command}</pre>}</li>)}</ul> : null}{!compact && runtime && <><div className="runtime-resources">{runtime.cpus !== undefined && <div><span>CPU</span><strong>{runtime.cpus} {runtime.cpus === 1 ? 'core' : 'cores'}</strong></div>}{runtime.memoryGiB !== undefined && <div><span>Memory</span><strong>{runtime.memoryGiB} GiB</strong></div>}{runtime.diskGiB !== undefined && <div><span>Disk capacity</span><strong>{runtime.diskGiB} GiB</strong></div>}<div><span>Repository workspaces</span><strong>{runtime.artifactFsSupported ? 'Git & ArtifactFS' : 'Git'}</strong></div></div><p className="runtime-resource-note">{runtime.kind === 'lima' ? 'These are fixed limits for the private virtual machine, shared by all goals on this Mac. Increase them here when you need more capacity; they do not grow automatically.' : 'The private container engine uses this Linux computer’s resources directly. Goal agent limits and the device worker limit control how much work runs at once.'}</p>{active.length > 0 && <p className="runtime-description">{active.length} {active.length === 1 ? 'active environment uses' : 'active environments use'} this runtime on {state.device.name}.</p>}<details className="runtime-details"><summary>Runtime details</summary><dl><dt>Runtime</dt><dd>{runtime.kind === 'lima' ? 'Private Lima virtual machine' : 'Private rootless container daemon'}</dd>{runtime.version && <><dt>Version</dt><dd>{runtime.version}</dd></>}{runtime.dockerVersion && <><dt>Container engine</dt><dd>{runtime.dockerVersion}</dd></>}<dt>Data directory</dt><dd>{runtime.dataDirectory}</dd><dt>Socket</dt><dd>{runtime.socketPath}</dd></dl></details></>}</Panel><Modal open={confirmStop} onClose={() => setConfirmStop(false)} title="Stop runtime?" description={`Stop the private runtime on ${state.device.name}. Agents and tools using it will be interrupted.`}><div className="modal-form"><p className="runtime-stop-warning">EnoughFactory stops running environments and factory workers before shutting down. Source recovery and conversation history remain stored on this device.</p><div className="header-actions"><Button variant="outline" disabled={operation !== null} onClick={() => setConfirmStop(false)}>Keep working</Button><Button disabled={operation !== null} onClick={() => void stop(true)}><Square size={13} />{operation === 'stop' ? 'Stopping environments…' : 'Stop work & runtime'}</Button></div></div></Modal><Modal open={configure} onClose={() => setConfigure(false)} title="Runtime resources" description="CPU and memory assigned to the container runtime."><form className="modal-form" onSubmit={event => { event.preventDefault(); if (canConfigure) void resources(); }}>{!canConfigure && <div className="runtime-resource-limit"><p>Changing these limits requires stopping the runtime. This interrupts running agents and tools.</p><Button type="button" variant="outline" size="sm" disabled={operation !== null || preparing} onClick={() => { setConfigure(false); setConfirmStop(true); }}><Square size={12} />Review runtime shutdown</Button></div>}<div className="runtime-resource-form"><Field label="CPU cores"><Input type="number" required min={1} max={64} step={1} value={cpus} onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setSaved(false); setCpus(event.target.value); }} /></Field><Field label="Memory (GiB)"><Input type="number" required min={2} max={512} step={1} value={memory} onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setSaved(false); setMemory(event.target.value); }} /></Field></div><p className="field-hint">Saved limits apply the next time the runtime starts. Leave enough CPU and memory for other apps on your Mac.</p><Button type="submit" disabled={operation !== null || !canConfigure || !cpus || !memory}>{saved ? <Check size={15} /> : <SlidersHorizontal size={15} />}{operation === 'resources' ? 'Saving…' : saved ? 'Saved' : 'Save resources'}</Button></form></Modal></section>;
}
