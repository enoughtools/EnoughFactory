import { cva } from "class-variance-authority";
export const menubarRootClassName = "flex h-[41px] items-center gap-1 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] p-[4px] shadow-[var(--shadow-card)] font-sans";
export const menubarTriggerClassName = "flex cursor-default select-none items-center rounded-none px-[12px] py-[6px] text-[14px] font-medium font-sans outline-none transition-colors hover:bg-[var(--color-hover)] focus:bg-[var(--color-hover-strong)] focus:text-[var(--color-text-main)] data-[state=open]:bg-[var(--color-hover-strong)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
export const menubarContentClassName = "z-50 min-w-[12rem] max-h-[var(--radix-menubar-content-available-height,32rem)] overflow-y-auto overflow-x-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] p-[4px] font-sans text-[var(--color-text-main)] shadow-[var(--shadow-palette)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2";
export const menubarSubContentClassName = "z-50 min-w-[12rem] max-h-[var(--radix-menubar-content-available-height,32rem)] overflow-y-auto overflow-x-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] p-[4px] font-sans text-[var(--color-text-main)] shadow-[var(--shadow-card)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2";
export const menubarItemVariants = cva("relative flex cursor-pointer select-none items-center border-s-[3px] border-s-transparent py-[10px] pe-[16px] font-sans text-[15px] outline-none rounded-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50", {
    variants: {
        variant: {
            default: "text-[var(--color-text-main)] hover:bg-[var(--color-hover)] focus:border-s-[var(--color-accent)] focus:bg-[var(--color-hover-strong)]",
            destructive: "text-[var(--color-warn)] hover:bg-[var(--color-hover)] focus:border-s-[var(--color-warn)] focus:bg-[color-mix(in_srgb,var(--color-warn)_10%,var(--color-surface))]",
        },
        inset: {
            true: "ps-[29px]",
            false: "ps-[13px]",
        },
    },
    defaultVariants: {
        variant: "default",
        inset: false,
    },
});
export const menubarSubTriggerVariants = cva("flex cursor-default select-none items-center border-s-[3px] border-s-transparent py-[10px] pe-[16px] font-sans text-[15px] outline-none rounded-none transition-colors hover:bg-[var(--color-hover)] focus:border-s-[var(--color-accent)] focus:bg-[var(--color-hover-strong)] data-[state=open]:border-s-[var(--color-accent)] data-[state=open]:bg-[var(--color-accent-soft)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50", {
    variants: {
        inset: {
            true: "ps-[29px]",
            false: "ps-[13px]",
        },
    },
    defaultVariants: {
        inset: false,
    },
});
export const menubarCheckboxItemClassName = "relative flex cursor-pointer select-none items-center border-s-[3px] border-s-transparent py-[10px] ps-[29px] pe-[16px] font-sans text-[15px] outline-none rounded-none transition-colors hover:bg-[var(--color-hover)] focus:border-s-[var(--color-accent)] focus:bg-[var(--color-hover-strong)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
export const menubarRadioItemClassName = "relative flex cursor-pointer select-none items-center border-s-[3px] border-s-transparent py-[10px] ps-[29px] pe-[16px] font-sans text-[15px] outline-none rounded-none transition-colors hover:bg-[var(--color-hover)] focus:border-s-[var(--color-accent)] focus:bg-[var(--color-hover-strong)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
export const menubarLabelVariants = cva("px-[16px] py-[6px] font-sans text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-3)] rounded-none", {
    variants: {
        inset: {
            true: "ps-[32px]",
            false: "",
        },
    },
    defaultVariants: {
        inset: false,
    },
});
export const menubarSeparatorClassName = "-mx-[4px] my-[4px] h-px bg-[var(--color-hairline)]";
export const menubarShortcutClassName = "ms-auto ps-[16px] text-[11px] font-sans tracking-widest text-[var(--color-text-4)]";
//# sourceMappingURL=menubar.js.map