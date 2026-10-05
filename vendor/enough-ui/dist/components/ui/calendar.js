"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import * as React from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker, getDefaultClassNames, } from "react-day-picker";
import { cn } from "../../lib/utils.js";
import { Button, buttonVariants } from "./button.js";
/**
 * DayPicker's complete selection and navigation API, with EnoughUI appearance.
 * In Astro, use this stateful component inside a React island with client:load.
 * Pass a stable defaultMonth and today when rendering across time zones.
 */
function Calendar({ className, classNames, showOutsideDays = true, captionLayout = "label", buttonVariant = "ghost", locale, formatters, components, ...props }) {
    const defaults = getDefaultClassNames();
    const DayButtonComponent = React.useMemo(() => function LocalizedDayButton(dayProps) {
        return _jsx(CalendarDayButton, { locale: locale, ...dayProps });
    }, [locale]);
    return (_jsx(DayPicker, { showOutsideDays: showOutsideDays, captionLayout: captionLayout, locale: locale, className: cn("w-fit max-w-full bg-[var(--color-surface)] p-2 font-sans text-[var(--color-text-main)] [--calendar-cell-size:min(2.5rem,calc((100vw-3rem)/var(--calendar-columns)))]", props.showWeekNumber ? "[--calendar-columns:8]" : "[--calendar-columns:7]", String.raw `rtl:**:[.rdp-button\_next>svg]:rotate-180`, String.raw `rtl:**:[.rdp-button\_previous>svg]:rotate-180`, className), formatters: {
            formatMonthDropdown: (date) => date.toLocaleString(locale?.code ?? "en-US", { month: "short" }),
            ...formatters,
        }, classNames: {
            root: defaults.root,
            months: cn(defaults.months, "relative flex flex-col gap-4 md:flex-row"),
            month: cn(defaults.month, "flex w-[calc(var(--calendar-columns)*var(--calendar-cell-size))] shrink-0 flex-col gap-2"),
            nav: cn(defaults.nav, "absolute inset-x-0 top-0 flex items-center justify-between"),
            button_previous: cn(defaults.button_previous, buttonVariants({ variant: buttonVariant, size: "ghost" }), "size-[var(--calendar-cell-size)] p-0 disabled:opacity-40 aria-disabled:opacity-40"),
            button_next: cn(defaults.button_next, buttonVariants({ variant: buttonVariant, size: "ghost" }), "size-[var(--calendar-cell-size)] p-0 disabled:opacity-40 aria-disabled:opacity-40"),
            month_caption: cn(defaults.month_caption, "flex h-[var(--calendar-cell-size)] items-center justify-center px-[var(--calendar-cell-size)]"),
            caption_label: cn(defaults.caption_label, "flex items-center gap-1 text-sm font-semibold select-none [&_svg]:size-3"),
            dropdowns: cn(defaults.dropdowns, "flex items-center justify-center gap-2 text-sm"),
            dropdown_root: cn(defaults.dropdown_root, "relative border border-[var(--color-ink)] bg-[var(--color-surface)] px-2 py-1 has-focus-visible:outline-2 has-focus-visible:outline-[var(--color-accent)]"),
            dropdown: cn(defaults.dropdown, "absolute inset-0 w-full cursor-pointer bg-[var(--color-surface)] opacity-0"),
            month_grid: cn(defaults.month_grid, "w-full table-fixed border-collapse"),
            weekdays: defaults.weekdays,
            weekday: cn(defaults.weekday, "h-8 w-[var(--calendar-cell-size)] p-0 text-center text-xs font-medium text-[var(--color-text-3)]"),
            week: defaults.week,
            week_number_header: cn(defaults.week_number_header, "w-[var(--calendar-cell-size)]"),
            week_number: cn(defaults.week_number, "h-[var(--calendar-cell-size)] text-center text-xs text-[var(--color-text-3)]"),
            day: cn(defaults.day, "relative size-[var(--calendar-cell-size)] p-0 text-center select-none"),
            today: cn(defaults.today, "[&_button]:underline [&_button]:decoration-[var(--color-accent)] [&_button]:decoration-2 [&_button]:underline-offset-4"),
            outside: cn(defaults.outside, "[&_button]:text-[var(--color-text-4)]"),
            disabled: cn(defaults.disabled, "opacity-40"),
            hidden: cn(defaults.hidden, "invisible"),
            range_start: defaults.range_start,
            range_end: defaults.range_end,
            range_middle: cn(defaults.range_middle, "bg-[var(--color-accent-soft)]"),
            footer: cn(defaults.footer, "mt-3 max-w-[calc(var(--calendar-columns)*var(--calendar-cell-size))] text-sm text-[var(--color-text-3)]"),
            ...classNames,
        }, components: {
            Root: CalendarRoot,
            Chevron: ({ className: chevronClassName, orientation, size }) => {
                const Icon = orientation === "left" ? ChevronLeft : orientation === "right" ? ChevronRight : ChevronDown;
                return _jsx(Icon, { className: cn("size-4", chevronClassName), size: size, "aria-hidden": "true" });
            },
            DayButton: DayButtonComponent,
            ...components,
        }, ...props }));
}
function CalendarRoot({ rootRef, ...props }) {
    return _jsx("div", { "data-slot": "calendar", ref: rootRef, ...props });
}
function CalendarDayButton({ className, day, modifiers, locale, ...props }) {
    const ref = React.useRef(null);
    React.useEffect(() => {
        if (modifiers.focused)
            ref.current?.focus();
    }, [modifiers.focused]);
    return (_jsx(Button, { ref: ref, type: "button", variant: "ghost", size: "ghost", "data-slot": "calendar-day-button", "data-day": day.date.toLocaleDateString(locale?.code ?? "en-US"), "data-selected-single": Boolean(modifiers.selected && !modifiers.range_start && !modifiers.range_end && !modifiers.range_middle), "data-range-start": Boolean(modifiers.range_start), "data-range-end": Boolean(modifiers.range_end), "data-range-middle": Boolean(modifiers.range_middle), className: cn("relative flex size-[var(--calendar-cell-size)] rounded-none border-transparent p-0 text-sm font-normal leading-none text-[var(--color-text-main)] focus-visible:z-10 focus-visible:ring-inset focus-visible:ring-offset-0", "data-[selected-single=true]:bg-[var(--color-ink)] data-[selected-single=true]:text-[var(--color-dark-text)]", "data-[range-start=true]:bg-[var(--color-ink)] data-[range-start=true]:text-[var(--color-dark-text)] data-[range-end=true]:bg-[var(--color-ink)] data-[range-end=true]:text-[var(--color-dark-text)]", "data-[range-middle=true]:bg-[var(--color-accent-soft)] data-[range-middle=true]:text-[var(--color-ink)]", "data-[selected-single=true]:hover:bg-[var(--color-ink-2)] data-[selected-single=true]:hover:text-[var(--color-dark-text)] data-[range-start=true]:hover:bg-[var(--color-ink-2)] data-[range-start=true]:hover:text-[var(--color-dark-text)] data-[range-end=true]:hover:bg-[var(--color-ink-2)] data-[range-end=true]:hover:text-[var(--color-dark-text)]", className), ...props }));
}
export { Calendar, CalendarDayButton };
//# sourceMappingURL=calendar.js.map