import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSwiftCheckCompatibility, SWIFT_CHECK_COMPATIBILITY_SOURCE } from "../src/swift-check-compatibility.ts";
import { run } from "../src/process.ts";

const marker = "ENOUGHFACTORY_CHECK_COMPATIBILITY_V1 ";

test("compatibility evidence requires the trusted complete first line and preserves command output and failure", () => {
  const hash = "7".repeat(64);
  const stdout = `project result\n${marker}${"8".repeat(64)}\n`;
  const result = captureSwiftCheckCompatibility({ stdout: `${marker}${hash}\n${stdout}`, stderr: "actual failure", exitCode: 17 });
  assert.equal(result.stdout, stdout); assert.equal(result.stderr, "actual failure"); assert.equal(result.exitCode, 17);
  assert.equal(result.runtimeCompatibility.compiledSha256, hash);
  assert.equal(result.runtimeCompatibility.sourceSha256, createHash("sha256").update(SWIFT_CHECK_COMPATIBILITY_SOURCE).digest("hex"));
  assert.match(result.runtimeCompatibility.helperSha256, /^[a-f0-9]{64}$/);
  for (const untrusted of ["", `${marker}${hash}`, `project output\n${marker}${hash}\n`, `${marker}${"z".repeat(64)}\n`]) {
    assert.throws(() => captureSwiftCheckCompatibility({ stdout: untrusted, stderr: "bootstrap incomplete" }), /no valid compiled-library evidence/);
  }
});

test("Linux shim corrects only unsupported provenance on real directories and preserves external symlink targets", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "enough-provenance-shim-"));
  try {
    const source = join(root, "shim.c"), library = join(root, "shim.so"), driver = join(root, "driver");
    await writeFile(source, SWIFT_CHECK_COMPATIBILITY_SOURCE);
    const compiled = await run("clang", ["-shared", "-fPIC", "-O2", "-Wall", "-Wextra", "-Werror", "-pthread", source, "-o", library, "-ldl"]);
    assert.equal(compiled.exitCode, 0, compiled.stderr);
    const fixture = new URL("./fixtures/provenance-check.c", import.meta.url);
    const driverSource = join(root, "driver.c"); await writeFile(driverSource, await readFile(fixture));
    assert.equal((await run("clang", ["-Wall", "-Wextra", "-Werror", driverSource, "-o", driver])).exitCode, 0);
    const baseline = await run(driver, ["baseline", join(root, "baseline")], { env: { LD_PRELOAD: "" } });
    assert.equal(baseline.exitCode, 0, baseline.stderr);
    const corrected = await run(driver, ["shim", join(root, "corrected")], { env: { LD_PRELOAD: library } });
    assert.equal(corrected.exitCode, 0, corrected.stderr);
    assert.match(corrected.stdout, /external symlink target attribute, file bytes and symlink preserved/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
