/**
 * Simplified Natural Earth 1:110m country boundaries (public domain).
 * Extracted 2026-09-17 using ISO_A2_EH. Antarctica omitted.
 * Equirectangular SVG: x=(longitude+180)*2, y=(85-latitude)*2.
 * ViewBox: 0 0 720 300. See docs/country-heatmap.md for provenance.
 * The two -99 entries are unassigned disputed regions; never join data to them.
 */
export type CountryHeatmapGeometry = {
    readonly code: string;
    readonly name: string;
    readonly path: string;
};
export declare const countryHeatmapGeometry: readonly CountryHeatmapGeometry[];
//# sourceMappingURL=country-heatmap-geometry.d.ts.map