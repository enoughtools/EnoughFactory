"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { cn } from "../../lib/utils.js";
import { nativeSelectContainerClassName, nativeSelectIconClassName, nativeSelectIconSvgClassName, nativeSelectOptGroupClassName, nativeSelectOptionClassName, nativeSelectVariants, } from "../../lib/native-select.js";
const NativeSelect = React.forwardRef(({ className, containerClassName, size, variantSize, multiple, children, ...props }, ref) => {
    const isNumeric = typeof size === "number" || (typeof size === "string" && /^\d+$/.test(size));
    const numericSize = isNumeric ? Number(size) : undefined;
    const visualSize = variantSize ?? (size === "sm" || size === "default" ? size : "default");
    const isListBox = Boolean(multiple) || (typeof numericSize === "number" && numericSize > 1);
    return (_jsxs("div", { className: cn(nativeSelectContainerClassName, containerClassName), "data-slot": "native-select-container", children: [_jsx("select", { ref: ref, size: numericSize, multiple: multiple, "data-slot": "native-select", "data-size": visualSize, className: cn(nativeSelectVariants({ size: visualSize, isListBox }), className), ...props, children: children }), !isListBox && (_jsx("span", { "aria-hidden": "true", "data-slot": "native-select-icon", className: nativeSelectIconClassName, children: _jsx("svg", { "aria-hidden": "true", focusable: "false", className: nativeSelectIconSvgClassName, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: _jsx("polyline", { points: "6 9 12 15 18 9" }) }) }))] }));
});
NativeSelect.displayName = "NativeSelect";
const NativeSelectOption = React.forwardRef(({ className, ...props }, ref) => (_jsx("option", { ref: ref, "data-slot": "native-select-option", className: cn(nativeSelectOptionClassName, className), ...props })));
NativeSelectOption.displayName = "NativeSelectOption";
const NativeSelectOptGroup = React.forwardRef(({ className, ...props }, ref) => (_jsx("optgroup", { ref: ref, "data-slot": "native-select-optgroup", className: cn(nativeSelectOptGroupClassName, className), ...props })));
NativeSelectOptGroup.displayName = "NativeSelectOptGroup";
export { NativeSelect, NativeSelectOption, NativeSelectOptGroup };
//# sourceMappingURL=native-select.js.map