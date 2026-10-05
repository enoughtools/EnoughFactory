"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "../../lib/utils.js";
import { directionIconClass, directionChevronPaths } from "../../lib/direction-icons.js";
const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
const DropdownMenuSubTrigger = React.forwardRef(({ className, inset, children, ...props }, ref) => (_jsxs(DropdownMenuPrimitive.SubTrigger, { ref: ref, className: cn("flex cursor-default select-none items-center px-[16px] py-[13px] text-[15px] outline-none transition-colors hover:bg-[var(--color-hover)] focus:bg-[var(--color-hover-strong)] focus:border-l-[3px] focus:border-l-[var(--color-accent)] focus:pl-[13px] data-[state=open]:bg-[var(--color-accent-soft)] border border-transparent font-sans", inset && "pl-[32px]", className), ...props, children: [children, _jsx("svg", { "aria-hidden": "true", focusable: "false", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className: cn(directionIconClass, "ms-auto rtl:rotate-180"), children: _jsx("path", { d: directionChevronPaths.right }) })] })));
DropdownMenuSubTrigger.displayName =
    DropdownMenuPrimitive.SubTrigger.displayName;
const DropdownMenuSubContent = React.forwardRef(({ className, ...props }, ref) => (_jsx(DropdownMenuPrimitive.SubContent, { ref: ref, className: cn("z-50 min-w-[8rem] overflow-hidden border border-[var(--color-ink)] bg-[var(--color-surface)] p-[4px] text-[var(--color-text-main)] shadow-[var(--shadow-card)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 rounded-none font-sans", className), ...props })));
DropdownMenuSubContent.displayName =
    DropdownMenuPrimitive.SubContent.displayName;
const DropdownMenuContent = React.forwardRef(({ className, sideOffset = 4, ...props }, ref) => (_jsx(DropdownMenuPrimitive.Portal, { children: _jsx(DropdownMenuPrimitive.Content, { ref: ref, sideOffset: sideOffset, className: cn("z-50 min-w-[8rem] overflow-hidden border-2 border-[var(--color-ink)] bg-[var(--color-surface)] p-[4px] text-[var(--color-text-main)] shadow-[var(--shadow-card)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 rounded-none font-sans", className), ...props }) })));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;
const DropdownMenuItem = React.forwardRef(({ className, inset, ...props }, ref) => (_jsx(DropdownMenuPrimitive.Item, { ref: ref, className: cn("relative flex cursor-pointer select-none items-center px-[16px] py-[10px] text-[15px] outline-none transition-colors hover:bg-[var(--color-hover)] focus:bg-[var(--color-hover-strong)] focus:border-l-[3px] focus:border-l-[var(--color-accent)] focus:pl-[13px] border border-transparent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 font-sans", inset && "pl-[32px]", className), ...props })));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;
const DropdownMenuCheckboxItem = React.forwardRef(({ className, children, checked, ...props }, ref) => (_jsxs(DropdownMenuPrimitive.CheckboxItem, { ref: ref, className: cn("relative flex cursor-pointer select-none items-center py-[10px] pl-[32px] pr-[16px] text-[15px] outline-none transition-colors hover:bg-[var(--color-hover)] focus:bg-[var(--color-hover-strong)] focus:border-l-[3px] focus:border-l-[var(--color-accent)] focus:pl-[29px] border border-transparent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 font-sans", className), checked: checked, ...props, children: [_jsx("span", { className: "absolute left-[8px] flex h-[16px] w-[16px] items-center justify-center", children: _jsx(DropdownMenuPrimitive.ItemIndicator, { children: _jsx("span", { className: "text-[14px]", children: "\u2713" }) }) }), children] })));
DropdownMenuCheckboxItem.displayName =
    DropdownMenuPrimitive.CheckboxItem.displayName;
const DropdownMenuRadioItem = React.forwardRef(({ className, children, ...props }, ref) => (_jsxs(DropdownMenuPrimitive.RadioItem, { ref: ref, className: cn("relative flex cursor-pointer select-none items-center py-[10px] pl-[32px] pr-[16px] text-[15px] outline-none transition-colors hover:bg-[var(--color-hover)] focus:bg-[var(--color-hover-strong)] focus:border-l-[3px] focus:border-l-[var(--color-accent)] focus:pl-[29px] border border-transparent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 font-sans", className), ...props, children: [_jsx("span", { className: "absolute left-[8px] flex h-[16px] w-[16px] items-center justify-center", children: _jsx(DropdownMenuPrimitive.ItemIndicator, { children: _jsx("span", { className: "text-[12px]", children: "\u25CF" }) }) }), children] })));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;
const DropdownMenuLabel = React.forwardRef(({ className, inset, ...props }, ref) => (_jsx(DropdownMenuPrimitive.Label, { ref: ref, className: cn("px-[16px] py-[6px] text-[10px] font-sans tracking-[0.12em] uppercase text-[var(--color-text-3)]", inset && "pl-[32px]", className), ...props })));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;
const DropdownMenuSeparator = React.forwardRef(({ className, ...props }, ref) => (_jsx(DropdownMenuPrimitive.Separator, { ref: ref, className: cn("-mx-[4px] my-[4px] h-px bg-[var(--color-hairline)]", className), ...props })));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;
const DropdownMenuShortcut = ({ className, ...props }) => {
    return (_jsx("span", { className: cn("ml-auto text-[11px] font-sans tracking-widest text-[var(--color-text-4)]", className), ...props }));
};
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";
export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuGroup, DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuRadioGroup, };
//# sourceMappingURL=dropdown-menu.js.map