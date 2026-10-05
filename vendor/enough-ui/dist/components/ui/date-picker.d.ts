import * as React from "react";
import { type Locale } from "date-fns";
import type { DateRange } from "react-day-picker";
import { type ButtonProps } from "./button.js";
import { type CalendarProps } from "./calendar.js";
import { PopoverContent } from "./popover.js";
type DatePickerCommonProps = {
    /** A meaningful name such as "Departure date". The current value is appended. */
    label: string;
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    name?: string;
    className?: string;
    locale?: Locale;
    dateFormat?: string;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Defaults to true for a single date and false for a range. */
    closeOnSelect?: boolean;
    triggerProps?: Omit<ButtonProps, "children" | "disabled" | "id" | "className">;
    popoverProps?: Omit<React.ComponentProps<typeof PopoverContent>, "children">;
};
type SingleDatePickerProps = DatePickerCommonProps & {
    mode?: "single";
    value?: Date;
    defaultValue?: Date;
    onValueChange?: (date: Date | undefined) => void;
    calendarProps?: Omit<Extract<CalendarProps, {
        mode: "single";
    }>, "mode" | "selected" | "onSelect" | "required">;
};
type RangeDatePickerProps = DatePickerCommonProps & {
    mode: "range";
    value?: DateRange;
    defaultValue?: DateRange;
    onValueChange?: (range: DateRange | undefined) => void;
    calendarProps?: Omit<Extract<CalendarProps, {
        mode: "range";
    }>, "mode" | "selected" | "onSelect" | "required">;
};
type DatePickerProps = SingleDatePickerProps | RangeDatePickerProps;
/** Optional convenience composition. Calendar + Popover can also be composed directly. */
declare function DatePicker(props: DatePickerProps): React.JSX.Element;
export { DatePicker };
export type { DatePickerProps, SingleDatePickerProps, RangeDatePickerProps };
//# sourceMappingURL=date-picker.d.ts.map