import { cva } from "class-variance-authority";
/**
 * Aspect Ratio presentation helpers
 */
/**
 * Normalizes an aspect ratio value identically for native Astro and React.
 * Nonpositive, nonfinite, null, or undefined values fall back to 1.
 */
export function normalizeAspectRatio(ratio) {
    if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) {
        return 1;
    }
    return ratio;
}
/**
 * Generates an inline style object for the outer aspect-ratio wrapper div.
 */
export function getAspectRatioWrapperStyle(ratio) {
    const safeRatio = normalizeAspectRatio(ratio);
    return {
        position: "relative",
        width: "100%",
        paddingBottom: `${100 / safeRatio}%`,
    };
}
/**
 * Generates an inline style string for the outer aspect-ratio wrapper div in Astro.
 */
export function getAspectRatioWrapperStyleString(ratio) {
    const safeRatio = normalizeAspectRatio(ratio);
    return `position: relative; width: 100%; padding-bottom: ${100 / safeRatio}%;`;
}
export const aspectRatioClasses = {
    wrapper: "relative w-full",
    inner: "absolute inset-0 size-full",
};
export const defaultDirection = "ltr";
/**
 * Resolves public direction prop and dir alias to a valid Direction.
 */
export function resolveDirection(direction, dir) {
    return direction ?? dir ?? defaultDirection;
}
export const avatarVariants = cva("relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-paper)] font-sans select-none align-middle has-[>[data-slot=avatar-badge]]:overflow-visible", {
    variants: {
        size: {
            default: "size-10 text-sm",
            sm: "size-8 text-xs",
            lg: "size-14 text-base",
        },
    },
    defaultVariants: {
        size: "default",
    },
});
export const avatarImageClass = "aspect-square size-full object-cover rounded-none";
export const avatarFallbackClass = "flex size-full items-center justify-center rounded-none bg-[var(--color-paper)] font-sans font-medium text-[var(--color-ink)] uppercase select-none";
export const avatarBadgeVariants = cva("absolute bottom-0 end-0 z-10 inline-flex items-center justify-center rounded-none border font-sans font-semibold uppercase leading-none shadow-[var(--shadow-card)]", {
    variants: {
        variant: {
            default: "border-[var(--color-surface)] bg-[var(--color-ink)] text-[var(--color-surface)]",
            online: "border-[var(--color-surface)] bg-[var(--color-ok)] text-white",
            destructive: "border-[var(--color-surface)] bg-[var(--color-warn)] text-white",
            outline: "border-[var(--color-ink)] bg-[var(--color-surface)] text-[var(--color-ink)]",
        },
        size: {
            default: "size-3 text-[8px]",
            sm: "size-2.5 text-[7px]",
            lg: "size-4 text-[9px]",
        },
    },
    defaultVariants: {
        variant: "default",
        size: "default",
    },
});
export const avatarGroupVariants = cva("inline-flex items-center -space-x-2.5 rtl:space-x-reverse [&>[data-slot=avatar]]:ring-2 [&>[data-slot=avatar]]:ring-[var(--color-surface)] [&>[data-slot=avatar-group-count]]:ring-2 [&>[data-slot=avatar-group-count]]:ring-[var(--color-surface)]", {
    variants: {
        size: {
            default: "-space-x-2.5",
            sm: "-space-x-2",
            lg: "-space-x-3.5",
        },
    },
    defaultVariants: {
        size: "default",
    },
});
export const avatarGroupCountVariants = cva("relative inline-flex shrink-0 items-center justify-center rounded-none border border-[var(--color-ink)] bg-[var(--color-paper)] font-sans font-semibold text-[var(--color-text-2)] shadow-[var(--shadow-card)] ring-2 ring-[var(--color-surface)] select-none", {
    variants: {
        size: {
            default: "size-10 text-xs",
            sm: "size-8 text-[11px]",
            lg: "size-14 text-sm",
        },
    },
    defaultVariants: {
        size: "default",
    },
});
//# sourceMappingURL=minor-presentation.js.map