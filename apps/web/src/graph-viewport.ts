export interface GraphViewport { x: number; y: number; zoom: number }
export interface GraphPoint { x: number; y: number }
export interface GraphSize { width: number; height: number }

export const MIN_GRAPH_ZOOM = .1;
export const MAX_GRAPH_ZOOM = 2.5;

/** Zoom around a point in viewport pixels, keeping the graph under that point still. */
export function zoomGraphViewport(view: GraphViewport, anchor: GraphPoint, requestedZoom: number): GraphViewport {
  const zoom = Math.max(MIN_GRAPH_ZOOM, Math.min(MAX_GRAPH_ZOOM, requestedZoom));
  const ratio = zoom / view.zoom;
  return { x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio, zoom };
}

export function panGraphViewport(view: GraphViewport, delta: GraphPoint): GraphViewport {
  return { ...view, x: view.x + delta.x, y: view.y + delta.y };
}

/** Use all of the available area, with a small margin around the recorded layout. */
export function fitGraphViewport(content: GraphSize, available: GraphSize): GraphViewport {
  const zoom = Math.max(MIN_GRAPH_ZOOM, Math.min(1, (available.width - 32) / content.width, (available.height - 32) / content.height));
  return { x: (available.width - content.width * zoom) / 2, y: (available.height - content.height * zoom) / 2, zoom };
}
