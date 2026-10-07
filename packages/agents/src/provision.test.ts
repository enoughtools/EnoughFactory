import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionRuntime } from "./provision.ts";
import { quote, type SpawnProcess } from "./process.ts";
import { RUNTIME_PINS } from "./types.ts";

const dockerEndpoint = { cliPath: "/owned/docker", host: "unix:///owned/docker.sock", configDirectory: "/owned/config" };

/** Execute the actual provisioning shell in a disposable local filesystem, without Docker or downloads. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "enough-provision-test-"));
  const node = join(directory, "node"), home = join(directory, "home"), temporary = join(directory, "tmp");
  await Promise.all([mkdir(join(node, "bin"), { recursive: true }), mkdir(join(home, ".npm", "_cacache"), { recursive: true }), mkdir(join(home, ".codex"), { recursive: true }), mkdir(temporary)]);
  await writeFile(join(home, ".npm", "_cacache", "existing"), "previous cache must survive");
  await writeFile(join(home, ".codex", "continuation"), "provider state must survive");
  async function executable(name: string, contents: string) {
    await writeFile(join(node, "bin", name), `#!/bin/sh\n${contents}\n`);
    await chmod(join(node, "bin", name), 0o755);
  }
  await executable("node", "exit 0");
  await executable("setsid", "exit 0");
  await executable("codex", `if [ ! -f "$FIXTURE_ROOT/installed-version" ]; then exit 1; fi
version=$(cat "$FIXTURE_ROOT/installed-version")
if [ "$version" = broken ]; then echo 'The native optional dependency is missing' >&2; exit 127; fi
printf 'codex-cli %s\\n' "$version"`);
  await executable("npm", `cache=''
package=''
while [ "$#" -gt 0 ]; do
  case "$1" in --cache) shift; cache=$1;; @openai/codex@*) package=$1;; esac
  shift
done
test "$package" = '@openai/codex@${RUNTIME_PINS.codex}'
test -d "$cache"
case "$cache" in "$TMPDIR"/enoughfactory-npm.*) ;; *) echo 'Cache escaped the disposable directory' >&2; exit 1;; esac
printf '%s\\n' "$cache" >> "$FIXTURE_ROOT/cache-paths"
mkdir -p "$cache/_cacache"
printf 'downloaded optional package' > "$cache/_cacache/payload"
case "$FIXTURE_MODE" in
  failure) echo 'simulated package transfer failed' >&2; exit 31;;
  broken) printf broken > "$FIXTURE_ROOT/installed-version";;
  wrong-version) printf '${RUNTIME_PINS.codex}0' > "$FIXTURE_ROOT/installed-version";;
  *) printf '${RUNTIME_PINS.codex}' > "$FIXTURE_ROOT/installed-version";;
esac`);
  let mode = "success";
  const translate = (text: string) => text.replaceAll("/opt/enoughfactory/node", node).replaceAll("/opt/enoughfactory/agents", join(directory, "agents")).replaceAll("/root", home);
  const spawnProcess = ((command: string, args: readonly string[]) => {
    assert.equal(command, dockerEndpoint.cliPath);
    assert.deepEqual(args.slice(0, 4), ["--host", dockerEndpoint.host, "--config", dockerEndpoint.configDirectory]);
    const index = args.indexOf("fixture-container");
    assert.ok(index > 4, "Only the selected container may receive the command");
    const shell = args.slice(index + 1);
    assert.equal(shell[0], "sh");
    const replacements = `s|/opt/enoughfactory/node|${node}|g;s|/opt/enoughfactory/agents|${join(directory, "agents")}|g;s|/root|${home}|g`;
    const localArgs = shell[1] === "-s" ? ["-c", `sed ${quote(replacements)} | /bin/sh -s`] : shell.slice(1).map(translate);
    return spawn("/bin/sh", localArgs, { stdio: "pipe", env: { PATH: `${node}/bin:/usr/bin:/bin`, HOME: home, TMPDIR: temporary, FIXTURE_ROOT: directory, FIXTURE_MODE: mode } });
  }) as SpawnProcess;
  return {
    options: { dockerEndpoint, spawnProcess },
    setMode(value: string) { mode = value; },
    async assertPreserved() {
      assert.equal(await readFile(join(home, ".npm", "_cacache", "existing"), "utf8"), "previous cache must survive");
      assert.equal(await readFile(join(home, ".codex", "continuation"), "utf8"), "provider state must survive");
      await access(join(node, "bin", "node"));
      const paths = (await readFile(join(directory, "cache-paths"), "utf8")).trim().split("\n");
      assert.equal(new Set(paths).size, paths.length, "Every installation must receive its own cache");
      for (const path of paths) await assert.rejects(access(path), { code: "ENOENT" });
      assert.deepEqual(await readdir(temporary), [], "Failed and successful installation caches must both be gone");
      return paths;
    },
    close() { return rm(directory, { recursive: true, force: true }); },
  };
}

test("failed provider transfer and successful retry clean only their own temporary caches", async () => {
  const context = await fixture();
  try {
    context.setMode("failure");
    await assert.rejects(provisionRuntime("fixture-container", "codex", {}, context.options), /simulated package transfer failed/);
    context.setMode("success");
    const runtime = await provisionRuntime("fixture-container", "codex", {}, context.options);
    assert.equal(runtime.version, `codex-cli ${RUNTIME_PINS.codex}`);
    assert.equal(runtime.interactiveApprovals, true);
    assert.equal((await context.assertPreserved()).length, 2);
  } finally { await context.close(); }
});

test("npm success cannot hide a missing native optional dependency or a different provider version", async (t) => {
  for (const [mode, code] of [["broken", "RUNTIME_MISSING"], ["wrong-version", "RUNTIME_VERSION_MISMATCH"]]) {
    await t.test(mode!, async () => {
      const context = await fixture();
      try {
        context.setMode(mode!);
        await assert.rejects(provisionRuntime("fixture-container", "codex", {}, context.options), { code });
        assert.equal((await context.assertPreserved()).length, 1);
      } finally { await context.close(); }
    });
  }
});
