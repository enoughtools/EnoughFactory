import React from 'react';
export interface ToolRowProps {
    domain?: string;
    tile?: string;
    icon?: React.ReactNode;
    title: string;
    meta?: string;
    metaColor?: string;
    action?: string;
    actionAccent?: boolean;
    surface?: 'light' | 'selected' | 'dark' | 'gap' | 'transparent';
    onClick?: () => void;
    className?: string;
}
export declare function ToolRow({ domain, tile, icon, title, meta, metaColor, action, actionAccent, surface, onClick, className }: ToolRowProps): React.JSX.Element;
//# sourceMappingURL=tool-row.d.ts.map