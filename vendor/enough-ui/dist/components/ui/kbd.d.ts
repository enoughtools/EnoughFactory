import * as React from "react";
interface KbdProps extends React.ComponentPropsWithoutRef<"kbd"> {
    asChild?: boolean;
}
declare const Kbd: React.ForwardRefExoticComponent<KbdProps & React.RefAttributes<HTMLElement>>;
declare const KbdGroup: React.ForwardRefExoticComponent<Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLSpanElement>, HTMLSpanElement>, "ref"> & React.RefAttributes<HTMLSpanElement>>;
export { Kbd, KbdGroup };
export type { KbdProps };
//# sourceMappingURL=kbd.d.ts.map