"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { cn } from '../../lib/utils.js';
import { surfaces, metaColors } from '../../lib/tool-row.js';
export function ToolRow({ domain, tile, icon, title, meta, metaColor, action, actionAccent = false, surface = 'light', onClick, className }) {
    const onDark = surface === 'dark' || surface === 'gap';
    const handleKeyDown = (event) => {
        if (onClick && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            onClick();
        }
    };
    return (_jsxs("div", { onClick: onClick, onKeyDown: handleKeyDown, role: onClick ? 'button' : undefined, tabIndex: onClick ? 0 : undefined, className: cn("flex items-center w-full gap-[13px] font-sans", surface !== 'transparent' && "px-[16px] py-[13px]", onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]", onClick && (onDark
            ? "hover:bg-[var(--color-ink)] active:bg-[var(--color-ink-border)]"
            : "hover:bg-[var(--color-hover)] active:bg-[var(--color-active)]"), surfaces[surface], className), children: [icon ? (_jsx("span", { className: "flex w-[22px] h-[22px] items-center justify-center", children: icon })) : domain ? (_jsx("img", { src: `https://www.google.com/s2/favicons?domain=${domain}&sz=64`, width: 22, height: 22, alt: "" })) : (_jsx("span", { className: cn("flex w-[22px] h-[22px] items-center justify-center text-[11px] font-bold border", onDark
                    ? "border-[var(--color-dark-text-3)] text-[var(--color-dark-text-2)]"
                    : "border-[var(--color-ink)] text-[var(--color-ink)]"), children: tile || 'P' })), _jsxs("div", { className: "flex-1 text-left", children: [_jsx("div", { className: "text-[15px] font-semibold", children: title }), meta && (_jsx("div", { className: "text-[12px]", style: { color: metaColor }, children: _jsx("span", { className: cn(!metaColor && metaColors[surface]), children: meta }) }))] }), action && (_jsx("span", { className: cn("font-sans text-[11px] uppercase tracking-[0.08em] whitespace-nowrap", actionAccent
                    ? (onDark ? "text-[var(--color-accent-on-ink)]" : "text-[var(--color-accent)]")
                    : (onDark ? "text-[var(--color-dark-text-3)]" : "text-[var(--color-text-4)]")), children: action }))] }));
}
//# sourceMappingURL=tool-row.js.map