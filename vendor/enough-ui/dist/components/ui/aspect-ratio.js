"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import * as React from "react";
import * as AspectRatioPrimitive from "@radix-ui/react-aspect-ratio";
import { cn } from "../../lib/utils.js";
import { normalizeAspectRatio, aspectRatioClasses } from "../../lib/minor-presentation.js";
const AspectRatio = React.forwardRef(({ ratio = 1, className, ...props }, ref) => (_jsx(AspectRatioPrimitive.Root, { ref: ref, ratio: normalizeAspectRatio(ratio), "data-slot": "aspect-ratio", className: cn(aspectRatioClasses.inner, className), ...props })));
AspectRatio.displayName = AspectRatioPrimitive.Root.displayName;
export { AspectRatio };
//# sourceMappingURL=aspect-ratio.js.map