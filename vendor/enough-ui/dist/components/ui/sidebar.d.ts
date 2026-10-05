import * as React from "react";
import { type VariantProps } from "class-variance-authority";
import { Button } from "./button.js";
import { Input } from "./input.js";
import { Separator } from "./separator.js";
import { TooltipContent } from "./tooltip.js";
type SidebarContextProps = {
    state: "expanded" | "collapsed";
    open: boolean;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>;
    openMobile: boolean;
    setOpenMobile: React.Dispatch<React.SetStateAction<boolean>>;
    isMobile: boolean;
    toggleSidebar: () => void;
    /** Compatibility alias for the original EnoughUI context. */
    expanded: boolean;
    sidebarId: string;
    mobileStyle: React.CSSProperties;
    mobileReturnFocusRef: React.RefObject<HTMLElement | null>;
    dir?: string;
};
declare const SidebarContext: React.Context<SidebarContextProps | null>;
declare function useSidebar(): SidebarContextProps;
declare function SidebarProvider({ defaultOpen, open: openProp, onOpenChange: setOpenProp, expanded, onExpandedChange, persistState, cookieName, cookieMaxAge, className, style, children, dir, id, ...props }: React.ComponentProps<"div"> & {
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** @deprecated Use open instead. */
    expanded?: boolean;
    /** @deprecated Use onOpenChange instead. */
    onExpandedChange?: (expanded: boolean) => void;
    /** Set false to disable sidebar state cookie writes. */
    persistState?: boolean;
    cookieName?: string;
    cookieMaxAge?: number;
}): React.JSX.Element;
declare function Sidebar({ side, variant, collapsible, className, children, dir, id, ...props }: React.ComponentProps<"div"> & {
    side?: "left" | "right";
    variant?: "sidebar" | "floating" | "inset";
    collapsible?: "offcanvas" | "icon" | "none";
}): React.JSX.Element;
declare function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>): React.JSX.Element;
declare function SidebarRail({ className, onClick, ...props }: React.ComponentProps<"button">): React.JSX.Element;
declare function SidebarInset({ className, ...props }: React.ComponentProps<"main">): React.JSX.Element;
declare function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>): React.JSX.Element;
declare function SidebarHeader({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function SidebarFooter({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>): React.JSX.Element;
declare function SidebarContent({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function SidebarGroup({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function SidebarGroupLabel({ className, asChild, ...props }: React.ComponentProps<"div"> & {
    asChild?: boolean;
}): React.JSX.Element;
declare function SidebarGroupAction({ className, asChild, ...props }: React.ComponentProps<"button"> & {
    asChild?: boolean;
}): React.JSX.Element;
declare function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">): React.JSX.Element;
declare function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">): React.JSX.Element;
declare const sidebarMenuButtonVariants: (props?: ({
    variant?: "default" | "outline" | null | undefined;
    size?: "default" | "lg" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
declare function SidebarMenuButton({ asChild, isActive, variant, size, tooltip, className, ...props }: React.ComponentProps<"button"> & {
    asChild?: boolean;
    isActive?: boolean;
    tooltip?: string | React.ComponentProps<typeof TooltipContent>;
} & VariantProps<typeof sidebarMenuButtonVariants>): React.JSX.Element;
declare function SidebarMenuAction({ className, asChild, showOnHover, ...props }: React.ComponentProps<"button"> & {
    asChild?: boolean;
    showOnHover?: boolean;
}): React.JSX.Element;
declare function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function SidebarMenuSkeleton({ className, showIcon, ...props }: React.ComponentProps<"div"> & {
    showIcon?: boolean;
}): React.JSX.Element;
declare function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">): React.JSX.Element;
declare function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">): React.JSX.Element;
declare function SidebarMenuSubButton({ asChild, size, isActive, className, ...props }: React.ComponentProps<"a"> & {
    asChild?: boolean;
    size?: "sm" | "md";
    isActive?: boolean;
}): React.JSX.Element;
export { Sidebar, SidebarContent, SidebarContext, SidebarFooter, SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarInset, SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, SidebarRail, SidebarSeparator, SidebarTrigger, useSidebar, sidebarMenuButtonVariants, };
export type { SidebarContextProps };
//# sourceMappingURL=sidebar.d.ts.map