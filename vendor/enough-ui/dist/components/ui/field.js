"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { presentation } from '../../lib/presentation.js';
import { fieldVariants } from '../../lib/variants.js';
import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "../../lib/utils.js";
const Field = React.forwardRef(({ className, orientation = "vertical", ...props }, ref) => (_jsx("div", { ref: ref, role: "group", "data-slot": "field", "data-orientation": orientation, className: cn(fieldVariants({ orientation }), className), ...props })));
Field.displayName = "Field";
const FieldSet = React.forwardRef(({ className, ...props }, ref) => (_jsx("fieldset", { ref: ref, "data-slot": "field-set", className: cn(presentation.FieldSet, className), ...props })));
FieldSet.displayName = "FieldSet";
const FieldLegend = React.forwardRef(({ className, variant = "legend", ...props }, ref) => (_jsx("legend", { ref: ref, "data-slot": "field-legend", "data-variant": variant, className: cn(presentation.FieldLegend, className), ...props })));
FieldLegend.displayName = "FieldLegend";
const FieldGroup = React.forwardRef(({ className, ...props }, ref) => (_jsx("div", { ref: ref, "data-slot": "field-group", className: cn(presentation.FieldGroup, className), ...props })));
FieldGroup.displayName = "FieldGroup";
const FieldContent = React.forwardRef(({ className, ...props }, ref) => (_jsx("div", { ref: ref, "data-slot": "field-content", className: cn(presentation.FieldContent, className), ...props })));
FieldContent.displayName = "FieldContent";
const FieldLabel = React.forwardRef(({ className, ...props }, ref) => (_jsx(LabelPrimitive.Root, { ref: ref, "data-slot": "field-label", className: cn(presentation.FieldLabel, className), ...props })));
FieldLabel.displayName = LabelPrimitive.Root.displayName;
const FieldTitle = React.forwardRef(({ className, ...props }, ref) => (_jsx("div", { ref: ref, "data-slot": "field-title", className: cn(presentation.FieldTitle, className), ...props })));
FieldTitle.displayName = "FieldTitle";
const FieldDescription = React.forwardRef(({ className, ...props }, ref) => (_jsx("p", { ref: ref, "data-slot": "field-description", className: cn(presentation.FieldDescription, className), ...props })));
FieldDescription.displayName = "FieldDescription";
const FieldError = React.forwardRef(({ className, children, errors, ...props }, ref) => {
    const uniqueErrors = React.useMemo(() => Array.from(new Map((errors ?? [])
        .filter((error) => Boolean(error?.message))
        .map((error) => [error.message, error])).values()), [errors]);
    if (!children && uniqueErrors.length === 0)
        return null;
    return (_jsx("div", { ref: ref, role: "alert", "aria-live": "polite", "data-slot": "field-error", className: cn(presentation.FieldError, className), ...props, children: children ??
            (uniqueErrors.length === 1 ? (uniqueErrors[0]?.message) : (_jsx("ul", { className: "ml-4 list-square space-y-1", children: uniqueErrors.map((error) => (_jsx("li", { children: error.message }, error.message))) }))) }));
});
FieldError.displayName = "FieldError";
const FieldSeparator = React.forwardRef(({ className, children, ...props }, ref) => (_jsx("div", { ref: ref, role: "separator", "data-slot": "field-separator", className: cn(presentation.FieldSeparator, className), ...props, children: children ? (_jsx("span", { className: "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--color-surface)] px-2 font-sans text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-3)]", children: children })) : null })));
FieldSeparator.displayName = "FieldSeparator";
export { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet, FieldTitle, fieldVariants, };
//# sourceMappingURL=field.js.map