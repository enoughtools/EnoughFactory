import { badgeVariants } from '../../lib/variants.js';
import * as React from "react";
import { type VariantProps } from "class-variance-authority";
interface BadgeProps extends React.ComponentPropsWithoutRef<"span">, VariantProps<typeof badgeVariants> {
    asChild?: boolean;
}
declare const Badge: React.ForwardRefExoticComponent<BadgeProps & React.RefAttributes<HTMLSpanElement>>;
export { Badge, badgeVariants };
export type { BadgeProps };
//# sourceMappingURL=badge.d.ts.map