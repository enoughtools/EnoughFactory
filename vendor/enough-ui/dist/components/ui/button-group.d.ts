import { buttonGroupVariants } from '../../lib/variants.js';
import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { type VariantProps } from "class-variance-authority";
type ButtonGroupProps = React.ComponentPropsWithoutRef<"div"> & VariantProps<typeof buttonGroupVariants>;
declare const ButtonGroup: React.ForwardRefExoticComponent<Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>, "ref"> & VariantProps<(props?: ({
    orientation?: "horizontal" | "vertical" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string> & React.RefAttributes<HTMLDivElement>>;
type ButtonGroupTextProps = React.ComponentPropsWithoutRef<"div"> & {
    asChild?: boolean;
};
declare const ButtonGroupText: React.ForwardRefExoticComponent<Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>, "ref"> & {
    asChild?: boolean;
} & React.RefAttributes<HTMLDivElement>>;
type ButtonGroupSeparatorProps = React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>;
declare const ButtonGroupSeparator: React.ForwardRefExoticComponent<Omit<SeparatorPrimitive.SeparatorProps & React.RefAttributes<HTMLDivElement>, "ref"> & React.RefAttributes<HTMLDivElement>>;
export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText, buttonGroupVariants, };
export type { ButtonGroupProps, ButtonGroupSeparatorProps, ButtonGroupTextProps };
//# sourceMappingURL=button-group.d.ts.map