import { cva } from "class-variance-authority";
// Conversation surfaces are shared by native Astro markup and React islands.
export const conversation = {
    AttachmentContent: "flex min-w-0 flex-1 flex-col gap-1 leading-tight group-data-[orientation=vertical]/attachment:w-full",
    AttachmentTitle: "block min-w-0 break-words font-sans font-semibold text-[var(--color-ink)] group-data-[state=uploading]/attachment:motion-safe:animate-pulse group-data-[state=processing]/attachment:motion-safe:animate-pulse",
    AttachmentDescription: "block min-w-0 break-words font-sans text-xs leading-5 text-[var(--color-text-3)] group-data-[state=error]/attachment:text-[var(--color-warn)]",
    AttachmentActions: "relative z-20 flex shrink-0 items-center gap-1 group-data-[orientation=vertical]/attachment:self-end",
    AttachmentTrigger: "absolute inset-0 z-10 cursor-pointer rounded-none outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] disabled:pointer-events-none disabled:opacity-50",
    AttachmentGroup: "flex min-w-0 snap-x snap-proximity scroll-px-1 gap-3 overflow-x-auto overscroll-x-contain p-1 font-sans [&>[data-slot=attachment]]:flex-none [&>[data-slot=attachment]]:snap-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] [mask-image:linear-gradient(to_right,transparent,black_4px,black_calc(100%-4px),transparent)]",
    BubbleGroup: "flex min-w-0 flex-col gap-3",
    BubbleContent: "w-fit max-w-full min-w-0 rounded-none border border-[var(--color-ink)] px-4 py-3 font-sans text-sm leading-6 break-words group-data-[align=end]/bubble:self-end [&:is(button)]:cursor-pointer [&:is(button)]:text-start [&:is(a)]:underline-offset-4 [&:is(a)]:hover:underline [&:is(button,a)]:transition-colors [&:is(button,a)]:focus-visible:outline-none [&:is(button,a)]:focus-visible:ring-2 [&:is(button,a)]:focus-visible:ring-[var(--color-accent)] [&:is(button,a)]:focus-visible:ring-offset-2 [&:is(button,a)]:focus-visible:ring-offset-[var(--color-surface)]",
    MessageGroup: "flex min-w-0 flex-col gap-4 font-sans",
    Message: "group/message relative flex w-full min-w-0 items-end gap-3 font-sans text-sm text-[var(--color-ink)] data-[align=end]:flex-row-reverse",
    MessageAvatar: "flex w-fit min-w-8 shrink-0 items-center justify-center self-end overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-paper)] group-has-[[data-slot=message-footer]]/message:mb-8",
    MessageContent: "flex w-full min-w-0 flex-col gap-2.5 break-words group-data-[align=end]/message:[&>[data-slot]]:self-end",
    MessageHeader: "flex max-w-full min-w-0 flex-wrap items-center gap-2 px-4 font-sans text-xs font-medium text-[var(--color-text-3)] group-has-[[data-variant=ghost]]/message:px-0",
    MessageFooter: "flex max-w-full min-w-0 flex-wrap items-center gap-2 px-4 font-sans text-xs font-medium text-[var(--color-text-3)] group-has-[[data-variant=ghost]]/message:px-0 group-data-[align=end]/message:justify-end",
};
export const attachmentVariants = cva("group/attachment relative flex w-fit max-w-full min-w-0 shrink-0 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] font-sans text-[var(--color-ink)] shadow-[var(--shadow-card)] focus-within:border-[var(--color-accent)] has-[>[data-slot=attachment-trigger]]:hover:bg-[var(--color-hover)] data-[state=error]:border-[var(--color-warn)] data-[state=idle]:border-dashed", {
    variants: {
        size: { default: "gap-3 p-3 text-sm", sm: "gap-2 p-2 text-xs", xs: "gap-1.5 p-1.5 text-xs" },
        orientation: { horizontal: "min-w-40 items-center", vertical: "w-40 flex-col items-start" },
    },
    defaultVariants: { size: "default", orientation: "horizontal" },
});
export const attachmentMediaVariants = cva("relative flex aspect-square w-10 shrink-0 items-center justify-center overflow-hidden rounded-none border border-[var(--color-border-mid)] bg-[var(--color-paper)] text-[var(--color-ink)] group-data-[orientation=vertical]/attachment:w-full group-data-[size=sm]/attachment:w-8 group-data-[size=xs]/attachment:w-7 group-data-[state=error]/attachment:text-[var(--color-warn)] [&_svg]:pointer-events-none [&_svg]:size-5 group-data-[orientation=vertical]/attachment:[&_svg]:size-8", { variants: { variant: { icon: "", image: "[&_img]:h-full [&_img]:w-full [&_img]:object-cover group-data-[state=uploading]/attachment:opacity-60 group-data-[state=processing]/attachment:opacity-60" } }, defaultVariants: { variant: "icon" } });
export const bubbleVariants = cva("group/bubble relative flex w-fit max-w-[80%] min-w-0 flex-col gap-1 data-[align=end]:self-end group-data-[align=end]/message:self-end has-[[data-slot=bubble-reactions][data-side=bottom]]:mb-3 has-[[data-slot=bubble-reactions][data-side=top]]:mt-3", {
    variants: {
        variant: {
            default: "[&>[data-slot=bubble-content]]:bg-[var(--color-ink)] [&>[data-slot=bubble-content]]:text-[var(--color-surface)]",
            secondary: "[&>[data-slot=bubble-content]]:bg-[var(--color-surface)] [&>[data-slot=bubble-content]]:text-[var(--color-ink)] [&>[data-slot=bubble-content]]:shadow-[var(--shadow-card)]",
            muted: "[&>[data-slot=bubble-content]]:border-[var(--color-border-mid)] [&>[data-slot=bubble-content]]:bg-[var(--color-paper)] [&>[data-slot=bubble-content]]:text-[var(--color-text-3)]",
            tinted: "[&>[data-slot=bubble-content]]:border-[var(--color-accent)] [&>[data-slot=bubble-content]]:bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-surface))] [&>[data-slot=bubble-content]]:text-[var(--color-ink)]",
            outline: "[&>[data-slot=bubble-content]]:bg-transparent [&>[data-slot=bubble-content]]:text-[var(--color-ink)]",
            ghost: "max-w-full [&>[data-slot=bubble-content]]:border-0 [&>[data-slot=bubble-content]]:bg-transparent [&>[data-slot=bubble-content]]:p-0 [&>[data-slot=bubble-content]]:text-[var(--color-ink)]",
            destructive: "[&>[data-slot=bubble-content]]:border-[var(--color-warn)] [&>[data-slot=bubble-content]]:bg-[color-mix(in_srgb,var(--color-warn)_10%,var(--color-surface))] [&>[data-slot=bubble-content]]:text-[var(--color-warn)]",
        },
    },
    defaultVariants: { variant: "default" },
});
export const bubbleReactionsVariants = cva("absolute z-10 flex w-fit items-center justify-center gap-1 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] px-2 py-0.5 font-sans text-sm text-[var(--color-ink)] shadow-[var(--shadow-card)]", { variants: { side: { top: "top-0 -translate-y-1/2", bottom: "bottom-0 translate-y-1/2" }, align: { start: "start-3", end: "end-3" } }, defaultVariants: { side: "bottom", align: "end" } });
//# sourceMappingURL=conversation.js.map