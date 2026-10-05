import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
type SliderThumbProps = React.ComponentProps<typeof SliderPrimitive.Thumb>;
interface SliderProps extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
    /** Accessible names for individual handles, useful for minimum/maximum ranges. */
    thumbLabels?: readonly string[];
    /** Configure each handle, including its accessible value text, events, and ref. */
    thumbProps?: readonly SliderThumbProps[] | ((index: number, value: number) => SliderThumbProps);
}
declare const Slider: React.ForwardRefExoticComponent<SliderProps & React.RefAttributes<HTMLSpanElement>>;
export { Slider };
export type { SliderProps, SliderThumbProps };
//# sourceMappingURL=slider.d.ts.map