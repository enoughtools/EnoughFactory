import { useState } from 'react';
import type { Device, ExecutionCapability, Project } from '@enoughfactory/contracts';
import { Download, RefreshCw } from 'lucide-react';
import type { DeviceClient } from './api';
import { downloadArtifact } from './artifacts';
import { DeviceExecutionReadiness, ReadinessStatus } from './ExecutionReadiness';
import { useResource } from './hooks';
import { nativeProfileSummaries } from './native-profile-summary';
import { Button, Modal, Status } from './ui';
import './native-profiles.css';

type Run = (action: () => Promise<unknown>) => Promise<void>;
function CapabilityStatus({ device, capability }: { device?: Device; capability: ExecutionCapability }) {
  const advertised = device?.executionTargets?.filter(target => target.protocolVersion === 1 && target.kind === 'host-macos').flatMap(target => target.capabilities).filter(item => item.kind === capability);
  const item = advertised?.find(item => item.readiness === 'ready') ?? advertised?.[0];
  return item && device ? <ReadinessStatus readiness={device.online ? item.readiness : 'offline'} /> : <span className="field-hint">Readiness unavailable</span>;
}

export function ProjectNativeProfiles({ project, devices, client, run }: { project?: Project; devices: Device[]; client: DeviceClient; run: Run }) {
  const [open, setOpen] = useState(false);
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [downloading, setDownloading] = useState<string>();
  const [error, setError] = useState<string>();
  const profiles = useResource<unknown>(client, open && project ? `/api/projects/${encodeURIComponent(project.id)}/inspection-profiles` : null);
  const owner = devices.find(device => device.id === project?.deviceId);
  const items = nativeProfileSummaries(profiles.data);
  if (!project) return null;
  return <details className="project-native-profiles" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Native testing setup</summary>
    <div className="native-profiles-heading"><p className="field-hint">Configured on {owner?.name ?? 'the project’s device'}. Source audits define isolated test data; each build checks that source again. Task evidence records actual tests and screenshots.</p><Button type="button" size="sm" variant="ghost" disabled={profiles.loading} onClick={() => void profiles.refresh()}><RefreshCw size={12} />Refresh</Button></div>
    {profiles.loading && <p className="field-hint" role="status">Loading testing setup…</p>}
    {profiles.error && <p className="field-hint" role="status">Testing setup could not be loaded. {profiles.error}</p>}
    {!profiles.loading && !profiles.error && !items.length && <div className="native-profile-guidance"><strong>Project needs isolated test data setup</strong><p>Give the factory a test data mode that uses separate storage and credentials for every run. The coordinating device must audit that source and configure a Mac or iPhone Simulator testing profile before native UI tests can run.</p></div>}
    {items.map(profile => <article className="native-profile" key={profile.id}>
      <div className="native-profiles-heading"><strong>{profile.scheme ?? profile.id}</strong><Status state={profile.receipt ? 'ready' : 'waiting'} label={profile.receipt ? 'Audit receipt retained' : 'Source audit needed'} /></div>
      <p className="field-hint">{profile.platform === 'macos' ? 'Mac app' : 'iPhone Simulator'} · {profile.id}</p>
      <dl className="native-profile-readiness"><div><dt>Apple builds</dt><dd><CapabilityStatus device={owner} capability="apple-compilation" /></dd></div><div><dt>{profile.platform === 'macos' ? 'Mac app testing' : 'iPhone Simulator testing'}</dt><dd><CapabilityStatus device={owner} capability={profile.platform === 'macos' ? 'macos-app-inspection' : 'ios-simulator-inspection'} /></dd></div></dl>
      {profile.receipt ? <Button type="button" size="sm" variant="ghost" disabled={!!downloading || devices.find(device => device.id === profile.receipt!.deviceId)?.online === false} onClick={() => { setDownloading(profile.id); setError(undefined); void run(async () => {
        try { await downloadArtifact(client, profile.receipt!, profile.receipt!.deviceId, () => {}); }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'The source audit could not be opened.'); throw cause; }
      }).finally(() => setDownloading(undefined)); }}><Download size={12} />{downloading === profile.id ? 'Downloading…' : 'Download source audit'}</Button> : <p className="field-hint">The coordinating device needs to retain an original audit of the fixture source before using this profile.</p>}
    </article>)}
    {error && <p className="field-hint" role="alert">{error}</p>}
    <Button type="button" size="sm" variant="outline" disabled={!owner} onClick={() => setReadinessOpen(true)}>View device testing setup</Button>
    <Modal open={readinessOpen} onClose={() => setReadinessOpen(false)} title="Device testing setup" description={`Agents and native testing on ${owner?.name ?? 'the project’s device'}`}><div className="modal-form">{owner && <DeviceExecutionReadiness device={owner} client={client} run={run} />}</div></Modal>
  </details>;
}
