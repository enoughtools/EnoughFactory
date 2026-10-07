import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopQuitController } from './desktop-lifetime.ts';

const flush = () => new Promise<void>(done => setImmediate(done));

test('repeated quit cannot bypass an accepted handoff before its independent successor is ready', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  let complete!: () => void;
  const handoff = new Promise<void>(done => { complete = done; });
  const controller = createDesktopQuitController({
    prepareQuit: () => { calls.push('stop desktop update timers'); return handoff; },
    closePreview: async () => { calls.push('close preview'); },
    quit: () => { calls.push('quit desktop'); }, exit: () => { calls.push('exit desktop'); },
  });
  context.after(() => controller.dispose());
  let prevented = 0;
  const event = { preventDefault: () => { prevented++; } };
  controller.beforeQuit(event);
  controller.beforeQuit(event);
  context.mock.timers.tick(60_000);
  await flush();
  assert.equal(prevented, 2);
  assert.deepEqual(calls, ['stop desktop update timers']);
  calls.push('independent successor ready'); complete();
  await flush();
  assert.deepEqual(calls, ['stop desktop update timers', 'independent successor ready', 'close preview', 'quit desktop']);
  controller.beforeQuit({ preventDefault: () => assert.fail('The final graceful quit must be allowed') });
  context.mock.timers.tick(5_000);
  assert.equal(calls.at(-1), 'exit desktop');
});

test('unresponsive preview and renderer cannot keep the desktop alive beyond its GUI drain', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  const controller = createDesktopQuitController({
    prepareQuit: () => undefined,
    closePreview: () => new Promise<void>(() => {}),
    quit: () => { calls.push('quit desktop'); }, exit: () => { calls.push('exit desktop'); },
  });
  context.after(() => controller.dispose());
  controller.beforeQuit({ preventDefault() {} });
  await flush();
  context.mock.timers.tick(2_999);
  await flush();
  assert.deepEqual(calls, []);
  context.mock.timers.tick(1);
  await flush();
  assert.deepEqual(calls, ['quit desktop']);
  context.mock.timers.tick(2_000);
  assert.deepEqual(calls, ['quit desktop', 'exit desktop']);
  context.mock.timers.tick(60_000);
  assert.equal(calls.length, 2);
});

test('failed handoff or preview cleanup still permits quit and actual exit clears the watchdog', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  const controller = createDesktopQuitController({
    prepareQuit: () => Promise.reject(new Error('The retained service remains connected')),
    closePreview: async () => { throw new Error('Preview service unavailable'); },
    quit: () => { calls.push('quit desktop'); controller.dispose(); },
    exit: () => { calls.push('exit desktop'); },
  });
  controller.beforeQuit({ preventDefault() {} });
  await flush();
  context.mock.timers.tick(60_000);
  assert.deepEqual(calls, ['quit desktop']);
});
