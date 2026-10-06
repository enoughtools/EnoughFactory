import type { ChangeEvent } from 'react';
import { useState } from 'react';
import type { ApprovalMode, FactoryState, RuntimeKind, Settings } from '@enoughfactory/contracts';
import { ArrowRight, Check, RefreshCw, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import type { Connection, DeviceClient } from './api';
import { BrowserConnection } from './BrowserConnection';
import { RuntimePanel } from './RuntimePanel';
import { uiBuildLabel } from './BuildVersion';
import { UI_BUILD } from './build-version';
import { Button, Field, Input, PageHeader, Panel, Status } from './ui';
import './settings-device.css';

type Run = (action: () => Promise<unknown>) => Promise<void>;
export const enoughNetworkingUrl = 'wss://enoughfactory-network.russellbloxwich.workers.dev/ws';
const policies: { mode: ApprovalMode; label: string; description: string }[] = [
  { mode: 'approve-all', label: 'Approve all', description: 'Agents execute freely inside their containers. Enough accepts supported requests immediately.' },
  { mode: 'rules', label: 'Use rules', description: 'Evaluate typed requests against project rules. Unresolved choices appear in your inbox.' },
  { mode: 'manual', label: 'Ask me', description: 'Review the approval requests your selected runtime can expose, directly in Enough.' },
];

export function ConnectionForm({ connection, onConnect }: { connection: Connection; onConnect: (value: Connection) => void }) {
  const [url, setUrl] = useState(connection.url || 'http://127.0.0.1:4317');
  const [token, setToken] = useState(connection.token);
  const [error, setError] = useState<string | null>(null);
  return <><form className="modal-form" onSubmit={event => { event.preventDefault(); try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use an HTTP or HTTPS service address.'); onConnect({ mode: 'http', url: parsed.origin, token: token.trim() }); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}><Field label="Device service address" hint="Your installed device service keeps running when this app closes."><Input required type="url" value={url} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setUrl(event.target.value)} placeholder="http://127.0.0.1:4317" /></Field><Field label="Connection token" hint="Find it in your device service connection settings. It stays in this browser’s local preferences."><Input type="password" autoComplete="off" value={token} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setToken(event.target.value)} placeholder="Paste your device token" /></Field>{error && <div className="error-banner">{error}</div>}<Button type="submit">Connect to device</Button></form><BrowserConnection connection={connection} onConnect={onConnect} /></>;
}

export function SettingsPage({ state, client, run, connection, setConnection, refresh, onOpenDevices }: { state: FactoryState; client: DeviceClient; run: Run; connection: Connection; setConnection: (value: Connection) => void; refresh: () => Promise<void>; onOpenDevices?: () => void }) {
  const [settings, setSettings] = useState<Settings>(state.settings);
  const [saved, setSaved] = useState(false);
  const hostedNetworkingAvailable = state.diagnostics.networking?.hostedRelay === true;
  const hostedNetworkingSelected = settings.signalingUrl === enoughNetworkingUrl;
  const networkingConfigured = Boolean(settings.signalingUrl?.trim());
  const networkingChanged = settings.signalingUrl !== state.settings.signalingUrl;
  const desktop = Boolean(window.enoughFactory);
  const save = async () => { await run(async () => { await client.patch('/api/settings', settings); setSaved(true); }); };
  return <>
    <PageHeader title="Settings" actions={<Button onClick={() => void save()}>{saved ? <Check size={15} /> : <SlidersHorizontal size={15} />}{saved ? 'Saved' : 'Save changes'}</Button>} />
    <div className="settings-layout">
      <RuntimePanel state={state} client={client} run={run} />
      <Panel title="Device defaults">
        <p className="settings-context">Defaults for new work on {state.device.name}. Each goal can choose its own agent and approval policy.</p>
        <div className="form-grid">
          <Field label="Device name"><Input value={settings.deviceName} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { setSaved(false); setSettings({ ...settings, deviceName: event.target.value }); }} /></Field>
          <Field label="Default agent"><select value={settings.defaultRuntime} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { setSaved(false); setSettings({ ...settings, defaultRuntime: event.target.value as RuntimeKind }); }}><option value="codex">Codex</option><option value="antigravity">Antigravity</option><option value="claude">Claude</option></select></Field>
        </div>
      </Panel>
      <Panel title="Default approval policy">
        <div className="policy-choice-grid">{policies.map(policy => <button className={`policy-choice ${settings.defaultApprovalMode === policy.mode ? 'active' : ''}`} aria-pressed={settings.defaultApprovalMode === policy.mode} key={policy.mode} onClick={() => { setSaved(false); setSettings({ ...settings, defaultApprovalMode: policy.mode }); }}><div><ShieldCheck size={18} /><strong>{policy.label}</strong>{settings.defaultApprovalMode === policy.mode && <Check size={14} />}</div><p>{policy.description}</p></button>)}</div>
        <details className="settings-disclosure"><summary>Approval coverage</summary><p className="field-hint">All agents receive full container access. Selective decisions cover the typed requests each runtime exposes; they do not intercept every effect inside an allowed command. Changes apply to new work.</p></details>
      </Panel>
      <Panel title="Device connections" actions={onOpenDevices && <Button variant="ghost" size="sm" onClick={onOpenDevices}>Manage devices<ArrowRight size={14} /></Button>}>
        <div className="settings-connection-summary"><strong>{hostedNetworkingSelected ? 'Enough networking' : networkingConfigured ? 'Custom networking' : 'Device pairing is not configured'}</strong><Status state={networkingConfigured ? 'ready' : 'unknown'} label={networkingChanged ? 'Unsaved' : networkingConfigured ? 'Configured' : 'Not configured'} /></div>
        <p className="settings-context">Pair your computers in Devices to share work between them. Enough connects paired devices directly where possible and uses an encrypted relay when needed. Work and chats stay on the device running them.</p>
        {hostedNetworkingAvailable && !hostedNetworkingSelected && <Button variant="outline" size="sm" onClick={() => { setSaved(false); setSettings(previous => ({ ...previous, signalingUrl: enoughNetworkingUrl })); }}>Use Enough networking</Button>}
        {networkingChanged && <p className="field-hint">Save changes to apply this networking configuration.</p>}
        {!hostedNetworkingAvailable && <p className="field-hint">Update this device service to use Enough networking, or configure your own service below.</p>}
        <details className="settings-disclosure"><summary>Advanced networking</summary>
          <p className="field-hint">Use these settings for a self-hosted network or a separate TURN relay. The normal connection does not require a TURN server.</p>
          {hostedNetworkingSelected && <details className="settings-disclosure"><summary>Enough networking capacity</summary><p className="field-hint">Shared limits: 1 GiB of encrypted WebSocket relay traffic and 10,000 network messages per UTC day, with up to 128 simultaneous connections. Capacity may be reached earlier. Direct WebRTC remains available if relay capacity is reached. Hosted TURN is not enabled.</p></details>}
          <div className="form-grid">
            <Field label="Signaling service" hint="Introduces paired devices and provides the configured WebSocket fallback."><Input type="url" value={settings.signalingUrl ?? ''} placeholder="wss://signal.example.com" onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { setSaved(false); setSettings({ ...settings, signalingUrl: event.target.value || undefined }); }} /></Field>
            <Field label="TURN relay addresses" hint="Optional WebRTC relay, separate from WebSocket fallback. One TURN address per line."><textarea rows={3} value={settings.turnUrls?.join('\n') ?? ''} placeholder="turn:relay.example.com:3478" onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { setSaved(false); setSettings({ ...settings, turnUrls: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) }); }} /></Field>
            <Field label="TURN username"><Input autoComplete="off" value={settings.turnUsername ?? ''} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { setSaved(false); setSettings({ ...settings, turnUsername: event.target.value || undefined }); }} /></Field>
            <Field label="TURN credential"><Input autoComplete="off" type="password" value={settings.turnCredential ?? ''} onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { setSaved(false); setSettings({ ...settings, turnCredential: event.target.value || undefined }); }} /></Field>
          </div>
        </details>
      </Panel>
      <Panel title="Workspace connection" actions={onOpenDevices && <Button variant="ghost" size="sm" onClick={onOpenDevices}>Devices<ArrowRight size={14} /></Button>}>
        <div className="settings-connection-summary"><strong>{state.device.name}</strong><Status state="ready" label="Connected" /></div>
        <p className="settings-context">{desktop ? 'The desktop app connects to its installed device service automatically. Work continues when you close this window.' : `This browser controls the service on ${state.device.name}. This workspace connection is separate from the worker devices available to your goals. Work continues when you close this tab.`}</p>
        {!desktop && <BrowserConnection connection={connection} onConnect={setConnection} />}
        <details className="settings-disclosure"><summary>Advanced connection details</summary><ConnectionForm connection={connection} onConnect={setConnection} /></details>
      </Panel>
      <Panel title="Diagnostics">
        <details className="settings-disclosure settings-disclosure-first"><summary>Bundled engine and agent runtimes</summary>
          <div className="settings-diagnostics-heading"><p className="field-hint">envmux is a required internal engine. These diagnostics are not a list of tools installed inside agent containers.</p><Button variant="ghost" size="sm" onClick={() => void run(async () => { await client.get('/api/diagnostics'); await refresh(); })}><RefreshCw size={14} />Refresh</Button></div>
          <div className="diagnostics-list"><div className="diagnostic-row"><div><strong>envmux · internal engine</strong><span>{state.diagnostics.envmux.version || state.diagnostics.envmux.error || 'Environment engine'}</span></div><Status state={state.diagnostics.envmux.available ? 'ready' : 'failed'} label={state.diagnostics.envmux.available ? 'Ready' : 'Setup needed'} /></div>{state.diagnostics.runtimes.map(runtime => <div className="diagnostic-row" key={runtime.kind}><div><strong>{runtime.kind}</strong><span>{runtime.version ?? runtime.details ?? 'Not detected'}</span><span>{runtime.interactiveApprovals ? 'Typed approvals available' : 'Full execution without an approval response channel'}{runtime.resume ? ' · conversation resume' : ''}</span></div><Status state={runtime.available ? 'ready' : 'unknown'} label={runtime.available ? 'Available' : 'Not detected'} /></div>)}</div>
        </details>
      </Panel>
      <p className="field-hint" title={`UI source: ${UI_BUILD.revisionFull ?? 'unavailable'}`}>UI {uiBuildLabel}{connection.appVersion && ` · Desktop v${connection.appVersion}`} · Device service v{state.version} · {state.device.platform} / {state.device.arch}</p>
    </div>
  </>;
}

export { policies };
