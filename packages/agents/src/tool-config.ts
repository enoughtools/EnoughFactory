import { createHash } from "node:crypto";
import type { AgentEvent, AgentMcpServer, TurnCallbacks } from "./types.ts";
import { AgentError } from "./types.ts";

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reservedEnvironment = /^(?:HOME|USER|LOGNAME|PATH|SHELL|TMPDIR|CODEX_HOME|CLAUDE_CONFIG_DIR|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|DOCKER_.*)$/;
export function validateToolEnvironment(environment: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(environment)) {
    if (!environmentName.test(key) || reservedEnvironment.test(key) || typeof value !== "string" || value.includes("\0") || value.length > 65536) throw new AgentError("A scoped tool environment entry is invalid.", "INVALID_TOOL_CONFIG");
  }
  return environment;
}
/** Generate only Factory-owned MCP configuration. JSON string literals are valid TOML strings. */
export function codexToolConfiguration(servers: Record<string, AgentMcpServer> = {}): string {
  const output: string[] = ["# Managed by EnoughFactory for this execution session."];
  const string = (value: string): string => {
    if (typeof value !== "string" || value.includes("\0") || value.length > 65536) throw new AgentError("An MCP configuration value is invalid.", "INVALID_TOOL_CONFIG");
    return JSON.stringify(value);
  };
  for (const [name, server] of Object.entries(servers)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new AgentError("An MCP server identity is invalid.", "INVALID_TOOL_CONFIG");
    output.push("", `[mcp_servers.${name}]`);
    if ("command" in server) {
      if (!server.command.trim()) throw new AgentError("An MCP command is required.", "INVALID_TOOL_CONFIG");
      output.push(`command = ${string(server.command)}`);
      if (server.args) output.push(`args = [${server.args.map(string).join(", ")}]`);
    } else {
      let url: URL;
      try { url = new URL(server.url); } catch { throw new AgentError("An MCP service address is invalid.", "INVALID_TOOL_CONFIG"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new AgentError("An MCP service must use HTTP with a scoped environment credential.", "INVALID_TOOL_CONFIG");
      output.push(`url = ${string(server.url)}`);
      if (server.bearerTokenEnvVar) {
        if (!environmentName.test(server.bearerTokenEnvVar)) throw new AgentError("An MCP credential environment name is invalid.", "INVALID_TOOL_CONFIG");
        output.push(`bearer_token_env_var = ${string(server.bearerTokenEnvVar)}`);
      }
    }
    if (server.enabledTools) output.push(`enabled_tools = [${server.enabledTools.map(string).join(", ")}]`);
    for (const [key, value] of [["startup_timeout_sec", server.startupTimeoutSeconds], ["tool_timeout_sec", server.toolTimeoutSeconds]] as const) {
      if (value !== undefined) {
        if (!Number.isFinite(value) || value <= 0 || value > 3600) throw new AgentError("An MCP timeout is invalid.", "INVALID_TOOL_CONFIG");
        output.push(`${key} = ${value}`);
      }
    }
    if ("command" in server && server.env) {
      output.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(validateToolEnvironment(server.env))) output.push(`${key} = ${string(value)}`);
    }
  }
  return `${output.join("\n")}\n`;
}

/** Pinned app-server thread config is delivered over private stdio, not process arguments. */
export function codexToolOverrides(servers: Record<string, AgentMcpServer> | undefined): Record<string, unknown> | undefined {
  if (!servers) return undefined;
  codexToolConfiguration(servers); // Keep one validation contract for file and RPC routes.
  return { mcp_servers: Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, {
    ...("command" in server ? { command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}) } : { url: server.url, ...(server.bearerTokenEnvVar ? { bearer_token_env_var: server.bearerTokenEnvVar } : {}) }),
    ...(server.enabledTools ? { enabled_tools: server.enabledTools } : {}),
    ...(server.startupTimeoutSeconds === undefined ? {} : { startup_timeout_sec: server.startupTimeoutSeconds }),
    ...(server.toolTimeoutSeconds === undefined ? {} : { tool_timeout_sec: server.toolTimeoutSeconds }),
  }])) };
}

/** Codex has already consumed MCP content. History keeps references, never repeated image bodies. */
export async function retainToolImages(event: AgentEvent, callbacks: TurnCallbacks, signal: AbortSignal): Promise<AgentEvent> {
  if (event.kind !== "tool" || !event.data) return event;
  const item = event.data.item as { id?: string; type?: string; status?: string } | undefined;
  const itemId = item?.id;
  const completedMcpResult = event.data.method === "item/completed" && item?.type === "mcpToolCall" && item.status === "completed";
  const visit = async (value: unknown, depth: number, location: Array<string | number>): Promise<unknown> => {
    if (depth > 32) return { omitted: "Tool result nesting exceeded the history limit." };
    if (Array.isArray(value)) return Promise.all(value.map((entry, index) => visit(entry, depth + 1, [...location, index])));
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    let encoded: string | undefined, mimeType: string | undefined;
    if (object.type === "image" && typeof object.data === "string") {
      encoded = object.data; mimeType = typeof object.mimeType === "string" ? object.mimeType : typeof object.mime_type === "string" ? object.mime_type : "image/png";
    } else if ((object.type === "image" || object.type === "image_url") && typeof object.image_url === "string" && object.image_url.startsWith("data:")) {
      const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]*)$/.exec(object.image_url);
      if (match) { mimeType = match[1]; encoded = match[2]; }
    }
    if (encoded !== undefined) {
      const providerImageResult = completedMcpResult && location.length === 4 && location[0] === "item" && location[1] === "result" && location[2] === "content" && typeof location[3] === "number";
      // Arguments and structured JSON are model/server-authored text, not image
      // content delivered through Codex's verified MCP result route.
      if (!providerImageResult) return { type: "image", retained: false, imageDataRemoved: true, omitted: "Image-shaped data outside a completed MCP image result." };
      if (encoded.length > 28_000_000 || !/^image\/[A-Za-z0-9.+-]+$/.test(mimeType!) || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(encoded)) return { type: "image", retained: false, omitted: "Invalid or oversized image response." };
      const bytes = Buffer.from(encoded, "base64"), sha256 = createHash("sha256").update(bytes).digest("hex");
      const reference = callbacks.onToolImage ? await callbacks.onToolImage({ bytes, mimeType: mimeType!, itemId }, signal) : { sha256, byteLength: bytes.length, mimeType, retained: false };
      if (reference.sha256 !== sha256 || reference.byteLength !== bytes.length || reference.mimeType !== mimeType) throw new AgentError("The tool image retention reference does not match its original bytes.", "IMAGE_RETENTION_MISMATCH");
      return { type: "image", ...reference, imageDataRemoved: true };
    }
    const entries = await Promise.all(Object.entries(object).map(async ([key, entry]) => [key, await visit(entry, depth + 1, [...location, key])] as const));
    return Object.fromEntries(entries);
  };
  return { ...event, data: await visit(event.data, 0, []) as Record<string, unknown> };
}
