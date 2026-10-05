import React from 'react';
export interface SearchFieldProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
    placeholder?: string;
    onActivate?: () => void;
}
/** The hero search field: 2px ink border, hard blue offset shadow, ⌘K hint. It opens the launcher, so it is a button. */
export declare function SearchField({ placeholder, onActivate, className, ...props }: SearchFieldProps): React.JSX.Element;
//# sourceMappingURL=search-field.d.ts.map