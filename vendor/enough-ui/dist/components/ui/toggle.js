"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import * as React from "react";
import * as TogglePrimitive from "@radix-ui/react-toggle";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";
const toggleVariants = cva("inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 overflow-hidden whitespace-nowrap rounded-none border border-[var(--color-ink)] p-0 font-sans text-sm font-semibold text-[var(--color-ink)] transition-[background-color,color,box-shadow,transform] duration-150 motion-reduce:transition-none motion-reduce:transform-none before:flex before:min-w-11 before:self-stretch before:items-center before:justify-center before:border-r before:border-[var(--color-ink)] before:bg-[var(--color-paper)] before:px-2 before:font-sans before:text-[10px] before:font-bold before:tracking-[0.12em] before:text-[var(--color-text-2)] before:content-['OFF'] hover:bg-[var(--color-hover-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[var(--color-surface)] disabled:active:translate-y-0 data-[state=on]:shadow-[inset_0_-3px_0_var(--color-accent-on-ink)] data-[state=on]:before:bg-[var(--color-accent)] data-[state=on]:before:text-white data-[state=on]:before:content-['ON'] data-[state-indicator=false]:before:hidden [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0", {
    variants: {
        variant: {
            default: "bg-[var(--color-surface)] data-[state=on]:bg-[var(--color-ink)] data-[state=on]:text-[var(--color-dark-text)] data-[state=on]:hover:bg-[var(--color-ink-2)]",
            outline: "bg-[var(--color-paper)] data-[state=on]:bg-[var(--color-accent)] data-[state=on]:text-white data-[state=on]:hover:bg-[color-mix(in_srgb,var(--color-accent)_88%,var(--color-ink))]",
        },
        size: {
            default: "h-10",
            sm: "h-8 text-xs",
            lg: "h-12 text-base",
        },
    },
    defaultVariants: {
        variant: "default",
        size: "default",
    },
});
const Toggle = React.forwardRef(({ children, className, showStateIndicator = true, size, variant, ...props }, ref) => (_jsx(TogglePrimitive.Root, { ref: ref, "data-slot": "toggle", "data-state-indicator": showStateIndicator, className: cn(toggleVariants({ variant, size, className }), size === "sm" ? "pr-2.5" : size === "lg" ? "pr-5" : "pr-3", !showStateIndicator &&
        (size === "sm" ? "pl-2.5" : size === "lg" ? "pl-5" : "pl-3")), ...props, children: children })));
Toggle.displayName = TogglePrimitive.Root.displayName;
export { Toggle, toggleVariants };
//# sourceMappingURL=toggle.js.map