import { itemVariants, itemMediaVariants } from '../../lib/variants.js';
import * as React from "react";
import { type VariantProps } from "class-variance-authority";
import { Separator } from './separator.js';
interface ItemProps extends React.ComponentProps<"div">, VariantProps<typeof itemVariants> {
    asChild?: boolean;
}
declare function Item({ className, variant, size, asChild, ...props }: ItemProps): React.JSX.Element;
declare function ItemGroup({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
interface ItemMediaProps extends React.ComponentProps<"div">, VariantProps<typeof itemMediaVariants> {
}
declare function ItemMedia({ className, variant, ...props }: ItemMediaProps): React.JSX.Element;
declare const ItemImage: typeof ItemMedia;
declare function ItemContent({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function ItemTitle({ className, ...props }: React.ComponentProps<"h3">): React.JSX.Element;
declare function ItemDescription({ className, ...props }: React.ComponentProps<"p">): React.JSX.Element;
declare function ItemActions({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare const ItemAction: typeof ItemActions;
declare function ItemHeader({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function ItemFooter({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function ItemSeparator({ className, ...props }: React.ComponentProps<typeof Separator>): React.JSX.Element;
export { Item, ItemAction, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemHeader, ItemImage, ItemMedia, ItemSeparator, ItemTitle, itemMediaVariants, itemVariants, };
//# sourceMappingURL=item.d.ts.map