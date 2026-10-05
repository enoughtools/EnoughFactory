import { inputGroupAddonVariants, inputGroupButtonVariants, buttonVariants } from '../../lib/variants.js';
import * as React from "react";
import { type VariantProps } from "class-variance-authority";
declare const InputGroup: React.ForwardRefExoticComponent<Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>, "ref"> & React.RefAttributes<HTMLDivElement>>;
interface InputGroupAddonProps extends React.ComponentPropsWithoutRef<"div">, VariantProps<typeof inputGroupAddonVariants> {
    asChild?: boolean;
}
declare const InputGroupAddon: React.ForwardRefExoticComponent<InputGroupAddonProps & React.RefAttributes<HTMLDivElement>>;
interface InputGroupButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof inputGroupButtonVariants> {
    asChild?: boolean;
    variant?: VariantProps<typeof buttonVariants>['variant'];
}
declare const InputGroupButton: React.ForwardRefExoticComponent<InputGroupButtonProps & React.RefAttributes<HTMLButtonElement>>;
declare const InputGroupText: React.ForwardRefExoticComponent<Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLSpanElement>, HTMLSpanElement>, "ref"> & React.RefAttributes<HTMLSpanElement>>;
declare const InputGroupInput: React.ForwardRefExoticComponent<Omit<import("./input.js").InputProps & React.RefAttributes<HTMLInputElement>, "ref"> & React.RefAttributes<HTMLInputElement>>;
declare const InputGroupTextarea: React.ForwardRefExoticComponent<Omit<import("./textarea.js").TextareaProps & React.RefAttributes<HTMLTextAreaElement>, "ref"> & React.RefAttributes<HTMLTextAreaElement>>;
export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText, InputGroupTextarea, inputGroupAddonVariants, inputGroupButtonVariants, };
//# sourceMappingURL=input-group.d.ts.map