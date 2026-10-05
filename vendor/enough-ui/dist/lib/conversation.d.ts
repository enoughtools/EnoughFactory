export declare const conversation: {
    readonly AttachmentContent: "flex min-w-0 flex-1 flex-col gap-1 leading-tight group-data-[orientation=vertical]/attachment:w-full";
    readonly AttachmentTitle: "block min-w-0 break-words font-sans font-semibold text-[var(--color-ink)] group-data-[state=uploading]/attachment:motion-safe:animate-pulse group-data-[state=processing]/attachment:motion-safe:animate-pulse";
    readonly AttachmentDescription: "block min-w-0 break-words font-sans text-xs leading-5 text-[var(--color-text-3)] group-data-[state=error]/attachment:text-[var(--color-warn)]";
    readonly AttachmentActions: "relative z-20 flex shrink-0 items-center gap-1 group-data-[orientation=vertical]/attachment:self-end";
    readonly AttachmentTrigger: "absolute inset-0 z-10 cursor-pointer rounded-none outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] disabled:pointer-events-none disabled:opacity-50";
    readonly AttachmentGroup: "flex min-w-0 snap-x snap-proximity scroll-px-1 gap-3 overflow-x-auto overscroll-x-contain p-1 font-sans [&>[data-slot=attachment]]:flex-none [&>[data-slot=attachment]]:snap-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] [mask-image:linear-gradient(to_right,transparent,black_4px,black_calc(100%-4px),transparent)]";
    readonly BubbleGroup: "flex min-w-0 flex-col gap-3";
    readonly BubbleContent: "w-fit max-w-full min-w-0 rounded-none border border-[var(--color-ink)] px-4 py-3 font-sans text-sm leading-6 break-words group-data-[align=end]/bubble:self-end [&:is(button)]:cursor-pointer [&:is(button)]:text-start [&:is(a)]:underline-offset-4 [&:is(a)]:hover:underline [&:is(button,a)]:transition-colors [&:is(button,a)]:focus-visible:outline-none [&:is(button,a)]:focus-visible:ring-2 [&:is(button,a)]:focus-visible:ring-[var(--color-accent)] [&:is(button,a)]:focus-visible:ring-offset-2 [&:is(button,a)]:focus-visible:ring-offset-[var(--color-surface)]";
    readonly MessageGroup: "flex min-w-0 flex-col gap-4 font-sans";
    readonly Message: "group/message relative flex w-full min-w-0 items-end gap-3 font-sans text-sm text-[var(--color-ink)] data-[align=end]:flex-row-reverse";
    readonly MessageAvatar: "flex w-fit min-w-8 shrink-0 items-center justify-center self-end overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-paper)] group-has-[[data-slot=message-footer]]/message:mb-8";
    readonly MessageContent: "flex w-full min-w-0 flex-col gap-2.5 break-words group-data-[align=end]/message:[&>[data-slot]]:self-end";
    readonly MessageHeader: "flex max-w-full min-w-0 flex-wrap items-center gap-2 px-4 font-sans text-xs font-medium text-[var(--color-text-3)] group-has-[[data-variant=ghost]]/message:px-0";
    readonly MessageFooter: "flex max-w-full min-w-0 flex-wrap items-center gap-2 px-4 font-sans text-xs font-medium text-[var(--color-text-3)] group-has-[[data-variant=ghost]]/message:px-0 group-data-[align=end]/message:justify-end";
};
export declare const attachmentVariants: (props?: ({
    size?: "default" | "xs" | "sm" | null | undefined;
    orientation?: "horizontal" | "vertical" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const attachmentMediaVariants: (props?: ({
    variant?: "image" | "icon" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const bubbleVariants: (props?: ({
    variant?: "default" | "secondary" | "outline" | "ghost" | "destructive" | "muted" | "tinted" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const bubbleReactionsVariants: (props?: ({
    side?: "top" | "bottom" | null | undefined;
    align?: "start" | "end" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
//# sourceMappingURL=conversation.d.ts.map