import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ArtifactStore } from "../src/artifacts.ts";
import {
  APPLE_PRODUCT_INVENTORY_SOURCE, appleCheckArtifacts, appleCheckExecutor, appleEnvironment,
  appleSandboxProfile, appleToolArguments, isAppleCheckCommand, parseAppleCheckCommand, runNativeGroup,
} from "../src/apple-checks.ts";
import type { Candidate } from "../src/types.ts";

test("Apple validation accepts a narrow data contract and rejects shell/path/option escapes", () => {
  const prefix = "enoughfactory:apple-build ";
  assert.equal(isAppleCheckCommand("swift build"), false);
  assert.deepEqual(parseAppleCheckCommand(`${prefix}{"tool":"swift","package":".","action":"test"}`), { tool: "swift", package: ".", action: "test" });
  assert.equal(parseAppleCheckCommand(`${prefix}{"tool":"xcodebuild","project":"Apps/Mail.xcodeproj","scheme":"Enough Mail","platform":"macos"}`).tool, "xcodebuild");
  for (const profile of [
    { tool: "swift", package: "../personal", action: "build" },
    { tool: "swift", package: "/Users/personal", action: "build" },
    { tool: "swift", package: ".", action: "run" },
    { tool: "swift", package: ".", action: "build", env: { HOME: "/Users/personal" } },
    { tool: "xcodebuild", project: "Mail.xcodeproj", scheme: "-allowProvisioningUpdates", platform: "macos" },
    { tool: "xcodebuild", project: "Mail.xcodeproj", scheme: "Mail", platform: "device" },
  ]) assert.throws(() => parseAppleCheckCommand(prefix + JSON.stringify(profile)));
  assert.throws(() => parseAppleCheckCommand(`${prefix}swift build; touch /outside`));
  const environment = appleEnvironment("/owned/scratch", "/Applications/Xcode.app/Contents/Developer");
  assert.equal(environment.HOME, "/owned/scratch/home");
  assert.equal(environment.SSH_AUTH_SOCK, undefined);
  assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
  const policy = appleSandboxProfile({ sources: ["/owned/check"], scratch: "/owned/scratch", developerDirectory: "/Applications/Xcode.app/Contents/Developer" });
  assert.ok(!policy.includes('(subpath "/System")'));
  assert.ok(!policy.includes("(allow mach-lookup"));
  assert.ok(!policy.includes("(allow network"));
  assert.ok(policy.includes('(deny file-write* (literal "/owned/scratch"))'));
  const args = appleToolArguments({ tool: "xcodebuild", project: "Mail.xcodeproj", scheme: "Mail", platform: "ios-simulator", configuration: "Debug" }, "/owned/check", "/owned/scratch");
  assert.ok(args.includes("iphonesimulator"));
  assert.ok(args.includes("CODE_SIGNING_ALLOWED=NO"));
  assert.ok(!args.includes("test"));
});

test("Apple product inventory refuses escaping symlinks and preserves confined framework links", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-apple-products-")));
  try {
    const application = join(root, "Mail.app");
    await mkdir(join(application, "Contents"), { recursive: true });
    await writeFile(join(application, "Contents", "binary"), "trusted fixture bytes");
    await symlink("Contents/binary", join(application, "internal-link"));
    const execute = () => runNativeGroup(process.execPath, ["--jitless", "-e", APPLE_PRODUCT_INVENTORY_SOURCE, root], { cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000 });
    const valid = await execute();
    assert.equal(valid.exitCode, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), [application]);
    await writeFile(join(root, "outside-sentinel"), "owned but outside app");
    await symlink("../outside-sentinel", join(application, "escape"));
    const refused = await execute();
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, /symlink escaping/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native cancellation kills ordinary build descendants and remains bounded", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-apple-process-")));
  try {
    const before = Date.now();
    const result = await runNativeGroup("/bin/sh", ["-c", "sleep 30 & wait"], { cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 100 });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
    assert.ok(Date.now() - before < 5_000);
    const canceled = new AbortController();
    const timer = setTimeout(() => canceled.abort(), 100);
    try {
      const handled = await runNativeGroup("/bin/sh", ["-c", "trap 'exit 0' TERM; sleep 30 & wait"], { cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000, signal: canceled.signal });
      assert.equal(handled.exitCode, 130);
      assert.match(handled.stderr, /canceled/);
    } finally { clearTimeout(timer); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fake Apple executor binds products/evidence to exact check and combined commits", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-apple-executor-")));
  const checksRoot = join(root, "checks"), integrationRoot = join(root, "integration");
  await mkdir(checksRoot); await mkdir(integrationRoot);
  const store = new ArtifactStore(join(root, "artifacts"), "test-device");
  const commits: string[] = [];
  const executor = appleCheckExecutor({ checksRoot, artifacts: store, execute: async (file, args) => {
    if (file === "/usr/bin/nc") return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    const probe = args.indexOf("enoughfactory-probe");
    if (probe >= 0) {
      await writeFile(args[probe + 2]!, "allowed");
      return { exitCode: 0, stdout: "enoughfactory-boundary-verified", stderr: "", timedOut: false };
    }
    if (args.some(arg => arg.endsWith("/xcodebuild"))) {
      const build = args[args.indexOf("-derivedDataPath") + 1]!;
      await mkdir(join(build, "Products", "Debug", "Mail.app"), { recursive: true });
      return { exitCode: 0, stdout: "BUILD SUCCEEDED", stderr: "", timedOut: false };
    }
    if (args.includes("--jitless")) return { exitCode: 0, stdout: JSON.stringify([join(args.at(-1)!, "Debug", "Mail.app")]), stderr: "", timedOut: false };
    if (args.includes("/usr/bin/ditto")) {
      await writeFile(args.at(-1)!, "fake zip fixture bytes");
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
    throw new Error("Unexpected native tool");
  } });
  try {
    for (const [parent, commit] of [[checksRoot, "a".repeat(40)], [integrationRoot, "b".repeat(40)]] as const) {
      const path = join(parent, "snapshot"); await mkdir(join(path, "Mail.xcodeproj"), { recursive: true });
      const result = await executor({ path, commit, candidate: { id: "candidate", commit: "a".repeat(40), goalId: "goal", taskId: "task", attemptId: "attempt" } as Candidate, command: 'enoughfactory:apple-build {"tool":"xcodebuild","project":"Mail.xcodeproj","scheme":"Mail","platform":"macos"}', timeoutMs: 5_000 });
      assert.equal(result.exitCode, 0);
      const artifacts = appleCheckArtifacts(result);
      assert.equal(artifacts.length, 2);
      assert.equal(artifacts[0]!.metadata!.commit, commit);
      const evidence = JSON.parse((await store.read(artifacts[1]!)).toString());
      commits.push(evidence.checkedCommit);
      assert.equal(evidence.candidateCommit, "a".repeat(40));
      assert.equal(evidence.products[0].sha256, artifacts[0]!.sha256);
      assert.equal((await readFile(await store.path(artifacts[0]!))).toString(), "fake zip fixture bytes");
      await assert.rejects(executor({ path: dirname(root), commit, candidate: { commit } as Candidate, command: 'enoughfactory:apple-build {"tool":"swift","package":".","action":"build"}', timeoutMs: 5_000 }), /private check or integration/);
    }
    assert.deepEqual(commits, ["a".repeat(40), "b".repeat(40)]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
