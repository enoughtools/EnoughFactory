import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { Device, TaskOverview, TaskWorkState } from '@enoughfactory/contracts';
import { criticalPathMinutes } from '@enoughfactory/factory/scheduler';
import { Maximize, Minus, Plus } from 'lucide-react';
import { Button } from './ui';
import { GRAPH_CARD, criticalGraphBranches, taskGraphLayout } from './task-graph-layout';
import { fitGraphViewport, MAX_GRAPH_ZOOM, MIN_GRAPH_ZOOM, panGraphViewport, zoomGraphViewport } from './graph-viewport';
import type { GraphPoint, GraphViewport } from './graph-viewport';
import './task-graph.css';

export const taskWorkLabels: Record<TaskWorkState, string> = { blocked: 'Blocked', ready: 'Ready', queued: 'Queued', running: 'Running', review: 'Review', preparing: 'Preparing', executing: 'Working', capturing: 'Capturing', checking: 'Checking', integrating: 'Integrating', accepted: 'Accepted', failed: 'Failed', canceled: 'Canceled', unknown: 'Outcome unknown', waiting: 'Waiting' };
const working = new Set<TaskWorkState>(['running', 'review', 'preparing', 'executing', 'capturing', 'checking', 'integrating']);

export function estimatedTime(minutes: number) {
  return minutes < 60 ? `${Math.round(minutes)}m` : `${Math.floor(minutes / 60)}h${Math.round(minutes % 60) ? ` ${Math.round(minutes % 60)}m` : ''}`;
}

export function TaskGraph({ tasks, devices, selectedId, matchingIds, concurrency, onSelect }: {
  tasks: TaskOverview[]; devices: Device[]; selectedId?: string; matchingIds: string[]; concurrency: number; onSelect: (id: string) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const marker = useId().replaceAll(':', '');
  const [view, setView] = useState<GraphViewport>({ x: 0, y: 0, zoom: 1 });
  const [dragging, setDragging] = useState(false);
  const fitting = useRef(true);
  const pointerPositions = useRef(new Map<number, GraphPoint>());
  const drag = useRef<{ pointerId: number; origin: GraphPoint; previous: GraphPoint } | null>(null);
  const pinch = useRef<{ center: GraphPoint; distance: number } | null>(null);
  const suppressClick = useRef(false);
  const [available, setAvailable] = useState({ width: 800, height: 400 });
  const layout = useMemo(() => taskGraphLayout(tasks.map(item => item.task)), [tasks]);
  const valid = !layout.unresolved.length && !layout.missing.length && !layout.duplicates.length;
  const critical = useMemo(() => valid ? criticalGraphBranches(tasks.map(item => item.task), criticalPathMinutes(tasks.map(item => item.task))) : { marked: new Set<string>(), edges: new Set<string>(), longest: 0 }, [tasks, valid]);
  const overview = new Map(tasks.map(item => [item.task.id, item]));
  const nodes = new Map(layout.nodes.map(node => [node.task.id, node]));
  const matched = new Set(matchingIds);
  const selected = tasks.find(item => item.task.id === selectedId)?.task;
  const connected = new Set([selectedId, ...(selected?.dependsOn ?? []), ...tasks.filter(item => item.task.dependsOn.includes(selectedId ?? '')).map(item => item.task.id)]);
  const running = tasks.filter(item => working.has(item.state)).length;
  const ready = tasks.filter(item => item.state === 'ready' || item.state === 'queued').length;
  const blocked = tasks.filter(item => ['blocked', 'waiting', 'failed', 'unknown'].includes(item.state)).length;
  const zoom = view.zoom;
  const fit = useCallback(() => {
    fitting.current = true;
    setView(fitGraphViewport(layout, available));
  }, [layout.width, layout.height, available]);
  const zoomAt = useCallback((factor: number, anchor?: GraphPoint) => {
    fitting.current = false;
    setView(previous => zoomGraphViewport(previous, anchor ?? { x: available.width / 2, y: available.height / 2 }, previous.zoom * factor));
  }, [available]);
  const pan = useCallback((delta: GraphPoint) => {
    fitting.current = false;
    setView(previous => panGraphViewport(previous, delta));
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setAvailable({ width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight) }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (fitting.current) setView(fitGraphViewport(layout, available));
  }, [layout.width, layout.height, available]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        const bounds = element.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * unit * .008), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      } else pan({ x: -(event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit, y: event.shiftKey && !event.deltaX ? 0 : -event.deltaY * unit });
    };
    // Browser pinch gestures arrive as ctrl+wheel. A native, non-passive listener
    // keeps that zoom inside the graph rather than zooming the entire application.
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [pan, zoomAt]);
  const pointerPoint = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY });
  const pinchPoints = () => {
    const [a, b] = [...pointerPositions.current.values()];
    return a && b ? { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) } : null;
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' && event.button !== 0 && event.button !== 1) return;
    if (!pointerPositions.current.size) suppressClick.current = false;
    const point = pointerPoint(event);
    if (event.pointerType === 'touch') {
      pointerPositions.current.set(event.pointerId, point);
      pinch.current = pinchPoints();
      if (pinch.current) { drag.current = null; return; }
    } else if (event.button === 0 && (event.target as Element).closest('.task-graph-node')) return;
    drag.current = { pointerId: event.pointerId, origin: point, previous: point };
    if (event.pointerType !== 'touch') {
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const point = pointerPoint(event);
    if (event.pointerType === 'touch' && pointerPositions.current.has(event.pointerId)) {
      pointerPositions.current.set(event.pointerId, point);
      const nextPinch = pinchPoints(), previousPinch = pinch.current;
      if (nextPinch && previousPinch) {
        const bounds = event.currentTarget.getBoundingClientRect();
        const anchor = { x: previousPinch.center.x - bounds.left, y: previousPinch.center.y - bounds.top };
        fitting.current = false;
        setView(previous => panGraphViewport(zoomGraphViewport(previous, anchor, previous.zoom * nextPinch.distance / Math.max(1, previousPinch.distance)), { x: nextPinch.center.x - previousPinch.center.x, y: nextPinch.center.y - previousPinch.center.y }));
        pinch.current = nextPinch;
        suppressClick.current = true;
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
    }
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || (!suppressClick.current && Math.hypot(point.x - current.origin.x, point.y - current.origin.y) < 4)) return;
    pan({ x: point.x - current.previous.x, y: point.y - current.previous.y });
    current.previous = point;
    suppressClick.current = true;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    // Canceled gestures and middle-button pans do not produce a primary click.
    if (event.type === 'pointercancel' || (event.pointerType !== 'touch' && event.button !== 0)) suppressClick.current = false;
    pointerPositions.current.delete(event.pointerId);
    pinch.current = pinchPoints();
    const [remainingId, remainingPoint] = [...pointerPositions.current.entries()][0] ?? [];
    drag.current = remainingPoint ? { pointerId: remainingId, origin: remainingPoint, previous: remainingPoint } : null;
    if (!pointerPositions.current.size) setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
    const distance = event.shiftKey ? 192 : 64;
    const direction: Record<string, GraphPoint> = { ArrowLeft: { x: distance, y: 0 }, ArrowRight: { x: -distance, y: 0 }, ArrowUp: { x: 0, y: distance }, ArrowDown: { x: 0, y: -distance } };
    if (direction[event.key]) pan(direction[event.key]);
    else if (event.key === '+' || event.key === '=') zoomAt(1.2);
    else if (event.key === '-') zoomAt(1 / 1.2);
    else if (event.key === 'f' || event.key === 'F' || event.key === 'Home') fit();
    else if (event.key === '0') zoomAt(1 / view.zoom);
    else return;
    event.preventDefault();
  };
  return <section className="task-graph" aria-label="Task dependency graph">
    <div className="task-graph-toolbar"><div className="task-graph-facts"><strong>{running} active / {concurrency} limit</strong><span>{ready} ready or queued</span><span>{blocked} blocked or attention</span>{critical.longest > 0 && <span title="Planner estimates; unestimated tasks count as one minute for scheduling.">Remaining path · {estimatedTime(critical.longest)} estimated</span>}{matchingIds.length !== tasks.length && <span>{matchingIds.length} matches · surrounding tasks dimmed</span>}</div><div className="task-graph-zoom"><Button size="sm" variant="ghost" aria-label="Zoom out dependency graph" disabled={zoom <= MIN_GRAPH_ZOOM} onClick={() => zoomAt(1 / 1.2)}><Minus size={13} /></Button><span>{Math.round(zoom * 100)}%</span><Button size="sm" variant="ghost" aria-label="Zoom in dependency graph" disabled={zoom >= MAX_GRAPH_ZOOM} onClick={() => zoomAt(1.2)}><Plus size={13} /></Button><Button size="sm" variant="ghost" onClick={fit} title="Fit the whole graph (F)"><Maximize size={13} />Fit</Button></div></div>
    {!valid && <div className="task-graph-notice" role="status">{layout.missing.length > 0 && <span>{layout.missing.length} prerequisite references are missing. </span>}{layout.unresolved.length > 0 && <span>{layout.unresolved.length} tasks have cyclic or unresolved ordering. </span>}{layout.duplicates.length > 0 && <span>{layout.duplicates.length} duplicate task identities. </span>}Showing recorded links; critical path is unavailable.</div>}
    {!matchingIds.length && <div className="task-graph-notice" role="status">No tasks match these filters.</div>}
    <div className={`task-graph-viewport ${dragging ? 'is-panning' : ''}`} ref={viewport} tabIndex={0} aria-label="Task graph workspace" aria-describedby={`${marker}-help`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onKeyDown={keyboard} onClickCapture={event => { if (event.detail === 0) { suppressClick.current = false; return; } if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }} style={{ backgroundSize: `${24 * zoom}px ${24 * zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
      <div className="task-graph-canvas" style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${zoom})` }}>
        <svg className="task-graph-links" width={layout.width} height={layout.height} aria-hidden="true"><defs><marker id={`${marker}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>{layout.edges.map(edge => {
          const from = nodes.get(edge.from)!, to = nodes.get(edge.to)!;
          const startX = from.x + GRAPH_CARD.width, startY = from.y + GRAPH_CARD.height / 2;
          const endX = to.x - 6, endY = to.y + GRAPH_CARD.height / 2;
          const bend = Math.max(24, Math.abs(endX - startX) / 2);
          const criticalLink = critical.edges.has(`${edge.from}\0${edge.to}`);
          const selectedLink = edge.from === selectedId || edge.to === selectedId;
          return <path key={`${edge.from}:${edge.to}`} className={`${criticalLink ? 'critical' : ''} ${selectedLink ? 'selected' : ''} ${!matched.has(edge.from) && !matched.has(edge.to) ? 'dimmed' : ''}`} d={`M${startX},${startY} C${startX + bend},${startY} ${endX - bend},${endY} ${endX},${endY}`} markerEnd={`url(#${marker}-arrow)`} />;
        })}</svg>
        {Array.from({ length: layout.layers }, (_, layer) => <span key={layer} className="task-graph-layer" style={{ left: GRAPH_CARD.padding + layer * (GRAPH_CARD.width + GRAPH_CARD.columnGap), width: GRAPH_CARD.width }}>{layout.unresolved.length && layer === layout.layers - 1 ? 'Unresolved ordering' : layer === 0 ? 'Independent roots' : `Dependency step ${layer}`}</span>)}
        {layout.nodes.map(node => {
          const item = overview.get(node.task.id)!;
          const owner = devices.find(device => device.id === node.task.deviceId);
          const criticalTask = critical.marked.has(node.task.id);
          const stateLabel = item.state === 'canceled' && /^Replaced during (replanning|goal steering)\./.test(item.reason ?? '') ? 'Superseded' : taskWorkLabels[item.state];
          return <button key={node.task.id} className={`task-graph-node ${selectedId === node.task.id ? 'selected' : ''} ${criticalTask ? 'critical' : ''} ${connected.has(node.task.id) ? 'connected' : ''} ${!matched.has(node.task.id) ? 'dimmed' : ''} ${working.has(item.state) ? 'working' : ''}`} style={{ left: node.x, top: node.y, width: GRAPH_CARD.width, height: GRAPH_CARD.height }} aria-pressed={selectedId === node.task.id} onClick={() => onSelect(node.task.id)} onFocus={event => {
            if (!event.currentTarget.matches(':focus-visible')) return;
            // Keyboard traversal must reveal focused cards even after a long pan.
            setView(previous => {
              const left = previous.x + node.x * previous.zoom, top = previous.y + node.y * previous.zoom;
              const right = left + GRAPH_CARD.width * previous.zoom, bottom = top + GRAPH_CARD.height * previous.zoom;
              const x = left < 12 ? 12 - left : right > available.width - 12 ? available.width - 12 - right : 0;
              const y = top < 12 ? 12 - top : bottom > available.height - 12 ? available.height - 12 - bottom : 0;
              if (x || y) { fitting.current = false; return panGraphViewport(previous, { x, y }); }
              return previous;
            });
          }} title={[node.task.title, item.reason, owner?.online === false ? `${owner.name} is offline` : undefined].filter(Boolean).join('\n')}>
            <div className="task-graph-node-state"><span className={`status-dot state-${item.state}`} /><span>{stateLabel}</span>{criticalTask && <span className="task-graph-critical-tag">Critical path</span>}</div><strong>{node.task.title}</strong><span className="task-graph-owner">{owner?.name ?? 'Unassigned'}{owner?.online === false ? ' · offline' : ''}{node.task.estimatedMinutes ? ` · ${estimatedTime(node.task.estimatedMinutes)}` : ''}</span><span className="task-graph-reason">{node.unresolved ? 'Dependency order unresolved' : item.reason ?? (node.task.dependsOn.length ? `${node.task.dependsOn.length} prerequisite${node.task.dependsOn.length === 1 ? '' : 's'}` : 'No prerequisites')}</span>
          </button>;
        })}
      </div>
    </div>
    <div className="task-graph-legend"><span className="critical">Critical path</span><span className="selected">Selected task links</span><span>Prerequisite → dependent</span><span className="task-graph-gesture-hint" title="Arrow keys pan. + and − zoom. F fits the graph. 0 resets to 100%.">Drag to pan · pinch to zoom</span></div>
    <p id={`${marker}-help`} className="task-graph-sr-help">Drag the background or scroll with two fingers to pan. Pinch to zoom. With this workspace focused, use arrow keys to pan, plus and minus to zoom, F to fit, or 0 for 100%. Tab through tasks and press Enter to open one.</p>
  </section>;
}
