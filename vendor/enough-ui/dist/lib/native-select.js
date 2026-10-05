import { cva } from "class-variance-authority";
export const nativeSelectContainerClassName = "relative w-full";
export const nativeSelectVariants = cva("peer w-full rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] font-sans text-[var(--color-text-main)] shadow-[var(--shadow-card)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:bg-[var(--color-paper)] disabled:opacity-50 aria-invalid:border-[var(--color-warn)] aria-invalid:ring-1 aria-invalid:ring-[var(--color-warn)] aria-[invalid=true]:border-[var(--color-warn)] aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-[var(--color-warn)]", {
    variants: {
        size: {
            default: "text-[15px]",
            sm: "text-[13px]",
        },
        isListBox: {
            true: "min-h-[80px] h-auto p-[8px]",
            false: "appearance-none",
        },
    },
    compoundVariants: [
        {
            size: "default",
            isListBox: false,
            className: "h-[41px] ps-[16px] pe-[40px] py-[8px]",
        },
        {
            size: "sm",
            isListBox: false,
            className: "h-[33px] ps-[12px] pe-[32px] py-[6px]",
        },
        {
            size: "sm",
            isListBox: true,
            className: "min-h-[70px] p-[6px]",
        },
    ],
    defaultVariants: {
        size: "default",
        isListBox: false,
    },
});
export const nativeSelectIconClassName = "pointer-events-none absolute inset-y-0 end-0 flex items-center pe-[14px] text-[var(--color-text-3)] peer-disabled:opacity-50";
export const nativeSelectIconSvgClassName = "size-4 shrink-0 text-[var(--color-text-3)]";
export const nativeSelectOptionClassName = "bg-[var(--color-surface)] text-[var(--color-text-main)] font-sans py-1";
export const nativeSelectOptGroupClassName = "bg-[var(--color-surface)] text-[var(--color-text-main)] font-sans font-semibold";
//# sourceMappingURL=native-select.js.map