import { countryHeatmapGeometry } from "./country-heatmap-geometry.js";
export const countryHeatmapClasses = {
    root: "grid w-full min-w-0 gap-4 border border-hairline bg-surface p-4 font-sans text-text-main shadow-card sm:p-5",
    caption: "grid min-w-0 gap-1",
    title: "text-lg font-medium leading-snug [overflow-wrap:anywhere]",
    description: "text-sm leading-relaxed text-text-3 [overflow-wrap:anywhere]",
    map: "block h-auto w-full overflow-visible",
    legend: "flex min-w-0 max-w-full flex-wrap items-center gap-x-5 gap-y-3 text-xs text-text-2",
    legendItem: "inline-flex min-w-0 max-w-full items-center gap-2 [overflow-wrap:anywhere]",
    swatch: "inline-block h-3 w-5 shrink-0 border border-hairline",
    range: "inline-flex min-w-0 max-w-full flex-wrap items-center gap-2",
    endpoint: "min-w-0 max-w-full [overflow-wrap:anywhere]",
    ramp: "inline-flex h-3 w-24 shrink-0 overflow-hidden border border-hairline",
    rampStep: "h-full flex-1",
    note: "text-xs leading-relaxed text-text-3 [overflow-wrap:anywhere]",
    empty: "text-sm text-text-3",
    details: "min-w-0 max-w-full border-t border-hairline pt-3 text-sm",
    summary: "w-fit max-w-full cursor-pointer list-none font-medium underline decoration-border-mid underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent [&::-webkit-details-marker]:hidden",
    tableWrapper: "mt-3 min-w-0 max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    table: "w-full text-sm",
    tableCaption: "sr-only",
    head: "border-b border-hairline pb-2 text-start font-medium text-text-3",
    numberHead: "border-b border-hairline pb-2 text-end font-medium text-text-3",
    row: "border-b border-hairline-soft last:border-0",
    country: "py-2 pe-4 text-start font-normal",
    code: "ms-2 text-xs text-text-3",
    value: "py-2 text-end",
    unmapped: "block text-xs text-text-3",
    credit: "text-xs leading-relaxed text-text-3",
    creditLink: "underline decoration-border-mid underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent",
};
export const countryHeatmapColors = [18, 38, 58, 78, 100].map((percent) => `color-mix(in srgb, var(--color-accent) ${percent}%, var(--color-surface))`);
export const countryHeatmapNoDataColor = "var(--color-hairline-soft)";
export const countryHeatmapDescription = "Color shows the value for each country. Missing data is separate from a measured zero. Exact values, including countries too small to appear on this map, are available below.";
const aliases = { UK: "GB", EL: "GR" };
export function normalizeCountryHeatmapCode(code) {
    const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
    if (!/^[A-Z]{2}$/.test(normalized)) {
        throw new RangeError("CountryHeatmap requires two-letter ISO country codes.");
    }
    return aliases[normalized] ?? normalized;
}
function transformed(value, scale) {
    return scale === "log" ? Math.sign(value) * Math.log1p(Math.abs(value)) : value;
}
function logDistance(from, to) {
    // Taking a relative logarithm preserves narrow domains such as 1e15..1e15+1.
    // Subtracting two already-rounded logarithms would turn that range into zero.
    if (from >= 0)
        return Math.log1p((to - from) / (1 + from));
    if (to <= 0)
        return Math.log1p((to - from) / (1 - to));
    return transformed(to, "log") - transformed(from, "log");
}
/** Shared normalization, colors, labels, and table rows for both renderers. */
export function createCountryHeatmapModel({ data, locale = "en", formatValue, scale = "linear", domain, noDataLabel = "No data", unmappedLabel = "Not shown at this map scale", }) {
    if (scale !== "linear" && scale !== "log")
        throw new RangeError("CountryHeatmap scale must be linear or log.");
    if (domain && (domain.length !== 2 || !domain.every(Number.isFinite) || domain[0] > domain[1])) {
        throw new RangeError("CountryHeatmap domain must have two finite, ascending endpoints.");
    }
    const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 21 });
    const names = new Intl.DisplayNames(locale, { type: "region", fallback: "code" });
    const format = formatValue ?? ((value) => number.format(value));
    const geometries = new Map(countryHeatmapGeometry.filter((country) => country.code !== "-99").map((country) => [country.code, country]));
    const combined = new Map();
    for (const datum of data) {
        const code = normalizeCountryHeatmapCode(datum.code);
        const value = typeof datum.value === "number" && Number.isFinite(datum.value) ? datum.value : null;
        const previous = combined.get(code);
        const sum = previous?.value == null ? value : value == null ? previous.value : previous.value + value;
        if (sum !== null && !Number.isFinite(sum))
            throw new RangeError("CountryHeatmap duplicate values exceed the finite numeric range.");
        combined.set(code, { code, value: sum, label: previous?.label || datum.label });
    }
    const values = [...combined.values()].flatMap((row) => row.value === null ? [] : [row.value]);
    const extent = domain ?? [Math.min(0, ...values), Math.max(0, ...values)];
    const magnitude = Math.max(Math.abs(extent[0]), Math.abs(extent[1]), 1);
    const linearRange = extent[1] - extent[0];
    const logarithmicRange = scale === "log" ? logDistance(extent[0], extent[1]) : 0;
    const bucket = (value) => {
        if (value === null)
            return null;
        if (extent[0] === extent[1] || value <= extent[0])
            return 0;
        if (value >= extent[1])
            return 4;
        const position = scale === "log" ? logDistance(extent[0], value) / logarithmicRange
            : Number.isFinite(linearRange) ? (value - extent[0]) / linearRange
                // Normalize only when subtracting finite endpoints near ±MAX_VALUE overflows.
                : (value / magnitude - extent[0] / magnitude) / (extent[1] / magnitude - extent[0] / magnitude);
        return Math.min(4, Math.max(0, Math.ceil(position * 5) - 1));
    };
    const rows = [...combined.values()].map((row) => ({
        ...row,
        label: row.label || names.of(row.code) || geometries.get(row.code)?.name || row.code,
        formattedValue: row.value === null ? noDataLabel : format(row.value),
        mapped: geometries.has(row.code),
        bucket: bucket(row.value),
        state: row.value === null ? "no-data" : row.value === 0 ? "zero" : "value",
    })).sort((first, second) => first.label.localeCompare(second.label, locale));
    const byCode = new Map(rows.map((row) => [row.code, row]));
    const countries = countryHeatmapGeometry.map((country, index) => {
        const row = country.code === "-99" ? undefined : byCode.get(country.code);
        const name = row?.label || (country.code === "-99" ? country.name : names.of(country.code)) || country.name;
        const color = row?.bucket == null ? countryHeatmapNoDataColor : countryHeatmapColors[row.bucket];
        return {
            ...country, key: `${country.code}-${index}`, name,
            value: row?.value ?? null,
            formattedValue: row?.formattedValue ?? noDataLabel,
            color, state: row?.state ?? "no-data",
        };
    });
    return {
        rows, countries, domain: extent, scale,
        hasData: values.length > 0, collapsed: extent[0] === extent[1],
        legendColors: extent[0] === extent[1] ? [countryHeatmapColors[0]] : countryHeatmapColors,
        minimumLabel: format(extent[0]), maximumLabel: format(extent[1]),
        unmappedLabel, unmappedCount: rows.filter((row) => !row.mapped).length,
    };
}
//# sourceMappingURL=country-heatmap.js.map