import * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";
declare function Drawer({ direction, autoFocus, ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>): React.JSX.Element;
declare const DrawerTrigger: React.ForwardRefExoticComponent<Omit<import("@radix-ui/react-dialog").DialogTriggerProps & React.RefAttributes<HTMLButtonElement>, "ref"> & React.RefAttributes<HTMLButtonElement>>;
declare const DrawerPortal: typeof import("vaul").Portal;
declare const DrawerClose: React.ForwardRefExoticComponent<Omit<import("@radix-ui/react-dialog").DialogCloseProps & React.RefAttributes<HTMLButtonElement>, "ref"> & React.RefAttributes<HTMLButtonElement>>;
declare const DrawerHandle: React.ForwardRefExoticComponent<Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>, "ref"> & {
    preventCycle?: boolean | undefined;
} & React.RefAttributes<HTMLDivElement>>;
type DrawerSide = "top" | "right" | "bottom" | "left";
declare const DrawerOverlay: React.ForwardRefExoticComponent<Omit<Omit<import("@radix-ui/react-dialog").DialogOverlayProps & React.RefAttributes<HTMLDivElement>, "ref"> & React.RefAttributes<HTMLDivElement>, "ref"> & React.RefAttributes<HTMLDivElement>>;
interface DrawerContentProps extends React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Content> {
    /** @deprecated Set direction on Drawer to control placement and swiping. */
    side?: DrawerSide;
    showClose?: boolean;
}
declare const DrawerContent: React.ForwardRefExoticComponent<DrawerContentProps & React.RefAttributes<HTMLDivElement>>;
declare function DrawerHeader({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare namespace DrawerHeader {
    var displayName: string;
}
declare function DrawerBody({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare namespace DrawerBody {
    var displayName: string;
}
declare function DrawerFooter({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
declare namespace DrawerFooter {
    var displayName: string;
}
declare const DrawerTitle: React.ForwardRefExoticComponent<Omit<import("@radix-ui/react-dialog").DialogTitleProps & React.RefAttributes<HTMLHeadingElement>, "ref"> & React.RefAttributes<HTMLHeadingElement>>;
declare const DrawerDescription: React.ForwardRefExoticComponent<Omit<import("@radix-ui/react-dialog").DialogDescriptionProps & React.RefAttributes<HTMLParagraphElement>, "ref"> & React.RefAttributes<HTMLParagraphElement>>;
export { Drawer, DrawerPortal, DrawerOverlay, DrawerTrigger, DrawerClose, DrawerHandle, DrawerContent, DrawerHeader, DrawerBody, DrawerFooter, DrawerTitle, DrawerDescription, };
export type { DrawerContentProps, DrawerSide };
//# sourceMappingURL=drawer.d.ts.map