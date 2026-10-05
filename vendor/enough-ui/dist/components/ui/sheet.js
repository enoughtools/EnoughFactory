"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";
const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;
const SheetOverlay = React.forwardRef(({ className, ...props }, ref) => (_jsx(SheetPrimitive.Overlay, { ref: ref, className: cn("drawer-sheet-overlay fixed inset-0 z-50 bg-[color:var(--color-ink)]/50", className), ...props })));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;
const sheetVariants = cva("drawer-sheet-content fixed z-50 flex flex-col overflow-y-auto rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] font-sans text-[var(--color-ink)] shadow-[8px_8px_0_var(--color-ink)]", {
    variants: {
        side: {
            top: "inset-x-0 top-0 max-h-[85svh] border-x-0 border-t-0",
            right: "inset-y-0 right-0 h-full w-[min(28rem,calc(100%-32px))] border-y-0 border-r-0",
            bottom: "inset-x-0 bottom-0 max-h-[85svh] border-x-0 border-b-0",
            left: "inset-y-0 left-0 h-full w-[min(28rem,calc(100%-32px))] border-y-0 border-l-0",
        },
    },
    defaultVariants: {
        side: "right",
    },
});
const SheetContent = React.forwardRef(({ side = "right", showClose = true, showCloseButton, className, children, ...props }, ref) => (_jsxs(SheetPortal, { children: [_jsx(SheetOverlay, {}), _jsxs(SheetPrimitive.Content, { ref: ref, "data-side": side, className: cn(sheetVariants({ side }), className), ...props, children: [children, (showCloseButton ?? showClose) && (_jsxs(SheetPrimitive.Close, { className: "absolute right-[20px] top-[20px] inline-flex size-[32px] cursor-pointer items-center justify-center rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] text-[18px] leading-none text-[var(--color-ink)] shadow-[3px_3px_0_var(--color-ink)] transition-[transform,background-color] hover:bg-[var(--color-accent)] active:translate-x-[1px] active:translate-y-[1px] active:shadow-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50", children: [_jsx("span", { "aria-hidden": "true", children: "\u00D7" }), _jsx("span", { className: "sr-only", children: "Close" })] }))] })] })));
SheetContent.displayName = SheetPrimitive.Content.displayName;
function SheetHeader({ className, ...props }) {
    return (_jsx("div", { className: cn("flex flex-col gap-[8px] border-b border-[var(--color-ink)] px-[24px] py-[20px] pr-[68px] text-left", className), ...props }));
}
SheetHeader.displayName = "SheetHeader";
function SheetBody({ className, ...props }) {
    return _jsx("div", { className: cn("flex-1 p-[24px]", className), ...props });
}
SheetBody.displayName = "SheetBody";
function SheetFooter({ className, ...props }) {
    return (_jsx("div", { className: cn("mt-auto flex flex-col-reverse gap-[8px] border-t border-[var(--color-ink)] p-[24px] sm:flex-row sm:justify-end", className), ...props }));
}
SheetFooter.displayName = "SheetFooter";
const SheetTitle = React.forwardRef(({ className, ...props }, ref) => (_jsx(SheetPrimitive.Title, { ref: ref, className: cn("text-[18px] font-semibold leading-none tracking-tight text-[var(--color-ink)]", className), ...props })));
SheetTitle.displayName = SheetPrimitive.Title.displayName;
const SheetDescription = React.forwardRef(({ className, ...props }, ref) => (_jsx(SheetPrimitive.Description, { ref: ref, className: cn("text-[14px] leading-[1.5] text-[var(--color-ink)] opacity-70", className), ...props })));
SheetDescription.displayName = SheetPrimitive.Description.displayName;
export { Sheet, SheetPortal, SheetOverlay, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetBody, SheetFooter, SheetTitle, SheetDescription, sheetVariants, };
//# sourceMappingURL=sheet.js.map