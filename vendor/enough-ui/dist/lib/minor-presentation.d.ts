import { type VariantProps } from "class-variance-authority";
/**
 * Aspect Ratio presentation helpers
 */
/**
 * Normalizes an aspect ratio value identically for native Astro and React.
 * Nonpositive, nonfinite, null, or undefined values fall back to 1.
 */
export declare function normalizeAspectRatio(ratio?: number | null): number;
/**
 * Generates an inline style object for the outer aspect-ratio wrapper div.
 */
export declare function getAspectRatioWrapperStyle(ratio?: number | null): {
    position: "relative";
    width: "100%";
    paddingBottom: string;
};
/**
 * Generates an inline style string for the outer aspect-ratio wrapper div in Astro.
 */
export declare function getAspectRatioWrapperStyleString(ratio?: number | null): string;
export declare const aspectRatioClasses: {
    readonly wrapper: "relative w-full";
    readonly inner: "absolute inset-0 size-full";
};
/**
 * Direction presentation helpers
 */
export type Direction = "ltr" | "rtl";
export declare const defaultDirection: Direction;
/**
 * Resolves public direction prop and dir alias to a valid Direction.
 */
export declare function resolveDirection(direction?: Direction | null, dir?: Direction | null): Direction;
/**
 * Avatar presentation styles and variants
 */
export type AvatarSize = "default" | "sm" | "lg";
export type AvatarBadgeVariant = "default" | "online" | "destructive" | "outline";
export type AvatarBadgeSize = "default" | "sm" | "lg";
export declare const avatarVariants: (props?: ({
    size?: "default" | "lg" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const avatarImageClass = "aspect-square size-full object-cover rounded-none";
export declare const avatarFallbackClass = "flex size-full items-center justify-center rounded-none bg-[var(--color-paper)] font-sans font-medium text-[var(--color-ink)] uppercase select-none";
export declare const avatarBadgeVariants: (props?: ({
    variant?: "default" | "outline" | "destructive" | "online" | null | undefined;
    size?: "default" | "lg" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const avatarGroupVariants: (props?: ({
    size?: "default" | "lg" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const avatarGroupCountVariants: (props?: ({
    size?: "default" | "lg" | "sm" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export type AvatarVariantsProps = VariantProps<typeof avatarVariants>;
export type AvatarBadgeVariantsProps = VariantProps<typeof avatarBadgeVariants>;
export type AvatarGroupVariantsProps = VariantProps<typeof avatarGroupVariants>;
export type AvatarGroupCountVariantsProps = VariantProps<typeof avatarGroupCountVariants>;
//# sourceMappingURL=minor-presentation.d.ts.map