import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitGraphViewport, MAX_GRAPH_ZOOM, MIN_GRAPH_ZOOM, panGraphViewport, zoomGraphViewport } from './graph-viewport';

test('pinching retains the graph point under the pointer through zoom and limits', () => {
  const before = { x: -240, y: 75, zoom: .8 };
  const anchor = { x: 460, y: 212 };
  const graphPoint = { x: (anchor.x - before.x) / before.zoom, y: (anchor.y - before.y) / before.zoom };
  for (const requested of [.01, .55, 1.4, 12]) {
    const after = zoomGraphViewport(before, anchor, requested);
    assert(Math.abs(after.x + graphPoint.x * after.zoom - anchor.x) < 1e-9);
    assert(Math.abs(after.y + graphPoint.y * after.zoom - anchor.y) < 1e-9);
    assert(after.zoom >= MIN_GRAPH_ZOOM && after.zoom <= MAX_GRAPH_ZOOM);
  }
});

test('fitting a wide or tall dependency graph centers its bounds within the viewport', () => {
  for (const content of [{ width: 2800, height: 650 }, { width: 500, height: 3000 }, { width: 400, height: 300 }]) {
    const available = { width: 1200, height: 720 };
    const view = fitGraphViewport(content, available);
    assert(view.x >= 16 && view.y >= 16);
    assert(Math.abs(view.x * 2 + content.width * view.zoom - available.width) < 1e-9);
    assert(Math.abs(view.y * 2 + content.height * view.zoom - available.height) < 1e-9);
    assert(view.zoom <= 1);
  }
});

test('two-finger pan distance remains in viewport pixels at every zoom', () => {
  for (const zoom of [.1, .5, 1, 2.5]) {
    const view = { x: -100, y: 30, zoom };
    assert.deepEqual(panGraphViewport(view, { x: 72, y: -39 }), { x: -28, y: -9, zoom });
  }
});
