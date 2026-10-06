import { FactoryControllerError } from '@enoughfactory/factory';

/** Classify only facts known at the adapter boundary, never a guessed provider outcome. */
export function controllerError(error: unknown, context: { providerInvoked: boolean; runtimeReady: boolean }): FactoryControllerError {
  if (error instanceof FactoryControllerError) return error;
  const failure = error instanceof Error ? error : new Error(String(error));
  const metadata = failure as Error & { code?: string; agentStarted?: boolean };
  const code = metadata.code;
  let recovery: FactoryControllerError['recovery'] = 'controller-retry-required';
  if (code === 'RUNTIME_PAUSED') recovery = 'runtime-available';
  else if (['MANAGED_RUNTIME_UNCONFIGURED', 'RUNTIME_MISSING', 'UNSUPPORTED_APPROVAL_MODE'].includes(code || '')) recovery = 'runtime-configured';
  else if (['AUTHENTICATION_REQUIRED', 'UNAUTHENTICATED', 'INVALID_CREDENTIAL'].includes(code || '')) recovery = 'credentials-changed';
  else if (['RATE_LIMITED', 'QUOTA_EXCEEDED'].includes(code || '')) recovery = 'provider-available';
  else if (metadata.agentStarted === false || !context.providerInvoked) {
    const transientCode = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'RUNTIME_TIMEOUT'].includes(code || '');
    const transientDownload = code === 'CONTAINER_COMMAND_FAILED' && /curl:\s*\((?:6|7|18|28|35|52|55|56)\)/.test(failure.message);
    if (transientCode || transientDownload) recovery = 'retry';
    else if (!context.runtimeReady) recovery = 'runtime-available';
  }
  return new FactoryControllerError(failure.message, recovery, { cause: error });
}
