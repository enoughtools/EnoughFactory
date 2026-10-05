import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
    /** Props for the scrolling element, including its accessible name and ref. */
    viewportProps?: React.ComponentProps<typeof ScrollAreaPrimitive.Viewport>;
}
declare const ScrollArea: React.ForwardRefExoticComponent<ScrollAreaProps & React.RefAttributes<HTMLDivElement>>;
declare const ScrollBar: React.ForwardRefExoticComponent<Omit<ScrollAreaPrimitive.ScrollAreaScrollbarProps & React.RefAttributes<HTMLDivElement>, "ref"> & React.RefAttributes<HTMLDivElement>>;
export { ScrollArea, ScrollBar };
export type { ScrollAreaProps };
//# sourceMappingURL=scroll-area.d.ts.map