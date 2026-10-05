"use client";
import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { MessageScroller as MessageScrollerPrimitive, useMessageScroller as usePrimitiveMessageScroller, useMessageScrollerScrollable, useMessageScrollerVisibility, } from "@shadcn/react/message-scroller";
import { cn } from "../../lib/utils.js";
import { Button } from "./button.js";
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
function prefersReducedMotion() {
    return typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia(reducedMotionQuery).matches;
}
function subscribeReducedMotion(listener) {
    if (typeof window.matchMedia !== "function")
        return () => { };
    const query = window.matchMedia(reducedMotionQuery);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
}
function resolveScrollOptions(options) {
    return options?.behavior === "smooth" && prefersReducedMotion()
        ? { ...options, behavior: "auto" }
        : options;
}
/** Imperative commands share the primitive's API and honor reduced motion. */
function useMessageScroller() {
    const commands = usePrimitiveMessageScroller();
    return React.useMemo(() => ({
        scrollToMessage: (messageId, options) => commands.scrollToMessage(messageId, resolveScrollOptions(options)),
        scrollToEnd: (options) => commands.scrollToEnd(resolveScrollOptions(options)),
        scrollToStart: (options) => commands.scrollToStart(resolveScrollOptions(options)),
    }), [commands]);
}
function MessageScrollerProvider(props) {
    return _jsx(MessageScrollerPrimitive.Provider, { ...props });
}
function MessageScroller({ className, ...props }) {
    return (_jsx(MessageScrollerPrimitive.Root, { "data-slot": "message-scroller", className: cn("group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] font-sans text-[var(--color-ink)]", className), ...props }));
}
function MessageScrollerViewport({ className, ...props }) {
    return (_jsx(MessageScrollerPrimitive.Viewport, { "data-slot": "message-scroller-viewport", className: cn("size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] [scrollbar-width:thin] data-[pending-scroll]:invisible outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] motion-reduce:scroll-auto", className), ...props }));
}
function MessageScrollerContent({ className, ...props }) {
    return (_jsx(MessageScrollerPrimitive.Content, { "data-slot": "message-scroller-content", className: cn("flex h-max min-h-full flex-col gap-6 p-4 sm:p-6", className), ...props }));
}
function MessageScrollerItem({ className, scrollAnchor = false, ...props }) {
    return (_jsx(MessageScrollerPrimitive.Item, { "data-slot": "message-scroller-item", scrollAnchor: scrollAnchor, className: cn("min-w-0 shrink-0", className), ...props }));
}
function MessageScrollerButton({ direction = "end", behavior = "smooth", className, children, render, variant = "secondary", size = "icon-sm", ...props }) {
    const reducedMotion = React.useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
    return (_jsx(MessageScrollerPrimitive.Button, { "data-slot": "message-scroller-button", "data-variant": variant, "data-size": size, direction: direction, behavior: reducedMotion && behavior === "smooth" ? "auto" : behavior, className: cn("absolute start-1/2 z-10 -translate-x-1/2 shadow-[var(--shadow-card)] transition-[translate,opacity] duration-200 data-[active=false]:pointer-events-none data-[active=false]:opacity-0 data-[direction=end]:bottom-4 data-[direction=start]:top-4 rtl:translate-x-1/2 motion-reduce:transition-none", className), render: render ?? _jsx(Button, { variant: variant, size: size }), ...props, children: children ?? (_jsxs(_Fragment, { children: [_jsx("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false", className: direction === "start" ? "rotate-180" : undefined, children: _jsx("path", { d: "M12 5v14m-7-7 7 7 7-7" }) }), _jsx("span", { className: "sr-only", children: direction === "end" ? "Scroll to end" : "Scroll to start" })] })) }));
}
export { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton, useMessageScroller, useMessageScrollerScrollable, useMessageScrollerVisibility, };
//# sourceMappingURL=message-scroller.js.map