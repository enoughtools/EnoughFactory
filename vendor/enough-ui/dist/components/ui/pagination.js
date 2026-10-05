"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { presentation } from '../../lib/presentation.js';
import { paginationLinkVariants } from '../../lib/variants.js';
import * as React from "react";
import { directionIconClass, directionChevronPaths } from "../../lib/direction-icons.js";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils.js";
const Pagination = React.forwardRef(({ className, "aria-label": ariaLabel = "Pagination", ...props }, ref) => (_jsx("nav", { ref: ref, "aria-label": ariaLabel, "data-slot": "pagination", className: cn(presentation.Pagination, className), ...props })));
Pagination.displayName = "Pagination";
const PaginationContent = React.forwardRef(({ className, ...props }, ref) => (_jsx("ul", { ref: ref, "data-slot": "pagination-content", className: cn(presentation.PaginationContent, className), ...props })));
PaginationContent.displayName = "PaginationContent";
const PaginationItem = React.forwardRef(({ className, ...props }, ref) => (_jsx("li", { ref: ref, "data-slot": "pagination-item", className: cn(presentation.PaginationItem, className), ...props })));
PaginationItem.displayName = "PaginationItem";
const PaginationLink = React.forwardRef(({ asChild = false, "aria-disabled": ariaDisabled, children, className, disabled = false, isActive = false, href, onClick, size, tabIndex, ...props }, ref) => {
    const Comp = asChild ? Slot : "a";
    const isDisabled = disabled || ariaDisabled === true || ariaDisabled === "true";
    const content = asChild && isDisabled && React.isValidElement(children)
        ? React.cloneElement(children, {
            href: undefined,
            "aria-disabled": true,
            tabIndex: -1,
            onClick: (event) => event.preventDefault(),
        })
        : children;
    return (_jsx(Comp, { ref: ref, "aria-current": isActive ? "page" : undefined, "aria-disabled": isDisabled || undefined, "data-active": isActive ? "true" : undefined, "data-disabled": isDisabled ? "true" : undefined, "data-slot": "pagination-link", href: isDisabled ? undefined : href, tabIndex: isDisabled ? -1 : tabIndex, onClick: (event) => {
            if (isDisabled) {
                event.preventDefault();
                return;
            }
            onClick?.(event);
        }, className: cn(paginationLinkVariants({
            variant: isActive ? "active" : "default",
            size,
        }), className), ...props, children: content }));
});
PaginationLink.displayName = "PaginationLink";
const PaginationPrevious = React.forwardRef(({ className, children, text = "Previous", ...props }, ref) => (_jsxs(PaginationLink, { ref: ref, "aria-label": "Go to previous page", size: "default", className: cn(presentation.PaginationPrevious, className), ...props, children: [_jsx("svg", { "aria-hidden": "true", focusable: "false", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className: cn(directionIconClass, "rtl:rotate-180"), children: _jsx("path", { d: directionChevronPaths.left }) }), _jsx("span", { className: "max-[479px]:sr-only", children: children ?? text })] })));
PaginationPrevious.displayName = "PaginationPrevious";
const PaginationNext = React.forwardRef(({ className, children, text = "Next", ...props }, ref) => (_jsxs(PaginationLink, { ref: ref, "aria-label": "Go to next page", size: "default", className: cn(presentation.PaginationNext, className), ...props, children: [_jsx("span", { className: "max-[479px]:sr-only", children: children ?? text }), _jsx("svg", { "aria-hidden": "true", focusable: "false", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className: cn(directionIconClass, "rtl:rotate-180"), children: _jsx("path", { d: directionChevronPaths.right }) })] })));
PaginationNext.displayName = "PaginationNext";
const PaginationEllipsis = React.forwardRef(({ className, ...props }, ref) => (_jsxs("span", { ref: ref, "data-slot": "pagination-ellipsis", className: cn(presentation.PaginationEllipsis, className), ...props, children: [_jsx("span", { "aria-hidden": "true", children: "\u2026" }), _jsx("span", { className: "sr-only", children: "More pages" })] })));
PaginationEllipsis.displayName = "PaginationEllipsis";
export { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious, paginationLinkVariants, };
//# sourceMappingURL=pagination.js.map