import type { VariantProps } from 'class-variance-authority';
export declare const buttonVariants: (props?: ({
    variant?: "default" | "link" | "secondary" | "ink" | "accent" | "outline" | "ghost" | "destructive" | null | undefined;
    size?: "default" | "ghost" | "xs" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg" | "md" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const badgeVariants: (props?: ({
    variant?: "default" | "link" | "secondary" | "outline" | "ghost" | "destructive" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const alertVariants: (props?: ({
    variant?: "default" | "destructive" | "success" | "warning" | "info" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const typographyVariants: (props?: ({
    variant?: "h2" | "h3" | "p" | "h1" | "h4" | "small" | "lead" | "large" | "muted" | null | undefined;
    align?: "center" | "left" | "right" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const markerVariants: (props?: ({
    variant?: "default" | "separator" | "secondary" | "accent" | "outline" | "border" | null | undefined;
    size?: "lg" | "md" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const fieldVariants: (props?: ({
    orientation?: "horizontal" | "vertical" | "responsive" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const buttonGroupVariants: (props?: ({
    orientation?: "horizontal" | "vertical" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const itemVariants: (props?: ({
    variant?: "default" | "accent" | "outline" | "muted" | "plain" | null | undefined;
    size?: "default" | "xs" | "lg" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const itemMediaVariants: (props?: ({
    variant?: "default" | "image" | "lg" | "icon" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const emptyMediaVariants: (props?: ({
    variant?: "default" | "icon" | "bare" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const labelVariants: (props?: import("class-variance-authority/types").ClassProp | undefined) => string;
export declare const paginationLinkVariants: (props?: ({
    variant?: "default" | "active" | null | undefined;
    size?: "default" | "ghost" | "xs" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg" | "md" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const spinnerVariants: (props?: ({
    size?: "default" | "lg" | "sm" | "xl" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const inputGroupAddonVariants: (props?: ({
    align?: "inline-start" | "inline-end" | "block-start" | "block-end" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const inputGroupButtonVariants: (props?: ({
    size?: "xs" | "icon-xs" | "icon-sm" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare function inputGroupButtonClasses({ variant, size }?: {
    variant?: VariantProps<typeof buttonVariants>['variant'];
    size?: VariantProps<typeof inputGroupButtonVariants>['size'];
}): string;
//# sourceMappingURL=variants.d.ts.map