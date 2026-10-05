import * as React from "react";
import { MessageScroller as MessageScrollerPrimitive, useMessageScrollerScrollable, useMessageScrollerVisibility, type MessageScrollerScrollOptions } from "@shadcn/react/message-scroller";
import { Button } from "./button.js";
/** Imperative commands share the primitive's API and honor reduced motion. */
declare function useMessageScroller(): {
    scrollToMessage: (messageId: string, options?: MessageScrollerScrollOptions) => boolean;
    scrollToEnd: (options?: MessageScrollerScrollOptions) => boolean;
    scrollToStart: (options?: MessageScrollerScrollOptions) => boolean;
};
type MessageScrollerProviderProps = React.ComponentProps<typeof MessageScrollerPrimitive.Provider>;
type MessageScrollerProps = React.ComponentProps<typeof MessageScrollerPrimitive.Root>;
type MessageScrollerViewportProps = React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>;
type MessageScrollerContentProps = React.ComponentProps<typeof MessageScrollerPrimitive.Content>;
type MessageScrollerItemProps = React.ComponentProps<typeof MessageScrollerPrimitive.Item>;
type MessageScrollerButtonProps = React.ComponentProps<typeof MessageScrollerPrimitive.Button> & Pick<React.ComponentProps<typeof Button>, "variant" | "size">;
declare function MessageScrollerProvider(props: MessageScrollerProviderProps): React.JSX.Element;
declare function MessageScroller({ className, ...props }: MessageScrollerProps): React.JSX.Element;
declare function MessageScrollerViewport({ className, ...props }: MessageScrollerViewportProps): React.JSX.Element;
declare function MessageScrollerContent({ className, ...props }: MessageScrollerContentProps): React.JSX.Element;
declare function MessageScrollerItem({ className, scrollAnchor, ...props }: MessageScrollerItemProps): React.JSX.Element;
declare function MessageScrollerButton({ direction, behavior, className, children, render, variant, size, ...props }: MessageScrollerButtonProps): React.JSX.Element;
export { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton, useMessageScroller, useMessageScrollerScrollable, useMessageScrollerVisibility, };
export type { MessageScrollerProviderProps, MessageScrollerProps, MessageScrollerViewportProps, MessageScrollerContentProps, MessageScrollerItemProps, MessageScrollerButtonProps, };
export type { MessageScrollerDefaultScrollPosition, MessageScrollerScrollAlign, MessageScrollerScrollOptions, MessageScrollerScrollable, MessageScrollerVisibilityState, } from "@shadcn/react/message-scroller";
//# sourceMappingURL=message-scroller.d.ts.map