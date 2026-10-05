"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";
function Tabs({ className, orientation = "horizontal", ...props }) {
    return (_jsx(TabsPrimitive.Root, { "data-slot": "tabs", "data-orientation": orientation, orientation: orientation, className: cn("group/tabs flex gap-[16px] data-[orientation=horizontal]:flex-col data-[orientation=vertical]:flex-row", className), ...props }));
}
const tabsListVariants = cva("group/tabs-list inline-flex min-h-[44px] w-fit max-w-full items-stretch overflow-x-auto text-[var(--color-text-2)] rounded-none group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col", {
    variants: {
        variant: {
            default: "border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-[var(--shadow-palette)]",
            line: "gap-1 border-0 bg-transparent shadow-none",
        },
    },
    defaultVariants: { variant: "default" },
});
const TabsList = React.forwardRef(({ className, variant = "default", ...props }, ref) => (_jsx(TabsPrimitive.List, { ref: ref, "data-slot": "tabs-list", "data-variant": variant, className: cn(tabsListVariants({ variant }), className), ...props })));
TabsList.displayName = TabsPrimitive.List.displayName;
const TabsTrigger = React.forwardRef(({ className, ...props }, ref) => (_jsx(TabsPrimitive.Trigger, { ref: ref, "data-slot": "tabs-trigger", className: cn("relative inline-flex min-h-[42px] shrink-0 cursor-pointer items-center justify-center whitespace-nowrap border-r border-[var(--color-ink)] bg-[var(--color-surface)] px-[18px] py-[10px] font-sans text-[13px] font-semibold tracking-[0.02em] text-[var(--color-text-2)] transition-colors last:border-r-0 hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-text-main)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-[var(--color-accent)] data-[state=active]:text-[var(--color-surface)] rounded-none", "group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start group-data-[orientation=vertical]/tabs:border-r-0 group-data-[orientation=vertical]/tabs:border-b group-data-[orientation=vertical]/tabs:last:border-b-0", "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ink)]", "group-data-[variant=line]/tabs-list:border-0 group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:text-[var(--color-accent)]", "after:absolute after:bg-[var(--color-accent)] after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-0 group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:right-0 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100", className), ...props })));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;
const TabsContent = React.forwardRef(({ className, ...props }, ref) => (_jsx(TabsPrimitive.Content, { ref: ref, "data-slot": "tabs-content", className: cn("min-w-0 flex-1 border border-[var(--color-ink)] bg-[var(--color-card)] p-[20px] font-sans text-[14px] text-[var(--color-text-2)] shadow-[var(--shadow-card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded-none", className), ...props })));
TabsContent.displayName = TabsPrimitive.Content.displayName;
export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
//# sourceMappingURL=tabs.js.map