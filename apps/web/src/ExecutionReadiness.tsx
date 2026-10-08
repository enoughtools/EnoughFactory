import { useState } from 'react';
import type { Device, ExecutionCapability, ExecutionReadiness } from '@enoughfactory/contracts';
import { RefreshCw } from 'lucide-react';
import type { DeviceClient } from './api';
import { Button, Modal, Status } from './ui';
import './execution-readiness.css';

export const capabilityLabels: Record<ExecutionCapability, string> = {
  'linux-shell': 'Linux agents', 'mac-shell': 'Mac agents', 'chromium-inspection': 'Browser testing',
  'apple-compilation': 'Apple app builds', 'macos-app-inspection': 'Mac app testing', 'ios-simulator-inspection': 'iPhone Simulator testing',
};
const readinessLabels: Record<ExecutionReadiness, string> = {
  ready: 'Ready', preparing: 'Preparing', busy: 'In use', offline: 'Offline', 'setup-required': 'Setup needed', unsupported: 'Unavailable',
};
export function ReadinessStatus({ readiness }: { readiness: ExecutionReadiness }) {
  const state = readiness === 'setup-required' ? 'waiting' : readiness === 'unsupported' ? 'offline' : readiness === 'busy' ? 'running' : readiness;
  return <Status state={state} label={readinessLabels[readiness]} />;
}

export function DeviceExecutionReadiness({ device, client, run }: { device: Device; client: DeviceClient; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [setup, setSetup] = useState<{ title: string; reason?: string; action: string; targetId: string; capability?: ExecutionCapability }>();
  const setupTarget = device.executionTargets?.find(target => target.id === setup?.targetId);
  const setupReadiness = !device.online ? 'offline' : setup?.capability ? setupTarget?.capabilities.find(capability => capability.kind === setup.capability)?.readiness : setupTarget?.readiness;
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true); setError(undefined);
    try {
      await run(async () => {
        try { await client.get(`/api/inspection/readiness?deviceId=${encodeURIComponent(device.id)}`); }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'Readiness could not be checked.'); throw cause; }
      });
    } finally { setRefreshing(false); }
  }
  return <section className="device-readiness" aria-label={`Agents and testing on ${device.name}`}>
    <div className="device-readiness-heading"><h3>Agents and testing</h3><Button size="sm" variant="ghost" disabled={!device.online || refreshing} onClick={() => void refresh()}><RefreshCw size={12} />{refreshing ? 'Checking…' : 'Check readiness'}</Button></div>
    {device.executionTargets?.length ? device.executionTargets.map(target => <div className="device-readiness-target" key={target.id}>
      <div className="device-readiness-row"><strong>{target.kind === 'host-macos' ? 'Mac execution' : 'Container execution'}</strong><ReadinessStatus readiness={device.online ? target.readiness : 'offline'} /></div>
      {target.reason && target.readiness !== 'ready' && <p className="device-readiness-note">{target.reason}</p>}
      <ul>{target.capabilities.map(capability => <li key={capability.kind}><div className="device-readiness-row"><span>{capabilityLabels[capability.kind]}</span><ReadinessStatus readiness={device.online ? capability.readiness : 'offline'} /></div>
        {capability.reason && capability.readiness !== 'ready' && <p className="device-readiness-note">{capability.reason}</p>}
        {capability.setupAction && capability.readiness === 'setup-required' && <Button size="sm" variant="ghost" disabled={!device.online} onClick={() => setSetup({ title: `Set up ${capabilityLabels[capability.kind]}`, reason: capability.reason, action: capability.setupAction!, targetId: target.id, capability: capability.kind })}>{capability.kind.endsWith('shell') ? 'Set up agents' : 'Set up testing'}</Button>}
      </li>)}</ul>
      {target.setupAction && target.readiness === 'setup-required' && <Button size="sm" variant="ghost" disabled={!device.online} onClick={() => setSetup({ title: 'Set up execution', reason: target.reason, action: target.setupAction!, targetId: target.id })}>Set up execution</Button>}
    </div>) : <p className="device-readiness-note">Readiness is unavailable from this device. Update its device service to report supported agents and testing tools.</p>}
    {!device.online && <p className="device-readiness-note">Connect this device to use its agents and testing tools.</p>}
    {error && <p className="device-readiness-note" role="alert">{error}</p>}
    <Modal open={!!setup} onClose={() => setSetup(undefined)} title={setup?.title ?? 'Set up testing'} description={`Testing setup on ${device.name}`}><div className="modal-form">{setupReadiness && <ReadinessStatus readiness={setupReadiness} />}{setupReadiness === 'ready' ? <p>The required tools are ready. The factory can now use them.</p> : <>{setup?.reason && <p>{setup.reason}</p>}<p className="device-readiness-guidance">{setup?.action}</p></>}<div className="header-actions"><Button size="sm" variant="ghost" onClick={() => setSetup(undefined)}>Close</Button><Button size="sm" variant="outline" disabled={!device.online || refreshing} onClick={() => void refresh()}><RefreshCw size={12} />{refreshing ? 'Checking…' : 'Check again'}</Button></div>{error && <p role="alert">{error}</p>}</div></Modal>
  </section>;
}
