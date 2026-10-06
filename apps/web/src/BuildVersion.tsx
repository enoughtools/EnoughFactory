import { UI_BUILD } from './build-version';

export const uiBuildLabel = `v${UI_BUILD.version} · ${UI_BUILD.revision ?? 'source unavailable'}${UI_BUILD.dirty ? ' +modified' : ''}`;

export function BuildVersion({ desktopVersion, serviceVersion, serviceOnline, className = '' }: { desktopVersion?: string; serviceVersion?: string; serviceOnline?: boolean; className?: string }) {
  const details = [
    `UI ${uiBuildLabel}`,
    `Source: ${UI_BUILD.revisionFull ?? 'unavailable'}`,
    desktopVersion && `Desktop: v${desktopVersion}`,
    serviceVersion ? `Device service: v${serviceVersion}${serviceOnline ? '' : ' (last known)'}` : 'Device service: not connected',
  ].filter(Boolean).join('\n');
  return <span className={`build-version ${className}`} title={details} aria-label={details}>{uiBuildLabel}</span>;
}
