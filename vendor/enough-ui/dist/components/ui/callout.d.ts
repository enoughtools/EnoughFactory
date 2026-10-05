import * as React from 'react';
export interface CalloutProps extends React.ComponentProps<'aside'> {
    label: string;
    tone?: 'accent' | 'warn';
}
export declare function Callout({ label, tone, className, children, ...props }: CalloutProps): React.JSX.Element;
//# sourceMappingURL=callout.d.ts.map