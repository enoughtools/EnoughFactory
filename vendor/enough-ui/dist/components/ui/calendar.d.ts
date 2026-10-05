import * as React from "react";
import { DayPicker, type DayButton, type Locale } from "react-day-picker";
import { Button } from "./button.js";
type CalendarProps = React.ComponentProps<typeof DayPicker> & {
    buttonVariant?: React.ComponentProps<typeof Button>["variant"];
};
/**
 * DayPicker's complete selection and navigation API, with EnoughUI appearance.
 * In Astro, use this stateful component inside a React island with client:load.
 * Pass a stable defaultMonth and today when rendering across time zones.
 */
declare function Calendar({ className, classNames, showOutsideDays, captionLayout, buttonVariant, locale, formatters, components, ...props }: CalendarProps): React.JSX.Element;
declare function CalendarDayButton({ className, day, modifiers, locale, ...props }: React.ComponentProps<typeof DayButton> & {
    locale?: Partial<Locale>;
}): React.JSX.Element;
export { Calendar, CalendarDayButton };
export type { CalendarProps };
//# sourceMappingURL=calendar.d.ts.map