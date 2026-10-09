import { useEffect, useRef, useState } from 'react';
import type { Device, ExecutionCapability, ExecutionReadiness, ExecutionTargetAdvertisement } from '@enoughfactory/contracts';
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
  const scope = useRef({ deviceId: device.id, client, generation: 0, online: device.online });
  if (scope.current.deviceId !== device.id || scope.current.client !== client) scope.current = { deviceId: device.id, client, generation: scope.current.generation + 1, online: device.online };
  scope.current.online = device.online;
  const generation = scope.current.generation;
  const mounted = useRef(true), flight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [operation, setOperation] = useState<{ kind: 'checking' | 'permissions'; ownerName: string }>();
  const [feedback, setFeedback] = useState<{ generation: number; error?: string; message?: string }>();
  const [updated, setUpdated] = useState<{ generation: number; targets: ExecutionTargetAdvertisement[] }>();
  const advertisedValues = JSON.stringify(device.executionTargets ?? []);
  useEffect(() => { setUpdated(undefined); }, [advertisedValues, device.id, client]);
  const [setup, setSetup] = useState<{ generation: number; title: string; reason?: string; action: string; targetId: string; capability?: ExecutionCapability }>();
  const selectedSetup = setup?.generation === generation ? setup : undefined;
  const targets = updated?.generation === generation ? updated.targets : device.executionTargets;
  const setupTarget = targets?.find(target => target.id === selectedSetup?.targetId);
  const setupReadiness = !device.online ? 'offline' : selectedSetup?.capability ? setupTarget?.capabilities.find(capability => capability.kind === selectedSetup.capability)?.readiness : setupTarget?.readiness;
  const error = feedback?.generation === generation ? feedback.error : undefined;
  const message = feedback?.generation === generation ? feedback.message : undefined;
  const pending = !!operation;
  const canRequestPermissions = (target: ExecutionTargetAdvertisement | undefined) => device.platform === 'darwin' && target?.protocolVersion === 1 && target.kind === 'host-macos' && target.capabilities.some(capability => capability.kind === 'macos-app-inspection' && capability.readiness === 'setup-required');
  const permissionGuidance = <>Mac app testing uses the separate EnoughFactory Native Inspection helper, which needs Accessibility and Screen Recording access. macOS may show EnoughFactory or EnoughFactory Native Inspection depending on how the helper was launched. Follow the permission entry opened by the request on {device.name}. Previously denied access may need to be enabled in System Settings → Privacy &amp; Security, then choose Check again.</>;
  async function check(kind: 'checking' | 'permissions') {
    if (flight.current || !device.online || kind === 'permissions' && !targets?.some(canRequestPermissions)) return;
    flight.current = true;
    const ownerId = device.id, ownerName = device.name, requestGeneration = generation;
    const current = () => mounted.current && scope.current.generation === requestGeneration && scope.current.deviceId === ownerId && scope.current.client === client && scope.current.online;
    setOperation({ kind, ownerName }); setFeedback(undefined);
    try {
      await run(async () => {
        try {
          if (!current()) return;
          if (kind === 'permissions') {
            const response = await client.post<{ readiness: { status: 'ready' | 'setup-required' | 'unsupported'; reasons: string[]; guiSession?: boolean }; executionTargets: ExecutionTargetAdvertisement[] }>(`/api/inspection/mac-permissions?deviceId=${encodeURIComponent(ownerId)}`);
            if (!current()) return;
            setUpdated({ generation: requestGeneration, targets: response.executionTargets });
            const readiness = response.readiness;
            const detail = readiness.reasons.join(' ');
            const message = readiness.guiSession === false ? `Sign in to an unlocked desktop on ${ownerName} to use Mac app testing.` : readiness.status === 'ready' ? `The native testing helper is ready on ${ownerName}.` : `Mac app testing still needs setup on ${ownerName}. After responding to macOS or updating System Settings, choose Check again.`;
            setFeedback({ generation: requestGeneration, message: `${message}${detail ? ` ${detail}` : ''}` });
          }
          if (!current()) return;
          const response = await client.get<{ executionTargets: ExecutionTargetAdvertisement[] }>(`/api/inspection/readiness?deviceId=${encodeURIComponent(ownerId)}`);
          if (current()) {
            setUpdated({ generation: requestGeneration, targets: response.executionTargets });
            if (kind === 'permissions') {
              const mac = response.executionTargets.filter(target => target.kind === 'host-macos').flatMap(target => target.capabilities).find(capability => capability.kind === 'macos-app-inspection');
              const message = mac?.readiness === 'ready' ? `The native testing helper is ready on ${ownerName}.` : mac ? `Mac app testing on ${ownerName}: ${readinessLabels[mac.readiness].toLowerCase()}.${mac.reason ? ` ${mac.reason}` : ''}${mac.readiness === 'setup-required' ? ' After updating the permission entry opened by the request, choose Check again.' : ''}` : `Mac app testing readiness is unavailable on ${ownerName}. Choose Check again after completing its setup.`;
              setFeedback({ generation: requestGeneration, message });
            }
          }
        } catch (cause) {
          if (!current()) return;
          setFeedback({ generation: requestGeneration, error: cause instanceof Error ? cause.message : kind === 'permissions' ? 'Mac permissions could not be requested.' : 'Readiness could not be checked.' });
          throw cause;
        }
      });
    } finally { flight.current = false; if (mounted.current) setOperation(undefined); }
  }
  return <section className="device-readiness" aria-label={`Agents and testing on ${device.name}`}>
    <div className="device-readiness-heading"><h3>Agents and testing</h3><Button size="sm" variant="ghost" disabled={!device.online || pending} onClick={() => void check('checking')}><RefreshCw size={12} />{operation?.kind === 'checking' ? 'Checking…' : 'Check readiness'}</Button></div>
    {targets?.length ? targets.map(target => <div className="device-readiness-target" key={target.id}>
      <div className="device-readiness-row"><strong>{target.kind === 'host-macos' ? 'Mac execution' : 'Container execution'}</strong><ReadinessStatus readiness={device.online ? target.readiness : 'offline'} /></div>
      {target.reason && target.readiness !== 'ready' && <p className="device-readiness-note">{target.reason}</p>}
      <ul>{target.capabilities.map(capability => <li key={capability.kind}><div className="device-readiness-row"><span>{capabilityLabels[capability.kind]}</span><ReadinessStatus readiness={device.online ? capability.readiness : 'offline'} /></div>
        {capability.reason && capability.readiness !== 'ready' && <p className="device-readiness-note">{capability.reason}</p>}
        {capability.kind === 'macos-app-inspection' && canRequestPermissions(target) && <><p className="device-readiness-note">{permissionGuidance}</p><Button size="sm" variant="outline" disabled={!device.online || pending} onClick={() => void check('permissions')}>{operation?.kind === 'permissions' ? 'Requesting permissions…' : 'Allow Mac app testing'}</Button></>}
        {capability.setupAction && capability.readiness === 'setup-required' && <Button size="sm" variant="ghost" disabled={!device.online || pending} onClick={() => setSetup({ generation, title: `Set up ${capabilityLabels[capability.kind]}`, reason: capability.reason, action: capability.setupAction!, targetId: target.id, capability: capability.kind })}>{capability.kind.endsWith('shell') ? 'Set up agents' : 'Set up testing'}</Button>}
      </li>)}</ul>
      {target.setupAction && target.readiness === 'setup-required' && <Button size="sm" variant="ghost" disabled={!device.online || pending} onClick={() => setSetup({ generation, title: 'Set up execution', reason: target.reason, action: target.setupAction!, targetId: target.id })}>Set up execution</Button>}
    </div>) : <p className="device-readiness-note">Readiness is unavailable from this device. Update its device service to report supported agents and testing tools.</p>}
    {!device.online && <p className="device-readiness-note">Connect this device to use its agents and testing tools.</p>}
    {operation?.kind === 'permissions' && <p className="device-readiness-note" role="status">Requesting permissions on {operation.ownerName}. Respond to any macOS prompts on that Mac.</p>}
    {message && <p className="device-readiness-note" role="status">{message}</p>}
    {error && <p className="device-readiness-note" role="alert">{error}</p>}
    <Modal open={!!selectedSetup} onClose={() => setSetup(undefined)} title={selectedSetup?.title ?? 'Set up testing'} description={`Testing setup on ${device.name}`}><div className="modal-form">{setupReadiness && <ReadinessStatus readiness={setupReadiness} />}{setupReadiness === 'ready' ? <p>The required tools are ready. The factory can now use them.</p> : <>{selectedSetup?.reason && <p>{selectedSetup.reason}</p>}<p className="device-readiness-guidance">{selectedSetup?.action}</p>{selectedSetup?.capability === 'macos-app-inspection' && <p>{permissionGuidance}</p>}</>}<div className="header-actions"><Button size="sm" variant="ghost" onClick={() => setSetup(undefined)}>Close</Button>{selectedSetup?.capability === 'macos-app-inspection' && canRequestPermissions(setupTarget) && <Button size="sm" variant="outline" disabled={!device.online || pending} onClick={() => void check('permissions')}>{operation?.kind === 'permissions' ? 'Requesting permissions…' : 'Allow Mac app testing'}</Button>}<Button size="sm" variant="outline" disabled={!device.online || pending} onClick={() => void check('checking')}><RefreshCw size={12} />{operation?.kind === 'checking' ? 'Checking…' : 'Check again'}</Button></div>{operation?.kind === 'permissions' && <p role="status">Respond to the macOS prompts on {operation.ownerName}.</p>}{message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}</div></Modal>
  </section>;
}
