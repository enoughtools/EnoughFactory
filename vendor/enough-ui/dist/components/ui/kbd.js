"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { presentation } from '../../lib/presentation.js';
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils.js";
const Kbd = React.forwardRef(({ asChild = false, className, ...props }, ref) => {
    const Comp = asChild ? Slot : "kbd";
    return (_jsx(Comp, { ref: ref, "data-slot": "kbd", className: cn(presentation.Kbd, className), ...props }));
});
Kbd.displayName = "Kbd";
const KbdGroup = React.forwardRef(({ className, ...props }, ref) => (_jsx("span", { ref: ref, role: "group", "data-slot": "kbd-group", className: cn(presentation.KbdGroup, className), ...props })));
KbdGroup.displayName = "KbdGroup";
export { Kbd, KbdGroup };
//# sourceMappingURL=kbd.js.map