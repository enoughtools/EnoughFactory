import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FactoryTask } from '@enoughfactory/contracts';
import { criticalGraphBranches, hideCompletedGraphNodes, taskGraphLayout } from './task-graph-layout';

const task = (id: string, dependsOn: string[] = []): FactoryTask => ({ id, dependsOn, goalId: 'goal', title: id, description: '', status: 'queued', createdAt: '', updatedAt: '' });

test('fork and join graph retains every dependency and places prerequisites before dependents', () => {
  const tasks = [task('integration', ['api', 'interface']), task('interface', ['contract']), task('api', ['contract']), task('contract'), task('docs')];
  const graph = taskGraphLayout(tasks);
  assert.equal(graph.nodes.length, 5);
  assert.equal(graph.layers, 3);
  assert.equal(graph.edges.length, 4);
  assert.deepEqual(graph.missing, []);
  assert.deepEqual(graph.unresolved, []);
  const nodes = new Map(graph.nodes.map(node => [node.task.id, node]));
  for (const edge of graph.edges) assert(nodes.get(edge.from)!.layer < nodes.get(edge.to)!.layer);
  assert.equal(nodes.get('api')!.layer, nodes.get('interface')!.layer);
  assert.equal(nodes.get('contract')!.layer, nodes.get('docs')!.layer);
  assert.deepEqual(taskGraphLayout(tasks), graph);
});

test('legacy missing references, cycles and duplicate identities remain inspectable', () => {
  const graph = taskGraphLayout([task('a', ['b']), task('b', ['a']), task('after-cycle', ['b']), task('missing', ['deleted']), task('missing'), task('independent')]);
  assert.equal(graph.nodes.length, 5);
  assert.deepEqual(graph.unresolved, ['a', 'b', 'after-cycle', 'missing']);
  assert.deepEqual(graph.missing, [{ taskId: 'missing', dependencyId: 'deleted' }]);
  assert.deepEqual(graph.duplicates, ['missing']);
  assert(graph.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert(graph.nodes.filter(node => node.unresolved).every(node => node.layer === graph.layers - 1));
  assert.equal(taskGraphLayout([]).layers, 0);
});

test('critical branches exclude shortcuts and retain fractional estimates', () => {
  const tasks = [{ ...task('a'), estimatedMinutes: .1 }, { ...task('b', ['a']), estimatedMinutes: .2 }, { ...task('c', ['a', 'b']), estimatedMinutes: .3 }];
  const critical = criticalGraphBranches(tasks, new Map([['a', .1 + .2 + .3], ['b', .2 + .3], ['c', .3]]));
  assert.deepEqual([...critical.marked], ['a', 'b', 'c']);
  assert.deepEqual([...critical.edges], ['a\0b', 'b\0c']);
  assert(!critical.edges.has('a\0c'));
});

test('hidden completed cards compact the graph without changing dependency order or inventing missing references', () => {
  const full = taskGraphLayout([
    { ...task('accepted-root'), status: 'completed' },
    { ...task('accepted-step', ['accepted-root']), status: 'completed' },
    task('next', ['accepted-step']), task('parallel', ['accepted-step']), task('join', ['next', 'parallel']),
    { ...task('canceled'), status: 'canceled' },
  ]);
  const before = structuredClone(full);
  const visible = hideCompletedGraphNodes(full);
  assert.deepEqual(visible.nodes.map(node => node.task.id), ['next', 'parallel', 'join', 'canceled']);
  assert.deepEqual(visible.missing, []);
  assert.deepEqual(visible.unresolved, []);
  assert.deepEqual(visible.edges, [{ from: 'next', to: 'join' }, { from: 'parallel', to: 'join' }]);
  const next = visible.nodes.find(node => node.task.id === 'next')!;
  assert.equal(next.layer, 2, 'The original dependency step must remain visible even when earlier cards are hidden.');
  assert.deepEqual(next.task.dependsOn, ['accepted-step']);
  assert.ok(visible.width < full.width);
  assert.deepEqual(full, before, 'The full graph remains available for readiness, critical-path calculations and Show completed.');
  const allHidden = hideCompletedGraphNodes(taskGraphLayout([{ ...task('done'), status: 'completed' }]));
  assert.equal(allHidden.nodes.length, 0);
  assert.equal(allHidden.layers, 0);
  assert.ok(Number.isFinite(allHidden.width) && Number.isFinite(allHidden.height));
});
