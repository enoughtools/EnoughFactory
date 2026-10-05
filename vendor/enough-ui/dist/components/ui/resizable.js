"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import * as ResizablePrimitive from "react-resizable-panels";
import { cn } from "../../lib/utils.js";
function ResizablePanelGroup({ className, ...props }) {
    return (_jsx(ResizablePrimitive.Group, { "data-slot": "resizable-panel-group", className: cn("flex h-full w-full overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] aria-[orientation=vertical]:flex-col", className), ...props }));
}
function ResizablePanel(props) {
    return _jsx(ResizablePrimitive.Panel, { "data-slot": "resizable-panel", ...props });
}
function ResizableHandle({ withHandle, className, ...props }) {
    return (_jsx(ResizablePrimitive.Separator, { "data-slot": "resizable-handle", className: cn("group relative flex w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch bg-[var(--color-surface)] outline-none transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-[var(--color-ink)] hover:bg-[var(--color-accent-soft)] focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] data-[separator=active]:bg-[var(--color-accent-soft)] aria-[orientation=horizontal]:h-3 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize aria-[orientation=horizontal]:self-auto aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:inset-y-auto aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:h-px aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=horizontal]:after:translate-x-0", className), ...props, children: withHandle && (_jsx("span", { className: "pointer-events-none z-10 flex h-4 w-3 items-center justify-center border border-[var(--color-ink)] bg-[var(--color-surface)] group-aria-[orientation=horizontal]:h-3 group-aria-[orientation=horizontal]:w-4", children: _jsx("span", { className: "h-2 w-px bg-[var(--color-ink)] group-aria-[orientation=horizontal]:h-px group-aria-[orientation=horizontal]:w-2" }) })) }));
}
export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
//# sourceMappingURL=resizable.js.map