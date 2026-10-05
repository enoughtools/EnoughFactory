"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { spinnerVariants } from '../../lib/variants.js';
import * as React from "react";
import { cn } from "../../lib/utils.js";
const Spinner = React.forwardRef(({ className, size, label = "Loading", ...props }, ref) => (_jsx("span", { ref: ref, "data-slot": "spinner", role: "status", "aria-label": label, className: cn(spinnerVariants({ size }), className), ...props, children: _jsxs("svg", { className: "animate-spin motion-reduce:animate-none h-full w-full", viewBox: "0 0 24 24", fill: "none", xmlns: "http://www.w3.org/2000/svg", children: [_jsx("rect", { x: "3", y: "3", width: "18", height: "18", stroke: "var(--color-ink)", strokeWidth: "4" }), _jsx("rect", { x: "3", y: "3", width: "9", height: "9", fill: "var(--color-accent)" })] }) })));
Spinner.displayName = "Spinner";
export { Spinner, spinnerVariants };
//# sourceMappingURL=spinner.js.map