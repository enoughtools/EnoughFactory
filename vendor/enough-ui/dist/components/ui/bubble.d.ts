import * as React from "react";
import type { VariantProps } from "class-variance-authority";
import { bubbleVariants, bubbleReactionsVariants } from "../../lib/conversation.js";
export type BubbleProps = React.ComponentProps<"div"> & VariantProps<typeof bubbleVariants> & {
    align?: "start" | "end";
};
export type BubbleContentProps = React.ComponentProps<"div"> & {
    asChild?: boolean;
};
export type BubbleReactionsProps = React.ComponentProps<"div"> & VariantProps<typeof bubbleReactionsVariants>;
declare function BubbleGroup({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function Bubble({ variant, align, className, ...props }: BubbleProps): React.JSX.Element;
declare function BubbleContent({ asChild, className, ...props }: BubbleContentProps): React.JSX.Element;
declare function BubbleReactions({ side, align, className, ...props }: BubbleReactionsProps): React.JSX.Element;
export { BubbleGroup, Bubble, BubbleContent, BubbleReactions, bubbleVariants, bubbleReactionsVariants };
//# sourceMappingURL=bubble.d.ts.map