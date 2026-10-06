import { useEffect, useState } from 'react';
import type { Device } from '@enoughfactory/contracts';
import { ArrowRight, Link2, RefreshCw, Wifi } from 'lucide-react';
import type { Connection } from './api';
import { browserPeerClient, pairedBrowserDevices, peerChanges } from './browserPeers';
import { Button, Field, Status } from './ui';

const DEVICE_SERVICE_UPDATE_REQUIRED = '[DEVICE_SERVICE_UPDATE_REQUIRED]';

export function deviceConnectionError(error: string | null): string | null {
  if (!error) return error;
  const marker = error.indexOf(DEVICE_SERVICE_UPDATE_REQUIRED);
  return marker < 0 ? error : error.slice(marker + DEVICE_SERVICE_UPDATE_REQUIRED.length).trim();
}

export function DesktopServiceRecovery({ error, onConnect }: { error: string | null; onConnect: (connection: Connection) => void }) {
  const [busy, setBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const restart = window.enoughFactory?.restartDeviceService;
  if (!restart || !error?.includes(DEVICE_SERVICE_UPDATE_REQUIRED)) return null;
  async function update() {
    setBusy(true); setRecoveryError(null);
    try { onConnect({ ...await restart!(), mode: 'http' }); }
    catch (cause) { setRecoveryError(deviceConnectionError(cause instanceof Error ? cause.message : String(cause))); }
    finally { setBusy(false); }
  }
  return <section className="modal-form" aria-label="Update device service" aria-busy={busy}><div className="notice"><RefreshCw size={18} /><div><strong>Update device service</strong><p className="field-hint">Restart with this installation’s current service version. Existing environments and work records are retained.</p></div></div>{recoveryError && <div className="error-banner" role="alert">{recoveryError}</div>}<div className="header-actions"><Button disabled={busy} onClick={() => void update()}><RefreshCw size={15} className={busy ? 'loading-spinner' : undefined} />{busy ? 'Updating device service…' : 'Update device service'}</Button></div></section>;
}

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
  return <section className="browser-connection"><Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}><Wifi size={15} />Pair a device<ArrowRight size={13} /></Button>{expanded && <div className="modal-form">{devices.length > 0 && <div className="paired-browser-devices">{devices.map(device => <button className={`paired-browser-device ${connection.deviceId === device.id ? 'active' : ''}`} key={device.id} onClick={() => onConnect({ mode: 'peer', deviceId: device.id, url: '', token: '' })}><strong>{device.name}</strong><Status state={device.online ? 'ready' : 'offline'} label={device.online ? 'Connect' : 'Offline'} /></button>)}</div>}<form className="modal-form" onSubmit={event => { event.preventDefault(); void pair(); }}><Field label="Device invitation" hint="Open Devices → Pair a device → Generate invitation on the other device. Paste it here while that device is online."><textarea rows={3} value={invitation} onChange={event => setInvitation(event.target.value)} placeholder="Paste an invitation from your device…" /></Field>{error && <div className="error-banner">{error}</div>}<Button type="submit" variant="outline" disabled={busy || !invitation.trim()}><Link2 size={15} />{busy ? 'Pairing…' : 'Pair & connect'}</Button><p className="field-hint">Pairing allows this browser to control the device. Chats stay on that device; remote connections are encrypted.</p></form></div>}</section>;
}
