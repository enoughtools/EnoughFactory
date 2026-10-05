"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { presentation } from '../../lib/presentation.js';
import * as React from "react";
import { cn } from "../../lib/utils.js";
const Input = React.forwardRef(({ className, type, ...props }, ref) => {
    return (_jsx("input", { type: type, className: cn(presentation.Input, className), ref: ref, ...props }));
});
Input.displayName = "Input";
export { Input };
//# sourceMappingURL=input.js.map