import { fieldVariants } from '../../lib/variants.js';
import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { type VariantProps } from "class-variance-authority";
declare const Field: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLDivElement> & VariantProps<(props?: ({
    orientation?: "horizontal" | "vertical" | "responsive" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string> & React.RefAttributes<HTMLDivElement>>;
declare const FieldSet: React.ForwardRefExoticComponent<React.FieldsetHTMLAttributes<HTMLFieldSetElement> & React.RefAttributes<HTMLFieldSetElement>>;
declare const FieldLegend: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLLegendElement> & {
    variant?: "legend" | "label";
} & React.RefAttributes<HTMLLegendElement>>;
declare const FieldGroup: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLDivElement> & React.RefAttributes<HTMLDivElement>>;
declare const FieldContent: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLDivElement> & React.RefAttributes<HTMLDivElement>>;
declare const FieldLabel: React.ForwardRefExoticComponent<Omit<LabelPrimitive.LabelProps & React.RefAttributes<HTMLLabelElement>, "ref"> & React.RefAttributes<HTMLLabelElement>>;
declare const FieldTitle: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLDivElement> & React.RefAttributes<HTMLDivElement>>;
declare const FieldDescription: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLParagraphElement> & React.RefAttributes<HTMLParagraphElement>>;
type FieldErrorItem = {
    message?: string;
} | undefined;
declare const FieldError: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLDivElement> & {
    errors?: FieldErrorItem[];
} & React.RefAttributes<HTMLDivElement>>;
declare const FieldSeparator: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLDivElement> & React.RefAttributes<HTMLDivElement>>;
export { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet, FieldTitle, fieldVariants, };
//# sourceMappingURL=field.d.ts.map