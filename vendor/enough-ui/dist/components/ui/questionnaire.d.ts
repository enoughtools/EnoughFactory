import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Questionnaire as QuestionnairePrimitive } from "@shadcn/react/questionnaire";
import { type ButtonProps } from "./button.js";
type QuestionnaireProps = React.ComponentProps<typeof QuestionnairePrimitive.Root> & {
    legacy?: boolean;
};
declare function Questionnaire({ className, legacy, ...props }: QuestionnaireProps): React.JSX.Element;
type QuestionnaireProgressProps = React.ComponentProps<typeof QuestionnairePrimitive.Progress> & {
    /** Compatibility with EnoughUI's original numeric progress bar. */
    value?: number;
    max?: number;
    label?: string;
};
declare function QuestionnaireProgress({ className, value, max, label, ...props }: QuestionnaireProgressProps): React.JSX.Element;
type QuestionnaireItemProps = Omit<React.ComponentProps<typeof QuestionnairePrimitive.Item>, "name"> & {
    name?: string;
};
declare function QuestionnaireItem({ className, name, ...props }: QuestionnaireItemProps): React.JSX.Element;
declare function QuestionnaireTitle({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Title>): React.JSX.Element;
declare function QuestionnaireDescription({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Description>): React.JSX.Element;
type QuestionnaireChoicesProps = React.ComponentProps<typeof QuestionnairePrimitive.Choices> & Pick<React.ComponentProps<typeof RadioGroupPrimitive.Root>, "name" | "value" | "defaultValue" | "onValueChange" | "required" | "disabled" | "orientation" | "loop">;
declare function QuestionnaireChoices({ className, name, value, defaultValue, onValueChange, required, disabled, orientation, loop, ...props }: QuestionnaireChoicesProps): React.JSX.Element;
type QuestionnaireChoiceProps = React.ComponentProps<typeof QuestionnairePrimitive.Choice> & {
    /** The legacy label prop is equivalent to children. */
    label?: React.ReactNode;
    description?: React.ReactNode;
};
declare function QuestionnaireChoice({ className, children, label, description, ...props }: QuestionnaireChoiceProps): React.JSX.Element;
declare function QuestionnaireChoiceDescription({ className, ...props }: React.ComponentProps<"span">): React.JSX.Element;
declare function QuestionnaireInput({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Input>): React.JSX.Element;
declare function QuestionnaireError({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Error>): React.JSX.Element;
declare function QuestionnaireActions({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element;
type QuestionnaireActionAppearance = {
    size?: ButtonProps["size"] | "default" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";
    variant?: ButtonProps["variant"] | "default" | "secondary" | "link";
};
declare function QuestionnairePrevious({ children, className, size, variant, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Previous> & QuestionnaireActionAppearance): React.JSX.Element;
declare function QuestionnaireSkip({ children, className, size, variant, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Skip> & QuestionnaireActionAppearance): React.JSX.Element;
declare function QuestionnaireNext({ children, className, size, variant, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Next> & QuestionnaireActionAppearance): React.JSX.Element;
declare function QuestionnaireSubmit({ children, className, size, variant, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Submit> & QuestionnaireActionAppearance): React.JSX.Element;
declare const QuestionnaireHeader: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLDivElement> & React.RefAttributes<HTMLDivElement>>;
declare const QuestionnaireEyebrow: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLParagraphElement> & React.RefAttributes<HTMLParagraphElement>>;
declare const QuestionnaireContent: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLDivElement> & React.RefAttributes<HTMLDivElement>>;
declare const QuestionnaireFooter: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLDivElement> & React.RefAttributes<HTMLDivElement>>;
declare const QuestionnaireItemLabel: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLLegendElement> & React.RefAttributes<HTMLLegendElement>>;
declare const QuestionnaireItemDescription: React.ForwardRefExoticComponent<React.HTMLAttributes<HTMLParagraphElement> & React.RefAttributes<HTMLParagraphElement>>;
export { Questionnaire, QuestionnaireActions, QuestionnaireChoice, QuestionnaireChoiceDescription, QuestionnaireChoices, QuestionnaireDescription, QuestionnaireError, QuestionnaireInput, QuestionnaireItem, QuestionnaireNext, QuestionnairePrevious, QuestionnaireProgress, QuestionnaireSkip, QuestionnaireSubmit, QuestionnaireTitle, QuestionnaireHeader, QuestionnaireEyebrow, QuestionnaireContent, QuestionnaireFooter, QuestionnaireItemLabel, QuestionnaireItemDescription, };
export type { QuestionnaireProps, QuestionnaireChoiceProps, QuestionnaireProgressProps, QuestionnaireItemProps };
//# sourceMappingURL=questionnaire.d.ts.map