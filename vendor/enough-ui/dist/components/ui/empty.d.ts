import { emptyMediaVariants } from '../../lib/variants.js';
import * as React from "react";
import { type VariantProps } from "class-variance-authority";
declare function Empty({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function EmptyHeader({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
type EmptyMediaProps = React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>;
declare function EmptyMedia({ className, variant, ...props }: EmptyMediaProps): React.JSX.Element;
declare const EmptyIcon: typeof EmptyMedia;
declare function EmptyTitle({ className, ...props }: React.ComponentProps<"h3">): React.JSX.Element;
declare function EmptyDescription({ className, ...props }: React.ComponentProps<"p">): React.JSX.Element;
declare function EmptyContent({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
interface EmptyActionProps extends React.ComponentProps<"div"> {
    asChild?: boolean;
}
declare function EmptyAction({ asChild, className, ...props }: EmptyActionProps): React.JSX.Element;
export { Empty, EmptyAction, EmptyContent, EmptyDescription, EmptyHeader, EmptyIcon, EmptyMedia, EmptyTitle, emptyMediaVariants, };
//# sourceMappingURL=empty.d.ts.map