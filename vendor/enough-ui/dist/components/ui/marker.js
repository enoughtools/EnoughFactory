"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { markerVariants } from '../../lib/variants.js';
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils.js";
import { apiPresentation } from '../../lib/api-presentation.js';
const Marker = React.forwardRef(({ asChild = false, className, size, variant, ...props }, ref) => {
    const Comp = asChild ? Slot : variant === "border" || variant === "separator" ? "div" : "mark";
    return (_jsx(Comp, { ref: ref, "data-slot": "marker", "data-variant": variant ?? "default", className: cn(markerVariants({ size, variant }), className), ...props }));
});
Marker.displayName = "Marker";
const MarkerContent = React.forwardRef(({ className, ...props }, ref) => (_jsx("span", { ref: ref, "data-slot": "marker-content", className: cn(apiPresentation.MarkerContent, className), ...props })));
MarkerContent.displayName = "MarkerContent";
const MarkerIcon = React.forwardRef(({ className, ...props }, ref) => (_jsx("span", { ref: ref, "data-slot": "marker-icon", "aria-hidden": "true", className: cn(apiPresentation.MarkerIcon, className), ...props })));
MarkerIcon.displayName = "MarkerIcon";
export { Marker, MarkerContent, MarkerIcon, markerVariants };
//# sourceMappingURL=marker.js.map