import { useEffect, useState } from 'react';
import type { ApprovalMode, PolicyRule, Project, RuntimeKind } from '@enoughfactory/contracts';
import { Check, Code2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { DeviceClient } from './api';
import { useResource } from './hooks';
import { policies } from './SettingsPage';
import { Button, Field, Input, Loading, Modal } from './ui';

interface EnvironmentConfig { content: string; valid?: boolean; error?: string }
export function ProjectSettings({ project, client, open, close, run }: { project: Project; client: DeviceClient; open: boolean; close: () => void; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [section, setSection] = useState<'policy' | 'environment'>('policy');
  const [runtime, setRuntime] = useState(project.runtime);
  const [mode, setMode] = useState(project.approvalMode);
  const [rules, setRules] = useState<PolicyRule[]>(project.rules);
  const [content, setContent] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const config = useResource<EnvironmentConfig>(client, open && section === 'environment' ? `/api/projects/${project.id}/config` : null);
  useEffect(() => { if (config.data) { setContent(config.data.content); setConfigError(config.data.error ?? null); } }, [config.data]);
  async function save() {
    setSaving(true); setSaved(false);
    await run(async () => {
      if (section === 'environment') {
        try { JSON.parse(content); } catch (cause) { setConfigError(cause instanceof Error ? cause.message : 'Invalid JSON.'); return; }
        const result = await client.put<EnvironmentConfig>(`/api/projects/${project.id}/config`, { content });
        setConfigError(result.error ?? null); setSaved(result.valid !== false);
      } else { await client.patch(`/api/projects/${project.id}`, { runtime, approvalMode: mode, rules: rules.filter(rule => rule.tool?.trim() || rule.commandPattern?.trim()) }); setSaved(true); }
    });
    setSaving(false);
  }
  function changeRule(id: string, changes: Partial<PolicyRule>) { setSaved(false); setRules(rules.map(rule => rule.id === id ? { ...rule, ...changes } : rule)); }
  return <Modal open={open} onClose={close} title={`${project.name} settings`} description="Environment and agent defaults."><div className="session-tabs" role="tablist" aria-label="Project settings"><button className={`session-tab ${section === 'policy' ? 'active' : ''}`} role="tab" aria-selected={section === 'policy'} onClick={() => setSection('policy')}><ShieldCheck size={14} />Agent & policy</button><button className={`session-tab ${section === 'environment' ? 'active' : ''}`} role="tab" aria-selected={section === 'environment'} onClick={() => setSection('environment')}><Code2 size={14} />Environment</button></div><div className="modal-form">{section === 'policy' ? <><div className="form-grid"><Field label="Default agent"><select value={runtime} onChange={event => { setSaved(false); setRuntime(event.target.value as RuntimeKind); }}><option value="codex">Codex</option><option value="antigravity">Antigravity</option><option value="claude">Claude</option></select></Field><Field label="Approval policy"><select value={mode} onChange={event => { setSaved(false); setMode(event.target.value as ApprovalMode); }}>{policies.map(policy => <option key={policy.mode} value={policy.mode}>{policy.label}</option>)}</select></Field></div><p className="field-hint">New conversations and tasks use this policy. All modes preserve full container access. Rules apply only to typed requests the runtime exposes.</p>{mode === 'rules' && <><div className="section-heading"><h3>Decision rules</h3><Button variant="ghost" size="sm" onClick={() => { setSaved(false); setRules([...rules, { id: crypto.randomUUID(), tool: '', commandPattern: '', decision: 'allow' }]); }}><Plus size={14} />Add rule</Button></div>{rules.length ? rules.map(rule => <div className="rule-row" key={rule.id}><Field label="Tool"><Input value={rule.tool ?? ''} placeholder="item/commandExecution/*" onChange={(event: React.ChangeEvent<HTMLInputElement>) => changeRule(rule.id, { tool: event.target.value })} /></Field><Field label="Command pattern"><Input value={rule.commandPattern ?? ''} placeholder="npm run *" onChange={(event: React.ChangeEvent<HTMLInputElement>) => changeRule(rule.id, { commandPattern: event.target.value })} /></Field><Field label="Decision"><select value={rule.decision} onChange={event => changeRule(rule.id, { decision: event.target.value as PolicyRule['decision'] })}><option value="allow">Allow</option><option value="deny">Deny</option><option value="ask">Ask me</option></select></Field><Button variant="ghost" size="icon" aria-label="Remove rule" onClick={() => { setSaved(false); setRules(rules.filter(item => item.id !== rule.id)); }}><Trash2 size={14} /></Button></div>) : <p className="field-hint">Rules run in order; the first match decides. Use * as a wildcard. With no matching rule, unresolved requests go to your approval inbox.</p>}</>}</> : config.loading ? <Loading>Reading environment setup…</Loading> : config.error ? <div className="error-banner">{config.error}</div> : <><Field label="Environment definition" hint="The project’s .envmux.json. Changes apply to the next environment you start."><textarea className="config-editor" aria-label="Environment definition JSON" rows={14} value={content} onChange={event => { setSaved(false); setConfigError(null); setContent(event.target.value); }} spellCheck={false} /></Field>{configError && <div className="error-banner">{configError}</div>}<a href="https://github.com/envmux/envmux" target="_blank" rel="noreferrer" className="field-hint">envmux environment configuration reference</a></>}<Button onClick={() => void save()} disabled={saving || (section === 'environment' && (config.loading || !!config.error))}>{saved ? <Check size={15} /> : section === 'policy' ? <ShieldCheck size={15} /> : <Code2 size={15} />}{saving ? 'Saving…' : saved ? 'Saved' : 'Save settings'}</Button></div></Modal>;
}
