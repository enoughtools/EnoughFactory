import { isAbsolute, dirname, delimiter } from 'node:path';
import { request } from 'node:http';
import type { DockerRuntimeEndpoint } from './types.ts';

export function validateDockerEndpoint(endpoint: DockerRuntimeEndpoint): void {
  if (!endpoint.host.startsWith('unix:///') || endpoint.host.includes('\0') || !isAbsolute(endpoint.cliPath) || !isAbsolute(endpoint.configDirectory)) {
    throw new Error('EnoughFactory requires its explicitly owned Unix Docker socket, bundled CLI and private configuration directory.');
  }
}

/** Never inherit a user's Docker context, credentials, remote TLS or version override. */
export function dockerInvocation(endpoint: DockerRuntimeEndpoint, args: readonly string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  validateDockerEndpoint(endpoint);
  const env = { ...process.env };
  for (const key of ['DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION', 'DOCKER_CUSTOM_HEADERS', 'DOCKER_AUTH_CONFIG', 'BUILDKIT_HOST']) delete env[key];
  env.DOCKER_HOST = endpoint.host; env.DOCKER_CONFIG = endpoint.configDirectory;
  // Envmux uses the supported Docker Engine build API; do not require an
  // unbundled Buildx plugin because of an inherited developer preference.
  env.DOCKER_BUILDKIT = '0';
  env.PATH = `${dirname(endpoint.cliPath)}${delimiter}${env.PATH ?? ''}`;
  return { command: endpoint.cliPath, args: ['--host', endpoint.host, '--config', endpoint.configDirectory, ...args], env };
}

export async function dockerInfo(endpoint: DockerRuntimeEndpoint): Promise<{ ID: string; ServerVersion: string; DockerRootDir?: string; Labels?: string[]; Name?: string }> {
  validateDockerEndpoint(endpoint);
  return await new Promise((resolve, reject) => {
    const req = request({ socketPath: endpoint.host.slice('unix://'.length), path: '/info', timeout: 2_000 }, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(new Error('Docker runtime response exceeded its limit')); });
      response.on('end', () => { try { if (response.statusCode !== 200) throw new Error(`Owned Docker runtime returned ${response.statusCode}`); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Owned Docker runtime is unavailable'))); req.end();
  });
}
