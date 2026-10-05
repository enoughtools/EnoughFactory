import { type VariantProps } from "class-variance-authority";
export declare const nativeSelectContainerClassName = "relative w-full";
export declare const nativeSelectVariants: (props?: ({
    size?: "default" | "sm" | null | undefined;
    isListBox?: boolean | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export declare const nativeSelectIconClassName = "pointer-events-none absolute inset-y-0 end-0 flex items-center pe-[14px] text-[var(--color-text-3)] peer-disabled:opacity-50";
export declare const nativeSelectIconSvgClassName = "size-4 shrink-0 text-[var(--color-text-3)]";
export declare const nativeSelectOptionClassName = "bg-[var(--color-surface)] text-[var(--color-text-main)] font-sans py-1";
export declare const nativeSelectOptGroupClassName = "bg-[var(--color-surface)] text-[var(--color-text-main)] font-sans font-semibold";
export type NativeSelectVariantsProps = VariantProps<typeof nativeSelectVariants>;
//# sourceMappingURL=native-select.d.ts.map