"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import * as React from "react";
import * as Recharts from "recharts";
import { cn } from "../../lib/utils.js";
const ChartContext = React.createContext(null);
function useChartConfig() {
    const config = React.useContext(ChartContext);
    if (!config)
        throw new Error("Chart content must be inside a ChartContainer.");
    return config;
}
const colorFunctions = new Set([
    "var", "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab",
    "oklch", "color", "color-mix", "light-dark", "calc", "min", "max", "clamp",
]);
// CSS config can come from data. Never let it end a declaration or a style tag.
function safeColor(color) {
    if (!color || !/^[a-zA-Z0-9#.,%()+\-_/ ]+$/.test(color) || color.includes("/*")) {
        return undefined;
    }
    for (const match of color.matchAll(/([a-zA-Z-]+)\s*\(/g)) {
        if (!colorFunctions.has(match[1].toLowerCase()))
            return undefined;
    }
    return color;
}
function cssString(value) {
    return Array.from(value, (character) => {
        return /[a-zA-Z0-9_-]/.test(character)
            ? character
            : `\\${character.codePointAt(0).toString(16)} `;
    }).join("");
}
function configVariables(config, theme) {
    return Object.entries(config).flatMap(([key, series]) => {
        const color = safeColor(series.theme?.[theme] ?? series.color);
        return /^[a-zA-Z0-9_-]+$/.test(key) && color
            ? [`  --color-${key}: ${color};`]
            : [];
    }).join("\n");
}
function ChartStyle({ id, config }) {
    const light = configVariables(config, "light");
    const dark = configVariables(config, "dark");
    if (!light && !dark)
        return null;
    const selector = `[data-chart="${cssString(id)}"]`;
    const css = `${selector} {\n${light}\n}\n:where(.dark, [data-theme="dark"]) ${selector}, ${selector}:where(.dark, [data-theme="dark"]) {\n${dark}\n}`;
    return _jsx("style", { "data-slot": "chart-style", dangerouslySetInnerHTML: { __html: css } });
}
function ChartContainer({ config, children, className, id, initialDimension = { width: 320, height: 200 }, ...props }) {
    const uniqueId = React.useId();
    // The unique suffix also keeps separately mounted charts with the same id apart.
    const chartId = `chart-${Array.from(`${id ?? ""}-${uniqueId}`, (character) => character.codePointAt(0).toString(16)).join("-")}`;
    return (_jsx(ChartContext.Provider, { value: config, children: _jsxs("div", { ...props, id: id, "data-slot": "chart", "data-chart": chartId, className: cn("flex min-h-[200px] w-full aspect-video justify-center font-sans text-xs text-text-3 [&_.recharts-cartesian-axis-tick_text]:fill-text-3 [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-hairline [&_.recharts-tooltip-cursor]:fill-hover [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border-mid [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-hairline [&_.recharts-reference-line_[stroke='#ccc']]:stroke-hairline [&_.recharts-radial-bar-background-sector]:fill-hover [&_.recharts-surface:focus-visible]:outline-2 [&_.recharts-surface:focus-visible]:outline-accent [&_.recharts-surface:focus-visible]:outline-offset-2", className), children: [_jsx(ChartStyle, { id: chartId, config: config }), _jsx(Recharts.ResponsiveContainer, { initialDimension: initialDimension, children: children })] }) }));
}
const ChartTooltip = Recharts.Tooltip;
const ChartLegend = Recharts.Legend;
const contentAttributes = new Set([
    "id", "role", "ref", "style", "title", "tabIndex", "dir", "lang", "hidden", "inert",
    "onClick", "onDoubleClick", "onKeyDown", "onKeyUp", "onFocus", "onBlur",
    "onMouseEnter", "onMouseLeave", "onPointerDown", "onPointerUp", "onContextMenu",
]);
// Recharts injects layout and interaction settings into custom content elements.
function contentDomProps(props) {
    return Object.fromEntries(Object.entries(props).filter(([key]) => {
        return contentAttributes.has(key) || key.startsWith("aria-") || key.startsWith("data-");
    }));
}
function seriesKey(config, item, key) {
    if (!item || typeof item !== "object")
        return key;
    const record = item;
    const row = record.payload && typeof record.payload === "object"
        ? record.payload
        : undefined;
    const lookup = typeof record[key] === "string" ? record[key]
        : typeof row?.[key] === "string" ? row[key] : key;
    return Object.hasOwn(config, lookup) ? lookup : key;
}
function seriesFor(config, item, key) {
    const resolved = seriesKey(config, item, key);
    return Object.hasOwn(config, resolved) ? config[resolved] : undefined;
}
function seriesColor(config, item, key, override) {
    const row = item.payload;
    const series = seriesFor(config, item, key);
    const configured = series?.theme || series?.color;
    const candidate = override ?? (typeof row?.fill === "string" ? row.fill : undefined)
        ?? item.color ?? (configured ? `var(--color-${seriesKey(config, item, key)})` : undefined);
    return safeColor(candidate);
}
function ChartTooltipContent({ active, payload, label, labelFormatter, formatter, indicator = "dot", hideLabel = false, hideIndicator = false, nameKey, labelKey, color, className, labelClassName, itemStyle: _itemStyle, labelStyle: _labelStyle, contentStyle: _contentStyle, separator: _separator, wrapperClassName: _wrapperClassName, accessibilityLayer = false, ...props }) {
    const config = useChartConfig();
    if (!active || !payload?.length)
        return null;
    const items = payload.filter((item) => item.type !== "none");
    if (!items.length)
        return null;
    const first = items[0];
    const labelSeries = seriesFor(config, first, String(labelKey ?? first.dataKey ?? first.name ?? "value"));
    const heading = !labelKey && (typeof label === "string" || typeof label === "number")
        ? (Object.hasOwn(config, String(label)) ? config[String(label)]?.label : undefined) ?? label : labelSeries?.label;
    const labelContent = !hideLabel && (labelFormatter || heading != null) ? (_jsx("div", { className: cn("font-medium text-text-main", labelClassName), "data-slot": "chart-tooltip-label", children: labelFormatter ? labelFormatter(heading, payload) : heading })) : null;
    const inlineLabel = items.length === 1 && indicator !== "dot";
    return (_jsxs("div", { role: accessibilityLayer ? "status" : "tooltip", "aria-live": accessibilityLayer ? "polite" : undefined, "aria-atomic": accessibilityLayer ? true : undefined, ...contentDomProps(props), "data-slot": "chart-tooltip", className: cn("grid min-w-32 gap-2 rounded-md border border-hairline bg-surface px-3 py-2 font-sans text-xs text-text-main shadow-card", className), children: [!inlineLabel && labelContent, items.map((item, index) => {
                const key = String(nameKey ?? item.name ?? item.dataKey ?? "value");
                const series = seriesFor(config, item, key);
                const Icon = series?.icon;
                const swatch = seriesColor(config, item, key, color);
                return (_jsx("div", { className: "flex items-center gap-2", "data-slot": "chart-tooltip-item", children: formatter && item.value !== undefined && item.name != null ? (formatter(item.value, item.name, item, index, item.payload)) : (_jsxs(_Fragment, { children: [Icon ? (_jsx("span", { "aria-hidden": "true", className: "flex size-3 shrink-0 items-center justify-center [&>svg]:size-3", children: _jsx(Icon, {}) })) : !hideIndicator && (_jsx("span", { "aria-hidden": "true", "data-slot": "chart-tooltip-indicator", "data-indicator": indicator, className: cn("shrink-0 rounded-sm", indicator === "dot" ? "size-2.5" : indicator === "line" ? "h-5 w-1" : "h-5 w-0 border-l-2 border-dashed"), style: { backgroundColor: indicator === "dashed" ? undefined : swatch, borderColor: swatch } })), _jsxs("div", { className: "grid flex-1 gap-1 text-text-3", children: [inlineLabel && labelContent, _jsx("span", { children: series?.label ?? item.name ?? (typeof item.dataKey === "function" ? `Series ${index + 1}` : item.dataKey) })] }), item.value != null && _jsx("span", { className: "font-sans font-medium text-text-main tabular-nums", children: typeof item.value === "number" ? item.value.toLocaleString() : String(item.value) })] })) }, `${item.dataKey ?? key}-${index}`));
            })] }));
}
function ChartLegendContent({ payload, verticalAlign = "bottom", hideIcon = false, nameKey, className, onClick, onMouseEnter, onMouseLeave, inactiveColor = "var(--color-line-soft)", ...props }) {
    const config = useChartConfig();
    const items = payload?.flatMap((item, index) => item.type === "none" ? [] : [{ item, index }]);
    if (!items?.length)
        return null;
    return (_jsx("div", { role: "list", "aria-label": "Chart legend", ...contentDomProps(props), "data-slot": "chart-legend", className: cn("flex flex-wrap items-center justify-center gap-x-4 gap-y-2 font-sans text-xs text-text-3", verticalAlign === "top" ? "pb-3" : "pt-3", className), children: items.map(({ item, index }) => {
            const key = String(nameKey ?? item.dataKey ?? item.value ?? "value");
            const series = seriesFor(config, item, key);
            const Icon = series?.icon;
            const label = (_jsxs(_Fragment, { children: [Icon && !hideIcon ? (_jsx("span", { "aria-hidden": "true", className: "flex size-3 items-center justify-center [&>svg]:size-3", children: _jsx(Icon, {}) })) : (_jsx("span", { "aria-hidden": "true", "data-slot": "chart-legend-indicator", className: "size-2 shrink-0 rounded-sm", style: { backgroundColor: safeColor(item.inactive ? inactiveColor : item.color) } })), _jsx("span", { className: item.inactive ? "line-through" : undefined, children: series?.label ?? item.value ?? (typeof item.dataKey === "function" ? `Series ${index + 1}` : item.dataKey) })] }));
            return (_jsx("div", { role: "listitem", className: "flex items-center gap-1.5", children: onClick ? (_jsx("button", { type: "button", "aria-pressed": typeof item.inactive === "boolean" ? !item.inactive : undefined, className: "inline-flex items-center gap-1.5 rounded-sm font-sans focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2", onClick: (event) => onClick(item, index, event), onMouseEnter: (event) => onMouseEnter?.(item, index, event), onMouseLeave: (event) => onMouseLeave?.(item, index, event), children: label })) : (_jsx("div", { className: "inline-flex items-center gap-1.5", onMouseEnter: (event) => onMouseEnter?.(item, index, event), onMouseLeave: (event) => onMouseLeave?.(item, index, event), children: label })) }, `${item.dataKey ?? key}-${index}`));
        }) }));
}
export { ChartContainer, ChartStyle, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent };
//# sourceMappingURL=chart.js.map