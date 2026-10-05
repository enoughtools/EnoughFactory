"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";
const ToastProvider = ToastPrimitive.Provider;
const ToastViewport = React.forwardRef(({ className, ...props }, ref) => (_jsx(ToastPrimitive.Viewport, { ref: ref, className: cn("fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col-reverse gap-3 p-4 outline-none rounded-none sm:w-[420px] sm:max-w-[calc(100vw-2rem)]", className), ...props })));
ToastViewport.displayName = ToastPrimitive.Viewport.displayName;
const toastVariants = cva("group pointer-events-auto relative grid w-full grid-cols-[1fr_auto] items-start gap-x-4 overflow-hidden border border-[var(--color-ink)] p-5 pr-10 font-sans shadow-[var(--shadow-palette)] transition-all rounded-none data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none data-[swipe=end]:animate-out data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-full", {
    variants: {
        variant: {
            default: "bg-[var(--color-surface)] text-[var(--color-ink)]",
            destructive: "destructive border-[var(--color-ink)] bg-red-700 text-white",
        },
    },
    defaultVariants: {
        variant: "default",
    },
});
const Toast = React.forwardRef(({ className, variant, ...props }, ref) => (_jsx(ToastPrimitive.Root, { ref: ref, className: cn(toastVariants({ variant }), className), ...props })));
Toast.displayName = ToastPrimitive.Root.displayName;
const ToastAction = React.forwardRef(({ className, ...props }, ref) => (_jsx(ToastPrimitive.Action, { ref: ref, className: cn("row-span-2 inline-flex h-9 shrink-0 items-center justify-center self-center border border-[var(--color-ink)] bg-[var(--color-surface)] px-4 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-ink)] transition-colors rounded-none hover:bg-[var(--color-paper)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-[var(--color-dark-text)] group-[.destructive]:bg-transparent group-[.destructive]:text-[var(--color-dark-text)] group-[.destructive]:hover:bg-[var(--color-ink-2)] group-[.destructive]:focus-visible:ring-[var(--color-accent-on-ink)] group-[.destructive]:focus-visible:ring-offset-[var(--color-ink)]", className), ...props })));
ToastAction.displayName = ToastPrimitive.Action.displayName;
const ToastClose = React.forwardRef(({ className, children, ...props }, ref) => (_jsxs(ToastPrimitive.Close, { ref: ref, "toast-close": "", className: cn("absolute right-2 top-2 inline-flex size-7 items-center justify-center border border-transparent text-lg leading-none text-[var(--color-text-3)] transition-colors rounded-none hover:border-[var(--color-ink)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] focus-visible:border-[var(--color-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] group-[.destructive]:text-[var(--color-dark-text-2)] group-[.destructive]:hover:border-[var(--color-dark-text)] group-[.destructive]:hover:bg-[var(--color-ink-2)] group-[.destructive]:hover:text-[var(--color-dark-text)]", className), ...props, children: [children ?? _jsx("span", { "aria-hidden": "true", children: "\u00D7" }), _jsx("span", { className: "sr-only", children: "Close" })] })));
ToastClose.displayName = ToastPrimitive.Close.displayName;
const ToastTitle = React.forwardRef(({ className, ...props }, ref) => (_jsx(ToastPrimitive.Title, { ref: ref, className: cn("text-sm font-semibold leading-5 tracking-[-0.01em]", className), ...props })));
ToastTitle.displayName = ToastPrimitive.Title.displayName;
const ToastDescription = React.forwardRef(({ className, ...props }, ref) => (_jsx(ToastPrimitive.Description, { ref: ref, className: cn("col-start-1 mt-1 text-sm leading-5 text-[var(--color-text-3)] group-[.destructive]:text-[var(--color-dark-text-2)]", className), ...props })));
ToastDescription.displayName = ToastPrimitive.Description.displayName;
export { ToastProvider, ToastViewport, Toast, ToastTitle, ToastDescription, ToastClose, ToastAction, };
//# sourceMappingURL=toast.js.map