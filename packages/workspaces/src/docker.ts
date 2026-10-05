import { dockerInvocation, type DockerRuntimeEndpoint } from "@enoughfactory/runtime";
import { run } from "./process.ts";

export type { DockerRuntimeEndpoint } from "@enoughfactory/runtime";

/** Standalone maintenance recipes use only Enough's explicit descriptor, never a user's Docker context. */
export function resolveDockerRuntime(explicit?: DockerRuntimeEndpoint): DockerRuntimeEndpoint {
  if (explicit) { dockerInvocation(explicit, []); return explicit; }
  const host = process.env.ENOUGHFACTORY_DOCKER_HOST;
  const cliPath = process.env.ENOUGHFACTORY_DOCKER_CLI;
  const configDirectory = process.env.ENOUGHFACTORY_DOCKER_CONFIG;
  if (!host || !cliPath || !configDirectory) throw new Error("EnoughFactory's managed container runtime is not configured. Start its device service before running container work.");
  const endpoint = { host, cliPath, configDirectory };
  dockerInvocation(endpoint, []);
  return endpoint;
}

export const managedDockerInvocation = dockerInvocation;

export async function runManagedDocker(endpoint: DockerRuntimeEndpoint, args: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const invocation = dockerInvocation(endpoint, args);
  return run(invocation.command, invocation.args, { ...options, env: invocation.env, inheritEnv: false });
}
