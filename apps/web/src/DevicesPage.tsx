import { useEffect, useState } from 'react';
import type { Device, FactoryState, Settings } from '@enoughfactory/contracts';
import { Check, Copy, Laptop, Link2, Monitor, Plus, Server, Wifi } from 'lucide-react';
import type { DeviceClient } from './api';
import { relativeTime } from './hooks';
import { enoughNetworkingUrl } from './SettingsPage';
import { Button, EmptyState, Field, Modal, PageHeader, Status } from './ui';
import './device-capacity.css';

function DeviceCapacity({ device, settings, client, run }: { device: Device; settings: Settings; client: DeviceClient; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [automatic, setAutomatic] = useState(settings.workerCapacity === undefined);
  const [slots, setSlots] = useState(String(settings.workerCapacity ?? Math.max(1, device.capacity ?? 2)));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setAutomatic(settings.workerCapacity === undefined);
    setSlots(String(settings.workerCapacity ?? Math.max(1, device.capacity ?? 2)));
  }, [settings.workerCapacity]);
  const value = Number(slots);
  const valid = automatic || (slots.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 32);
  const changed = automatic ? settings.workerCapacity !== undefined : settings.workerCapacity !== value;
  async function save() {
    setSaving(true);
    try { await run(async () => { await client.patch('/api/settings', { workerCapacity: automatic ? null : value }); setSaved(true); }); }
    finally { setSaving(false); }
  }
  return <details className="device-capacity-controls"><summary>Advanced worker limit · {settings.workerCapacity === undefined ? 'Automatic' : `${settings.workerCapacity} slots`}</summary><div className="device-capacity-content">
    <div className="device-capacity-fields">
      <Field label="Shared device limit"><select value={automatic ? 'auto' : 'manual'} disabled={saving} onChange={event => { setAutomatic(event.target.value === 'auto'); setSaved(false); }}><option value="auto">Automatic</option><option value="manual">Set a limit</option></select></Field>
      {!automatic && <Field label="Worker slots"><input type="number" min={1} max={32} step={1} value={slots} disabled={saving} onChange={event => { setSlots(event.target.value); setSaved(false); }} aria-invalid={!valid} /></Field>}
    </div>
    <p className="field-hint">Each goal has its own agent limit. This device limit is a shared ceiling for all goals using this computer.</p><p className="field-hint">{automatic ? 'Automatic uses one worker per 2 CPUs and 2 GiB of execution resources, up to 32 workers.' : 'A manual limit controls new factory attempts on this computer.'} Task resource requirements also apply.</p>
    {device.capacity === 0 && <p className="field-hint">No new work will be scheduled while the runtime is unavailable or paused.</p>}
    {!valid && <p className="field-hint" role="alert">Choose a whole number from 1 to 32.</p>}
    <Button variant="outline" size="sm" disabled={!valid || !changed || saving} onClick={() => void save()}>{saving ? 'Saving…' : saved && !changed ? 'Saved' : 'Save capacity'}</Button>
  </div></details>;
}

export function DevicesPage({ state, client, run, onOpenSettings }: { state: FactoryState; client: DeviceClient; run: (action: () => Promise<unknown>) => Promise<void>; onOpenSettings?: () => void }) {
  const [pairing, setPairing] = useState(false);
  const [invite, setInvite] = useState('');
  const [expires, setExpires] = useState<string | null>(null);
  const [remoteInvite, setRemoteInvite] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const signalingConfigured = Boolean(state.settings.signalingUrl?.trim());
  const hostedNetworkingAvailable = state.diagnostics.networking?.hostedRelay === true;
  const hostedNetworkingSelected = state.settings.signalingUrl === enoughNetworkingUrl;
  async function generate() {
    setBusy(true);
    await run(async () => { const result = await client.post<{ invite: string; expiresAt?: string }>('/api/devices/invite'); setInvite(result.invite); setExpires(result.expiresAt ?? null); });
    setBusy(false);
  }
  async function pair() {
    setBusy(true);
    await run(async () => { await client.post('/api/devices/pair', { invite: remoteInvite.trim() }); setRemoteInvite(''); setPairing(false); });
    setBusy(false);
  }
  return <><PageHeader title="Devices" actions={<Button onClick={() => setPairing(true)}><Plus size={16} />Pair a device</Button>} /><p className="device-page-context">Your workspace is connected through {state.device.name}. Paired computers can run agents for your goals; each computer shares its available capacity across all goals.</p><div className="card-grid device-grid">{state.devices.map(device => <article className="device-card" key={device.id}><div className="device-card-top"><div className="device-icon">{device.platform === 'darwin' ? <Laptop size={25} /> : device.platform === 'linux' ? <Server size={25} /> : <Monitor size={25} />}</div><Status state={device.online ? 'ready' : 'offline'} label={device.online ? 'Online' : 'Offline'} /></div><h2>{device.name}</h2><p>{device.platform === 'darwin' ? 'macOS' : device.platform} · {device.arch}</p><div className="device-stats"><div><strong>{device.platform === 'browser' ? 0 : device.capacity ?? 2}</strong><span>worker slots</span></div><div><strong>{state.sessions.filter(session => session.deviceId === device.id && session.status === 'ready').length}</strong><span>running containers</span></div><div><strong>{state.chats.filter(chat => chat.deviceId === device.id && chat.status === 'running').length}</strong><span>working agents</span></div></div>{device.workerResources && <div className="device-capacity-resources"><strong>{device.workerResources.cpus} CPUs · {device.workerResources.memoryGiB} GiB</strong><span>{device.platform === 'linux' ? 'Host resources' : 'Private VM limit'}</span>{device.id === state.device.id && device.platform === 'darwin' && onOpenSettings && <Button variant="ghost" size="sm" onClick={onOpenSettings}>Change resources</Button>}</div>}{device.id === state.device.id && device.capacity === 0 && <p className="device-execution-note">Execution is paused or unavailable.{onOpenSettings && <Button variant="ghost" size="sm" onClick={onOpenSettings}>Open runtime</Button>}</p>}{device.id === state.device.id && device.platform !== 'browser' && <DeviceCapacity device={device} settings={state.settings} client={client} run={run} />}<div className="device-card-footer"><span title={device.transport === 'webrtc' ? 'Direct WebRTC' : device.transport === 'relay' ? 'Encrypted WebSocket relay' : 'Device service connection'}><Wifi size={13} />{device.id === state.device.id ? 'Workspace connection' : 'Paired device'}</span><span>{device.online ? 'Connected' : `Seen ${relativeTime(device.lastSeen)}`}</span></div>{!device.online && <p className="device-offline-note">Chats and live tools are unavailable until this device reconnects.</p>}</article>)}</div>{!state.devices.length && <EmptyState icon={<Monitor size={32} />} title="No devices connected">Connect a device service to view its environments and agents.</EmptyState>}<Modal open={pairing} onClose={() => setPairing(false)} title="Pair a device" description="Paired devices and browsers can control this device service."><div className="modal-form">{!signalingConfigured && <div className="notice"><div><strong>Set up device networking</strong><p>{hostedNetworkingAvailable ? 'Open Settings → Device connections, choose Use Enough networking and save changes. You can also use your own signaling service.' : 'Open Settings → Device connections and configure a self-hosted signaling service. Enough networking requires an updated device service.'}</p>{onOpenSettings && <Button variant="outline" size="sm" onClick={() => { setPairing(false); onOpenSettings(); }}>Open settings</Button>}</div></div>}{hostedNetworkingSelected && <p className="field-hint">Enough networking connects paired devices directly where possible, with an encrypted relay when needed.</p>}<div className="pairing-section"><h3>Invite another device</h3><p>Generate an invitation here, then paste it into EnoughFactory on the other device.</p>{invite ? <><textarea className="pairing-code" value={invite} readOnly aria-label="Device invitation" rows={4} /><Button variant="outline" onClick={() => { void navigator.clipboard.writeText(invite).then(() => setCopied(true)); }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy invitation'}</Button>{expires && <span className="field-hint">Expires {new Date(expires).toLocaleTimeString()}</span>}</> : <Button variant="outline" disabled={busy || !signalingConfigured} onClick={() => void generate()}><Link2 size={14} />Generate invitation</Button>}</div><div className="pairing-section"><h3>Accept an invitation</h3><Field label="Invitation from your other device"><textarea rows={4} value={remoteInvite} onChange={event => setRemoteInvite(event.target.value)} placeholder="Paste the invitation…" /></Field><Button disabled={!remoteInvite.trim() || busy} onClick={() => void pair()}><Plus size={14} />Pair device</Button></div></div></Modal></>;
}
