import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager, WorkingDirectoryManager, dockerCheckExecutor, validateCheckInputs } from "../src/index.ts";
import { git, run } from "../src/process.ts";
import type { CheckContext, CheckExecutor, FrozenCheckInputs } from "../src/types.ts";

function frozenInputs(): FrozenCheckInputs {
  return {
    configurationRevision: 7,
    workingDirectoryIds: ["evidence-id"],
    environment: {
      ENOUGH_EVIDENCE_ROOT: "/workspaces/evidence/native evidence",
      ENOUGH_NATIVE_INDEX_SHA256: "a".repeat(64),
      ENOUGH_ACCEPTANCE_INDEX_SHA256: "b".repeat(64),
      ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR: "/workspaces/evidence/native evidence/ui 'receipt' $(literal).json",
    },
  };
}

const selectedRoots = [
  { id: "evidence-id", containerPath: "/workspaces/evidence" },
  { id: "other-id", containerPath: "/workspaces/other" },
];

const passingExecutor: CheckExecutor = async context => ({ command: context.command, exitCode: 0, stdout: "", stderr: "", startedAt: new Date().toISOString(), endedAt: new Date().toISOString() });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "enough-frozen-check-inputs-"));
  const project = join(root, "project"), dataDir = join(root, "data");
  await mkdir(project);
  assert.equal((await run("git", ["init", "-b", "main", project])).exitCode, 0);
  await git(project, "config", "user.name", "Check Inputs Test");
  await git(project, "config", "user.email", "check-inputs@example.com");
  await writeFile(join(project, "source.txt"), "retained source\n");
  await git(project, "add", ".");
  await git(project, "commit", "-m", "Retained source");
  const manager = new WorkspaceManager({ dataDir, deviceId: "check-inputs-test", checkExecutor: passingExecutor });
  const source = join(root, "evidence-source");
  await mkdir(join(source, "native evidence"), { recursive: true });
  await writeFile(join(source, "native evidence", "index.json"), "{\"retained\":true}\n");
  await writeFile(join(source, "native evidence", "ui 'receipt' $(literal).json"), "{\"native\":true}\n");
  const directories = new WorkingDirectoryManager({ dataDir, artifacts: manager.artifacts });
  const [snapshot] = await directories.prepare({ identity: "evidence-snapshot", sources: [{ id: "evidence-id", name: "evidence", path: source }] });
  const capture = await directories.captureFromPath(snapshot!, snapshot!.path);
  return { root, project, dataDir, manager, capture };
}

async function fakeDocker(root: string) {
  const calls = join(root, "docker-calls.jsonl"), cliPath = join(root, "bundled-docker");
  await writeFile(cliPath, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');\n`);
  await chmod(cliPath, 0o700);
  const endpoint = { cliPath, host: `unix://${join(root, "factory-owned.sock")}`, configDirectory: join(root, "factory-docker-config") };
  const readCalls = async (): Promise<string[][]> => {
    try { return (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  return { endpoint, readCalls };
}

test("frozen check inputs validate exact revisions, selected evidence paths and the narrow environment contract", () => {
  assert.equal(validateCheckInputs(undefined), undefined);
  assert.deepEqual(validateCheckInputs({ configurationRevision: 0, workingDirectoryIds: [], environment: {} }, []), { configurationRevision: 0, workingDirectoryIds: [], environment: {} });
  const input = frozenInputs(), expected = structuredClone(input);
  const validated = validateCheckInputs(input, selectedRoots)!;
  input.workingDirectoryIds.push("other-id");
  input.environment.ENOUGH_NATIVE_INDEX_SHA256 = "c".repeat(64);
  assert.deepEqual(validated, expected, "validation must not retain mutable caller input");

  const invalid: Array<[string, unknown]> = [
    ["null input", null],
    ["array input", []],
    ["unknown field", { ...frozenInputs(), extra: true }],
    ...[-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1].map(revision => [`invalid revision ${revision}`, { ...frozenInputs(), configurationRevision: revision }] as [string, unknown]),
    ["repeated identity", { ...frozenInputs(), workingDirectoryIds: ["evidence-id", "evidence-id"] }],
    ["unsafe identity", { ...frozenInputs(), workingDirectoryIds: ["../evidence"] }],
    ["too many identities", { ...frozenInputs(), workingDirectoryIds: Array.from({ length: 9 }, (_, index) => `id-${index}`) }],
    ["unknown environment key", { ...frozenInputs(), environment: { PATH: "/tmp/override" } }],
    ["nonstring environment value", { ...frozenInputs(), environment: { ENOUGH_NATIVE_INDEX_SHA256: 123 } }],
    ["uppercase digest", { ...frozenInputs(), environment: { ENOUGH_NATIVE_INDEX_SHA256: "A".repeat(64) } }],
    ["short digest", { ...frozenInputs(), environment: { ENOUGH_ACCEPTANCE_INDEX_SHA256: "a".repeat(63) } }],
  ];
  for (const path of ["/work/evidence", "/workspaces/evidence/../other", "/workspaces/evidence/./index", "/workspaces/evidence//index", "/workspaces/evidence/", "/workspaces/evidence/index\0.json", "/workspaces/evidence\\index", "/workspaces/evidence-other/index", "/workspaces/other/index"]) {
    for (const name of ["ENOUGH_EVIDENCE_ROOT", "ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR"]) invalid.push([`${name}: ${JSON.stringify(path)}`, { ...frozenInputs(), environment: { [name]: path } }]);
  }
  for (const [description, value] of invalid) assert.throws(() => validateCheckInputs(value, selectedRoots), description);
  assert.throws(() => validateCheckInputs(frozenInputs(), []), "a selected identity must resolve in the candidate");
  assert.throws(() => validateCheckInputs(frozenInputs(), [{ id: "other-id", containerPath: "/workspaces/evidence" }]), "an alias cannot substitute for the selected identity");
});

test("capture freezes check inputs in both source manifests and rejects altered attempt or candidate contracts", async () => {
  const f = await fixture();
  try {
    const legacyWorkspace = await f.manager.create({ projectPath: f.project, goalId: "goal", taskId: "legacy", attemptId: "legacy-contract" });
    assert.equal(Object.hasOwn(await f.manager.workspace(legacyWorkspace.id), "checkInputs"), false);
    const legacyCandidate = await f.manager.capture({ workspaceId: legacyWorkspace.id });
    const legacyRaw = JSON.parse(await readFile(join(f.dataDir, "candidates", `${legacyCandidate.id}.json`), "utf8"));
    assert.equal(Object.hasOwn(legacyRaw, "checkInputs"), false);
    assert.deepEqual(await f.manager.candidate(legacyCandidate.id), legacyRaw, "loading an authentic legacy candidate must preserve its saved object shape");

    const selected = frozenInputs(), expected = structuredClone(selected);
    const identity = { projectPath: f.project, goalId: "goal", taskId: "task", attemptId: "frozen-attempt" };
    const workspace = await f.manager.create({ ...identity, checkInputs: selected });
    selected.configurationRevision++;
    selected.workingDirectoryIds.push("other-id");
    selected.environment.ENOUGH_NATIVE_INDEX_SHA256 = "c".repeat(64);
    assert.deepEqual(workspace.checkInputs, expected);
    assert.deepEqual((await f.manager.workspace(workspace.id)).checkInputs, expected);
    await assert.rejects(f.manager.create({ ...identity, checkInputs: selected }), /frozen check inputs/i);
    assert.deepEqual((await f.manager.create({ ...identity, checkInputs: structuredClone(expected) })).checkInputs, expected);
    await assert.rejects(f.manager.capture({ workspaceId: workspace.id, workingDirectories: [] }), /working.directory|selected|check inputs/i);

    const candidate = await f.manager.capture({ workspaceId: workspace.id, workingDirectories: [f.capture] });
    assert.deepEqual(candidate.checkInputs, expected);
    assert.deepEqual(candidate.bundleArtifact.metadata?.checkInputs, expected);
    assert.deepEqual(candidate.diffArtifact.metadata?.checkInputs, expected);
    assert.deepEqual((await f.manager.candidate(candidate.id)).checkInputs, expected);
    const changed = { ...expected, environment: { ...expected.environment, ENOUGH_NATIVE_INDEX_SHA256: "c".repeat(64) } };
    const receiver = new WorkspaceManager({ dataDir: join(f.root, "receiver"), deviceId: "receiver", checkExecutor: passingExecutor });
    const bundlePath = await f.manager.artifacts.path(candidate.bundleArtifact);
    const diffPath = await f.manager.artifacts.path(candidate.diffArtifact);
    await assert.rejects(receiver.acceptCandidate({ ...candidate, checkInputs: changed }, bundlePath, diffPath), /immutable source evidence/i);
    for (const key of ["bundleArtifact", "diffArtifact"] as const) {
      const tampered = { ...candidate, [key]: { ...candidate[key], metadata: { ...candidate[key].metadata, checkInputs: changed } } };
      await assert.rejects(receiver.acceptCandidate(tampered, bundlePath, diffPath), /immutable source evidence/i);
    }
    for (const artifact of [f.capture.bundleArtifact, f.capture.diffArtifact]) await receiver.artifacts.importFile(await f.manager.artifacts.path(artifact), artifact);
    await receiver.acceptCandidate(candidate, bundlePath, diffPath);
    assert.deepEqual((await receiver.candidate(candidate.id)).checkInputs, expected);
    const saved = join(f.dataDir, "candidates", `${candidate.id}.json`);
    await writeFile(saved, JSON.stringify({ ...candidate, checkInputs: changed }));
    await assert.rejects(f.manager.candidate(candidate.id), /immutable source evidence/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Docker checks pass only frozen literal evidence values and never inherit ambient evidence variables", async () => {
  const f = await fixture(), docker = await fakeDocker(f.root);
  const keys = [...Object.keys(frozenInputs().environment), "ENOUGH_AMBIENT_SECRET"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = `ambient ${key} $(must-not-expand)`;
    const workspace = await f.manager.create({ projectPath: f.project, goalId: "goal", taskId: "task", attemptId: "docker-attempt", checkInputs: frozenInputs() });
    const candidate = await f.manager.capture({ workspaceId: workspace.id, workingDirectories: [f.capture] });
    const executor = dockerCheckExecutor({ image: "node:22-bookworm", dockerRuntime: docker.endpoint });
    const manager = new WorkspaceManager({ dataDir: f.dataDir, deviceId: "check-inputs-test", checkExecutor: executor });
    const report = await manager.verify({ candidateId: candidate.id, commands: ["check retained evidence"] });
    assert.equal(report.status, "passed");
    const calls = await docker.readCalls();
    for (const args of calls) assert.deepEqual(args.slice(0, 4), ["--host", docker.endpoint.host, "--config", docker.endpoint.configDirectory]);
    const [invocation] = calls.filter(args => args[4] === "run");
    assert.ok(invocation);
    assert.deepEqual(invocation.filter(arg => arg.startsWith("--env=ENOUGH_")).sort(), Object.entries(frozenInputs().environment).map(([name, value]) => `--env=${name}=${value}`).sort());
    assert.equal(invocation.some(arg => arg.includes("ambient ") || arg.includes("ENOUGH_AMBIENT_SECRET")), false);
    assert.ok(invocation.some(arg => arg.startsWith(`type=bind,source=${join(f.dataDir, "checks")}/`) && arg.endsWith("-working-directories/evidence-id,target=/workspaces/evidence")), "the frozen environment refers to the retained evidence snapshot");

    const plain = await f.manager.create({ projectPath: f.project, goalId: "goal", taskId: "legacy", attemptId: "legacy-attempt" });
    const legacy = await f.manager.capture({ workspaceId: plain.id });
    assert.equal((await manager.verify({ candidateId: legacy.id, commands: ["legacy check"] })).status, "passed");
    const legacyRun = (await docker.readCalls()).filter(args => args[4] === "run")[1]!;
    assert.deepEqual(legacyRun.filter(arg => arg.startsWith("--env=ENOUGH_") || /^ENOUGH_/.test(arg)), []);
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(f.root, { recursive: true, force: true });
  }
});

test("invalid frozen environment or missing exact evidence snapshots are rejected before invoking Docker", async () => {
  const f = await fixture(), docker = await fakeDocker(f.root);
  try {
    const workspace = await f.manager.create({ projectPath: f.project, goalId: "goal", taskId: "task", attemptId: "invalid-attempt", checkInputs: frozenInputs() });
    const candidate = await f.manager.capture({ workspaceId: workspace.id, workingDirectories: [f.capture] });
    const executor = dockerCheckExecutor({ dockerRuntime: docker.endpoint });
    const context: CheckContext = { path: workspace.path, commit: candidate.commit, candidate, command: "must not run", timeoutMs: 1_000 };
    const invalidInputs = { ...frozenInputs(), environment: { ENOUGH_EVIDENCE_ROOT: "/workspaces/evidence/../other" } };
    const invalidCandidate = { ...candidate, checkInputs: invalidInputs, bundleArtifact: { ...candidate.bundleArtifact, metadata: { ...candidate.bundleArtifact.metadata, checkInputs: invalidInputs } }, diffArtifact: { ...candidate.diffArtifact, metadata: { ...candidate.diffArtifact.metadata, checkInputs: invalidInputs } } };
    await assert.rejects(executor({ ...context, candidate: invalidCandidate }));
    await assert.rejects(executor(context), /snapshot|working.directory|selected|check inputs/i);
    await assert.rejects(executor({ ...context, workingDirectories: [{ path: join(`${workspace.path}-working-directories`, f.capture.id), containerPath: f.capture.containerPath, commit: "0".repeat(40) }] }), /snapshot|working.directory|commit|check inputs/i);
    assert.deepEqual(await docker.readCalls(), [], "invalid evidence must not launch or prepare any Docker resource");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
