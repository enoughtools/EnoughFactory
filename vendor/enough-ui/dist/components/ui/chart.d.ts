import * as React from "react";
import * as Recharts from "recharts";
type ChartTheme = "light" | "dark";
/** Config keys are also the CSS variable suffix in `var(--color-KEY)`. */
export type ChartConfig = Record<string, {
    label?: React.ReactNode;
    icon?: React.ComponentType;
} & ({
    color?: string;
    theme?: never;
} | {
    color?: never;
    theme: Record<ChartTheme, string>;
})>;
declare function ChartStyle({ id, config }: {
    id: string;
    config: ChartConfig;
}): React.JSX.Element | null;
type ChartContainerProps = Omit<React.ComponentProps<"div">, "children"> & {
    config: ChartConfig;
    children: React.ComponentProps<typeof Recharts.ResponsiveContainer>["children"];
    initialDimension?: {
        width: number;
        height: number;
    };
};
declare function ChartContainer({ config, children, className, id, initialDimension, ...props }: ChartContainerProps): React.JSX.Element;
declare const ChartTooltip: typeof Recharts.Tooltip;
declare const ChartLegend: React.MemoExoticComponent<(outsideProps: Recharts.LegendProps) => React.ReactPortal | null>;
type ChartTooltipContentProps = Omit<React.ComponentProps<"div">, "children" | "color"> & React.ComponentProps<typeof Recharts.Tooltip> & Recharts.DefaultTooltipContentProps<Recharts.TooltipValueType, string | number> & {
    hideLabel?: boolean;
    hideIndicator?: boolean;
    indicator?: "dot" | "line" | "dashed";
    color?: string;
    nameKey?: string;
    labelKey?: string;
};
declare function ChartTooltipContent({ active, payload, label, labelFormatter, formatter, indicator, hideLabel, hideIndicator, nameKey, labelKey, color, className, labelClassName, itemStyle: _itemStyle, labelStyle: _labelStyle, contentStyle: _contentStyle, separator: _separator, wrapperClassName: _wrapperClassName, accessibilityLayer, ...props }: ChartTooltipContentProps): React.JSX.Element | null;
type ChartLegendContentProps = Omit<React.ComponentProps<"div">, "onClick" | "onMouseEnter" | "onMouseLeave"> & Recharts.DefaultLegendContentProps & {
    hideIcon?: boolean;
    nameKey?: string;
};
declare function ChartLegendContent({ payload, verticalAlign, hideIcon, nameKey, className, onClick, onMouseEnter, onMouseLeave, inactiveColor, ...props }: ChartLegendContentProps): React.JSX.Element | null;
export { ChartContainer, ChartStyle, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent };
//# sourceMappingURL=chart.d.ts.map