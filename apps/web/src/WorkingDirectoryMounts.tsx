import { useEffect, useRef, useState } from 'react';
import type { Artifact, WorkingDirectoryMount } from '@enoughfactory/contracts';
import { Download } from 'lucide-react';
import type { DeviceClient } from './api';
import { downloadArtifact } from './artifacts';
import { Button, Status } from './ui';
import './working-directory-mounts.css';

export interface WorkingDirectoryMountsProps {
  mounts: WorkingDirectoryMount[];
  deviceId: string;
  client: DeviceClient;
  run: (action: () => Promise<unknown>) => Promise<void>;
  offline?: boolean;
  compact?: boolean;
}

interface Transfer { id: string; received: number; size?: number }

export function WorkingDirectoryMounts({ mounts, deviceId, client, run, offline = false, compact = false }: WorkingDirectoryMountsProps) {
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [error, setError] = useState<{ mountId: string; message: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const context = `${deviceId}:${mounts.map(mount => mount.id).join(':')}`;
  useEffect(() => {
    generation.current++;
    setError(null);
    setTransfer(null);
    return () => { generation.current++; };
  }, [context]);

  async function exportArtifact(mountId: string, artifactId: string) {
    if (busy.current || offline || !deviceId) return;
    busy.current = true;
    setExporting(true);
    const current = generation.current;
    setError(null);
    setTransfer({ id: artifactId, received: 0 });
    try {
      await run(async () => {
        try {
          const artifact = await client.get<Artifact>(`/api/artifacts/${encodeURIComponent(artifactId)}?deviceId=${encodeURIComponent(deviceId)}`);
          if (artifact.id !== artifactId || artifact.deviceId !== deviceId) throw new Error('The export does not match its recorded owner.');
          if (generation.current === current) setTransfer({ id: artifactId, received: 0, size: artifact.size });
          await downloadArtifact(client, artifact, deviceId, received => {
            if (generation.current === current) setTransfer({ id: artifactId, received, size: artifact.size });
          });
        } catch (cause) {
          if (generation.current === current) setError({ mountId, message: cause instanceof Error ? cause.message : 'The export could not be downloaded.' });
          throw cause;
        }
      });
    } catch (cause) {
      if (generation.current === current) setError({ mountId, message: cause instanceof Error ? cause.message : 'The export could not be downloaded.' });
    } finally {
      busy.current = false;
      setExporting(false);
      if (generation.current === current) setTransfer(null);
    }
  }

  function exportLabel(artifactId: string, label: string) {
    if (transfer?.id !== artifactId) return label;
    return transfer.size === undefined ? 'Loading…' : `${label} · ${Math.round(transfer.received / Math.max(1, transfer.size) * 100)}%`;
  }

  return <section className={`working-directory-mounts ${compact ? 'compact' : ''}`} aria-label="Additional working directories">
    <h3>Additional working directories <span>{mounts.length}</span></h3>
    {mounts.length > 0 ? <>
      <p className="wdm-caption">Only the primary repository follows automatic integration. Additional edits are retained for export and applied separately.</p>
      <ul className="wdm-list">{mounts.map(mount => <li className="wdm-mount" key={mount.id}>
        <div className="wdm-heading"><strong>{mount.name}</strong><span className="wdm-kind">{mount.kind === 'git' ? 'Git repository' : 'Folder snapshot'}</span><Status state={mount.status} /></div>
        <code className="wdm-path">{mount.path}</code>
        {mount.error && <p className="wdm-error">{mount.error}</p>}
        {!mount.capture && <p className="wdm-caption">{mount.status === 'preparing' ? 'Preparing snapshot; no captured edits yet.' : 'No captured edits recorded.'}</p>}
        {(mount.baseCommit || mount.sourceCommit || mount.capture?.commit) && <details className="wdm-details"><summary>Snapshot commits</summary><dl>
          {mount.baseCommit && <div><dt>Snapshot base</dt><dd><code>{mount.baseCommit}</code></dd></div>}
          {mount.sourceCommit && <div><dt>Source commit</dt><dd><code>{mount.sourceCommit}</code></dd></div>}
          {mount.capture?.commit && <div><dt>Captured commit</dt><dd><code>{mount.capture.commit}</code></dd></div>}
        </dl></details>}
        {(mount.capture?.bundleArtifactId || mount.capture?.diffArtifactId) && <div className="wdm-exports" aria-label={`Export ${mount.name}`}>
          {mount.capture.bundleArtifactId && <Button size="sm" variant="ghost" disabled={offline || !deviceId || exporting} onClick={() => void exportArtifact(mount.id, mount.capture!.bundleArtifactId)}><Download size={13} />{exportLabel(mount.capture.bundleArtifactId, 'Source bundle')}</Button>}
          {mount.capture.diffArtifactId && <Button size="sm" variant="ghost" disabled={offline || !deviceId || exporting} onClick={() => void exportArtifact(mount.id, mount.capture!.diffArtifactId)}><Download size={13} />{exportLabel(mount.capture.diffArtifactId, 'Diff')}</Button>}
        </div>}
        {error?.mountId === mount.id && <p className="wdm-error" role="alert">{error.message}</p>}
      </li>)}</ul>
      {offline && <p className="wdm-caption" role="status">Exports are unavailable while the owning device is offline.</p>}
      {!offline && !deviceId && <p className="wdm-caption">The export owner is unavailable.</p>}
    </> : <p className="wdm-caption">No additional working directory mounts recorded.</p>}
  </section>;
}
