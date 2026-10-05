import { typographyVariants } from '../../lib/variants.js';
import * as React from "react";
import { type VariantProps } from "class-variance-authority";
interface TypographyProps extends React.ComponentPropsWithoutRef<"p">, VariantProps<typeof typographyVariants> {
    asChild?: boolean;
}
declare const Typography: React.ForwardRefExoticComponent<TypographyProps & React.RefAttributes<HTMLParagraphElement>>;
declare function TypographyH1({ className, ...props }: React.ComponentProps<"h1">): React.JSX.Element;
declare function TypographyH2({ className, ...props }: React.ComponentProps<"h2">): React.JSX.Element;
declare function TypographyH3({ className, ...props }: React.ComponentProps<"h3">): React.JSX.Element;
declare function TypographyH4({ className, ...props }: React.ComponentProps<"h4">): React.JSX.Element;
declare function TypographyP({ className, ...props }: React.ComponentProps<"p">): React.JSX.Element;
declare function TypographyLead({ className, ...props }: React.ComponentProps<"p">): React.JSX.Element;
declare function TypographyLarge({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function TypographySmall({ className, ...props }: React.ComponentProps<"small">): React.JSX.Element;
declare function TypographyMuted({ className, ...props }: React.ComponentProps<"p">): React.JSX.Element;
declare function TypographyBlockquote({ className, ...props }: React.ComponentProps<"blockquote">): React.JSX.Element;
declare function TypographyList({ className, ...props }: React.ComponentProps<"ul">): React.JSX.Element;
declare function TypographyInlineCode({ className, ...props }: React.ComponentProps<"code">): React.JSX.Element;
export { Typography, TypographyBlockquote, TypographyH1, TypographyH2, TypographyH3, TypographyH4, TypographyInlineCode, TypographyLarge, TypographyLead, TypographyList, TypographyMuted, TypographyP, TypographySmall, typographyVariants, };
export type { TypographyProps };
//# sourceMappingURL=typography.d.ts.map