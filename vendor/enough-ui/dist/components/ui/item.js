"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { presentation } from '../../lib/presentation.js';
import { itemVariants, itemMediaVariants } from '../../lib/variants.js';
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils.js";
import { Separator } from './separator.js';
function Item({ className, variant, size, asChild = false, ...props }) {
    const Comp = asChild ? Slot : "div";
    return (_jsx(Comp, { "data-slot": "item", "data-variant": variant ?? "default", "data-size": size ?? "default", className: cn(itemVariants({ variant, size }), className), ...props }));
}
function ItemGroup({ className, ...props }) {
    return (_jsx("div", { "data-slot": "item-group", role: "group", className: cn(presentation.ItemGroup, className), ...props }));
}
function ItemMedia({ className, variant = 'default', ...props }) {
    return (_jsx("div", { "data-slot": "item-media", "data-variant": variant, className: cn(itemMediaVariants({ variant }), className), ...props }));
}
const ItemImage = ItemMedia;
function ItemContent({ className, ...props }) {
    return (_jsx("div", { "data-slot": "item-content", className: cn(presentation.ItemContent, className), ...props }));
}
function ItemTitle({ className, ...props }) {
    return (_jsx("h3", { "data-slot": "item-title", className: cn(presentation.ItemTitle, className), ...props }));
}
function ItemDescription({ className, ...props }) {
    return (_jsx("p", { "data-slot": "item-description", className: cn(presentation.ItemDescription, className), ...props }));
}
function ItemActions({ className, ...props }) {
    return (_jsx("div", { "data-slot": "item-actions", className: cn(presentation.ItemActions, className), ...props }));
}
const ItemAction = ItemActions;
function ItemHeader({ className, ...props }) {
    return (_jsx("div", { "data-slot": "item-header", className: cn(presentation.ItemHeader, className), ...props }));
}
function ItemFooter({ className, ...props }) {
    return (_jsx("div", { "data-slot": "item-footer", className: cn(presentation.ItemFooter, className), ...props }));
}
function ItemSeparator({ className, ...props }) {
    return (_jsx(Separator, { "data-slot": "item-separator", className: className, ...props }));
}
export { Item, ItemAction, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemHeader, ItemImage, ItemMedia, ItemSeparator, ItemTitle, itemMediaVariants, itemVariants, };
//# sourceMappingURL=item.js.map