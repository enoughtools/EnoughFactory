/** Normalizes progress values identically for native Astro and React. */
export declare function normalizeProgress(value?: number | null, max?: number): {
    readonly max: number;
    readonly value: number | null;
    readonly percentage: number;
    readonly state: "loading" | "indeterminate" | "complete";
};
export declare function progressValueLabel(value: number, max: number): string;
export declare const progressClasses: {
    readonly root: "relative h-4 w-full overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]";
    readonly indicator: "h-full w-full bg-[var(--color-accent)] transition-transform duration-300 ease-out";
};
//# sourceMappingURL=progress.d.ts.map