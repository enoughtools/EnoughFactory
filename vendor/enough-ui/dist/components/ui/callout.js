import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { cn } from '../../lib/utils.js';
import { calloutStyles } from '../../lib/callout.js';
export function Callout({ label, tone = 'accent', className, children, ...props }) {
    return _jsxs("aside", { ...props, className: cn(calloutStyles.root, calloutStyles[tone], className), children: [_jsx("span", { className: calloutStyles.label, children: label }), _jsx("div", { className: calloutStyles.content, children: children })] });
}
//# sourceMappingURL=callout.js.map