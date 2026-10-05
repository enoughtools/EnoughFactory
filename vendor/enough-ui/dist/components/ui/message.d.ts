import * as React from "react";
export type MessageProps = React.ComponentProps<"div"> & {
    align?: "start" | "end";
};
declare function MessageGroup({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function Message({ className, align, ...props }: MessageProps): React.JSX.Element;
declare function MessageAvatar({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function MessageContent({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function MessageHeader({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare function MessageFooter({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
export { MessageGroup, Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader };
//# sourceMappingURL=message.d.ts.map