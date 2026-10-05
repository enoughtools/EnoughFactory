// Functional navigation and sort indicators use SVG geometry so they never
// depend on a platform's Unicode or emoji font rendering.
export const directionIconClass = 'size-4 shrink-0';
export const directionChevronPaths = {
    left: 'm15 18-6-6 6-6',
    right: 'm9 18 6-6-6-6',
    up: 'm18 15-6-6-6 6',
    down: 'm6 9 6 6 6-6',
};
export const sortIndicatorPaths = {
    asc: 'm8 8 4-4 4 4M12 4v16',
    desc: 'm8 16 4 4 4-4M12 4v16',
    none: 'm4 8 4-4 4 4M8 4v16m4-4 4 4 4-4M16 4v16',
};
//# sourceMappingURL=direction-icons.js.map