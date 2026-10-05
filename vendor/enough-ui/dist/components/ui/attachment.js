"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { Slot } from "@radix-ui/react-slot";
import { attachmentVariants, attachmentMediaVariants, conversation } from "../../lib/conversation.js";
import { cn } from "../../lib/utils.js";
import { Button } from "./button.js";
function Attachment({ className, state = "done", size = "default", orientation = "horizontal", ...props }) {
    return _jsx("div", { "data-slot": "attachment", "data-state": state, "data-size": size, "data-orientation": orientation, "aria-busy": state === "uploading" || state === "processing" || undefined, className: cn(attachmentVariants({ size, orientation }), className), ...props });
}
function AttachmentMedia({ className, variant = "icon", ...props }) {
    return _jsx("div", { "data-slot": "attachment-media", "data-variant": variant, className: cn(attachmentMediaVariants({ variant }), className), ...props });
}
function AttachmentContent({ className, ...props }) {
    return _jsx("div", { "data-slot": "attachment-content", className: cn(conversation.AttachmentContent, className), ...props });
}
function AttachmentTitle({ className, ...props }) {
    return _jsx("span", { "data-slot": "attachment-title", className: cn(conversation.AttachmentTitle, className), ...props });
}
function AttachmentDescription({ className, ...props }) {
    return _jsx("span", { "data-slot": "attachment-description", className: cn(conversation.AttachmentDescription, className), ...props });
}
function AttachmentActions({ className, ...props }) {
    return _jsx("div", { "data-slot": "attachment-actions", className: cn(conversation.AttachmentActions, className), ...props });
}
function AttachmentAction({ className, variant = "ghost", size = "icon-xs", asChild = false, type, ...props }) {
    return _jsx(Button, { "data-slot": "attachment-action", variant: variant, size: size, asChild: asChild, type: asChild ? type : (type ?? "button"), className: className, ...props });
}
function AttachmentTrigger({ className, asChild = false, type = "button", ...props }) {
    const Comp = asChild ? Slot : "button";
    return _jsx(Comp, { "data-slot": "attachment-trigger", type: asChild ? undefined : type, className: cn(conversation.AttachmentTrigger, className), ...props });
}
function AttachmentGroup({ className, ...props }) {
    return _jsx("div", { "data-slot": "attachment-group", className: cn(conversation.AttachmentGroup, className), ...props });
}
export { Attachment, AttachmentGroup, AttachmentMedia, AttachmentContent, AttachmentTitle, AttachmentDescription, AttachmentActions, AttachmentAction, AttachmentTrigger, attachmentVariants, attachmentMediaVariants };
//# sourceMappingURL=attachment.js.map