"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "../../lib/utils.js";
const ScrollArea = React.forwardRef(({ className, children, viewportProps, tabIndex, role, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, "aria-describedby": ariaDescribedBy, ...props }, ref) => {
    const hasOwnName = viewportProps?.["aria-label"] !== undefined || viewportProps?.["aria-labelledby"] !== undefined;
    const label = hasOwnName ? viewportProps?.["aria-label"] : ariaLabel;
    const labelledBy = hasOwnName ? viewportProps?.["aria-labelledby"] : ariaLabelledBy;
    const hasName = Boolean(label || labelledBy);
    return (_jsxs(ScrollAreaPrimitive.Root, { ref: ref, "data-slot": "scroll-area", className: cn("relative overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-card)]", className), ...props, children: [_jsx(ScrollAreaPrimitive.Viewport, { ...viewportProps, "data-slot": "scroll-area-viewport", tabIndex: viewportProps?.tabIndex ?? tabIndex ?? 0, role: viewportProps?.role ?? role ?? (hasName ? "region" : undefined), "aria-label": label, "aria-labelledby": labelledBy, "aria-describedby": viewportProps?.["aria-describedby"] ?? ariaDescribedBy, className: cn("size-full rounded-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]", viewportProps?.className), children: children }), _jsx(ScrollBar, {}), _jsx(ScrollAreaPrimitive.Corner, { "data-slot": "scroll-area-corner", className: "rounded-none bg-[var(--color-ink)]" })] }));
});
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;
const ScrollBar = React.forwardRef(({ className, orientation = "vertical", ...props }, ref) => (_jsx(ScrollAreaPrimitive.ScrollAreaScrollbar, { ref: ref, "data-slot": "scroll-area-scrollbar", orientation: orientation, className: cn("flex touch-none select-none rounded-none bg-[var(--color-surface)] transition-colors", orientation === "vertical" &&
        "h-full w-3 border-l border-[var(--color-ink)] p-0.5", orientation === "horizontal" &&
        "h-3 flex-col border-t border-[var(--color-ink)] p-0.5", className), ...props, children: _jsx(ScrollAreaPrimitive.ScrollAreaThumb, { "data-slot": "scroll-area-thumb", className: "relative flex-1 rounded-none bg-[var(--color-ink)] after:absolute after:left-1/2 after:top-1/2 after:min-h-11 after:min-w-11 after:-translate-x-1/2 after:-translate-y-1/2 hover:bg-[var(--color-accent)]" }) })));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;
export { ScrollArea, ScrollBar };
//# sourceMappingURL=scroll-area.js.map