"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { directionIconClass, directionChevronPaths } from "../../lib/direction-icons.js";
import useEmblaCarousel from "embla-carousel-react";
import { cn } from "../../lib/utils.js";
import { Button } from "./button.js";
const CarouselContext = React.createContext(null);
function useCarousel() {
    const context = React.useContext(CarouselContext);
    if (!context) {
        throw new Error("useCarousel must be used within a <Carousel />");
    }
    return context;
}
const Carousel = React.forwardRef(({ orientation = "horizontal", opts, setApi, plugins, className, children, ...props }, ref) => {
    const [carouselRef, api] = useEmblaCarousel({
        ...opts,
        axis: orientation === "horizontal" ? "x" : "y",
    }, plugins);
    const [canScrollPrev, setCanScrollPrev] = React.useState(false);
    const [canScrollNext, setCanScrollNext] = React.useState(false);
    const [mounted, setMounted] = React.useState(false);
    const onSelect = React.useCallback((api) => {
        if (!api) {
            return;
        }
        setCanScrollPrev(api.canScrollPrev());
        setCanScrollNext(api.canScrollNext());
    }, []);
    const scrollPrev = React.useCallback(() => {
        api?.scrollPrev();
    }, [api]);
    const scrollNext = React.useCallback(() => {
        api?.scrollNext();
    }, [api]);
    const handleKeyDown = React.useCallback((event) => {
        const previousKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
        const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
        if (event.key === previousKey) {
            event.preventDefault();
            scrollPrev();
        }
        else if (event.key === nextKey) {
            event.preventDefault();
            scrollNext();
        }
    }, [orientation, scrollPrev, scrollNext]);
    React.useEffect(() => {
        if (!api || !setApi) {
            return;
        }
        setApi(api);
    }, [api, setApi]);
    React.useEffect(() => {
        if (!api) {
            return;
        }
        onSelect(api);
        setMounted(true);
        api.on("reInit", onSelect);
        api.on("select", onSelect);
        return () => {
            api.off("reInit", onSelect);
            api.off("select", onSelect);
        };
    }, [api, onSelect]);
    return (_jsx(CarouselContext.Provider, { value: {
            carouselRef,
            api: api,
            opts,
            orientation: orientation || (opts?.axis === "y" ? "vertical" : "horizontal"),
            scrollPrev,
            scrollNext,
            canScrollPrev,
            canScrollNext,
            mounted,
        }, children: _jsx("div", { ref: ref, "data-slot": "carousel", onKeyDownCapture: handleKeyDown, className: cn("relative rounded-none", className), role: "region", "aria-roledescription": "carousel", ...props, children: children }) }));
});
Carousel.displayName = "Carousel";
const CarouselContent = React.forwardRef(({ className, ...props }, ref) => {
    const { carouselRef, orientation, mounted } = useCarousel();
    return (_jsx("div", { ref: carouselRef, "data-slot": "carousel-viewport", className: "overflow-hidden rounded-none", "data-carousel-mounted": mounted ? "true" : "false", children: _jsx("div", { ref: ref, "data-slot": "carousel-content", className: cn("flex translate-x-0 translate-y-0 opacity-100 transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none", orientation === "horizontal" ? "-ml-4" : "-mt-4 flex-col", className), ...props }) }));
});
CarouselContent.displayName = "CarouselContent";
const CarouselItem = React.forwardRef(({ className, ...props }, ref) => {
    const { orientation } = useCarousel();
    return (_jsx("div", { ref: ref, "data-slot": "carousel-item", role: "group", "aria-roledescription": "slide", className: cn("min-w-0 shrink-0 grow-0 basis-full rounded-none", orientation === "horizontal" ? "pl-4" : "pt-4", className), ...props }));
});
CarouselItem.displayName = "CarouselItem";
const CarouselPrevious = React.forwardRef(({ className, variant = "outline", size = "icon-sm", ...props }, ref) => {
    const { orientation, scrollPrev, canScrollPrev } = useCarousel();
    return (_jsxs(Button, { ref: ref, "data-slot": "carousel-previous", type: "button", variant: variant, size: size, className: cn("absolute touch-manipulation shadow-[var(--shadow-palette)] disabled:cursor-not-allowed", orientation === "horizontal"
            ? "-left-12 top-1/2 -translate-y-1/2"
            : "-top-12 left-1/2 -translate-x-1/2", className), disabled: !canScrollPrev, onClick: scrollPrev, ...props, children: [_jsx("svg", { "aria-hidden": "true", focusable: "false", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className: directionIconClass, "data-direction": orientation === "horizontal" ? "left" : "up", children: _jsx("path", { d: directionChevronPaths[orientation === "horizontal" ? "left" : "up"] }) }), _jsx("span", { className: "sr-only", children: "Previous slide" })] }));
});
CarouselPrevious.displayName = "CarouselPrevious";
const CarouselNext = React.forwardRef(({ className, variant = "outline", size = "icon-sm", ...props }, ref) => {
    const { orientation, scrollNext, canScrollNext } = useCarousel();
    return (_jsxs(Button, { ref: ref, "data-slot": "carousel-next", type: "button", variant: variant, size: size, className: cn("absolute touch-manipulation shadow-[var(--shadow-palette)] disabled:cursor-not-allowed", orientation === "horizontal"
            ? "-right-12 top-1/2 -translate-y-1/2"
            : "-bottom-12 left-1/2 -translate-x-1/2", className), disabled: !canScrollNext, onClick: scrollNext, ...props, children: [_jsx("svg", { "aria-hidden": "true", focusable: "false", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className: directionIconClass, "data-direction": orientation === "horizontal" ? "right" : "down", children: _jsx("path", { d: directionChevronPaths[orientation === "horizontal" ? "right" : "down"] }) }), _jsx("span", { className: "sr-only", children: "Next slide" })] }));
});
CarouselNext.displayName = "CarouselNext";
export { useCarousel, Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext, };
//# sourceMappingURL=carousel.js.map