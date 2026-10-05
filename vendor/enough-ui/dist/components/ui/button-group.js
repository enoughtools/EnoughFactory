"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { presentation } from '../../lib/presentation.js';
import { buttonGroupVariants } from '../../lib/variants.js';
import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils.js";
const ButtonGroup = React.forwardRef(({ className, orientation = "horizontal", ...props }, ref) => (_jsx("div", { ref: ref, role: "group", "data-slot": "button-group", "data-orientation": orientation, className: cn(buttonGroupVariants({ orientation }), className), ...props })));
ButtonGroup.displayName = "ButtonGroup";
const ButtonGroupText = React.forwardRef(({ className, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "div";
    return (_jsx(Comp, { ref: ref, "data-slot": "button-group-text", className: cn(presentation.ButtonGroupText, className), ...props }));
});
ButtonGroupText.displayName = "ButtonGroupText";
const ButtonGroupSeparator = React.forwardRef(({ className, orientation = "vertical", decorative = true, ...props }, ref) => (_jsx(SeparatorPrimitive.Root, { ref: ref, decorative: decorative, orientation: orientation, "data-slot": "button-group-separator", className: cn(presentation.ButtonGroupSeparator, orientation === "vertical" ? "my-0 w-px" : "mx-0 h-px", className), ...props })));
ButtonGroupSeparator.displayName = SeparatorPrimitive.Root.displayName;
export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText, buttonGroupVariants, };
//# sourceMappingURL=button-group.js.map