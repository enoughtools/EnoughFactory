"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { cn } from "../../lib/utils.js";
const DrawerDirectionContext = React.createContext("bottom");
// Resolve the original EnoughUI side prop for direct compositions so the panel
// position and Vaul's swipe direction always agree.
function legacySide(children) {
    for (const child of React.Children.toArray(children)) {
        if (!React.isValidElement(child))
            continue;
        if (child.type === DrawerContent && child.props.side)
            return child.props.side;
        if (child.type === React.Fragment) {
            const side = legacySide(child.props.children);
            if (side)
                return side;
        }
    }
}
function Drawer({ direction, autoFocus = true, ...props }) {
    const resolvedDirection = direction ?? legacySide(props.children) ?? "bottom";
    return _jsx(DrawerDirectionContext.Provider, { value: resolvedDirection, children: _jsx(DrawerPrimitive.Root, { direction: resolvedDirection, autoFocus: autoFocus, ...props }) });
}
const DrawerTrigger = React.forwardRef((props, ref) => (_jsx(DrawerPrimitive.Trigger, { ref: ref, "data-slot": "drawer-trigger", ...props })));
DrawerTrigger.displayName = "DrawerTrigger";
const DrawerPortal = DrawerPrimitive.Portal;
const DrawerClose = React.forwardRef((props, ref) => (_jsx(DrawerPrimitive.Close, { ref: ref, "data-slot": "drawer-close", ...props })));
DrawerClose.displayName = "DrawerClose";
const DrawerHandle = DrawerPrimitive.Handle;
const sideClasses = {
    top: "inset-x-0 top-0 max-h-[85svh] border-x-0 border-t-0 data-[vaul-snap-points=true]:h-svh data-[vaul-snap-points=true]:max-h-none",
    right: "inset-y-0 right-0 h-full w-[min(28rem,calc(100%-32px))] border-y-0 border-r-0 data-[vaul-snap-points=true]:w-screen",
    bottom: "inset-x-0 bottom-0 max-h-[85svh] border-x-0 border-b-0 data-[vaul-snap-points=true]:h-svh data-[vaul-snap-points=true]:max-h-none",
    left: "inset-y-0 left-0 h-full w-[min(28rem,calc(100%-32px))] border-y-0 border-l-0 data-[vaul-snap-points=true]:w-screen",
};
const DrawerOverlay = React.forwardRef(({ className, ...props }, ref) => (_jsx(DrawerPrimitive.Overlay, { ref: ref, "data-slot": "drawer-overlay", className: cn("fixed inset-0 z-50 bg-[var(--color-ink)]/50 motion-reduce:animate-none! motion-reduce:transition-none!", className), ...props })));
DrawerOverlay.displayName = DrawerPrimitive.Overlay.displayName;
const DrawerContent = React.forwardRef(({ className, children, side: _side, showClose = true, ...props }, ref) => {
    const side = React.useContext(DrawerDirectionContext);
    return (_jsxs(DrawerPortal, { children: [_jsx(DrawerOverlay, {}), _jsxs(DrawerPrimitive.Content, { ref: ref, "data-slot": "drawer-content", "data-side": side, className: cn("group/drawer-content fixed z-50 flex flex-col overflow-y-auto rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] font-sans text-[var(--color-ink)] shadow-[var(--shadow-palette)] motion-reduce:animate-none! motion-reduce:transition-none!", sideClasses[side], className), ...props, children: [side === "bottom" && _jsx(DrawerHandle, { "aria-label": "Adjust drawer height", className: "mt-3 bg-[var(--color-ink)]! rounded-none!" }), children, showClose && (_jsxs(DrawerPrimitive.Close, { className: "absolute right-[20px] top-[20px] inline-flex size-[32px] cursor-pointer items-center justify-center rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] text-[18px] leading-none text-[var(--color-ink)] shadow-[var(--shadow-card)] transition-[transform,background-color] motion-reduce:transition-none hover:bg-[var(--color-paper)] active:translate-x-[1px] active:translate-y-[1px] active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50", children: ["\u00D7", _jsx("span", { className: "sr-only", children: "Close" })] }))] })] }));
});
DrawerContent.displayName = "DrawerContent";
function DrawerHeader({ className, ...props }) {
    return (_jsx("div", { "data-slot": "drawer-header", className: cn("flex flex-col gap-[8px] border-b border-[var(--color-ink)] px-[24px] py-[20px] pr-[68px] text-left", className), ...props }));
}
DrawerHeader.displayName = "DrawerHeader";
function DrawerBody({ className, ...props }) {
    return _jsx("div", { "data-slot": "drawer-body", className: cn("min-h-0 flex-1 overflow-y-auto p-[24px]", className), ...props });
}
DrawerBody.displayName = "DrawerBody";
function DrawerFooter({ className, ...props }) {
    return (_jsx("div", { "data-slot": "drawer-footer", className: cn("mt-auto flex flex-col-reverse gap-[8px] border-t border-[var(--color-ink)] p-[24px] sm:flex-row sm:justify-end", className), ...props }));
}
DrawerFooter.displayName = "DrawerFooter";
const DrawerTitle = React.forwardRef(({ className, ...props }, ref) => (_jsx(DrawerPrimitive.Title, { ref: ref, "data-slot": "drawer-title", className: cn("text-[18px] font-semibold leading-none tracking-tight text-[var(--color-ink)]", className), ...props })));
DrawerTitle.displayName = DrawerPrimitive.Title.displayName;
const DrawerDescription = React.forwardRef(({ className, ...props }, ref) => (_jsx(DrawerPrimitive.Description, { ref: ref, "data-slot": "drawer-description", className: cn("text-[14px] leading-[1.5] text-[var(--color-ink)]/70", className), ...props })));
DrawerDescription.displayName = DrawerPrimitive.Description.displayName;
export { Drawer, DrawerPortal, DrawerOverlay, DrawerTrigger, DrawerClose, DrawerHandle, DrawerContent, DrawerHeader, DrawerBody, DrawerFooter, DrawerTitle, DrawerDescription, };
//# sourceMappingURL=drawer.js.map