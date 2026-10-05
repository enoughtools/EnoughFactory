"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { presentation } from '../../lib/presentation.js';
import { inputGroupAddonVariants, inputGroupButtonVariants, inputGroupButtonClasses } from '../../lib/variants.js';
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils.js";
import { Input } from "./input.js";
import { Textarea } from "./textarea.js";
const InputGroup = React.forwardRef(({ className, ...props }, ref) => (_jsx("div", { ref: ref, role: "group", "data-slot": "input-group", className: cn(presentation.InputGroup, className), ...props })));
InputGroup.displayName = "InputGroup";
const InputGroupAddon = React.forwardRef(({ className, align, asChild = false, onClick, ...props }, ref) => {
    const Comp = asChild ? Slot : "div";
    return (_jsx(Comp, { ref: ref, "data-slot": "input-group-addon", "data-align": align ?? "inline-start", className: cn(inputGroupAddonVariants({ align }), className), onClick: (event) => {
            onClick?.(event);
            if (event.defaultPrevented || event.target.closest('button, a, input, textarea, select, [role=button]'))
                return;
            const control = event.currentTarget.closest('[data-slot=input-group]')?.querySelector('[data-slot=input-group-control]');
            if (control && !control.disabled)
                control.focus();
        }, ...props }));
});
InputGroupAddon.displayName = "InputGroupAddon";
const InputGroupButton = React.forwardRef(({ className, size, variant = 'ghost', asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (_jsx(Comp, { ref: ref, type: asChild ? undefined : type ?? "button", "data-slot": "input-group-button", "data-size": size ?? 'xs', className: cn(inputGroupButtonClasses({ variant, size }), className), ...props }));
});
InputGroupButton.displayName = "InputGroupButton";
const InputGroupText = React.forwardRef(({ className, ...props }, ref) => (_jsx("span", { ref: ref, "data-slot": "input-group-text", className: cn(presentation.InputGroupText, className), ...props })));
InputGroupText.displayName = "InputGroupText";
const InputGroupInput = React.forwardRef(({ className, ...props }, ref) => (_jsx(Input, { ref: ref, "data-slot": "input-group-control", className: cn(presentation.InputGroupInput, className), ...props })));
InputGroupInput.displayName = "InputGroupInput";
const InputGroupTextarea = React.forwardRef(({ className, ...props }, ref) => (_jsx(Textarea, { ref: ref, "data-slot": "input-group-control", className: cn(presentation.InputGroupTextarea, className), ...props })));
InputGroupTextarea.displayName = "InputGroupTextarea";
export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText, InputGroupTextarea, inputGroupAddonVariants, inputGroupButtonVariants, };
//# sourceMappingURL=input-group.js.map