import React from 'react';
export interface TopNavLink {
    label: string;
    href: string;
}
export interface TopNavProps {
    links?: TopNavLink[];
    active?: string;
    brand?: React.ReactNode;
    homeHref?: string;
    homeLabel?: string;
    skipToHref?: string;
    showLauncher?: boolean;
    launcherLabel?: string;
    /** Optional primary action, rendered as a link unless onCta is supplied. */
    cta?: string;
    ctaHref?: string;
    onCta?: () => void;
    onPalette?: () => void;
    className?: string;
}
export declare function TopNav({ links, active, brand, homeHref, homeLabel, skipToHref, onPalette, showLauncher, launcherLabel, cta, ctaHref, onCta, className, }: TopNavProps): React.JSX.Element;
//# sourceMappingURL=top-nav.d.ts.map