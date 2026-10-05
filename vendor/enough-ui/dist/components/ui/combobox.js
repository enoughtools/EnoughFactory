"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Command as CommandPrimitive } from "cmdk";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { cn } from "../../lib/utils.js";
import { directionIconClass, directionChevronPaths } from "../../lib/direction-icons.js";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group.js";
const LegacyCombobox = PopoverPrimitive.Root;
const LegacyComboboxTrigger = PopoverPrimitive.Trigger;
const LegacyComboboxAnchor = PopoverPrimitive.Anchor;
const LegacyComboboxPortal = PopoverPrimitive.Portal;
const LegacyComboboxContent = React.forwardRef(({ className, align = "start", sideOffset = 6, ...props }, ref) => (_jsx(PopoverPrimitive.Portal, { children: _jsx(PopoverPrimitive.Content, { ref: ref, align: align, sideOffset: sideOffset, className: cn("z-50 w-[var(--radix-popover-trigger-width)] min-w-[220px] rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] p-0 text-[var(--color-ink)] shadow-[var(--shadow-palette)] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2", className), ...props }) })));
LegacyComboboxContent.displayName = PopoverPrimitive.Content.displayName;
const LegacyComboboxCommand = React.forwardRef(({ className, ...props }, ref) => (_jsx(CommandPrimitive, { ref: ref, className: cn("flex h-full w-full flex-col overflow-hidden rounded-none bg-[var(--color-surface)] font-sans text-[var(--color-ink)]", className), ...props })));
LegacyComboboxCommand.displayName = CommandPrimitive.displayName;
const LegacyComboboxInput = React.forwardRef(({ className, ...props }, ref) => (_jsxs("div", { className: "flex items-center gap-[12px] border-b border-[var(--color-ink)] px-[16px]", "cmdk-input-wrapper": "", children: [_jsx("span", { "aria-hidden": "true", className: "text-[18px] text-[var(--color-accent)]", children: "\u2315" }), _jsx(CommandPrimitive.Input, { ref: ref, className: cn("flex h-[44px] w-full bg-transparent py-[10px] text-[15px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-text-4)] disabled:cursor-not-allowed disabled:opacity-50 font-sans rounded-none", className), ...props })] })));
LegacyComboboxInput.displayName = CommandPrimitive.Input.displayName;
const LegacyComboboxList = React.forwardRef(({ className, ...props }, ref) => (_jsx(CommandPrimitive.List, { ref: ref, className: cn("max-h-[300px] overflow-y-auto overflow-x-hidden p-[4px]", className), ...props })));
LegacyComboboxList.displayName = CommandPrimitive.List.displayName;
const LegacyComboboxEmpty = React.forwardRef(({ className, ...props }, ref) => (_jsx(CommandPrimitive.Empty, { ref: ref, className: cn("py-[24px] text-center text-[14px] text-[var(--color-text-4)] font-sans", className), ...props })));
LegacyComboboxEmpty.displayName = CommandPrimitive.Empty.displayName;
const LegacyComboboxGroup = React.forwardRef(({ className, ...props }, ref) => (_jsx(CommandPrimitive.Group, { ref: ref, className: cn("overflow-hidden text-[var(--color-ink)] [&_[cmdk-group-heading]]:px-[12px] [&_[cmdk-group-heading]]:pt-[12px] [&_[cmdk-group-heading]]:pb-[6px] [&_[cmdk-group-heading]]:font-sans [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:text-[var(--color-text-3)]", className), ...props })));
LegacyComboboxGroup.displayName = CommandPrimitive.Group.displayName;
const LegacyComboboxSeparator = React.forwardRef(({ className, ...props }, ref) => (_jsx(CommandPrimitive.Separator, { ref: ref, className: cn("-mx-[4px] my-[4px] h-px bg-[var(--color-ink)]", className), ...props })));
LegacyComboboxSeparator.displayName = CommandPrimitive.Separator.displayName;
const LegacyComboboxItem = React.forwardRef(({ className, ...props }, ref) => (_jsx(CommandPrimitive.Item, { ref: ref, className: cn("relative flex cursor-pointer select-none items-center border border-transparent px-[12px] py-[10px] text-[15px] outline-none rounded-none transition-colors hover:bg-[var(--color-hover)] aria-selected:border-l-[3px] aria-selected:border-l-[var(--color-accent)] aria-selected:bg-[var(--color-hover-strong)] aria-selected:pl-[10px] data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50", className), ...props })));
LegacyComboboxItem.displayName = CommandPrimitive.Item.displayName;
const LegacyComboboxShortcut = ({ className, ...props }) => (_jsx("span", { className: cn("ml-auto font-sans text-[11px] tracking-widest text-[var(--color-text-4)]", className), ...props }));
LegacyComboboxShortcut.displayName = "LegacyComboboxShortcut";
const LegacyComboboxContext = React.createContext(false);
function containsCommand(children) {
    return React.Children.toArray(children).some((child) => React.isValidElement(child) &&
        (child.type === ComboboxCommand || containsCommand(child.props.children)));
}
/** The original popover/command composition remains supported for existing consumers. */
function Combobox(props) {
    const { legacy, modal, ...rest } = props;
    const isLegacy = legacy ?? (!props.items && containsCommand(props.children));
    return (_jsx(LegacyComboboxContext.Provider, { value: isLegacy, children: isLegacy
            ? _jsx(LegacyCombobox, { ...rest, modal: modal })
            : _jsx(ComboboxPrimitive.Root, { ...rest }) }));
}
function comboboxClass(base, className) {
    return typeof className === "function"
        ? (state) => cn(base, className(state))
        : cn(base, className);
}
function ComboboxValue(props) {
    return _jsx(ComboboxPrimitive.Value, { "data-slot": "combobox-value", ...props });
}
function ComboboxTrigger({ className, children, asChild, ...props }) {
    const legacy = React.useContext(LegacyComboboxContext);
    if (legacy)
        return _jsx(LegacyComboboxTrigger, { asChild: asChild, className: typeof className === "string" ? className : undefined, ...props, children: children });
    return (_jsxs(ComboboxPrimitive.Trigger, { "data-slot": "combobox-trigger", "aria-label": props["aria-label"] ?? (children ? undefined : "Toggle suggestions"), className: comboboxClass("inline-flex items-center justify-center gap-2 font-sans text-[var(--color-text-3)] disabled:pointer-events-none disabled:opacity-50", className), ...props, render: asChild && React.isValidElement(children) ? children : props.render, children: [asChild ? undefined : children, !asChild && _jsx("svg", { "aria-hidden": "true", focusable: "false", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className: cn(directionIconClass, "pointer-events-none"), children: _jsx("path", { d: directionChevronPaths.down }) })] }));
}
function ComboboxInput({ className, children, disabled, showTrigger = true, showClear = false, onValueChange, ...props }) {
    const legacy = React.useContext(LegacyComboboxContext);
    if (legacy)
        return _jsx(LegacyComboboxInput, { ...props, disabled: disabled, className: typeof className === "string" ? className : undefined, onValueChange: onValueChange });
    return (_jsxs(InputGroup, { className: typeof className === "string" ? className : undefined, children: [_jsx(ComboboxPrimitive.Input, { "data-slot": "combobox-input", render: (inputProps, state) => _jsx(InputGroupInput, { ...inputProps, disabled: state.disabled }), ...props, disabled: disabled, className: typeof className === "function" ? className : undefined, onChange: (event) => { props.onChange?.(event); onValueChange?.(event.currentTarget.value); } }), (showTrigger || showClear) && (_jsxs(InputGroupAddon, { align: "inline-end", children: [showTrigger && _jsx(ComboboxTrigger, { render: (buttonProps, state) => _jsx(InputGroupButton, { ...buttonProps, disabled: state.disabled, size: "icon-xs" }), disabled: disabled, className: "group-has-[[data-slot=combobox-clear]]/input-group:hidden" }), showClear && (_jsx(ComboboxPrimitive.Clear, { "data-slot": "combobox-clear", "aria-label": "Clear selection", disabled: disabled, render: _jsx(InputGroupButton, { size: "icon-xs" }), children: _jsx("span", { "aria-hidden": "true", children: "\u00D7" }) }))] })), children] }));
}
function ComboboxContent({ className, side = "bottom", sideOffset = 6, align = "start", alignOffset = 0, anchor, ...props }) {
    const legacy = React.useContext(LegacyComboboxContext);
    if (legacy)
        return _jsx(LegacyComboboxContent, { ...props, className: typeof className === "string" ? className : undefined, side: side, sideOffset: typeof sideOffset === "number" ? sideOffset : 6, align: align, alignOffset: typeof alignOffset === "number" ? alignOffset : 0 });
    return (_jsx(ComboboxPrimitive.Portal, { children: _jsx(ComboboxPrimitive.Positioner, { side: side, sideOffset: sideOffset, align: align, alignOffset: alignOffset, anchor: anchor, className: "isolate z-50", children: _jsx(ComboboxPrimitive.Popup, { "data-slot": "combobox-content", "data-chips": !!anchor, className: comboboxClass("relative max-h-[var(--available-height)] w-[var(--anchor-width)] min-w-[220px] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] p-0 font-sans text-[var(--color-ink)] shadow-[var(--shadow-palette)] outline-none data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-safe:transition-opacity", className), ...props }) }) }));
}
function ComboboxList({ className, ...props }) {
    const legacy = React.useContext(LegacyComboboxContext);
    if (legacy)
        return _jsx(LegacyComboboxList, { ...props, className: typeof className === "string" ? className : undefined });
    return _jsx(ComboboxPrimitive.List, { "data-slot": "combobox-list", className: comboboxClass("max-h-[300px] overflow-y-auto overflow-x-hidden overscroll-contain p-1 empty:p-0", className), ...props });
}
function ComboboxItem({ className, children, onSelect, ...props }) {
    const legacy = React.useContext(LegacyComboboxContext);
    if (legacy)
        return _jsx(LegacyComboboxItem, { ...props, className: typeof className === "string" ? className : undefined, onSelect: onSelect, children: children });
    return (_jsxs(ComboboxPrimitive.Item, { "data-slot": "combobox-item", className: comboboxClass("relative flex w-full cursor-default select-none items-center gap-2 rounded-none border border-transparent px-3 py-2.5 font-sans text-[15px] outline-none data-[highlighted]:border-l-[3px] data-[highlighted]:border-l-[var(--color-accent)] data-[highlighted]:bg-[var(--color-hover-strong)] data-[highlighted]:pl-2.5 data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className), ...props, onClick: (event) => { props.onClick?.(event); if (!event.defaultPrevented)
            onSelect?.(String(props.value)); }, children: [children, _jsx(ComboboxPrimitive.ItemIndicator, { className: "ms-auto text-[var(--color-accent)]", children: _jsx("span", { "aria-hidden": "true", children: "\u2713" }) })] }));
}
function ComboboxGroup({ className, heading, children, ...props }) {
    const legacy = React.useContext(LegacyComboboxContext);
    if (legacy)
        return _jsx(LegacyComboboxGroup, { ...props, heading: heading, className: typeof className === "string" ? className : undefined, children: children });
    return _jsxs(ComboboxPrimitive.Group, { "data-slot": "combobox-group", className: comboboxClass("text-[var(--color-ink)]", className), ...props, children: [heading && _jsx(ComboboxLabel, { children: heading }), children] });
}
function ComboboxLabel({ className, ...props }) {
    return _jsx(ComboboxPrimitive.GroupLabel, { "data-slot": "combobox-label", className: comboboxClass("px-3 pt-3 pb-1.5 font-sans text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-3)]", className), ...props });
}
function ComboboxCollection(props) {
    return _jsx(ComboboxPrimitive.Collection, { "data-slot": "combobox-collection", ...props });
}
function ComboboxEmpty({ className, ...props }) {
    const legacy = React.useContext(LegacyComboboxContext);
    if (legacy)
        return _jsx(LegacyComboboxEmpty, { ...props, className: typeof className === "string" ? className : undefined });
    return _jsx(ComboboxPrimitive.Empty, { "data-slot": "combobox-empty", className: comboboxClass("py-6 text-center font-sans text-sm text-[var(--color-text-4)] empty:hidden", className), ...props });
}
function ComboboxSeparator({ className, ...props }) {
    const legacy = React.useContext(LegacyComboboxContext);
    if (legacy)
        return _jsx(LegacyComboboxSeparator, { ...props, className: typeof className === "string" ? className : undefined });
    return _jsx(ComboboxPrimitive.Separator, { "data-slot": "combobox-separator", className: comboboxClass("my-1 h-px bg-[var(--color-ink)]", className), ...props });
}
function ComboboxChips({ className, ...props }) {
    return _jsx(ComboboxPrimitive.Chips, { "data-slot": "combobox-chips", className: comboboxClass("flex min-h-[41px] flex-wrap items-center gap-1.5 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] px-3 py-1.5 font-sans shadow-[var(--shadow-card)] focus-within:ring-1 focus-within:ring-[var(--color-accent)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50", className), ...props });
}
function ComboboxChip({ className, children, showRemove = true, ...props }) {
    return (_jsxs(ComboboxPrimitive.Chip, { "data-slot": "combobox-chip", className: comboboxClass("inline-flex items-center gap-1 rounded-none border border-[var(--color-ink)] bg-[var(--color-paper)] px-2 py-0.5 font-sans text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] has-[:disabled]:opacity-50", className), ...props, children: [children, showRemove && _jsx(ComboboxPrimitive.ChipRemove, { "data-slot": "combobox-chip-remove", "aria-label": typeof children === "string" || typeof children === "number" ? `Remove ${children}` : "Remove selection", className: "inline-flex size-6 items-center justify-center rounded-none font-sans text-base hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]", children: _jsx("span", { "aria-hidden": "true", children: "\u00D7" }) })] }));
}
function ComboboxChipsInput({ className, ...props }) {
    return _jsx(ComboboxPrimitive.Input, { "data-slot": "combobox-chip-input", className: comboboxClass("min-w-16 flex-1 bg-transparent py-1 font-sans text-[15px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-text-4)]", className), ...props });
}
function useComboboxAnchor() { return React.useRef(null); }
const ComboboxCommand = LegacyComboboxCommand;
const ComboboxAnchor = LegacyComboboxAnchor;
const ComboboxPortal = LegacyComboboxPortal;
const ComboboxShortcut = LegacyComboboxShortcut;
export { Combobox, ComboboxTrigger, ComboboxAnchor, ComboboxPortal, ComboboxCommand, ComboboxInput, ComboboxContent, ComboboxList, ComboboxItem, ComboboxGroup, ComboboxLabel, ComboboxCollection, ComboboxEmpty, ComboboxSeparator, ComboboxChips, ComboboxChip, ComboboxChipsInput, ComboboxValue, ComboboxShortcut, useComboboxAnchor, };
//# sourceMappingURL=combobox.js.map