import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
/** The original popover/command composition remains supported for existing consumers. */
declare function Combobox<Value, Multiple extends boolean | undefined = false, Item = Value>(props: ComboboxPrimitive.Root.Props<Value, Multiple, Item> & {
    legacy?: boolean;
    modal?: boolean;
}): React.JSX.Element;
declare function ComboboxValue(props: React.ComponentProps<typeof ComboboxPrimitive.Value>): React.JSX.Element;
declare function ComboboxTrigger({ className, children, asChild, ...props }: React.ComponentProps<typeof ComboboxPrimitive.Trigger> & {
    asChild?: boolean;
}): React.JSX.Element;
declare function ComboboxInput({ className, children, disabled, showTrigger, showClear, onValueChange, ...props }: React.ComponentProps<typeof ComboboxPrimitive.Input> & {
    showTrigger?: boolean;
    showClear?: boolean;
    onValueChange?: (value: string) => void;
}): React.JSX.Element;
declare function ComboboxContent({ className, side, sideOffset, align, alignOffset, anchor, ...props }: React.ComponentProps<typeof ComboboxPrimitive.Popup> & Pick<ComboboxPrimitive.Positioner.Props, "side" | "align" | "sideOffset" | "alignOffset" | "anchor">): React.JSX.Element;
declare function ComboboxList({ className, ...props }: React.ComponentProps<typeof ComboboxPrimitive.List>): React.JSX.Element;
declare function ComboboxItem({ className, children, onSelect, ...props }: Omit<React.ComponentProps<typeof ComboboxPrimitive.Item>, "onSelect"> & {
    onSelect?: (value: string) => void;
}): React.JSX.Element;
declare function ComboboxGroup({ className, heading, children, ...props }: React.ComponentProps<typeof ComboboxPrimitive.Group> & {
    heading?: React.ReactNode;
}): React.JSX.Element;
declare function ComboboxLabel({ className, ...props }: React.ComponentProps<typeof ComboboxPrimitive.GroupLabel>): React.JSX.Element;
declare function ComboboxCollection(props: React.ComponentProps<typeof ComboboxPrimitive.Collection>): React.JSX.Element;
declare function ComboboxEmpty({ className, ...props }: React.ComponentProps<typeof ComboboxPrimitive.Empty>): React.JSX.Element;
declare function ComboboxSeparator({ className, ...props }: React.ComponentProps<typeof ComboboxPrimitive.Separator>): React.JSX.Element;
declare function ComboboxChips({ className, ...props }: React.ComponentProps<typeof ComboboxPrimitive.Chips>): React.JSX.Element;
declare function ComboboxChip({ className, children, showRemove, ...props }: React.ComponentProps<typeof ComboboxPrimitive.Chip> & {
    showRemove?: boolean;
}): React.JSX.Element;
declare function ComboboxChipsInput({ className, ...props }: React.ComponentProps<typeof ComboboxPrimitive.Input>): React.JSX.Element;
declare function useComboboxAnchor(): React.RefObject<HTMLDivElement | null>;
declare const ComboboxCommand: React.ForwardRefExoticComponent<Omit<{
    children?: React.ReactNode;
} & Pick<Pick<React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>, "key" | keyof React.HTMLAttributes<HTMLDivElement>> & {
    ref?: React.Ref<HTMLDivElement>;
} & {
    asChild?: boolean;
}, "key" | keyof React.HTMLAttributes<HTMLDivElement> | "asChild"> & {
    label?: string;
    shouldFilter?: boolean;
    filter?: (value: string, search: string, keywords?: string[]) => number;
    defaultValue?: string;
    value?: string;
    onValueChange?: (value: string) => void;
    loop?: boolean;
    disablePointerSelection?: boolean;
    vimBindings?: boolean;
} & React.RefAttributes<HTMLDivElement>, "ref"> & React.RefAttributes<HTMLDivElement>>;
declare const ComboboxAnchor: React.ForwardRefExoticComponent<PopoverPrimitive.PopoverAnchorProps & React.RefAttributes<HTMLDivElement>>;
declare const ComboboxPortal: React.FC<PopoverPrimitive.PopoverPortalProps>;
declare const ComboboxShortcut: {
    ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element;
    displayName: string;
};
export { Combobox, ComboboxTrigger, ComboboxAnchor, ComboboxPortal, ComboboxCommand, ComboboxInput, ComboboxContent, ComboboxList, ComboboxItem, ComboboxGroup, ComboboxLabel, ComboboxCollection, ComboboxEmpty, ComboboxSeparator, ComboboxChips, ComboboxChip, ComboboxChipsInput, ComboboxValue, ComboboxShortcut, useComboboxAnchor, };
//# sourceMappingURL=combobox.d.ts.map