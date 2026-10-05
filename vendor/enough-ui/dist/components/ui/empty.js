"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { presentation } from '../../lib/presentation.js';
import { emptyMediaVariants } from '../../lib/variants.js';
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils.js";
function Empty({ className, ...props }) {
    return (_jsx("div", { "data-slot": "empty", className: cn(presentation.Empty, className), ...props }));
}
function EmptyHeader({ className, ...props }) {
    return (_jsx("div", { "data-slot": "empty-header", className: cn(presentation.EmptyHeader, className), ...props }));
}
function EmptyMedia({ className, variant, ...props }) {
    return (_jsx("div", { "data-slot": "empty-media", className: cn(emptyMediaVariants({ variant }), className), ...props }));
}
const EmptyIcon = EmptyMedia;
function EmptyTitle({ className, ...props }) {
    return (_jsx("h3", { "data-slot": "empty-title", className: cn(presentation.EmptyTitle, className), ...props }));
}
function EmptyDescription({ className, ...props }) {
    return (_jsx("p", { "data-slot": "empty-description", className: cn(presentation.EmptyDescription, className), ...props }));
}
function EmptyContent({ className, ...props }) {
    return (_jsx("div", { "data-slot": "empty-content", className: cn(presentation.EmptyContent, className), ...props }));
}
function EmptyAction({ asChild = false, className, ...props }) {
    const Comp = asChild ? Slot : "div";
    return (_jsx(Comp, { "data-slot": "empty-action", className: cn(presentation.EmptyAction, className), ...props }));
}
export { Empty, EmptyAction, EmptyContent, EmptyDescription, EmptyHeader, EmptyIcon, EmptyMedia, EmptyTitle, emptyMediaVariants, };
//# sourceMappingURL=empty.js.map