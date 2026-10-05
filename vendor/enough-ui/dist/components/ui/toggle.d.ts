import * as React from "react";
import * as TogglePrimitive from "@radix-ui/react-toggle";
import { type VariantProps } from "class-variance-authority";
declare const toggleVariants: (props?: ({
    variant?: "default" | "outline" | null | undefined;
    size?: "default" | "lg" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
type ToggleProps = React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants> & {
    /** Adds a visible ON/OFF plate. Keep enabled when the control's state is not otherwise explicit. */
    showStateIndicator?: boolean;
};
declare const Toggle: React.ForwardRefExoticComponent<Omit<TogglePrimitive.ToggleProps & React.RefAttributes<HTMLButtonElement>, "ref"> & VariantProps<(props?: ({
    variant?: "default" | "outline" | null | undefined;
    size?: "default" | "lg" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string> & {
    /** Adds a visible ON/OFF plate. Keep enabled when the control's state is not otherwise explicit. */
    showStateIndicator?: boolean;
} & React.RefAttributes<HTMLButtonElement>>;
export { Toggle, toggleVariants };
export type { ToggleProps };
//# sourceMappingURL=toggle.d.ts.map