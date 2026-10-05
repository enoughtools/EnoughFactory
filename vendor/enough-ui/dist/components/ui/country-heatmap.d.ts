import * as React from "react";
import { type CountryHeatmapOptions } from "../../lib/country-heatmap.js";
export type { CountryHeatmapDatum, CountryHeatmapOptions } from "../../lib/country-heatmap.js";
export type CountryHeatmapProps = Omit<React.ComponentProps<"figure">, "children" | "title"> & CountryHeatmapOptions;
/** Static SVG and a native expandable data table; hydration is optional. */
declare function CountryHeatmap({ data, title, description, valueLabel, countryLabel, noDataLabel, emptyLabel, tableLabel, legendLabel, unmappedLabel, scaleLabel, locale, formatValue, scale, domain, tableOpen, note, className, ...props }: CountryHeatmapProps): React.JSX.Element;
export { CountryHeatmap };
//# sourceMappingURL=country-heatmap.d.ts.map