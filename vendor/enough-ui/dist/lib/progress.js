/** Normalizes progress values identically for native Astro and React. */
export function normalizeProgress(value, max = 100) {
    const limit = Number.isFinite(max) && max > 0 ? max : 100;
    const current = value == null || !Number.isFinite(value)
        ? null
        : Math.min(limit, Math.max(0, value));
    return {
        max: limit,
        value: current,
        percentage: current === null ? 0 : current / limit * 100,
        state: current === null ? "indeterminate" : current === limit ? "complete" : "loading",
    };
}
export function progressValueLabel(value, max) {
    return `${Math.round(value / max * 100)}%`;
}
export const progressClasses = {
    root: "relative h-4 w-full overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]",
    indicator: "h-full w-full bg-[var(--color-accent)] transition-transform duration-300 ease-out",
};
//# sourceMappingURL=progress.js.map