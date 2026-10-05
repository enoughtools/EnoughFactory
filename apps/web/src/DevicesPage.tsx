import { useState } from 'react';
import type { FactoryState } from '@enoughfactory/contracts';
import { Check, Copy, Laptop, Link2, Monitor, Plus, Server, Wifi } from 'lucide-react';
import type { DeviceClient } from './api';
import { relativeTime } from './hooks';
import { Button, EmptyState, Field, Modal, PageHeader, Status } from './ui';

export function DevicesPage({ state, client, run }: { state: FactoryState; client: DeviceClient; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [pairing, setPairing] = useState(false);
  const [invite, setInvite] = useState('');
  const [expires, setExpires] = useState<string | null>(null);
  const [remoteInvite, setRemoteInvite] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
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
  return <><PageHeader eyebrow="Your distributed workspace" title="A factory across your devices." description="Each device owns its environments and conversations. Enough brings them into one workspace." actions={<Button onClick={() => setPairing(true)}><Plus size={16} />Pair a device</Button>} /><div className="card-grid device-grid">{state.devices.map(device => <article className="device-card" key={device.id}><div className="device-card-top"><div className="device-icon">{device.platform === 'darwin' ? <Laptop size={25} /> : device.platform === 'linux' ? <Server size={25} /> : <Monitor size={25} />}</div><Status state={device.online ? 'ready' : 'offline'} label={device.online ? 'Online' : 'Offline'} /></div><h2>{device.name}</h2><p>{device.platform === 'darwin' ? 'macOS' : device.platform} · {device.arch}{device.local ? ' · This device' : ''}</p><div className="device-stats"><div><strong>{state.sessions.filter(session => session.deviceId === device.id && session.status === 'ready').length}</strong><span>live environments</span></div><div><strong>{state.chats.filter(chat => chat.deviceId === device.id && chat.status === 'running').length}</strong><span>working agents</span></div></div><div className="device-card-footer"><span><Wifi size={13} />{device.transport === 'webrtc' ? 'WebRTC' : device.transport === 'relay' ? 'Relay' : 'Local connection'}</span><span>{device.online ? 'Connected' : `Seen ${relativeTime(device.lastSeen)}`}</span></div>{!device.online && <p className="device-offline-note">Its chats and live tools will return when it reconnects.</p>}</article>)}</div>{state.devices.length === 1 && <div className="device-pairing-callout"><Link2 size={22} /><div><h2>Put another machine to work.</h2><p>Pair a Mac or Linux device. Its sessions appear here while source and accepted results stay attached to your goals.</p></div><Button variant="outline" onClick={() => setPairing(true)}>Pair another device</Button></div>}{!state.devices.length && <EmptyState icon={<Monitor size={32} />} title="Your devices belong here">Connect an installed device service to start your factory.</EmptyState>}<Modal open={pairing} onClose={() => setPairing(false)} title="Pair a device" description="Exchange an invitation with another owned device. Pairing authenticates its identity before sharing control."><div className="modal-form"><div className="pairing-section"><h3>Invite another device</h3><p>Generate an invitation here, then paste it into EnoughFactory on the other device.</p>{invite ? <><textarea className="pairing-code" value={invite} readOnly aria-label="Device invitation" rows={4} /><Button variant="outline" onClick={() => { void navigator.clipboard.writeText(invite).then(() => setCopied(true)); }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy invitation'}</Button>{expires && <span className="field-hint">Expires {new Date(expires).toLocaleTimeString()}</span>}</> : <Button variant="outline" disabled={busy} onClick={() => void generate()}><Link2 size={14} />Generate invitation</Button>}</div><div className="pairing-section"><h3>Accept an invitation</h3><Field label="Invitation from your other device"><textarea rows={4} value={remoteInvite} onChange={event => setRemoteInvite(event.target.value)} placeholder="Paste the invitation…" /></Field><Button disabled={!remoteInvite.trim() || busy} onClick={() => void pair()}><Plus size={14} />Pair device</Button></div></div></Modal></>;
}
