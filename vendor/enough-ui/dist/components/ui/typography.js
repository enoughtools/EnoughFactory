"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { presentation } from '../../lib/presentation.js';
import { typographyVariants } from '../../lib/variants.js';
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils.js";
const Typography = React.forwardRef(({ asChild = false, align, className, variant, ...props }, ref) => {
    const Comp = asChild ? Slot : "p";
    return (_jsx(Comp, { ref: ref, "data-slot": "typography", "data-variant": variant ?? "p", className: cn(typographyVariants({ align, variant }), className), ...props }));
});
Typography.displayName = "Typography";
function TypographyH1({ className, ...props }) {
    return (_jsx("h1", { "data-slot": "typography-h1", className: cn(typographyVariants({ variant: "h1" }), className), ...props }));
}
function TypographyH2({ className, ...props }) {
    return (_jsx("h2", { "data-slot": "typography-h2", className: cn(typographyVariants({ variant: "h2" }), className), ...props }));
}
function TypographyH3({ className, ...props }) {
    return (_jsx("h3", { "data-slot": "typography-h3", className: cn(typographyVariants({ variant: "h3" }), className), ...props }));
}
function TypographyH4({ className, ...props }) {
    return (_jsx("h4", { "data-slot": "typography-h4", className: cn(typographyVariants({ variant: "h4" }), className), ...props }));
}
function TypographyP({ className, ...props }) {
    return (_jsx("p", { "data-slot": "typography-p", className: cn(typographyVariants({ variant: "p" }), className), ...props }));
}
function TypographyLead({ className, ...props }) {
    return (_jsx("p", { "data-slot": "typography-lead", className: cn(typographyVariants({ variant: "lead" }), className), ...props }));
}
function TypographyLarge({ className, ...props }) {
    return (_jsx("div", { "data-slot": "typography-large", className: cn(typographyVariants({ variant: "large" }), className), ...props }));
}
function TypographySmall({ className, ...props }) {
    return (_jsx("small", { "data-slot": "typography-small", className: cn(typographyVariants({ variant: "small" }), className), ...props }));
}
function TypographyMuted({ className, ...props }) {
    return (_jsx("p", { "data-slot": "typography-muted", className: cn(typographyVariants({ variant: "muted" }), className), ...props }));
}
function TypographyBlockquote({ className, ...props }) {
    return (_jsx("blockquote", { "data-slot": "typography-blockquote", className: cn(presentation.TypographyBlockquote, className), ...props }));
}
function TypographyList({ className, ...props }) {
    return (_jsx("ul", { "data-slot": "typography-list", className: cn(presentation.TypographyList, className), ...props }));
}
function TypographyInlineCode({ className, ...props }) {
    return (_jsx("code", { "data-slot": "typography-inline-code", className: cn(presentation.TypographyInlineCode, className), ...props }));
}
export { Typography, TypographyBlockquote, TypographyH1, TypographyH2, TypographyH3, TypographyH4, TypographyInlineCode, TypographyLarge, TypographyLead, TypographyList, TypographyMuted, TypographyP, TypographySmall, typographyVariants, };
//# sourceMappingURL=typography.js.map