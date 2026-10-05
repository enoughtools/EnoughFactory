"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";
import { Portal as TooltipPortal } from "@radix-ui/react-tooltip";
import { Slot } from "@radix-ui/react-slot";
import { Button } from "./button.js";
import { Input } from "./input.js";
import { Separator } from "./separator.js";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, } from "./sheet.js";
import { Skeleton } from "./skeleton.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, } from "./tooltip.js";
function useIsMobile() {
    const [isMobile, setIsMobile] = React.useState(false);
    React.useEffect(() => {
        const query = window.matchMedia("(max-width: 767px)");
        const update = () => setIsMobile(query.matches);
        update();
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);
    return isMobile;
}
const SIDEBAR_COOKIE_NAME = "sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_WIDTH_MOBILE = "18rem";
const SIDEBAR_WIDTH_ICON = "3.5rem";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";
const SidebarContext = React.createContext(null);
function useSidebar() {
    const context = React.useContext(SidebarContext);
    if (!context) {
        throw new Error("useSidebar must be used within a SidebarProvider.");
    }
    return context;
}
function SidebarProvider({ defaultOpen = true, open: openProp, onOpenChange: setOpenProp, expanded, onExpandedChange, persistState = true, cookieName = SIDEBAR_COOKIE_NAME, cookieMaxAge = SIDEBAR_COOKIE_MAX_AGE, className, style, children, dir, id, ...props }) {
    const isMobile = useIsMobile();
    const sidebarId = React.useId();
    const mobileReturnFocusRef = React.useRef(null);
    const [openMobile, setOpenMobile] = React.useState(false);
    // This is the internal state of the sidebar.
    // We use openProp and setOpenProp for control from outside the component.
    const [_open, _setOpen] = React.useState(defaultOpen);
    const controlledOpen = openProp ?? expanded;
    const open = controlledOpen ?? _open;
    const setOpen = React.useCallback((value) => {
        const openState = typeof value === "function" ? value(open) : value;
        if (controlledOpen === undefined)
            _setOpen(openState);
        setOpenProp?.(openState);
        onExpandedChange?.(openState);
        if (persistState) {
            document.cookie = `${encodeURIComponent(cookieName)}=${openState}; path=/; max-age=${cookieMaxAge}; samesite=lax`;
        }
    }, [setOpenProp, onExpandedChange, controlledOpen, open, persistState, cookieName, cookieMaxAge]);
    // Helper to toggle the sidebar.
    const toggleSidebar = React.useCallback(() => {
        if (isMobile) {
            if (!openMobile && !mobileReturnFocusRef.current && document.activeElement instanceof HTMLElement) {
                mobileReturnFocusRef.current = document.activeElement;
            }
            setOpenMobile((value) => !value);
        }
        else {
            setOpen((value) => !value);
        }
    }, [isMobile, setOpen, openMobile]);
    // Adds a keyboard shortcut to toggle the sidebar.
    React.useEffect(() => {
        const handleKeyDown = (event) => {
            const target = event.target;
            const editing = target instanceof HTMLElement &&
                (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
            if (!editing && !event.repeat && !event.altKey &&
                event.key.toLowerCase() === SIDEBAR_KEYBOARD_SHORTCUT &&
                (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                toggleSidebar();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [toggleSidebar]);
    // We add a state so that we can do data-state="expanded" or "collapsed".
    // This makes it easier to style the sidebar with Tailwind classes.
    const state = open ? "expanded" : "collapsed";
    const contextValue = React.useMemo(() => ({
        state,
        open,
        setOpen,
        isMobile,
        openMobile,
        setOpenMobile,
        toggleSidebar,
        expanded: open,
        sidebarId,
        mobileStyle: style ?? {},
        mobileReturnFocusRef,
        dir,
    }), [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar, sidebarId, style, dir]);
    return (_jsx(SidebarContext.Provider, { value: contextValue, children: _jsx(TooltipProvider, { delayDuration: 0, children: _jsx("div", { "data-slot": "sidebar-wrapper", dir: dir, id: id, style: {
                    "--sidebar-width": SIDEBAR_WIDTH,
                    "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
                    "--sidebar-width-mobile": SIDEBAR_WIDTH_MOBILE,
                    ...style,
                }, className: cn("group/sidebar-wrapper flex min-h-svh w-full bg-[var(--color-surface)] font-sans text-[var(--color-ink)] has-data-[variant=inset]:bg-[var(--color-paper)]", className), ...props, children: children }) }) }));
}
function Sidebar({ side = "left", variant = "sidebar", collapsible = "offcanvas", className, children, dir, id, ...props }) {
    const { isMobile, state, openMobile, setOpenMobile, sidebarId, mobileStyle, mobileReturnFocusRef, dir: providerDir } = useSidebar();
    if (collapsible === "none") {
        return (_jsx("div", { "data-slot": "sidebar", "data-sidebar": "sidebar", id: id ?? sidebarId, dir: dir ?? providerDir, className: cn("flex h-full w-[var(--sidebar-width)] flex-col bg-[var(--color-surface)] text-[var(--color-ink)]", className), ...props, children: children }));
    }
    if (isMobile) {
        return (_jsx(Sheet, { open: openMobile, onOpenChange: setOpenMobile, children: _jsxs(SheetContent, { id: id ?? sidebarId, dir: dir ?? providerDir, ...props, "data-sidebar": "sidebar", "data-slot": "sidebar", "data-mobile": "true", className: cn("w-[min(var(--sidebar-width-mobile),calc(100vw-2rem))] bg-[var(--color-surface)] p-0 text-[var(--color-ink)]", className), style: {
                    "--sidebar-width-mobile": SIDEBAR_WIDTH_MOBILE,
                    ...mobileStyle,
                    ...props.style,
                }, side: side, onCloseAutoFocus: (event) => {
                    event.preventDefault();
                    mobileReturnFocusRef.current?.focus();
                    mobileReturnFocusRef.current = null;
                }, children: [_jsxs(SheetHeader, { className: "sr-only", children: [_jsx(SheetTitle, { children: "Sidebar" }), _jsx(SheetDescription, { children: "Navigate the application using the mobile sidebar." })] }), _jsx("div", { className: "flex h-full w-full flex-col pt-16", children: children })] }) }));
    }
    return (_jsxs("div", { className: "group peer hidden text-[var(--color-ink)] md:block", "data-state": state, "data-collapsible": state === "collapsed" ? collapsible : "", "data-variant": variant, "data-side": side, "data-slot": "sidebar", dir: dir ?? providerDir, children: [_jsx("div", { "data-slot": "sidebar-gap", className: cn("relative w-[var(--sidebar-width)] bg-transparent transition-[width] duration-200 ease-linear motion-reduce:transition-none", "group-data-[collapsible=offcanvas]:w-0", "group-data-[side=right]:rotate-180", variant === "floating" || variant === "inset"
                    ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+1rem)]"
                    : "group-data-[collapsible=icon]:w-[var(--sidebar-width-icon)]") }), _jsx("div", { "data-slot": "sidebar-container", id: id ?? sidebarId, "data-side": side, className: cn("fixed inset-y-0 z-10 hidden h-svh w-[var(--sidebar-width)] transition-[left,right,width] duration-200 ease-linear motion-reduce:transition-none md:flex", "data-[side=left]:left-0 data-[side=right]:right-0 data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] data-[side=right]:group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]", 
                // Adjust the padding for floating and inset variants.
                variant === "floating" || variant === "inset"
                    ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+1rem+2px)]"
                    : "group-data-[collapsible=icon]:w-[var(--sidebar-width-icon)] group-data-[side=left]:border-r group-data-[side=right]:border-l border-[var(--color-ink)]", className), ...props, children: _jsx("div", { "data-sidebar": "sidebar", "data-slot": "sidebar-inner", className: "flex h-full w-full flex-col bg-[var(--color-surface)] group-data-[collapsible=offcanvas]:invisible group-data-[variant=floating]:rounded-none group-data-[variant=floating]:border group-data-[variant=floating]:border-[var(--color-ink)] group-data-[variant=floating]:shadow-[var(--shadow-card)]", children: children }) })] }));
}
function SidebarTrigger({ className, onClick, ...props }) {
    const { toggleSidebar, open, openMobile, isMobile, mobileReturnFocusRef } = useSidebar();
    return (_jsxs(Button, { "data-sidebar": "trigger", "data-slot": "sidebar-trigger", variant: "ghost", size: "icon", type: "button", "aria-expanded": isMobile ? openMobile : open, className: cn("size-9", className), onClick: (event) => {
            onClick?.(event);
            if (!event.defaultPrevented) {
                if (isMobile && !openMobile)
                    mobileReturnFocusRef.current = event.currentTarget;
                toggleSidebar();
            }
        }, ...props, children: [_jsxs("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", className: "size-4 rtl:rotate-180", "aria-hidden": "true", children: [_jsx("rect", { x: "3", y: "4", width: "18", height: "16" }), _jsx("path", { d: "M9 4v16" })] }), _jsx("span", { className: "sr-only", children: "Toggle Sidebar" })] }));
}
function SidebarRail({ className, onClick, ...props }) {
    const { toggleSidebar } = useSidebar();
    return (_jsx("button", { "data-sidebar": "rail", "data-slot": "sidebar-rail", "aria-label": "Toggle Sidebar", tabIndex: -1, type: "button", onClick: (event) => { onClick?.(event); if (!event.defaultPrevented)
            toggleSidebar(); }, title: "Toggle Sidebar", className: cn("visible absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear motion-reduce:transition-none group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-[var(--color-ink)] sm:flex", "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize", "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize", "group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-[var(--color-surface)]", "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2", "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2", className), ...props }));
}
function SidebarInset({ className, ...props }) {
    return (_jsx("main", { "data-slot": "sidebar-inset", className: cn("relative flex min-w-0 w-full flex-1 flex-col bg-[var(--color-surface)]", "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-none md:peer-data-[variant=inset]:shadow-[var(--shadow-card)] md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2", className), ...props }));
}
function SidebarInput({ className, ...props }) {
    return (_jsx(Input, { "data-slot": "sidebar-input", "data-sidebar": "input", className: cn("h-9 w-full bg-[var(--color-surface)] shadow-none", className), ...props }));
}
function SidebarHeader({ className, ...props }) {
    return (_jsx("div", { "data-slot": "sidebar-header", "data-sidebar": "header", className: cn("flex shrink-0 flex-col gap-2 border-b border-[var(--color-ink)] bg-[var(--color-accent-soft)] p-2", className), ...props }));
}
function SidebarFooter({ className, ...props }) {
    return (_jsx("div", { "data-slot": "sidebar-footer", "data-sidebar": "footer", className: cn("flex shrink-0 flex-col gap-2 border-t border-[var(--color-ink)] p-2", className), ...props }));
}
function SidebarSeparator({ className, ...props }) {
    return (_jsx(Separator, { "data-slot": "sidebar-separator", "data-sidebar": "separator", className: cn("mx-2 w-auto bg-[var(--color-ink)]", className), ...props }));
}
function SidebarContent({ className, ...props }) {
    return (_jsx("div", { "data-slot": "sidebar-content", "data-sidebar": "content", className: cn("flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden", className), ...props }));
}
function SidebarGroup({ className, ...props }) {
    return (_jsx("div", { "data-slot": "sidebar-group", "data-sidebar": "group", className: cn("relative flex w-full min-w-0 flex-col p-2", className), ...props }));
}
function SidebarGroupLabel({ className, asChild = false, ...props }) {
    const Comp = asChild ? Slot : "div";
    return (_jsx(Comp, { "data-slot": "sidebar-group-label", "data-sidebar": "group-label", className: cn("flex h-8 shrink-0 items-center rounded-none px-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-ink)]/70 ring-[var(--color-accent)] outline-none transition-[margin,opacity] duration-200 ease-linear motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-offset-2 [&>svg]:size-4 [&>svg]:shrink-0", "group-data-[collapsible=icon]:hidden", className), ...props }));
}
function SidebarGroupAction({ className, asChild = false, ...props }) {
    const Comp = asChild ? Slot : "button";
    return (_jsx(Comp, { "data-slot": "sidebar-group-action", "data-sidebar": "group-action", type: asChild ? undefined : "button", className: cn("absolute top-3.5 end-3 flex aspect-square w-5 items-center justify-center rounded-none p-0 text-[var(--color-ink)] ring-[var(--color-accent)] outline-none transition-transform motion-reduce:transition-none hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-ink)] focus-visible:ring-2 focus-visible:ring-offset-2 [&>svg]:size-4 [&>svg]:shrink-0", 
        // Increases the hit area of the button on mobile.
        "after:absolute after:-inset-2 md:after:hidden", "group-data-[collapsible=icon]:hidden", className), ...props }));
}
function SidebarGroupContent({ className, ...props }) {
    return (_jsx("div", { "data-slot": "sidebar-group-content", "data-sidebar": "group-content", className: cn("w-full text-sm", className), ...props }));
}
function SidebarMenu({ className, ...props }) {
    return (_jsx("ul", { "data-slot": "sidebar-menu", "data-sidebar": "menu", className: cn("flex w-full min-w-0 flex-col gap-1", className), ...props }));
}
function SidebarMenuItem({ className, ...props }) {
    return (_jsx("li", { "data-slot": "sidebar-menu-item", "data-sidebar": "menu-item", className: cn("group/menu-item relative", className), ...props }));
}
const sidebarMenuButtonVariants = cva("peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-none border border-transparent p-2 text-left text-sm font-semibold ring-[var(--color-accent)] outline-none transition-[width,height,padding] motion-reduce:transition-none group-has-data-[sidebar=menu-action]/menu-item:pe-8 group-has-data-[sidebar=menu-badge]/menu-item:pe-8 group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:p-2! hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-ink)] focus-visible:ring-2 focus-visible:ring-offset-2 active:bg-[var(--color-accent-soft)] active:text-[var(--color-ink)] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-[var(--color-ink)] data-[active=true]:font-semibold data-[active=true]:text-[var(--color-surface)] data-[active=true]:hover:bg-[var(--color-ink)] data-[active=true]:hover:text-[var(--color-surface)] data-[state=open]:hover:bg-[var(--color-accent-soft)] data-[state=open]:hover:text-[var(--color-ink)] group-data-[collapsible=icon]:[&>span:last-child]:sr-only [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0", {
    variants: {
        variant: {
            default: "hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-ink)]",
            outline: "bg-[var(--color-surface)] shadow-[0_0_0_1px_var(--color-ink)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-ink)] hover:shadow-[0_0_0_1px_var(--color-accent-soft)]",
        },
        size: {
            default: "h-9 text-sm",
            sm: "h-8 text-xs",
            lg: "h-12 text-sm group-data-[collapsible=icon]:p-0!",
        },
    },
    defaultVariants: {
        variant: "default",
        size: "default",
    },
});
function SidebarMenuButton({ asChild = false, isActive = false, variant = "default", size = "default", tooltip, className, ...props }) {
    const Comp = asChild ? Slot : "button";
    const { isMobile, state } = useSidebar();
    const button = (_jsx(Comp, { "data-slot": "sidebar-menu-button", "data-sidebar": "menu-button", "data-size": size, "data-active": isActive, type: asChild ? undefined : "button", className: cn(sidebarMenuButtonVariants({ variant, size }), className), ...props }));
    if (!tooltip) {
        return button;
    }
    if (typeof tooltip === "string") {
        tooltip = {
            children: tooltip,
        };
    }
    return (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: button }), _jsx(TooltipPortal, { children: _jsx(TooltipContent, { side: "right", align: "center", hidden: state !== "collapsed" || isMobile, ...tooltip }) })] }));
}
function SidebarMenuAction({ className, asChild = false, showOnHover = false, ...props }) {
    const Comp = asChild ? Slot : "button";
    return (_jsx(Comp, { "data-slot": "sidebar-menu-action", "data-sidebar": "menu-action", type: asChild ? undefined : "button", className: cn("absolute top-1.5 end-1 flex aspect-square w-5 items-center justify-center rounded-none p-0 text-[var(--color-ink)] ring-[var(--color-accent)] outline-none transition-transform motion-reduce:transition-none peer-hover/menu-button:text-[var(--color-ink)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-ink)] focus-visible:ring-2 focus-visible:ring-offset-2 [&>svg]:size-4 [&>svg]:shrink-0", 
        // Increases the hit area of the button on mobile.
        "after:absolute after:-inset-2 md:after:hidden", "peer-data-[size=sm]/menu-button:top-1", "peer-data-[size=default]/menu-button:top-1.5", "peer-data-[size=lg]/menu-button:top-2.5", "peer-data-[active=true]/menu-button:text-[var(--color-surface)] peer-data-[active=true]/menu-button:hover:bg-[var(--color-ink-2)]", "group-data-[collapsible=icon]:hidden", showOnHover &&
            "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 md:opacity-0", className), ...props }));
}
function SidebarMenuBadge({ className, ...props }) {
    return (_jsx("div", { "data-slot": "sidebar-menu-badge", "data-sidebar": "menu-badge", className: cn("pointer-events-none absolute end-1 flex h-5 min-w-5 items-center justify-center rounded-none px-1 text-xs font-medium text-[var(--color-ink)]  select-none", "peer-hover/menu-button:text-[var(--color-ink)] peer-data-[active=true]/menu-button:text-[var(--color-surface)] peer-data-[active=true]/menu-button:hover:bg-[var(--color-ink-2)]", "peer-data-[size=sm]/menu-button:top-1", "peer-data-[size=default]/menu-button:top-1.5", "peer-data-[size=lg]/menu-button:top-2.5", "group-data-[collapsible=icon]:hidden", className), ...props }));
}
function SidebarMenuSkeleton({ className, showIcon = false, ...props }) {
    // Stable width avoids a server/client hydration mismatch.
    const width = "70%";
    return (_jsxs("div", { "data-slot": "sidebar-menu-skeleton", "data-sidebar": "menu-skeleton", "aria-hidden": "true", className: cn("flex h-8 items-center gap-2 rounded-none px-2", className), ...props, children: [showIcon && (_jsx(Skeleton, { className: "size-4 rounded-none", "data-sidebar": "menu-skeleton-icon" })), _jsx(Skeleton, { className: "h-4 max-w-[var(--skeleton-width)] flex-1 group-data-[collapsible=icon]:hidden", "data-sidebar": "menu-skeleton-text", style: {
                    "--skeleton-width": width,
                } })] }));
}
function SidebarMenuSub({ className, ...props }) {
    return (_jsx("ul", { "data-slot": "sidebar-menu-sub", "data-sidebar": "menu-sub", className: cn("mx-3.5 flex min-w-0 flex-col gap-1 border-s border-[var(--color-ink)] px-2.5 py-0.5", "group-data-[collapsible=icon]:hidden", className), ...props }));
}
function SidebarMenuSubItem({ className, ...props }) {
    return (_jsx("li", { "data-slot": "sidebar-menu-sub-item", "data-sidebar": "menu-sub-item", className: cn("group/menu-sub-item relative", className), ...props }));
}
function SidebarMenuSubButton({ asChild = false, size = "md", isActive = false, className, ...props }) {
    const Comp = asChild ? Slot : "a";
    return (_jsx(Comp, { "data-slot": "sidebar-menu-sub-button", "data-sidebar": "menu-sub-button", "data-size": size, "data-active": isActive, "aria-current": isActive ? "page" : undefined, className: cn("flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-none px-2 text-[var(--color-ink)] ring-[var(--color-accent)] outline-none hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-ink)] focus-visible:ring-2 focus-visible:ring-offset-2 active:bg-[var(--color-accent-soft)] active:text-[var(--color-ink)] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-[collapsible=icon]:[&>span:last-child]:sr-only [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--color-ink)]", "data-[active=true]:bg-[var(--color-accent-soft)] data-[active=true]:text-[var(--color-ink)]", size === "sm" && "text-xs", size === "md" && "text-sm", "group-data-[collapsible=icon]:hidden", className), ...props }));
}
export { Sidebar, SidebarContent, SidebarContext, SidebarFooter, SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarInset, SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, SidebarRail, SidebarSeparator, SidebarTrigger, useSidebar, sidebarMenuButtonVariants, };
//# sourceMappingURL=sidebar.js.map