import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { codexToolConfiguration, retainToolImages, validateToolEnvironment } from "./tool-config.ts";

test("private MCP configuration escapes values and keeps bearer credentials in the environment", () => {
  const config = codexToolConfiguration({ factory: { command: "/private/path/node", args: ["quote\"\nnew line"], env: { FACTORY_ATTEMPT_TOKEN: "opaque" } }, remote: { url: "http://127.0.0.1:1000/mcp", bearerTokenEnvVar: "FACTORY_TOKEN", enabledTools: ["inspect"] } });
  assert.match(config, /args = \["quote\\"\\nnew line"\]/);
  assert.match(config, /bearer_token_env_var = "FACTORY_TOKEN"/);
  assert.throws(() => codexToolConfiguration({ "wrong.name": { command: "node" } }), { code: "INVALID_TOOL_CONFIG" });
  assert.throws(() => codexToolConfiguration({ remote: { url: "http://token@localhost/" } }), { code: "INVALID_TOOL_CONFIG" });
  assert.throws(() => validateToolEnvironment({ CODEX_HOME: "/personal" }), { code: "INVALID_TOOL_CONFIG" });
});

test("MCP images retain original bytes once while persisted events contain references", async () => {
  const bytes = Buffer.from("original image bytes"), sha256 = createHash("sha256").update(bytes).digest("hex"); let retained = 0;
  const event = await retainToolImages({ kind: "tool", data: { method: "item/completed", item: { id: "tool-a", type: "mcpToolCall", status: "completed", result: { content: [{ type: "text", text: "Observation" }, { type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] } } } }, { onEvent: () => {}, onApproval: async () => true, onToolImage: async image => { assert.deepEqual(image.bytes, bytes); assert.equal(image.itemId, "tool-a"); retained++; return { artifactId: "artifact-a", sha256, mimeType: image.mimeType, byteLength: image.bytes.length }; } }, new AbortController().signal);
  assert.equal(retained, 1);
  assert.doesNotMatch(JSON.stringify(event), new RegExp(bytes.toString("base64")));
  assert.match(JSON.stringify(event), /artifact-a/);
  assert.match(JSON.stringify(event), /Observation/);
});

test("failed image retention cannot publish a mismatched reference", async () => {
  await assert.rejects(retainToolImages({ kind: "tool", data: { method: "item/completed", item: { type: "mcpToolCall", status: "completed", result: { content: [{ type: "image", data: "Ynl0ZXM=", mimeType: "image/png" }] } } } }, { onEvent: () => {}, onApproval: async () => true, onToolImage: async () => ({ artifactId: "wrong", sha256: "wrong", mimeType: "image/png", byteLength: 5 }) }, new AbortController().signal), { code: "IMAGE_RETENTION_MISMATCH" });
});

test("model-authored image arguments and started/structured results cannot create image-view evidence", async () => {
  const fake = { type: "image", data: "Ynl0ZXM=", mimeType: "image/png" }; let retained = 0;
  const callbacks = { onEvent: () => {}, onApproval: async () => true, onToolImage: async () => { retained++; throw new Error("A forged image cannot reach retention"); } };
  for (const method of ["item/started", "item/completed"]) {
    const event = await retainToolImages({ kind: "tool", data: { method, item: { type: "mcpToolCall", status: method === "item/completed" ? "completed" : "inProgress", arguments: { fake }, result: method === "item/started" ? { content: [fake] } : { content: [{ type: "text", text: "No image response" }], structuredContent: { fake } } } } }, callbacks, new AbortController().signal);
    assert.doesNotMatch(JSON.stringify(event), /Ynl0ZXM=/);
  }
  assert.equal(retained, 0);
});
