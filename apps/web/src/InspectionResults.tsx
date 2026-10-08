import { useEffect, useRef, useState } from 'react';
import type { Device, InspectionEvidence, InspectionJob, InspectionSession, InspectionVerificationRun } from '@enoughfactory/contracts';
import { ArrowUpRight, Download, Image, MessageSquare, RefreshCw } from 'lucide-react';
import { DeviceRequestError, type DeviceClient } from './api';
import { downloadArtifact, readArtifactBlob } from './artifacts';
import { capabilityLabels } from './ExecutionReadiness';
import { relativeTime } from './hooks';
import { Button, Modal, Status } from './ui';
import './inspection-results.css';

interface InspectionRecords { jobs: InspectionJob[]; sessions: InspectionSession[]; evidence: InspectionEvidence[]; verifiers?: InspectionVerificationRun[] }
type Run = (action: () => Promise<unknown>) => Promise<void>;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const labels: Partial<Record<InspectionJob['status'], string>> = { succeeded: 'Finished', 'cancellation-requested': 'Stopping', unknown: 'Outcome unknown' };

function ResultEvidence({ evidence, job, client, run, device }: { evidence: InspectionEvidence; job: InspectionJob; client: DeviceClient; run: Run; device?: Device }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const active = useRef(true);
  const screenshot = evidence.kind === 'screenshot' && imageTypes.has(evidence.artifact.mime);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  async function open(downloadOnly = false) {
    if (busy) return;
    setBusy(true); setError(undefined); setProgress(0);
    try {
      await run(async () => {
        try {
          if (screenshot && !downloadOnly) {
            if (evidence.artifact.size > 16 * 1024 * 1024) throw new Error('This screenshot is too large to preview. Download it to view the original.');
            const blob = await readArtifactBlob(client, evidence.artifact, evidence.artifact.deviceId, received => { if (active.current) setProgress(received); });
            if (active.current) setPreview(URL.createObjectURL(blob));
          } else await downloadArtifact(client, evidence.artifact, evidence.artifact.deviceId, received => { if (active.current) setProgress(received); });
        } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'This result could not be opened.'); throw cause; }
      });
    } finally { if (active.current) setBusy(false); }
  }
  return <li className="inspection-evidence-row"><div><strong>{evidence.artifact.name}</strong><span>{evidence.kind.replaceAll('-', ' ')} · {relativeTime(evidence.createdAt)}</span>{error && <p role="alert">{error}</p>}</div><div className="inspection-evidence-actions"><Button size="sm" variant="ghost" disabled={busy || device?.online === false} onClick={() => void open()}>{screenshot ? <Image size={13} /> : <Download size={13} />}{busy ? `${Math.round(progress / Math.max(1, evidence.artifact.size) * 100)}%` : screenshot ? 'View screenshot' : 'Download result'}</Button>{screenshot && <Button size="sm" variant="ghost" disabled={busy || device?.online === false} onClick={() => void open(true)} aria-label={`Download ${evidence.artifact.name}`}><Download size={13} /></Button>}</div>
    <Modal open={!!preview} onClose={() => setPreview(undefined)} title={evidence.artifact.name} description={`Captured on ${device?.name ?? job.ownerDeviceId}. Source ${job.source.checkedCommit?.slice(0, 12) ?? job.source.candidateCommit?.slice(0, 12) ?? job.source.sha256.slice(0, 12)}.`}><div className="inspection-screenshot">{preview && <img src={preview} alt={`Inspection of ${evidence.artifact.name}`} />}<p>Original screenshot · fingerprint verified</p><Button size="sm" variant="outline" disabled={busy || device?.online === false} onClick={() => void open(true)}><Download size={13} />{busy ? 'Downloading…' : 'Download screenshot'}</Button></div></Modal>
  </li>;
}

export function InspectionResults({ taskId, attemptId, devices, client, run, onOpenChat, openSession }: { taskId: string; attemptId?: string; devices: Device[]; client: DeviceClient; run: Run; onOpenChat?: (sessionId: string, chatId: string) => void; openSession?: (sessionId: string) => void }) {
  const [records, setRecords] = useState<InspectionRecords>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true, pending = false;
    setRecords(undefined); setError(undefined); setLoading(true);
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const result = await client.get<InspectionRecords>(`/api/tasks/${encodeURIComponent(taskId)}/inspection`);
        if (active) { setRecords(result); setError(undefined); }
      } catch (cause) {
        if (active) setError(cause instanceof DeviceRequestError && cause.status === 404 ? 'This device service does not yet report inspection results.' : cause instanceof Error ? cause.message : 'Inspection results are unavailable.');
      } finally { pending = false; if (active) setLoading(false); }
    }
    void load();
    const interval = setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, 15_000);
    return () => { active = false; clearInterval(interval); };
  }, [client, taskId, refresh]);
  const jobs = (records?.jobs ?? []).filter(job => job.authority.taskId === taskId && (!attemptId || job.authority.attemptId === attemptId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const verifiers = (records?.verifiers ?? []).filter(verifier => verifier.authority.taskId === taskId && (!attemptId || verifier.authority.attemptId === attemptId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <section className="ti-section inspection-results" aria-label="Inspection results"><div className="inspection-results-heading"><h3>Screenshots and testing</h3><Button size="sm" variant="ghost" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={12} />Refresh</Button></div>
    {loading && <p className="ti-muted" role="status">Loading inspection results…</p>}
    {error && <p className="ti-muted" role="status">{error}</p>}
    {!loading && !error && !jobs.length && !verifiers.length && <p className="ti-muted">No browser or native inspection has been recorded for this attempt.</p>}
    {verifiers.map(verifier => {
      const device = devices.find(device => device.id === verifier.ownerDeviceId);
      return <article className="inspection-result" key={verifier.id}>
        <div className="inspection-results-heading"><strong>Independent UI review · {device?.name ?? 'Owning device'}</strong><Status state={verifier.status} label={verifier.status === 'succeeded' ? 'Review finished' : verifier.status === 'unknown' ? 'Outcome unknown' : undefined} /></div>
        <p className="ti-muted">{verifier.executionTargetKind === 'host-macos' ? 'Mac reviewer' : 'Container reviewer'} · updated {relativeTime(verifier.updatedAt)}. This reviewer has its own conversation and checks the saved source.</p>
        {verifier.reason && <p className="ti-preserve">{verifier.reason}</p>}
        {device?.online === false && <p className="ti-muted">Reconnect {device.name} to open its verification conversation. The last recorded review status is retained.</p>}
        <div className="ti-summary-actions">{verifier.sessionId && verifier.chatId && onOpenChat && <Button size="sm" variant="outline" disabled={device?.online === false} onClick={() => onOpenChat(verifier.sessionId!, verifier.chatId!)}><MessageSquare size={13} />Verification conversation</Button>}{verifier.sessionId && openSession && <Button size="sm" variant="ghost" disabled={device?.online === false} onClick={() => openSession(verifier.sessionId!)}><ArrowUpRight size={13} />Verification workspace</Button>}</div>
        <details className="inspection-source"><summary>Reviewed source and policy</summary><dl>{verifier.source.candidateCommit && <div><dt>Candidate</dt><dd><code>{verifier.source.candidateCommit}</code></dd></div>}{verifier.source.checkedCommit && <div><dt>Checked source</dt><dd><code>{verifier.source.checkedCommit}</code></dd></div>}<div><dt>Source fingerprint</dt><dd><code>{verifier.source.sha256}</code></dd></div><div><dt>Review policy</dt><dd><code>{verifier.policySha256}</code></dd></div></dl></details>
      </article>;
    })}
    {jobs.map(job => {
      const device = devices.find(item => item.id === job.ownerDeviceId);
      const session = records?.sessions.find(item => item.jobId === job.id && item.authority.attemptId === job.authority.attemptId);
      const evidence = (records?.evidence ?? []).filter(item => item.jobId === job.id && item.authority.taskId === taskId && item.authority.attemptId === job.authority.attemptId
        && item.authority.goalRevision === job.authority.goalRevision && item.authority.authorityGeneration === job.authority.authorityGeneration
        && item.source.snapshotId === job.source.snapshotId && item.source.sha256 === job.source.sha256
        && item.source.candidateCommit === job.source.candidateCommit && item.source.checkedCommit === job.source.checkedCommit);
      return <article className="inspection-result" key={job.id}><div className="inspection-results-heading"><strong>{capabilityLabels[job.capability]} · {device?.name ?? 'Owning device'}</strong><Status state={job.status === 'cancellation-requested' ? 'waiting' : job.status} label={labels[job.status]} /></div>
        {job.reason && <p className="ti-preserve">{job.reason}</p>}{session?.reason && session.reason !== job.reason && <p className="ti-preserve">{session.reason}</p>}
        {device?.online === false && <p className="ti-muted">Reconnect {device.name} to open its retained results. This connection loss does not establish whether the inspection finished.</p>}
        <details className="inspection-source"><summary>Source and result identity</summary><dl><div><dt>Source snapshot</dt><dd><code>{job.source.snapshotId}</code></dd></div>{job.source.candidateCommit && <div><dt>Candidate</dt><dd><code>{job.source.candidateCommit}</code></dd></div>}{job.source.checkedCommit && <div><dt>Checked source</dt><dd><code>{job.source.checkedCommit}</code></dd></div>}<div><dt>Source fingerprint</dt><dd><code>{job.source.sha256}</code></dd></div><div><dt>Updated</dt><dd>{new Date(job.updatedAt).toLocaleString()}</dd></div></dl></details>
        {evidence.length ? <ul className="inspection-evidence">{evidence.map(item => <ResultEvidence key={item.id} evidence={item} job={job} client={client} run={run} device={devices.find(device => device.id === item.artifact.deviceId)} />)}</ul> : <p className="ti-muted">No screenshots or result artifacts have been recorded for this inspection.</p>}
      </article>;
    })}
  </section>;
}
