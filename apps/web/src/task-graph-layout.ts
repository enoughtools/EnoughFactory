import type { FactoryTask } from '@enoughfactory/contracts';

export const GRAPH_CARD = { width: 232, height: 132, columnGap: 74, rowGap: 24, padding: 24, header: 38 };
export interface TaskGraphNode { task: FactoryTask; layer: number; x: number; y: number; unresolved: boolean }
export interface TaskGraphLayout {
  nodes: TaskGraphNode[]; edges: { from: string; to: string }[];
  width: number; height: number; layers: number;
  missing: { taskId: string; dependencyId: string }[]; unresolved: string[]; duplicates: string[];
}

export function criticalGraphBranches(tasks: FactoryTask[], ranks: Map<string, number>) {
  const longest = Math.max(0, ...ranks.values());
  const marked = new Set<string>(), edges = new Set<string>();
  const byId = new Map(tasks.map(task => [task.id, task]));
  const queue = tasks.filter(task => longest > 0 && ranks.get(task.id) === longest).map(task => task.id);
  while (queue.length) {
    const id = queue.shift()!;
    if (marked.has(id)) continue;
    marked.add(id);
    const task = byId.get(id)!;
    const remaining = (ranks.get(id) ?? 0) - (task.estimatedMinutes ?? 1);
    if (remaining <= 0) continue;
    for (const dependent of tasks) {
      const rank = ranks.get(dependent.id) ?? 0;
      if (dependent.dependsOn.includes(id) && rank > 0 && Math.abs(rank - remaining) < Math.max(1, longest) * 1e-9) {
        edges.add(`${id}\0${dependent.id}`);
        queue.push(dependent.id);
      }
    }
  }
  return { marked, edges, longest };
}

/** Keep malformed older catalogs inspectable without inventing their dependency order. */
export function taskGraphLayout(tasks: FactoryTask[]): TaskGraphLayout {
  const byId = new Map<string, FactoryTask>();
  const duplicates: string[] = [];
  for (const task of tasks) {
    if (byId.has(task.id)) duplicates.push(task.id);
    else byId.set(task.id, task);
  }
  const index = new Map([...byId.keys()].map((id, position) => [id, position]));
  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  const layer = new Map<string, number>();
  const missing: TaskGraphLayout['missing'] = [];
  const edges: TaskGraphLayout['edges'] = [];
  for (const task of byId.values()) {
    const valid = [...new Set(task.dependsOn)].filter(id => {
      if (byId.has(id)) return true;
      missing.push({ taskId: task.id, dependencyId: id });
      return false;
    });
    dependencies.set(task.id, valid);
    // Missing prerequisites never make a task appear independent or orderable.
    remaining.set(task.id, new Set(task.dependsOn).size);
    for (const id of valid) {
      dependents.set(id, [...(dependents.get(id) ?? []), task.id]);
      edges.push({ from: id, to: task.id });
    }
  }
  const ready = [...byId.keys()].filter(id => remaining.get(id) === 0);
  while (ready.length) {
    ready.sort((a, b) => index.get(a)! - index.get(b)!);
    const id = ready.shift()!;
    layer.set(id, Math.max(-1, ...(dependencies.get(id) ?? []).map(dependency => layer.get(dependency) ?? -1)) + 1);
    for (const dependent of dependents.get(id) ?? []) {
      remaining.set(dependent, remaining.get(dependent)! - 1);
      if (remaining.get(dependent) === 0) ready.push(dependent);
    }
  }
  const unresolved = [...byId.keys()].filter(id => !layer.has(id));
  const lastLayer = Math.max(-1, ...layer.values());
  for (const id of unresolved) layer.set(id, lastLayer + 1);
  const columns = Array.from({ length: Math.max(-1, ...layer.values()) + 1 }, () => [] as string[]);
  for (const id of byId.keys()) columns[layer.get(id)!].push(id);
  // Group each branch near its incoming edges; keep ties stable through live updates.
  const row = new Map<string, number>();
  for (const column of columns) {
    const midpoint = (id: string) => {
      const parents = (dependencies.get(id) ?? []).filter(parent => row.has(parent));
      return parents.length ? parents.reduce((sum, parent) => sum + row.get(parent)!, 0) / parents.length : index.get(id)!;
    };
    column.sort((a, b) => midpoint(a) - midpoint(b) || index.get(a)! - index.get(b)!);
    column.forEach((id, position) => row.set(id, position));
  }
  const { width, height, columnGap, rowGap, padding, header } = GRAPH_CARD;
  const longestColumn = Math.max(0, ...columns.map(column => column.length));
  const unresolvedSet = new Set(unresolved);
  return {
    nodes: [...byId.values()].map(task => ({ task, layer: layer.get(task.id)!,
      x: padding + layer.get(task.id)! * (width + columnGap),
      y: padding + header + row.get(task.id)! * (height + rowGap), unresolved: unresolvedSet.has(task.id) })),
    edges, width: Math.max(width + padding * 2, columns.length * (width + columnGap) - columnGap + padding * 2),
    height: Math.max(height + padding * 2 + header, longestColumn * (height + rowGap) - rowGap + padding * 2 + header),
    layers: columns.length, missing, unresolved, duplicates,
  };
}

/** Hide cards only after validating and ordering the complete dependency graph. */
export function hideCompletedGraphNodes(layout: TaskGraphLayout): TaskGraphLayout {
  const visible = layout.nodes.filter(node => node.task.status !== 'completed');
  const ids = new Set(visible.map(node => node.task.id));
  const layers = [...new Set(visible.map(node => node.layer))].sort((a, b) => a - b);
  const columns = layers.map(layer => visible.filter(node => node.layer === layer).sort((a, b) => a.y - b.y));
  const positions = new Map(columns.flatMap((column, index) => column.map((node, row) => [node.task.id, { column: index, row }] as const)));
  const { width, height, columnGap, rowGap, padding, header } = GRAPH_CARD;
  const longestColumn = Math.max(0, ...columns.map(column => column.length));
  return {
    ...layout,
    nodes: visible.map(node => ({ ...node,
      x: padding + positions.get(node.task.id)!.column * (width + columnGap),
      y: padding + header + positions.get(node.task.id)!.row * (height + rowGap),
    })),
    // Keep actual dependency edges; a hidden prerequisite never becomes a missing
    // reference or an invented direct link between its neighbors.
    edges: layout.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)),
    width: Math.max(width + padding * 2, columns.length * (width + columnGap) - columnGap + padding * 2),
    height: Math.max(height + padding * 2 + header, longestColumn * (height + rowGap) - rowGap + padding * 2 + header),
    layers: columns.length,
  };
}
