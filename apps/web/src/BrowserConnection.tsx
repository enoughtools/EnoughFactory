import { useEffect, useState } from 'react';
import type { Device } from '@enoughfactory/contracts';
import { ArrowRight, Link2, Wifi } from 'lucide-react';
import type { Connection } from './api';
import { browserPeerClient, pairedBrowserDevices, peerChanges } from './browserPeers';
import { Button, Field, Status } from './ui';

export function BrowserConnection({ connection, onConnect }: { connection: Connection; onConnect: (connection: Connection) => void }) {
  const [expanded, setExpanded] = useState(connection.mode === 'peer');
  const [devices, setDevices] = useState<Device[]>([]);
  const [invitation, setInvitation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    void pairedBrowserDevices().then(value => { if (active) setDevices(value); }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    const update = (event: Event) => setDevices((event as CustomEvent<Device[]>).detail.filter(device => !device.local));
    peerChanges.addEventListener('devices', update);
    return () => { active = false; peerChanges.removeEventListener('devices', update); };
  }, [expanded]);
  async function pair() {
    setBusy(true); setError(null);
    try { const device = await (await browserPeerClient()).pair(invitation); onConnect({ mode: 'peer', deviceId: device.id, url: '', token: '' }); setInvitation(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  if (window.enoughFactory) return null;
  return <section className="browser-connection"><Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}><Wifi size={15} />{expanded ? 'Direct device pairing' : 'Or connect directly over WebRTC'}<ArrowRight size={13} /></Button>{expanded && <div className="modal-form">{devices.length > 0 && <div className="paired-browser-devices">{devices.map(device => <button className={`paired-browser-device ${connection.deviceId === device.id ? 'active' : ''}`} key={device.id} onClick={() => onConnect({ mode: 'peer', deviceId: device.id, url: '', token: '' })}><strong>{device.name}</strong><Status state={device.online ? 'ready' : 'offline'} label={device.online ? 'Connect' : 'Offline'} /></button>)}</div>}<form className="modal-form" onSubmit={event => { event.preventDefault(); void pair(); }}><Field label="Device invitation" hint="In the desktop app, open Devices → Pair a device → Generate invitation. Paste it here while that device is online."><textarea rows={3} value={invitation} onChange={event => setInvitation(event.target.value)} placeholder="Paste an invitation from your device…" /></Field>{error && <div className="error-banner">{error}</div>}<Button type="submit" variant="outline" disabled={busy || !invitation.trim()}><Link2 size={15} />{busy ? 'Pairing your device…' : 'Pair & connect'}</Button><p className="field-hint">Accepting this invitation allows this browser to control the paired factory service. Chats stay on the device; live connections use WebRTC with an encrypted relay fallback when needed.</p></form></div>}</section>;
}
