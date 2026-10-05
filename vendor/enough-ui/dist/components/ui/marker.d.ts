import { markerVariants } from '../../lib/variants.js';
import * as React from "react";
import { type VariantProps } from "class-variance-authority";
interface MarkerProps extends React.ComponentPropsWithoutRef<"mark">, VariantProps<typeof markerVariants> {
    asChild?: boolean;
}
declare const Marker: React.ForwardRefExoticComponent<MarkerProps & React.RefAttributes<HTMLElement>>;
declare const MarkerContent: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLSpanElement> & React.RefAttributes<HTMLSpanElement>>;
declare const MarkerIcon: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLSpanElement> & React.RefAttributes<HTMLSpanElement>>;
export { Marker, MarkerContent, MarkerIcon, markerVariants };
export type { MarkerProps };
//# sourceMappingURL=marker.d.ts.map