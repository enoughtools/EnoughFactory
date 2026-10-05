import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import type { VariantProps } from "class-variance-authority";
import { avatarVariants, avatarBadgeVariants, avatarGroupVariants, avatarGroupCountVariants, type AvatarSize, type AvatarBadgeVariant, type AvatarBadgeSize } from "../../lib/minor-presentation.js";
interface AvatarProps extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>, VariantProps<typeof avatarVariants> {
}
declare const Avatar: React.ForwardRefExoticComponent<AvatarProps & React.RefAttributes<HTMLSpanElement>>;
interface AvatarImageProps extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image> {
}
declare const AvatarImage: React.ForwardRefExoticComponent<AvatarImageProps & React.RefAttributes<HTMLImageElement>>;
interface AvatarFallbackProps extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback> {
}
declare const AvatarFallback: React.ForwardRefExoticComponent<AvatarFallbackProps & React.RefAttributes<HTMLSpanElement>>;
interface AvatarBadgeProps extends React.ComponentPropsWithoutRef<"span">, VariantProps<typeof avatarBadgeVariants> {
}
declare const AvatarBadge: React.ForwardRefExoticComponent<AvatarBadgeProps & React.RefAttributes<HTMLSpanElement>>;
interface AvatarGroupProps extends React.ComponentPropsWithoutRef<"div">, VariantProps<typeof avatarGroupVariants> {
}
declare const AvatarGroup: React.ForwardRefExoticComponent<AvatarGroupProps & React.RefAttributes<HTMLDivElement>>;
interface AvatarGroupCountProps extends React.ComponentPropsWithoutRef<"span">, VariantProps<typeof avatarGroupCountVariants> {
}
declare const AvatarGroupCount: React.ForwardRefExoticComponent<AvatarGroupCountProps & React.RefAttributes<HTMLSpanElement>>;
export { Avatar, AvatarImage, AvatarFallback, AvatarBadge, AvatarGroup, AvatarGroupCount, };
export type { AvatarProps, AvatarImageProps, AvatarFallbackProps, AvatarBadgeProps, AvatarGroupProps, AvatarGroupCountProps, AvatarSize, AvatarBadgeVariant, AvatarBadgeSize, };
//# sourceMappingURL=avatar.d.ts.map