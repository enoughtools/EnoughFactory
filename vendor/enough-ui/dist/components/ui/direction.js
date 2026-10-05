"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { DirectionProvider as RadixDirectionProvider, useDirection, } from "@radix-ui/react-direction";
import { resolveDirection, } from "../../lib/minor-presentation.js";
function DirectionProvider({ direction, dir, children, }) {
    const resolvedDir = resolveDirection(direction, dir);
    return (_jsx(RadixDirectionProvider, { dir: resolvedDir, children: children }));
}
export { DirectionProvider, useDirection };
//# sourceMappingURL=direction.js.map