import { useCallback, useEffect, useRef, useState } from 'react';
import type { Artifact, Device, ExecutionCapability, Project } from '@enoughfactory/contracts';
import { Download, RefreshCw } from 'lucide-react';
import type { DeviceClient } from './api';
import { downloadArtifact } from './artifacts';
import { DeviceExecutionReadiness, ReadinessStatus } from './ExecutionReadiness';
import { useResource } from './hooks';
import { nativeProfileAuditSummaries, nativeProfileSummaries, type NativeProfileAuditStatus } from './native-profile-summary';
import { Button, Modal, Status } from './ui';
import './native-profiles.css';

type Run = (action: () => Promise<unknown>) => Promise<void>;
const auditPresentation: Record<NativeProfileAuditStatus, { state: string; label: string; description: string }> = {
  queued: { state: 'waiting', label: 'Review queued', description: 'Factory has saved the proposed setup and will audit its isolated test data mode.' },
  preparing: { state: 'preparing', label: 'Preparing review', description: 'Factory is preparing an independent source review.' },
  running: { state: 'running', label: 'Review in progress', description: 'Factory is checking that native tests use isolated data and credentials.' },
  waiting: { state: 'waiting', label: 'Setup waiting', description: 'Factory is waiting to continue this source review.' },
  unknown: { state: 'unknown', label: 'Checking review status', description: 'Factory is reconciling the original reviewer before continuing this audit.' },
  rejected: { state: 'failed', label: 'Setup needs attention', description: 'This source review did not approve native testing setup.' },
  configured: { state: 'ready', label: 'Profile configured', description: 'The source audit configured isolated native testing. Build and UI test results are recorded separately in task evidence.' },
  canceled: { state: 'canceled', label: 'Review canceled', description: 'This review ended without configuring a testing profile.' },
};
function CapabilityStatus({ device, capability }: { device?: Device; capability: ExecutionCapability }) {
  const advertised = device?.executionTargets?.filter(target => target.protocolVersion === 1 && target.kind === 'host-macos').flatMap(target => target.capabilities).filter(item => item.kind === capability);
  const item = advertised?.find(item => item.readiness === 'ready') ?? advertised?.[0];
  return item && device ? <ReadinessStatus readiness={device.online ? item.readiness : 'offline'} /> : <span className="field-hint">Readiness unavailable</span>;
}

export function ProjectNativeProfiles({ project, devices, client, run }: { project?: Project; devices: Device[]; client: DeviceClient; run: Run }) {
  const [open, setOpen] = useState(false);
  if (!project) return null;
  return <details className="project-native-profiles" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Native testing setup</summary>
    {open && <ProjectNativeProfileContent key={project.id} project={project} devices={devices} client={client} run={run} />}
  </details>;
}

function ProjectNativeProfileContent({ project, devices, client, run }: { project: Project; devices: Device[]; client: DeviceClient; run: Run }) {
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [downloading, setDownloading] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const refreshFlight = useRef<Promise<void> | undefined>(undefined);
  const [error, setError] = useState<string>();
  const profiles = useResource<unknown>(client, `/api/projects/${encodeURIComponent(project.id)}/inspection-profiles`);
  const audits = useResource<unknown>(client, `/api/projects/${encodeURIComponent(project.id)}/inspection-profile-audits`);
  const owner = devices.find(device => device.id === project?.deviceId);
  const items = nativeProfileSummaries(profiles.data);
  const reviews = nativeProfileAuditSummaries(audits.data);
  const initialLoading = profiles.loading || audits.loading || profiles.data === null && !profiles.error || audits.data === null && !audits.error;
  const loading = initialLoading || refreshing;
  // The keyed, open-only content owns its requests. Never overlap refresh pairs,
  // so an older response cannot replace a newer review or another project's data.
  const refreshTogether = useCallback(() => {
    if (refreshFlight.current) return refreshFlight.current;
    setRefreshing(true);
    const pending = Promise.allSettled([profiles.refresh(), audits.refresh()]).then(() => {});
    refreshFlight.current = pending;
    void pending.finally(() => { refreshFlight.current = undefined; setRefreshing(false); });
    return pending;
  }, [profiles.refresh, audits.refresh]);
  useEffect(() => {
    if (initialLoading) return;
    const timer = setInterval(() => void refreshTogether(), 5000);
    return () => clearInterval(timer);
  }, [initialLoading, refreshTogether]);
  const failed = profiles.error || audits.error;
  const profilesAvailable = Array.isArray(profiles.data) && profiles.data.length === items.length;
  const available = profilesAvailable && reviews.available;
  const downloadOwner = (artifact: Artifact) => devices.find(device => device.id === artifact.deviceId);
  const download = (id: string, artifact: Artifact) => {
    setDownloading(id); setError(undefined); void run(async () => {
      try { await downloadArtifact(client, artifact, artifact.deviceId, () => {}); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'The source audit could not be opened.'); throw cause; }
    }).finally(() => setDownloading(undefined));
  };
  return <>
    <div className="native-profiles-heading"><p className="field-hint">Configured on {owner?.name ?? 'the project’s device'}. Source audits define isolated test data; each build checks that source again. Task evidence records actual tests and screenshots.</p><Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void refreshTogether()}><RefreshCw size={12} />{refreshing ? 'Refreshing…' : 'Refresh'}</Button></div>
    {owner?.online === false && <p className="field-hint" role="status">{owner.name} is offline. Setup and audit downloads require its owning device.</p>}
    {loading && <p className="field-hint" role="status">Loading testing setup and source reviews…</p>}
    {failed && <p className="field-hint" role="status">Testing setup could not be fully loaded. {failed}</p>}
    {!loading && !failed && !available && <p className="field-hint" role="status">Testing setup returned incomplete information. Refresh to try again.</p>}
    {!loading && !failed && available && !items.length && !reviews.audits.length && <div className="native-profile-guidance"><strong>Project needs isolated test data setup</strong><p>Give the factory a test data mode that uses separate storage and credentials for every run. The coordinating device must audit that source and configure a Mac or iPhone Simulator testing profile before native UI tests can run.</p></div>}
    {reviews.audits.map(audit => {
      const presentation = auditPresentation[audit.status], artifactOwner = audit.verdict && downloadOwner(audit.verdict);
      return <article className="native-profile" key={audit.id}>
        <div className="native-profiles-heading"><strong>{items.find(profile => profile.id === audit.profileId)?.scheme ?? audit.profileId}</strong><Status state={presentation.state} label={presentation.label} /></div>
        <p className="field-hint">{audit.reason ?? presentation.description}</p>
        {audit.nextAction && <p className="field-hint">Next step: {audit.nextAction}</p>}
        {audit.verdict && <><Button type="button" size="sm" variant="ghost" disabled={!!downloading || artifactOwner?.online !== true} onClick={() => download(audit.id, audit.verdict!)}><Download size={12} />{downloading === audit.id ? 'Downloading…' : 'Download source findings'}</Button>{artifactOwner?.online !== true && <p className="field-hint">{artifactOwner ? `${artifactOwner.name} is offline.` : 'The findings’ owning device is unavailable.'} Reconnect it to download these findings.</p>}</>}
      </article>;
    })}
    {reviews.omitted && <p className="field-hint">{reviews.omitted} other profiles have retained source reviews. Showing up to 16 profiles, with pending reviews and setup findings first.</p>}
    {items.map(profile => <article className="native-profile" key={profile.id}>
      <div className="native-profiles-heading"><strong>{profile.scheme ?? profile.id}</strong><Status state={profile.receipt ? 'ready' : 'waiting'} label={profile.receipt ? 'Audit receipt retained' : 'Source audit needed'} /></div>
      <p className="field-hint">{profile.platform === 'macos' ? 'Mac app' : 'iPhone Simulator'} · {profile.id}</p>
      <dl className="native-profile-readiness"><div><dt>Apple builds</dt><dd><CapabilityStatus device={owner} capability="apple-compilation" /></dd></div><div><dt>{profile.platform === 'macos' ? 'Mac app testing' : 'iPhone Simulator testing'}</dt><dd><CapabilityStatus device={owner} capability={profile.platform === 'macos' ? 'macos-app-inspection' : 'ios-simulator-inspection'} /></dd></div></dl>
      {profile.receipt ? <><Button type="button" size="sm" variant="ghost" disabled={!!downloading || downloadOwner(profile.receipt)?.online !== true} onClick={() => download(profile.id, profile.receipt!)}><Download size={12} />{downloading === profile.id ? 'Downloading…' : 'Download source audit'}</Button>{downloadOwner(profile.receipt)?.online !== true && <p className="field-hint">The audit’s owning device is offline or unavailable. Reconnect it to download the original source audit.</p>}</> : <p className="field-hint">The coordinating device needs to retain an original audit of the fixture source before using this profile.</p>}
    </article>)}
    {error && <p className="field-hint" role="alert">{error}</p>}
    <Button type="button" size="sm" variant="outline" disabled={!owner} onClick={() => setReadinessOpen(true)}>View device testing setup</Button>
    <Modal open={readinessOpen} onClose={() => setReadinessOpen(false)} title="Device testing setup" description={`Agents and native testing on ${owner?.name ?? 'the project’s device'}`}><div className="modal-form">{owner && <DeviceExecutionReadiness device={owner} client={client} run={run} />}</div></Modal>
  </>;
}
