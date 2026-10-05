"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { cn } from '../../lib/utils.js';
/** The hero search field: 2px ink border, hard blue offset shadow, ⌘K hint. It opens the launcher, so it is a button. */
export function SearchField({ placeholder = 'What do you need to ship?', onActivate, className, ...props }) {
    return (_jsxs("button", { type: "button", onClick: onActivate, "aria-haspopup": "dialog", "aria-keyshortcuts": "Meta+K", className: cn("flex w-full cursor-pointer items-center border-2 border-[var(--color-ink)] bg-[var(--color-surface)] text-left shadow-[var(--shadow-pop)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]", className), ...props, children: [_jsx("span", { className: "flex-1 px-[20px] py-[17px] font-sans text-[16px] text-[var(--color-text-4)]", children: placeholder }), _jsx("span", { "aria-hidden": "true", className: "font-sans text-[12px] text-[var(--color-text-3)] pr-[18px]", children: "\u2318K" })] }));
}
//# sourceMappingURL=search-field.js.map