"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../../lib/utils.js";
function TooltipProvider({ delayDuration = 0, ...props }) {
    return _jsx(TooltipPrimitive.Provider, { delayDuration: delayDuration, ...props });
}
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;
const TooltipContent = React.forwardRef(({ className, sideOffset = 4, ...props }, ref) => (_jsx(TooltipPrimitive.Portal, { children: _jsx(TooltipPrimitive.Content, { ref: ref, "data-slot": "tooltip-content", sideOffset: sideOffset, className: cn("z-50 w-fit max-w-[min(20rem,calc(100vw-2rem))] overflow-hidden whitespace-normal break-words border border-[var(--color-ink)] bg-[var(--color-ink-2)] px-[12px] py-[6px] text-[12px] text-[var(--color-dark-text)] shadow-[var(--shadow-card)] animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 rounded-none font-sans", className), ...props }) })));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
//# sourceMappingURL=tooltip.js.map