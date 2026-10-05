"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { cn } from '../../lib/utils.js';
export function GroupLabel({ children, accent = false, onInk = false, marker = false, className, ...props }) {
    const textColorClass = onInk
        ? (accent ? 'text-[var(--color-accent-on-ink)]' : 'text-[var(--color-dark-text-3)]')
        : (accent ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-3)]');
    return (_jsxs("div", { className: cn("flex items-center gap-[12px] font-sans text-[10px] uppercase tracking-[0.12em]", textColorClass, className), ...props, children: [marker && (_jsx("span", { className: cn("inline-block box-border w-[8px] h-[8px]", accent ? "bg-[var(--color-accent)] border-none" : `border border-current bg-transparent`) })), children] }));
}
//# sourceMappingURL=group-label.js.map