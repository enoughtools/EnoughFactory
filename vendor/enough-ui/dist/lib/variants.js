// Shared appearance for native Astro components and React islands.
import { cva } from 'class-variance-authority';
import { cn } from './utils.js';
export const buttonVariants = cva("inline-flex cursor-pointer items-center justify-center gap-[8px] whitespace-nowrap rounded-none border font-sans font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] active:bg-[var(--color-active)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0", {
    variants: {
        variant: {
            default: "border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-dark-text)] hover:border-[var(--color-accent)] hover:bg-[var(--color-ink-2)] active:text-[var(--color-dark-text)]",
            secondary: "border-[var(--color-ink)] bg-[var(--color-paper)] text-[var(--color-ink)] hover:bg-[var(--color-hover-strong)]",
            link: "border-transparent bg-transparent text-[var(--color-accent)] underline-offset-4 hover:underline",
            ink: "border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-dark-text)] hover:border-[var(--color-accent)] hover:bg-[var(--color-ink-2)] active:text-[var(--color-dark-text)]",
            accent: "border-[var(--color-accent)] bg-[var(--color-accent)] text-white hover:border-[var(--color-ink)] hover:bg-[color-mix(in_srgb,var(--color-accent)_90%,var(--color-ink))] active:text-white",
            outline: "border-[var(--color-ink)] bg-[var(--color-surface)] text-[var(--color-text-2)] font-medium hover:bg-[var(--color-hover)] hover:text-[var(--color-text-main)]",
            ghost: "border-transparent bg-transparent text-[var(--color-accent)] hover:border-[var(--color-ink)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text-main)]",
            destructive: "border-[var(--color-warn)] bg-[var(--color-surface)] text-[var(--color-warn)] hover:bg-[var(--color-hover)] active:text-[var(--color-warn)]",
        },
        size: {
            default: "h-[41px] px-[20px] text-[14px]",
            xs: "h-[25px] gap-1 px-[8px] text-[11px] [&_svg]:size-3",
            lg: "h-[49px] px-[24px] text-[16px]",
            icon: "size-[41px] p-0 text-[14px]",
            "icon-xs": "size-[25px] gap-1 p-0 text-[11px] [&_svg]:size-3",
            "icon-sm": "size-[33px] p-0 text-[13px]",
            "icon-lg": "size-[49px] p-0 text-[16px] [&_svg]:size-5",
            md: "h-[41px] px-[20px] text-[14px]",
            sm: "h-[33px] px-[16px] text-[13px]",
            ghost: "h-auto p-0",
        },
    },
    defaultVariants: {
        variant: "ink",
        size: "md",
    },
});
export const badgeVariants = cva("inline-flex items-center rounded-none border border-[var(--color-ink)] px-2.5 py-0.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]", {
    variants: {
        variant: {
            default: "bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-90",
            secondary: "bg-[var(--color-surface)] text-[var(--color-ink)] hover:opacity-90",
            destructive: "bg-red-700 text-white hover:opacity-90",
            outline: "text-[var(--color-ink)]",
            ghost: "border-transparent bg-transparent text-[var(--color-ink)] hover:bg-[var(--color-paper)]",
            link: "border-transparent bg-transparent text-[var(--color-accent)] underline-offset-4 hover:underline",
        },
    },
    defaultVariants: {
        variant: "default",
    },
});
export const alertVariants = cva("relative w-full rounded-none border border-[var(--color-ink)] p-4 shadow-[var(--shadow-card)] bg-[var(--color-surface)] [&>[data-icon]]:absolute [&>[data-icon]]:left-4 [&>[data-icon]]:top-4 [&:has([data-icon])]:pl-11", {
    variants: {
        variant: {
            default: "text-[var(--color-ink)] [&>[data-icon]]:text-[var(--color-ink)]",
            destructive: "border-[var(--color-ink)] bg-red-700 text-white [&>[data-icon]]:text-white",
            success: "border-[var(--color-accent)] text-[var(--color-ink)] [&>[data-icon]]:text-[var(--color-accent)]",
            warning: "border-[var(--color-accent)] text-[var(--color-ink)] [&>[data-icon]]:text-[var(--color-accent)]",
            info: "border-[var(--color-accent)] text-[var(--color-ink)] [&>[data-icon]]:text-[var(--color-accent)]",
        },
    },
    defaultVariants: {
        variant: "default",
    },
});
export const typographyVariants = cva("text-[var(--color-ink)]", {
    variants: {
        variant: {
            // "Modern press": serif display is always weight 400; sans carries UI; see design-reference/tokens/typography.css.
            h1: "scroll-m-20 font-serif text-[36px] font-normal leading-[1.15] tracking-[-0.01em] text-balance sm:text-[44px]",
            h2: "scroll-m-20 font-serif text-[28px] font-normal leading-[1.2] text-balance sm:text-[34px]",
            h3: "scroll-m-20 font-serif text-[21px] font-normal leading-[1.25] text-balance",
            h4: "scroll-m-20 font-sans text-[16px] font-semibold leading-snug",
            p: "font-sans text-[15px] leading-[1.55] [&:not(:first-child)]:mt-4",
            lead: "font-sans text-[19px] leading-[1.55] text-[var(--color-text-2)]",
            large: "font-sans text-[18px] font-semibold leading-7",
            small: "font-sans text-[13px] font-medium leading-5",
            muted: "font-sans text-[13px] leading-[1.5] text-[var(--color-text-3)]",
        },
        align: {
            left: "text-left",
            center: "text-center",
            right: "text-right",
        },
    },
    defaultVariants: {
        variant: "p",
    },
});
export const markerVariants = cva("inline-flex items-center justify-center whitespace-nowrap rounded-none border border-[var(--color-ink)] font-sans font-semibold uppercase tracking-[0.08em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2", {
    variants: {
        variant: {
            default: "bg-[var(--color-ink)] text-[var(--color-dark-text)] shadow-[var(--shadow-palette)]",
            accent: "bg-[var(--color-accent)] text-white shadow-[8px_8px_0_var(--color-ink)]",
            secondary: "bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-card)]",
            outline: "bg-transparent text-[var(--color-ink)] shadow-[var(--shadow-palette)]",
            border: "w-full justify-start gap-2 border-0 border-b border-[var(--color-border-mid)] bg-transparent py-3 text-[var(--color-text-3)] normal-case tracking-normal shadow-none",
            separator: "flex w-full gap-4 border-0 bg-transparent text-[var(--color-text-3)] normal-case tracking-normal shadow-none before:h-px before:flex-1 before:bg-[var(--color-border-mid)] after:h-px after:flex-1 after:bg-[var(--color-border-mid)]",
        },
        size: {
            sm: "min-h-5 px-1.5 py-0.5 text-[10px]",
            md: "min-h-6 px-2 py-0.5 text-[11px]",
            lg: "min-h-7 px-2.5 py-1 text-xs",
        },
    },
    defaultVariants: {
        variant: "default",
        size: "md",
    },
});
export const fieldVariants = cva("group/field flex w-full rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)] data-[invalid=true]:border-red-500", {
    variants: {
        orientation: {
            vertical: "flex-col gap-3",
            horizontal: "flex-row items-center gap-4 [&>[data-slot=field-label]]:flex-1 [&:has(>[data-slot=field-content])]:items-start [&>[role=checkbox]]:shrink-0 [&>[role=radio]]:shrink-0 [&>input[type=checkbox]]:shrink-0 [&>input[type=radio]]:shrink-0 [&:has(>[data-slot=field-content])>[role=checkbox]]:mt-0.5 [&:has(>[data-slot=field-content])>[role=radio]]:mt-0.5 [&:has(>[data-slot=field-content])>input[type=checkbox]]:mt-0.5 [&:has(>[data-slot=field-content])>input[type=radio]]:mt-0.5",
            responsive: "flex-col gap-3 @md/field-group:flex-row @md/field-group:items-center @md/field-group:gap-4 @md/field-group:[&>[data-slot=field-label]]:flex-1 @md/field-group:[&:has(>[data-slot=field-content])]:items-start @md/field-group:[&>[role=checkbox]]:shrink-0 @md/field-group:[&>[role=radio]]:shrink-0 [&>input[type=checkbox]]:shrink-0 [&>input[type=radio]]:shrink-0 @md/field-group:[&:has(>[data-slot=field-content])>[role=checkbox]]:mt-0.5 @md/field-group:[&:has(>[data-slot=field-content])>[role=radio]]:mt-0.5 [&:has(>[data-slot=field-content])>input[type=checkbox]]:mt-0.5 [&:has(>[data-slot=field-content])>input[type=radio]]:mt-0.5",
        },
    },
    defaultVariants: {
        orientation: "vertical",
    },
});
export const buttonGroupVariants = cva("inline-flex w-fit items-stretch rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] [&>*]:relative [&>*]:rounded-none [&>*]:shadow-none [&>*:focus-visible]:z-10", {
    variants: {
        orientation: {
            horizontal: "flex-row [&>*:not(:first-child)]:border-l-0 [&>[data-slot=button-group-text]:not(:first-child)]:border-l [&>[data-slot=button-group-separator]+*]:border-l-0",
            vertical: "flex-col [&>*:not(:first-child)]:border-t-0 [&>[data-slot=button-group-text]:not(:first-child)]:border-t [&>[data-slot=button-group-separator]+*]:border-t-0",
        },
    },
    defaultVariants: {
        orientation: "horizontal",
    },
});
export const itemVariants = cva("group/item flex w-full flex-wrap items-center rounded-none border border-[var(--color-ink)] text-sm text-[var(--color-ink)] transition-[background-color,box-shadow,transform] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50", {
    variants: {
        variant: {
            default: "bg-[var(--color-surface)] shadow-[var(--shadow-card)]",
            accent: "bg-[var(--color-accent-soft)] shadow-[var(--shadow-palette)]",
            plain: "bg-transparent shadow-none",
            outline: "bg-transparent shadow-none",
            muted: "border-transparent bg-[var(--color-paper)] shadow-none",
        },
        size: {
            default: "gap-4 p-4",
            sm: "gap-3 px-3 py-2.5",
            xs: "gap-2 px-2.5 py-2",
            lg: "gap-5 p-5",
        },
    },
    defaultVariants: {
        variant: "default",
        size: "default",
    },
});
export const itemMediaVariants = cva("flex shrink-0 items-center justify-center self-start overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-paper)] text-[var(--color-ink)]", {
    variants: {
        variant: {
            default: "size-10 text-lg shadow-[var(--shadow-card)]",
            sm: "size-8 text-base shadow-none",
            lg: "size-14 text-2xl shadow-[var(--shadow-palette)]",
            icon: "size-8 text-base shadow-none [&>svg]:size-4",
            image: "size-10 text-lg shadow-none [&>img]:size-full [&>img]:object-cover",
        },
    },
    defaultVariants: {
        variant: "default",
    },
});
export const emptyMediaVariants = cva("mb-1 flex shrink-0 items-center justify-center rounded-none text-[var(--color-ink)]", {
    variants: {
        variant: {
            default: "h-14 w-14 border border-[var(--color-ink)] bg-[var(--color-accent)] text-2xl text-[var(--color-surface)] shadow-[var(--shadow-palette)]",
            bare: "h-auto w-auto border-0 bg-transparent text-3xl shadow-none",
            icon: "h-14 w-14 border border-[var(--color-ink)] bg-[var(--color-accent)] text-2xl text-[var(--color-surface)] shadow-[var(--shadow-palette)] [&>svg]:size-6",
        },
    },
    defaultVariants: {
        variant: "default",
    },
});
export const labelVariants = cva("text-[14px] font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-[var(--color-text-main)] font-sans");
export const paginationLinkVariants = cva("relative inline-flex h-11 min-w-11 cursor-pointer select-none items-center justify-center rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] px-3 font-sans text-[13px] font-semibold text-[var(--color-ink)] transition-[color,background-color,box-shadow,transform] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] aria-disabled:cursor-not-allowed aria-disabled:bg-[var(--color-paper)] aria-disabled:text-[var(--color-text-4)] aria-disabled:shadow-none aria-disabled:pointer-events-none", {
    variants: {
        variant: {
            default: "hover:z-[1] hover:-translate-x-px hover:-translate-y-px hover:bg-[var(--color-accent-soft)] hover:shadow-[3px_3px_0_var(--color-accent)] active:translate-x-0 active:translate-y-0 active:bg-[var(--color-accent)] active:text-white active:shadow-none",
            active: "z-[1] cursor-default bg-[var(--color-ink)] text-[var(--color-dark-text)] shadow-[inset_0_-3px_0_var(--color-accent)]",
        },
        size: {
            icon: "w-11 px-0",
            default: "min-w-[7rem] px-4 font-sans",
            sm: "h-[33px] min-w-[6rem] px-3 text-[13px]",
            lg: "h-[49px] min-w-[8rem] px-5 text-[16px]",
            xs: "h-[25px] min-w-[5rem] px-2 text-[11px]",
            md: "h-[41px] min-w-[7rem] px-4 text-[14px]",
            ghost: "h-auto min-w-0 p-0",
            "icon-xs": "size-[25px] min-w-[25px] px-0 text-[11px]",
            "icon-sm": "size-[33px] min-w-[33px] px-0 text-[13px]",
            "icon-lg": "size-[49px] min-w-[49px] px-0 text-[16px]",
        },
    },
    defaultVariants: {
        variant: "default",
        size: "icon",
    },
});
export const spinnerVariants = cva("inline-flex shrink-0 items-center justify-center text-[var(--color-ink)] shadow-none", {
    variants: {
        size: {
            sm: "size-5",
            default: "size-6",
            lg: "size-8",
            xl: "size-10",
        },
    },
    defaultVariants: {
        size: "default",
    },
});
export const inputGroupAddonVariants = cva("flex shrink-0 select-none items-center gap-[8px] rounded-none bg-[var(--color-paper)] px-[12px] text-[13px] font-medium text-[var(--color-text-3)] [&>svg]:size-4", {
    variants: {
        align: {
            "inline-start": "order-first border-r border-r-[var(--color-ink)]",
            "inline-end": "order-last border-l border-l-[var(--color-ink)]",
            "block-start": "order-first basis-full border-b border-b-[var(--color-ink)] px-[16px] py-[10px]",
            "block-end": "order-last basis-full border-t border-t-[var(--color-ink)] px-[16px] py-[10px]",
        },
    },
    defaultVariants: {
        align: "inline-start",
    },
});
export const inputGroupButtonVariants = cva("inline-flex shrink-0 cursor-pointer items-center justify-center gap-[6px] rounded-none border-0 bg-transparent font-sans font-semibold text-[var(--color-text-2)] transition-colors hover:bg-[var(--color-ink)] hover:text-[var(--color-dark-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50", {
    variants: {
        size: {
            xs: "h-[25px] px-[8px] text-[11px]",
            sm: "h-[31px] px-[10px] text-[12px]",
            "icon-xs": "size-[25px] px-0 text-[14px]",
            "icon-sm": "size-[31px] px-0 text-[16px]",
        },
    },
    defaultVariants: {
        size: "xs",
    },
});
export function inputGroupButtonClasses({ variant = 'ghost', size } = {}) {
    return cn(inputGroupButtonVariants({ size }), buttonVariants({ variant, size: null }));
}
//# sourceMappingURL=variants.js.map