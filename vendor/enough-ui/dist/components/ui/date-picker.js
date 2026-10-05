"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import * as React from "react";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Button } from "./button.js";
import { Calendar } from "./calendar.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
/** Optional convenience composition. Calendar + Popover can also be composed directly. */
function DatePicker(props) {
    const { label, placeholder = props.mode === "range" ? "Pick a date range" : "Pick a date", disabled, id, name, className, locale, dateFormat = "PPP", open, defaultOpen = false, onOpenChange, closeOnSelect = props.mode !== "range", triggerProps, calendarProps, popoverProps, } = props;
    const [internalValue, setInternalValue] = React.useState(props.defaultValue);
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
    // Presence, rather than undefined, distinguishes a controlled empty selection.
    const controlled = Object.prototype.hasOwnProperty.call(props, "value");
    const selected = controlled ? props.value : internalValue;
    const isOpen = open ?? internalOpen;
    const range = props.mode === "range" ? selected : undefined;
    const date = props.mode !== "range" ? selected : undefined;
    const formatDate = (value) => format(value, dateFormat, { locale });
    const valueLabel = range?.from
        ? range.to ? `${formatDate(range.from)} – ${formatDate(range.to)}` : `${formatDate(range.from)} – …`
        : date ? formatDate(date) : placeholder;
    function setOpen(next) {
        if (open === undefined)
            setInternalOpen(next);
        onOpenChange?.(next);
    }
    function selectDate(next) {
        if (!controlled)
            setInternalValue(next);
        if (props.mode !== "range")
            props.onValueChange?.(next);
        if (closeOnSelect && next)
            setOpen(false);
    }
    function selectRange(next) {
        if (!controlled)
            setInternalValue(next);
        if (props.mode === "range")
            props.onValueChange?.(next);
        if (closeOnSelect && next?.from && next.to)
            setOpen(false);
    }
    // Format dates without converting to UTC: these are calendar days, not instants.
    const inputDate = (value) => value ? format(value, "yyyy-MM-dd") : "";
    return (_jsxs(_Fragment, { children: [_jsxs(Popover, { open: isOpen, onOpenChange: setOpen, children: [_jsx(PopoverTrigger, { asChild: true, children: _jsxs(Button, { type: "button", variant: "outline", ...triggerProps, id: id, disabled: disabled, "aria-label": `${label}: ${valueLabel}`, "data-slot": "date-picker-trigger", "data-empty": !date && !range?.from, className: cn("h-auto min-h-[41px] w-full justify-start whitespace-normal px-3 py-2 text-start font-normal data-[empty=true]:text-[var(--color-text-3)]", className), children: [_jsx(CalendarIcon, { "aria-hidden": "true", className: "shrink-0" }), _jsx("span", { children: valueLabel })] }) }), _jsx(PopoverContent, { align: "start", className: "w-auto max-w-[calc(100vw-1rem)] p-0", ...popoverProps, children: props.mode === "range" ? (_jsx(Calendar, { locale: locale, autoFocus: true, resetOnSelect: true, defaultMonth: range?.from, ...calendarProps, mode: "range", selected: range, onSelect: selectRange, "aria-label": label })) : (_jsx(Calendar, { locale: locale, autoFocus: true, defaultMonth: date, ...calendarProps, mode: "single", selected: date, onSelect: selectDate, "aria-label": label })) })] }), name && (props.mode === "range" ? (_jsxs(_Fragment, { children: [_jsx("input", { type: "hidden", name: `${name}.from`, value: inputDate(range?.from), disabled: disabled }), _jsx("input", { type: "hidden", name: `${name}.to`, value: inputDate(range?.to), disabled: disabled })] })) : _jsx("input", { type: "hidden", name: name, value: inputDate(date), disabled: disabled }))] }));
}
export { DatePicker };
//# sourceMappingURL=date-picker.js.map