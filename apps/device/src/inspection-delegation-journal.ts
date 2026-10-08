import type { InspectionAction, InspectionEvidence, InspectionJob, InspectionSession } from '@enoughfactory/contracts';
import type { ArtifactManifest } from '@enoughfactory/workspaces';
import type { InspectionObservation } from './inspection-jobs.ts';

export type InspectionJournalRecord =
  | { bucket: 'inspection-actions'; value: InspectionAction }
  | { bucket: 'inspection-observations'; value: InspectionObservation }
  | { bucket: 'inspection-evidence'; value: InspectionEvidence };

export interface InspectionJournalEvent {
  /** Original owner SQLite sequence, shared across entities rather than renumbered by the relay. */
  seq: number;
  entity: string;
  value: { kind: string; at: string; value: unknown };
  record?: InspectionJournalRecord;
  /** Exact InspectionJournalRecord JSON when that single public record exceeds the page budget. */
  recordArtifact?: ArtifactManifest;
}

export interface InspectionJournalPage {
  job: InspectionJob;
  sessions: InspectionSession[];
  events: InspectionJournalEvent[];
  /** Last delivered original sequence. Pass this unchanged to obtain the following page. */
  after: number;
  hasMore: boolean;
}
