import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceClient, DeviceRequestError } from './api';

test('a rejected factory chat preserves typed recovery details through the HTTP client', async context => {
  const details = { goalId: 'goal-fixture', taskId: 'task-fixture', attemptId: 'failed-attempt', taskStatus: 'failed', reason: 'Terminal factory attempt' };
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({ error: 'Use Retry task with instructions.', code: 'FACTORY_TASK_RETRY_REQUIRED', details }, { status: 409 });
  });
  const client = new DeviceClient({ url: 'http://factory.invalid', token: 'inert-fixture-token' });
  await assert.rejects(client.post('/api/chats/chat-fixture/messages', { text: 'Unsent feedback' }), error => {
    assert.ok(error instanceof DeviceRequestError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'FACTORY_TASK_RETRY_REQUIRED');
    assert.deepEqual(error.details, details);
    assert.equal(error.message, 'Use Retry task with instructions.');
    return true;
  });
  assert.equal(requests, 1);
});

test('ordinary plain-text service failures retain their readable message', async context => {
  context.mock.method(globalThis, 'fetch', async () => new Response('The task changed. Refresh its current attempt.', { status: 409 }));
  const client = new DeviceClient({ url: 'http://factory.invalid', token: '' });
  await assert.rejects(client.post('/api/tasks/task-fixture/retry'), error => {
    assert.ok(error instanceof DeviceRequestError);
    assert.equal(error.code, undefined);
    assert.equal(error.details, undefined);
    assert.equal(error.message, 'The task changed. Refresh its current attempt.');
    return true;
  });
});
