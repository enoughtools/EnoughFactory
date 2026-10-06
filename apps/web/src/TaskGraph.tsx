import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Device, TaskOverview, TaskWorkState } from '@enoughfactory/contracts';
import { criticalPathMinutes } from '@enoughfactory/factory/scheduler';
import { Maximize, Minus, Plus } from 'lucide-react';
import { Button } from './ui';
import { GRAPH_CARD, criticalGraphBranches, taskGraphLayout } from './task-graph-layout';
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
  const [scale, setScale] = useState<number | null>(1);
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
  const fit = Math.max(.3, Math.min(1, available.width / layout.width, available.height / layout.height));
  const zoom = scale ?? fit;
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setAvailable({ width: Math.max(1, element.clientWidth - 16), height: Math.max(1, element.clientHeight - 16) }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <section className="task-graph" aria-label="Task dependency graph">
    <div className="task-graph-toolbar"><div className="task-graph-facts"><strong>{running} active / {concurrency} limit</strong><span>{ready} ready or queued</span><span>{blocked} blocked or attention</span>{critical.longest > 0 && <span title="Planner estimates; unestimated tasks count as one minute for scheduling.">Remaining path · {estimatedTime(critical.longest)} estimated</span>}{matchingIds.length !== tasks.length && <span>{matchingIds.length} matches · surrounding tasks dimmed</span>}</div><div className="task-graph-zoom"><Button size="sm" variant="ghost" aria-label="Zoom out dependency graph" disabled={zoom <= .3} onClick={() => setScale(Math.max(.3, zoom - .15))}><Minus size={13} /></Button><span>{Math.round(zoom * 100)}%</span><Button size="sm" variant="ghost" aria-label="Zoom in dependency graph" disabled={zoom >= 1.5} onClick={() => setScale(Math.min(1.5, zoom + .15))}><Plus size={13} /></Button><Button size="sm" variant="ghost" onClick={() => { setScale(null); viewport.current?.scrollTo({ top: 0, left: 0 }); }}><Maximize size={13} />Fit</Button></div></div>
    {!valid && <div className="task-graph-notice" role="status">{layout.missing.length > 0 && <span>{layout.missing.length} prerequisite references are missing. </span>}{layout.unresolved.length > 0 && <span>{layout.unresolved.length} tasks have cyclic or unresolved ordering. </span>}{layout.duplicates.length > 0 && <span>{layout.duplicates.length} duplicate task identities. </span>}Showing recorded links; critical path is unavailable.</div>}
    {!matchingIds.length && <div className="task-graph-notice" role="status">No tasks match these filters.</div>}
    <div className="task-graph-viewport" ref={viewport} tabIndex={0} aria-label="Scrollable dependency graph">
      <div className="task-graph-size" style={{ width: layout.width * zoom, height: layout.height * zoom }}><div className="task-graph-canvas" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
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
          return <button key={node.task.id} className={`task-graph-node ${selectedId === node.task.id ? 'selected' : ''} ${criticalTask ? 'critical' : ''} ${connected.has(node.task.id) ? 'connected' : ''} ${!matched.has(node.task.id) ? 'dimmed' : ''} ${working.has(item.state) ? 'working' : ''}`} style={{ left: node.x, top: node.y, width: GRAPH_CARD.width, height: GRAPH_CARD.height }} aria-pressed={selectedId === node.task.id} onClick={() => onSelect(node.task.id)} title={[node.task.title, item.reason, owner?.online === false ? `${owner.name} is offline` : undefined].filter(Boolean).join('\n')}>
            <div className="task-graph-node-state"><span className={`status-dot state-${item.state}`} /><span>{taskWorkLabels[item.state]}</span>{criticalTask && <span className="task-graph-critical-tag">Critical path</span>}</div><strong>{node.task.title}</strong><span className="task-graph-owner">{owner?.name ?? 'Unassigned'}{owner?.online === false ? ' · offline' : ''}{node.task.estimatedMinutes ? ` · ${estimatedTime(node.task.estimatedMinutes)}` : ''}</span><span className="task-graph-reason">{node.unresolved ? 'Dependency order unresolved' : item.reason ?? (node.task.dependsOn.length ? `${node.task.dependsOn.length} prerequisite${node.task.dependsOn.length === 1 ? '' : 's'}` : 'No prerequisites')}</span>
          </button>;
        })}
      </div></div>
    </div>
    <div className="task-graph-legend"><span className="critical">Critical path</span><span className="selected">Selected task links</span><span>Arrows point from prerequisite to dependent · select a task to inspect it</span></div>
  </section>;
}
