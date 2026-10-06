import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FactoryTask } from '@enoughfactory/contracts';
import { criticalGraphBranches, taskGraphLayout } from './task-graph-layout';

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
