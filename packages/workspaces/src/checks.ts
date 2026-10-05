import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { run } from "./process.ts";
import type { CheckExecutor } from "./types.ts";

/** Commands run as root with full network/tool access inside an isolated container. */
export function dockerCheckExecutor(options: { image?: string; docker?: string } = {}): CheckExecutor {
  const metadataVolumes = new Map<string, string>();
  const execute: CheckExecutor = async (context) => {
    const name = `enough-check-${randomUUID()}`;
    const metadataVolume = metadataVolumes.get(context.path) ?? `enough-check-git-${randomUUID()}`;
    metadataVolumes.set(context.path, metadataVolume);
    const startedAt = new Date().toISOString();
    const docker = options.docker ?? "docker";
    try {
      // Git metadata is private and writable inside the check container. The host metadata is a
      // read-only seed, overlaid by this volume at /work/.git. A check can configure its own Git
      // freely without changing the metadata used by the host's post-check inspection.
      const wrapper = 'if [ ! -f /work/.git/config ]; then cp -a /input-git/. /work/.git/; fi; trap "chmod -R a+rwX /work 2>/dev/null || true" EXIT; sh -lc "$1"';
      const result = await run(docker, ["run", "--name", name, "--rm", "--label", "enoughfactory.role=check", "--mount", `type=bind,source=${resolve(context.path)},target=/work`, "--mount", `type=bind,source=${resolve(context.path, ".git")},target=/input-git,readonly`, "--mount", `type=volume,source=${metadataVolume},target=/work/.git,volume-nocopy`, "--env", "GIT_CONFIG_COUNT=1", "--env", "GIT_CONFIG_KEY_0=safe.directory", "--env", "GIT_CONFIG_VALUE_0=/work", "--workdir", "/work", options.image ?? "node:22-bookworm", "sh", "-c", wrapper, "enoughfactory-check", context.command], { timeoutMs: context.timeoutMs, signal: context.signal });
      return { command: context.command, ...result, startedAt, endedAt: new Date().toISOString() };
    } finally {
      // Killing the Docker client does not confirm container termination.
      await run(docker, ["rm", "--force", name]).catch(() => undefined);
    }
  };
  execute.release = async path => {
    const volume = metadataVolumes.get(path);
    metadataVolumes.delete(path);
    if (volume) await run(options.docker ?? "docker", ["volume", "rm", "--force", volume]);
  };
  return execute;
}
