"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { presentation } from '../../lib/presentation.js';
import * as React from "react";
import { cn } from "../../lib/utils.js";
const Textarea = React.forwardRef(({ className, ...props }, ref) => (_jsx("textarea", { ref: ref, "data-slot": "textarea", className: cn(presentation.Textarea, className), ...props })));
Textarea.displayName = "Textarea";
export { Textarea };
//# sourceMappingURL=textarea.js.map