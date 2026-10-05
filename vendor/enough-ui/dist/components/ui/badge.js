"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { badgeVariants } from '../../lib/variants.js';
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils.js";
const Badge = React.forwardRef(({ asChild = false, className, variant, ...props }, ref) => {
    const Comp = asChild ? Slot : "span";
    return (_jsx(Comp, { "data-slot": "badge", ref: ref, className: cn(badgeVariants({ variant }), className), ...props }));
});
Badge.displayName = "Badge";
export { Badge, badgeVariants };
//# sourceMappingURL=badge.js.map