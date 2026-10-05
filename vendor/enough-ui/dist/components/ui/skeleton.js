"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { presentation } from '../../lib/presentation.js';
import { cn } from "../../lib/utils.js";
function Skeleton({ className, ...props }) {
    return (_jsx("div", { "data-slot": "skeleton", "aria-hidden": "true", className: cn(presentation.Skeleton, className), ...props }));
}
export { Skeleton };
//# sourceMappingURL=skeleton.js.map