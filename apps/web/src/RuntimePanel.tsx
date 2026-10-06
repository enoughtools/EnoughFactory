import { useEffect, useState } from 'react';
import type { ContainerRuntimeStatus, FactoryState } from '@enoughfactory/contracts';
import { Box, Check, LoaderCircle, Play, RefreshCw, SlidersHorizontal, Square } from 'lucide-react';
import type { DeviceClient } from './api';
import { Button, Field, Input, Modal, Panel, Status } from './ui';

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
          : runtime.state === 'stopped' ? 'Starts automatically with an environment.'
            : 'Resolve the setup details below, then try again.';
  return <section className={`runtime-panel ${compact ? 'runtime-compact' : ''}`} aria-label="Container runtime"><Panel title={compact ? undefined : 'Container runtime'} actions={!compact && <Button variant="ghost" size="sm" disabled={operation !== null} onClick={() => void run(async () => { await client.get('/api/diagnostics'); })}><RefreshCw size={14} />Refresh</Button>}><div className="runtime-overview"><div className="runtime-icon">{preparing || !runtime ? <LoaderCircle className="loading-spinner" size={21} /> : <Box size={23} />}</div><div className="runtime-heading"><div>{compact && <strong>Container runtime</strong>}<Status state={runtime ? displayState[runtime.state] : 'starting'} label={runtime ? labels[runtime.state] : 'Checking'} /></div>{description && <p className="runtime-description">{description}</p>}</div><div className="runtime-actions">{runtime && !preparing && runtime.state !== 'ready' && <Button variant={compact ? 'outline' : 'default'} size="sm" disabled={operation !== null || actionsRequired} onClick={() => void start()}><Play size={14} />{operation === 'start' ? 'Starting…' : runtime.state === 'failed' ? 'Try again' : 'Start runtime'}</Button>}{!compact && runtime?.state === 'ready' && <Button variant="outline" size="sm" disabled={operation !== null} onClick={() => active.length ? setConfirmStop(true) : void stop()}><Square size={12} />{operation === 'stop' ? 'Stopping…' : 'Stop runtime'}</Button>}{!compact && runtime?.kind === 'lima' && runtime.cpus !== undefined && runtime.memoryGiB !== undefined && <Button variant="ghost" size="icon" aria-label="Runtime resource settings" title={canConfigure ? 'Runtime resources' : 'Stop the runtime before changing its resources'} disabled={operation !== null || !canConfigure} onClick={() => setConfigure(true)}><SlidersHorizontal size={15} /></Button>}</div></div>{runtime?.phase && <div className="runtime-phase" role="status">{preparing && <LoaderCircle className="loading-spinner" size={13} />}<span>{runtime.phase}</span></div>}{runtime?.error && <div className="error-banner" role="alert">{runtime.error}</div>}{runtime?.requiredActions?.length ? <ul className="runtime-prerequisites">{runtime.requiredActions.map((action, index) => <li key={index}><strong>{action.label}</strong><p>{action.detail}</p>{action.command && <pre className="runtime-command">{action.command}</pre>}</li>)}</ul> : null}{!compact && runtime && <><div className="runtime-resources">{runtime.cpus !== undefined && <div><span>CPU</span><strong>{runtime.cpus} {runtime.cpus === 1 ? 'core' : 'cores'}</strong></div>}{runtime.memoryGiB !== undefined && <div><span>Memory</span><strong>{runtime.memoryGiB} GiB</strong></div>}{runtime.diskGiB !== undefined && <div><span>Disk capacity</span><strong>{runtime.diskGiB} GiB</strong></div>}<div><span>Repository workspaces</span><strong>{runtime.artifactFsSupported ? 'Git & ArtifactFS' : 'Git'}</strong></div></div>{active.length > 0 && <p className="runtime-description">{active.length} {active.length === 1 ? 'active environment uses' : 'active environments use'} this runtime on {state.device.name}.</p>}<details className="runtime-details"><summary>Runtime details</summary><dl><dt>Runtime</dt><dd>{runtime.kind === 'lima' ? 'Private Lima virtual machine' : 'Private rootless container daemon'}</dd>{runtime.version && <><dt>Version</dt><dd>{runtime.version}</dd></>}{runtime.dockerVersion && <><dt>Container engine</dt><dd>{runtime.dockerVersion}</dd></>}<dt>Data directory</dt><dd>{runtime.dataDirectory}</dd><dt>Socket</dt><dd>{runtime.socketPath}</dd></dl></details></>}</Panel><Modal open={confirmStop} onClose={() => setConfirmStop(false)} title="Stop runtime?" description={`${active.length} active ${active.length === 1 ? 'environment' : 'environments'} on ${state.device.name} will stop before the runtime shuts down.`}><div className="modal-form"><p className="runtime-stop-warning">Stopping these environments interrupts their running agents and tools. Source recovery and conversation history remain stored on this device.</p><div className="header-actions"><Button variant="outline" disabled={operation !== null} onClick={() => setConfirmStop(false)}>Keep working</Button><Button disabled={operation !== null} onClick={() => void stop(true)}><Square size={13} />{operation === 'stop' ? 'Stopping environments…' : 'Stop environments & runtime'}</Button></div></div></Modal><Modal open={configure} onClose={() => setConfigure(false)} title="Runtime resources" description="CPU and memory assigned to the container runtime."><form className="modal-form" onSubmit={event => { event.preventDefault(); void resources(); }}><div className="runtime-resource-form"><Field label="CPU cores"><Input type="number" required min={1} max={64} step={1} value={cpus} onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setSaved(false); setCpus(event.target.value); }} /></Field><Field label="Memory (GiB)"><Input type="number" required min={2} max={512} step={1} value={memory} onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setSaved(false); setMemory(event.target.value); }} /></Field></div><p className="field-hint">Stop the runtime before changing its resources. Saved settings apply the next time it starts.</p><Button type="submit" disabled={operation !== null || !canConfigure || !cpus || !memory}>{saved ? <Check size={15} /> : <SlidersHorizontal size={15} />}{operation === 'resources' ? 'Saving…' : saved ? 'Saved' : 'Save resources'}</Button></form></Modal></section>;
}
