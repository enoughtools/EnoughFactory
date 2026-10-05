"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { Slot } from "@radix-ui/react-slot";
import { bubbleVariants, bubbleReactionsVariants, conversation } from "../../lib/conversation.js";
import { cn } from "../../lib/utils.js";
function BubbleGroup({ className, ...props }) {
    return _jsx("div", { "data-slot": "bubble-group", className: cn(conversation.BubbleGroup, className), ...props });
}
function Bubble({ variant = "default", align = "start", className, ...props }) {
    return _jsx("div", { "data-slot": "bubble", "data-variant": variant, "data-align": align, className: cn(bubbleVariants({ variant }), className), ...props });
}
function BubbleContent({ asChild = false, className, ...props }) {
    const Comp = asChild ? Slot : "div";
    return _jsx(Comp, { "data-slot": "bubble-content", className: cn(conversation.BubbleContent, className), ...props });
}
function BubbleReactions({ side = "bottom", align = "end", className, ...props }) {
    return _jsx("div", { "data-slot": "bubble-reactions", "data-side": side, "data-align": align, className: cn(bubbleReactionsVariants({ side, align }), className), ...props });
}
export { BubbleGroup, Bubble, BubbleContent, BubbleReactions, bubbleVariants, bubbleReactionsVariants };
//# sourceMappingURL=bubble.js.map