"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { Controller, FormProvider, useFormContext, useFormState, } from "react-hook-form";
import { cn } from "../../lib/utils.js";
import { Label } from "./label.js";
const Form = FormProvider;
const FormFieldContext = React.createContext(null);
const FormItemContext = React.createContext(null);
function FormField(props) {
    return (_jsx(FormFieldContext.Provider, { value: { name: props.name }, children: _jsx(Controller, { ...props }) }));
}
function useFormField() {
    const field = React.useContext(FormFieldContext);
    const item = React.useContext(FormItemContext);
    const form = useFormContext();
    if (!field)
        throw new Error("useFormField must be used within <FormField>.");
    if (!item)
        throw new Error("useFormField must be used within <FormItem>.");
    if (!form)
        throw new Error("useFormField must be used within <Form>.");
    const formState = useFormState({ control: form.control, name: field.name });
    return {
        id: item.id,
        name: field.name,
        formItemId: `${item.id}-form-item`,
        formDescriptionId: `${item.id}-form-item-description`,
        formMessageId: `${item.id}-form-item-message`,
        ...form.getFieldState(field.name, formState),
    };
}
const FormItem = React.forwardRef(({ className, ...props }, ref) => {
    const id = React.useId();
    return (_jsx(FormItemContext.Provider, { value: { id }, children: _jsx("div", { ref: ref, "data-slot": "form-item", className: cn("grid gap-2 font-sans", className), ...props }) }));
});
FormItem.displayName = "FormItem";
const FormLabel = React.forwardRef(({ className, ...props }, ref) => {
    const { error, formItemId } = useFormField();
    return (_jsx(Label, { ...props, ref: ref, "data-slot": "form-label", "data-error": Boolean(error), className: cn("data-[error=true]:text-[var(--color-warn)]", className), htmlFor: formItemId }));
});
FormLabel.displayName = "FormLabel";
const FormControl = React.forwardRef(({ children, ...props }, ref) => {
    const { error, formItemId, formDescriptionId, formMessageId } = useFormField();
    const child = React.isValidElement(children) ? children : null;
    const descriptions = [
        props["aria-describedby"],
        child?.props["aria-describedby"],
        formDescriptionId,
        error ? formMessageId : null,
    ].filter(Boolean).join(" ").split(/\s+/);
    const controlProps = {
        "data-slot": "form-control",
        id: formItemId,
        "aria-describedby": [...new Set(descriptions)].join(" "),
        "aria-invalid": error ? true : (child?.props["aria-invalid"] ?? props["aria-invalid"] ?? false),
    };
    return (_jsx(Slot, { ...props, ...controlProps, ref: ref, children: child ? React.cloneElement(child, controlProps) : children }));
});
FormControl.displayName = "FormControl";
const FormDescription = React.forwardRef(({ className, ...props }, ref) => {
    const { formDescriptionId } = useFormField();
    return _jsx("p", { ...props, ref: ref, "data-slot": "form-description", id: formDescriptionId, className: cn("font-sans text-sm leading-5 text-[var(--color-text-3)]", className) });
});
FormDescription.displayName = "FormDescription";
const FormMessage = React.forwardRef(({ className, children, ...props }, ref) => {
    const { error, formMessageId } = useFormField();
    const body = error ? String(error.message ?? "") : children;
    if (!body)
        return null;
    return (_jsx("p", { ...props, ref: ref, "data-slot": "form-message", id: formMessageId, className: cn("border-l-2 border-[var(--color-warn)] pl-2 font-sans text-sm leading-5 text-[var(--color-warn)]", className), children: body }));
});
FormMessage.displayName = "FormMessage";
export { Form, FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage, useFormField };
//# sourceMappingURL=form.js.map