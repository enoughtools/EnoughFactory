import * as React from "react";
import { useDirection } from "@radix-ui/react-direction";
import { type Direction } from "../../lib/minor-presentation.js";
interface DirectionProviderProps {
    direction?: Direction;
    dir?: Direction;
    children?: React.ReactNode;
}
declare function DirectionProvider({ direction, dir, children, }: DirectionProviderProps): React.JSX.Element;
export { DirectionProvider, useDirection };
export type { Direction, DirectionProviderProps };
//# sourceMappingURL=direction.d.ts.map