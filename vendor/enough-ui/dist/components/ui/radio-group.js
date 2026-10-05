"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "../../lib/utils.js";
const RadioGroup = React.forwardRef(({ className, ...props }, ref) => (_jsx(RadioGroupPrimitive.Root, { ref: ref, "data-slot": "radio-group", className: cn("grid gap-3", className), ...props })));
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;
const RadioGroupItem = React.forwardRef(({ className, ...props }, ref) => (_jsx(RadioGroupPrimitive.Item, { ref: ref, "data-slot": "radio-group-item", className: cn("peer relative grid size-5 shrink-0 cursor-pointer place-items-center rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] text-[var(--color-ink)] after:absolute after:-inset-x-3 after:-inset-y-2 transition-[background-color,color] motion-reduce:transition-none", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]", "data-[state=checked]:bg-[var(--color-ink)] data-[state=checked]:text-[var(--color-surface)]", "disabled:cursor-not-allowed disabled:opacity-50", className), ...props, children: _jsx(RadioGroupPrimitive.Indicator, { "data-slot": "radio-group-indicator", className: "flex items-center justify-center", children: _jsx("span", { "aria-hidden": "true", className: "text-[10px] leading-none", children: "\u25A0" }) }) })));
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;
export { RadioGroup, RadioGroupItem };
//# sourceMappingURL=radio-group.js.map