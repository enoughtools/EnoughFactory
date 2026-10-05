"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { OTPInput, OTPInputContext } from "input-otp";
import { cn } from "../../lib/utils.js";
const noScriptCSS = `[data-input-otp] {
  font-family: var(--font-sans), sans-serif !important;
  background: var(--color-surface) !important;
  color: var(--color-text-main) !important;
  caret-color: var(--color-text-main) !important;
  letter-spacing: .25em !important;
  text-align: center !important;
  border: 1px solid var(--color-border-mid) !important;
  border-radius: 0 !important;
  width: 100% !important;
}`;
function InputOTP({ className, containerClassName, noScriptCSSFallback = noScriptCSS, ref, ...props }) {
    return (_jsx(OTPInput, { ...props, ref: ref, noScriptCSSFallback: noScriptCSSFallback, "data-slot": "input-otp", containerClassName: cn("group/input-otp flex items-center gap-2 font-sans has-[:disabled]:opacity-50", containerClassName), className: cn("font-sans! disabled:cursor-not-allowed", className) }));
}
const InputOTPGroup = React.forwardRef(({ className, ...props }, ref) => _jsx("div", { ...props, ref: ref, "data-slot": "input-otp-group", className: cn("flex items-center", className) }));
InputOTPGroup.displayName = "InputOTPGroup";
const InputOTPSlot = React.forwardRef(({ index, className, ...props }, ref) => {
    const context = React.useContext(OTPInputContext);
    const { char, placeholderChar, hasFakeCaret, isActive } = context?.slots?.[index] ?? {};
    return (_jsxs("div", { ...props, ref: ref, "data-slot": "input-otp-slot", "data-active": Boolean(isActive), "aria-hidden": "true", className: cn("relative flex h-11 w-11 items-center justify-center rounded-none border-y border-r border-[var(--color-border-mid)] bg-[var(--color-surface)] font-sans text-lg font-semibold text-[var(--color-text-main)] [font-variant-numeric:tabular-nums] transition-[border-color,box-shadow] first:border-l data-[active=true]:z-10 data-[active=true]:border-[var(--color-accent)] data-[active=true]:ring-2 data-[active=true]:ring-[var(--color-accent)] aria-[invalid=true]:border-[var(--color-warn)] aria-[invalid=true]:ring-[var(--color-warn)] group-has-[[aria-invalid=true]]/input-otp:border-[var(--color-warn)] group-has-[[aria-invalid=true]]/input-otp:ring-[var(--color-warn)]", className), children: [char ?? _jsx("span", { className: "font-normal text-[var(--color-text-4)]", children: placeholderChar }), hasFakeCaret && (_jsx("span", { className: "pointer-events-none absolute inset-0 flex items-center justify-center", children: _jsx("span", { className: "h-5 w-px animate-pulse bg-[var(--color-text-main)] motion-reduce:animate-none" }) }))] }));
});
InputOTPSlot.displayName = "InputOTPSlot";
const InputOTPSeparator = React.forwardRef(({ className, children, ...props }, ref) => (_jsx("div", { ...props, ref: ref, "data-slot": "input-otp-separator", role: "separator", "aria-hidden": "true", className: cn("flex items-center justify-center px-1 text-[var(--color-text-3)]", className), children: children ?? _jsx("svg", { viewBox: "0 0 16 16", width: "16", height: "16", fill: "none", children: _jsx("path", { d: "M4 8h8", stroke: "currentColor", strokeWidth: "1.5" }) }) })));
InputOTPSeparator.displayName = "InputOTPSeparator";
export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator };
//# sourceMappingURL=input-otp.js.map