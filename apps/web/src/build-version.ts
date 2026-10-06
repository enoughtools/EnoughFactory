export interface UiBuildVersion {
  readonly version: string;
  readonly revision: string | null;
  readonly revisionFull: string | null;
  readonly dirty: boolean | null;
}

declare const __ENOUGHFACTORY_UI_BUILD__: UiBuildVersion;

/** Identity of this UI bundle, available even when no device service is connected. */
export const UI_BUILD: UiBuildVersion = Object.freeze(__ENOUGHFACTORY_UI_BUILD__);
