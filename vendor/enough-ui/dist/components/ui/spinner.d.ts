import { spinnerVariants } from '../../lib/variants.js';
import * as React from "react";
import { type VariantProps } from "class-variance-authority";
interface SpinnerProps extends React.ComponentPropsWithoutRef<"span">, VariantProps<typeof spinnerVariants> {
    label?: string;
}
declare const Spinner: React.ForwardRefExoticComponent<SpinnerProps & React.RefAttributes<HTMLSpanElement>>;
export { Spinner, spinnerVariants };
export type { SpinnerProps };
//# sourceMappingURL=spinner.d.ts.map