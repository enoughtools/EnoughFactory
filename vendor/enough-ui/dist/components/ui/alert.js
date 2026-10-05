"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { alertVariants } from '../../lib/variants.js';
import * as React from "react";
import { apiPresentation } from '../../lib/api-presentation.js';
import { cn } from '../../lib/utils.js';
const Alert = React.forwardRef(({ className, variant, ...props }, ref) => (_jsx("div", { ref: ref, role: "alert", "data-slot": "alert", className: cn(alertVariants({ variant }), apiPresentation.Alert, className), ...props })));
Alert.displayName = "Alert";
const AlertTitle = React.forwardRef(({ className, ...props }, ref) => (_jsx("h5", { ref: ref, "data-slot": "alert-title", className: `mb-1 font-medium leading-none tracking-tight ${className || ""}`.trim(), ...props })));
AlertTitle.displayName = "AlertTitle";
const AlertDescription = React.forwardRef(({ className, ...props }, ref) => (_jsx("div", { ref: ref, "data-slot": "alert-description", className: `text-sm [&_p]:leading-relaxed ${className || ""}`.trim(), ...props })));
AlertDescription.displayName = "AlertDescription";
const AlertAction = React.forwardRef(({ className, ...props }, ref) => (_jsx("div", { ref: ref, "data-slot": "alert-action", className: cn(apiPresentation.AlertAction, className), ...props })));
AlertAction.displayName = "AlertAction";
export { Alert, AlertTitle, AlertDescription, AlertAction };
//# sourceMappingURL=alert.js.map