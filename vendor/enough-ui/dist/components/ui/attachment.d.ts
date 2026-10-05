import * as React from "react";
import type { VariantProps } from "class-variance-authority";
import { attachmentVariants, attachmentMediaVariants } from "../../lib/conversation.js";
import { type ButtonProps } from "./button.js";
export type AttachmentState = "idle" | "uploading" | "processing" | "error" | "done";
export type AttachmentProps = React.ComponentProps<"div"> & VariantProps<typeof attachmentVariants> & {
    state?: AttachmentState;
};
export type AttachmentMediaProps = React.ComponentProps<"div"> & VariantProps<typeof attachmentMediaVariants>;
export type AttachmentTriggerProps = React.ComponentProps<"button"> & {
    asChild?: boolean;
};
declare function Attachment({ className, state, size, orientation, ...props }: AttachmentProps): React.JSX.Element;
declare function AttachmentMedia({ className, variant, ...props }: AttachmentMediaProps): React.JSX.Element;
declare function AttachmentContent({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function AttachmentTitle({ className, ...props }: React.ComponentProps<"span">): React.JSX.Element;
declare function AttachmentDescription({ className, ...props }: React.ComponentProps<"span">): React.JSX.Element;
declare function AttachmentActions({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function AttachmentAction({ className, variant, size, asChild, type, ...props }: ButtonProps): React.JSX.Element;
declare function AttachmentTrigger({ className, asChild, type, ...props }: AttachmentTriggerProps): React.JSX.Element;
declare function AttachmentGroup({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
export { Attachment, AttachmentGroup, AttachmentMedia, AttachmentContent, AttachmentTitle, AttachmentDescription, AttachmentActions, AttachmentAction, AttachmentTrigger, attachmentVariants, attachmentMediaVariants };
//# sourceMappingURL=attachment.d.ts.map