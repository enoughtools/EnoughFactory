import assert from 'node:assert/strict';
import test from 'node:test';
import { controllerError } from './factory-controller-error.ts';

test('controller recovery requires both known preparation and a transient failure', () => {
  const cases = [
    { code: 'CONTAINER_COMMAND_FAILED', message: 'curl: (56) OpenSSL unexpected EOF', agentStarted: false, recovery: 'retry' },
    { code: 'CONTAINER_COMMAND_FAILED', message: 'curl: (56) OpenSSL unexpected EOF', agentStarted: true, recovery: 'controller-retry-required' },
    { code: 'CONTAINER_COMMAND_FAILED', message: 'curl: (56) OpenSSL unexpected EOF', recovery: 'controller-retry-required' },
    { code: 'CONTAINER_COMMAND_FAILED', message: 'curl: (60) Certificate validation failed', agentStarted: false, recovery: 'controller-retry-required' },
    { code: 'CONTAINER_COMMAND_FAILED', message: 'Required file is missing', agentStarted: false, recovery: 'controller-retry-required' },
    { code: 'RUNTIME_TIMEOUT', message: 'Container command timed out', agentStarted: false, recovery: 'retry' },
    { code: 'RUNTIME_TIMEOUT', message: 'Provider acknowledgement timed out', agentStarted: true, recovery: 'controller-retry-required' },
    { code: 'RUNTIME_PAUSED', message: 'Start the runtime to continue', recovery: 'runtime-available' },
    { code: 'RUNTIME_MISSING', message: 'Provider runtime is not installed', agentStarted: false, recovery: 'runtime-configured' },
    { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to continue', recovery: 'credentials-changed' },
    { code: 'QUOTA_EXCEEDED', message: 'Provider quota exceeded', recovery: 'provider-available' },
    { code: 'AGENT_TURN_FAILED', message: 'Sign in to continue', recovery: 'controller-retry-required' },
  ];
  for (const entry of cases) {
    const error = Object.assign(new Error(entry.message), { code: entry.code, ...('agentStarted' in entry ? { agentStarted: entry.agentStarted } : {}) });
    const result = controllerError(error, { providerInvoked: true, runtimeReady: true });
    assert.equal(result.recovery, entry.recovery, `${entry.code}: ${entry.message}; started=${entry.agentStarted}`);
    assert.equal(result.message, entry.message);
    assert.equal(result.cause, error);
  }
  assert.equal(controllerError(Object.assign(new Error('Connection reset before the provider'), { code: 'ECONNRESET' }), { providerInvoked: false, runtimeReady: true }).recovery, 'retry');
  assert.equal(controllerError(new Error('The owned VM could not start'), { providerInvoked: false, runtimeReady: false }).recovery, 'runtime-available');
  assert.equal(controllerError(new Error('Unknown provider outcome'), { providerInvoked: true, runtimeReady: false }).recovery, 'controller-retry-required');
});
