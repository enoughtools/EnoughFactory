"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { cn } from "../../lib/utils.js";
const Accordion = React.forwardRef((props, ref) => {
    const className = props.className;
    const rootProps = props.type === "single"
        ? { collapsible: true, ...props }
        : props;
    return (_jsx(AccordionPrimitive.Root, { ref: ref, "data-slot": "accordion", ...rootProps, className: cn("w-full border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] rounded-none", className) }));
});
Accordion.displayName = AccordionPrimitive.Root.displayName;
const AccordionItem = React.forwardRef(({ className, ...props }, ref) => (_jsx(AccordionPrimitive.Item, { ref: ref, "data-slot": "accordion-item", className: cn("border-b border-[var(--color-ink)] last:border-b-0 rounded-none", className), ...props })));
AccordionItem.displayName = "AccordionItem";
const AccordionTrigger = React.forwardRef(({ className, children, ...props }, ref) => (_jsx(AccordionPrimitive.Header, { className: "flex", children: _jsxs(AccordionPrimitive.Trigger, { ref: ref, "data-slot": "accordion-trigger", className: cn("group flex min-h-[52px] flex-1 cursor-pointer items-center justify-between gap-[16px] bg-[var(--color-surface)] px-[20px] py-[14px] text-left font-sans text-[15px] font-semibold text-[var(--color-text-main)] transition-colors hover:bg-[var(--color-accent-soft)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-[var(--color-paper)] rounded-none", className), ...props, children: [_jsx("span", { children: children }), _jsxs("span", { "aria-hidden": "true", className: "relative size-[18px] shrink-0 font-sans text-[18px] font-normal leading-[18px] text-[var(--color-accent)]", children: [_jsx("span", { className: "absolute inset-0 text-center motion-safe:transition-opacity group-data-[state=open]:opacity-0", children: "+" }), _jsx("span", { className: "absolute inset-0 text-center opacity-0 motion-safe:transition-opacity group-data-[state=open]:opacity-100", children: "\u2212" })] })] }) })));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;
const AccordionContent = React.forwardRef(({ className, children, ...props }, ref) => (_jsx(AccordionPrimitive.Content, { ref: ref, "data-slot": "accordion-content", className: "overflow-hidden border-t border-[var(--color-ink)] bg-[var(--color-card)] font-sans text-[14px] text-[var(--color-text-2)] motion-safe:data-[state=closed]:animate-[accordion-up_200ms_ease-out] motion-safe:data-[state=open]:animate-[accordion-down_200ms_ease-out] rounded-none", ...props, children: _jsx("div", { className: cn("px-[20px] py-[18px] leading-6", className), children: children }) })));
AccordionContent.displayName = AccordionPrimitive.Content.displayName;
export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
//# sourceMappingURL=accordion.js.map