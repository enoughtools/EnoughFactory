export type CountryHeatmapDatum = {
    /** ISO 3166-1 alpha-2 code. Lowercase, UK (GB), and EL (GR) are accepted. */
    code: string;
    /** A measured zero is distinct from missing data. Nonfinite values become no data. */
    value: number | null;
    label?: string;
};
export type CountryHeatmapOptions = {
    data: readonly CountryHeatmapDatum[];
    title?: string;
    description?: string;
    valueLabel?: string;
    countryLabel?: string;
    noDataLabel?: string;
    emptyLabel?: string;
    tableLabel?: string;
    legendLabel?: string;
    unmappedLabel?: string;
    scaleLabel?: string;
    locale?: string;
    formatValue?: (value: number) => string;
    /** Log uses a signed log1p transform, so zero and negative values remain valid. */
    scale?: "linear" | "log";
    /** Color scale endpoints. Values outside this range keep their exact table values. */
    domain?: readonly [number, number];
    tableOpen?: boolean;
    note?: string;
};
export declare const countryHeatmapClasses: {
    readonly root: "grid w-full min-w-0 gap-4 border border-hairline bg-surface p-4 font-sans text-text-main shadow-card sm:p-5";
    readonly caption: "grid min-w-0 gap-1";
    readonly title: "text-lg font-medium leading-snug [overflow-wrap:anywhere]";
    readonly description: "text-sm leading-relaxed text-text-3 [overflow-wrap:anywhere]";
    readonly map: "block h-auto w-full overflow-visible";
    readonly legend: "flex min-w-0 max-w-full flex-wrap items-center gap-x-5 gap-y-3 text-xs text-text-2";
    readonly legendItem: "inline-flex min-w-0 max-w-full items-center gap-2 [overflow-wrap:anywhere]";
    readonly swatch: "inline-block h-3 w-5 shrink-0 border border-hairline";
    readonly range: "inline-flex min-w-0 max-w-full flex-wrap items-center gap-2";
    readonly endpoint: "min-w-0 max-w-full [overflow-wrap:anywhere]";
    readonly ramp: "inline-flex h-3 w-24 shrink-0 overflow-hidden border border-hairline";
    readonly rampStep: "h-full flex-1";
    readonly note: "text-xs leading-relaxed text-text-3 [overflow-wrap:anywhere]";
    readonly empty: "text-sm text-text-3";
    readonly details: "min-w-0 max-w-full border-t border-hairline pt-3 text-sm";
    readonly summary: "w-fit max-w-full cursor-pointer list-none font-medium underline decoration-border-mid underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent [&::-webkit-details-marker]:hidden";
    readonly tableWrapper: "mt-3 min-w-0 max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
    readonly table: "w-full text-sm";
    readonly tableCaption: "sr-only";
    readonly head: "border-b border-hairline pb-2 text-start font-medium text-text-3";
    readonly numberHead: "border-b border-hairline pb-2 text-end font-medium text-text-3";
    readonly row: "border-b border-hairline-soft last:border-0";
    readonly country: "py-2 pe-4 text-start font-normal";
    readonly code: "ms-2 text-xs text-text-3";
    readonly value: "py-2 text-end";
    readonly unmapped: "block text-xs text-text-3";
    readonly credit: "text-xs leading-relaxed text-text-3";
    readonly creditLink: "underline decoration-border-mid underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent";
};
export declare const countryHeatmapColors: string[];
export declare const countryHeatmapNoDataColor = "var(--color-hairline-soft)";
export declare const countryHeatmapDescription = "Color shows the value for each country. Missing data is separate from a measured zero. Exact values, including countries too small to appear on this map, are available below.";
export declare function normalizeCountryHeatmapCode(code: string): string;
/** Shared normalization, colors, labels, and table rows for both renderers. */
export declare function createCountryHeatmapModel({ data, locale, formatValue, scale, domain, noDataLabel, unmappedLabel, }: CountryHeatmapOptions): {
    rows: {
        label: string;
        formattedValue: string;
        mapped: boolean;
        bucket: number | null;
        state: string;
        code: string;
        value: number | null;
    }[];
    countries: {
        key: string;
        name: string;
        value: number | null;
        formattedValue: string;
        color: string;
        state: string;
        code: string;
        path: string;
    }[];
    domain: readonly [number, number];
    scale: "log" | "linear";
    hasData: boolean;
    collapsed: boolean;
    legendColors: string[];
    minimumLabel: string;
    maximumLabel: string;
    unmappedLabel: string;
    unmappedCount: number;
};
//# sourceMappingURL=country-heatmap.d.ts.map