# EnoughFactory agents

The device service owns these runtime connections. All model/tool execution is
inside an existing Docker container; there is no host execution fallback.
Containers receive full root access, networking and unsandboxed tools. They do
not receive the host Docker socket through this package.

```ts
const agents = new AgentManager({ copyHostAuth: true });
const result = await agents.runTurn({
  chatId, sessionId, containerId, runtime: "codex",
  approvalMode: "approve-all", rules: [], prompt,
  threadId, attemptId, policyRevision: 1,
}, {
  onEvent: event => history.append(chatId, event),
  onApproval: (approval, signal) => policy.decide(approval, signal),
  onQuestion: (question, signal) => inputs.answer(question, signal),
});
```

`runTurn` returns `{ threadId?, text, usage?, stopReason? }`. `text` is Codex's
final answer when the runtime marks one; progress remains in events. `onEvent`
receives `ChatEvent` content without the history-owned identity, cursor or date.
Assistant deltas carry `data.delta` and `data.itemId`; completed messages carry
`data.final` and the same identity. Present one changing message per item.

`interrupt(chatId)` revokes callback authority immediately and terminates the
container process group, including tools. `shutdown()` interrupts this manager's
live turns. Closing a renderer does neither. The container command wrapper uses
`setsid --wait`, because Docker can make its exec process a process-group leader;
without `--wait` setsid forks and Docker loses a live protocol connection.

`availability(containerId)` reports real executable/package versions.
`provision(containerId, runtime, {copyHostAuth})` installs pinned runtime packages
inside the container and uploads the SDK bridge. Runtime pins are in `types.ts`:
Codex 0.160.0, Claude Code 2.1.289 and Google Antigravity SDK 0.1.20. The installer
uses an isolated Node 22.22.0 prefix where required and verifies its archive
against the release checksum. Envmux's configured `ENVMUX_WORKDIR` is respected,
with `/work` as the default.

## Policies and credentials

Approve all never invokes a UI approval callback. Rules use first matching rule;
tool and command patterns support `*`. Unmatched or `ask` rules call Enough's
typed policy callback. Manual calls the same callback. Attempt, turn, native
request and policy revision remain attached to the decision. Interrupted or
natively resolved requests cannot accept a late operator response.

Codex uses app-server with `danger-full-access`, `dangerFullAccess` and reviewer
`user`. Selective policy uses `on-request`; it governs actual typed requests,
including configured native execution rules, rather than every possible effect.
The explicit `codexTransport: "exec"` route supports Approve all only. It does not
silently retry a failed app-server turn, which could duplicate its effects.

Antigravity prefers the pinned SDK and full capabilities/policy bridge. An
existing `agy` CLI is available for Approve all when SDK provisioning is disabled;
the CLI has no bidirectional selective approval channel. Claude's headless
skip-permissions route also supports Approve all only.

Copying host authentication is explicit. Only Codex's `auth.json`, Claude's
`.credentials.json` or Google's application-default credential file travel;
provider configuration, transcripts and host keychains do not. Antigravity SDK
Gemini/Vertex authentication differs from IDE/CLI account sign-in. An existing
CLI sign-in does not authenticate SDK inference.

`connectApiKey(containerId,runtime,key)` writes a private container credential
through stdin; keys are not command-line arguments. Codex uses its supported
API-key login command. Claude and Antigravity use a provider-specific environment
file sourced only inside the container. Provider sign-in can also be performed
in the session terminal. Credentials never enter chat events.

Electron distributions must copy `runtime/agents/antigravity_bridge.py` as an
application resource and pass its directory as `runtimeAssetsDir`.

## Verification

```sh
pnpm --filter @enoughfactory/agents typecheck
pnpm --filter @enoughfactory/agents verify
ENOUGHFACTORY_AGENT_CONTAINER=your-disposable-container pnpm --filter @enoughfactory/agents verify
```

The focused suite covers service-owned Approve all, deny rules, stale manual
answers, native request resolution and generated Codex response shapes. The
optional Docker check covers connection lifetime and descendant interruption.

On 2026-10-05 a real pinned Codex app-server turn, authenticated inside a
disposable envmux container, wrote files to `/root` and `/work` as uid 0 and
completed without requesting a renderer's approval. The container connection
and descendant-interruption checks also passed. SDK configuration/routing was
verified against the published wheel; SDK inference needs its separately
configured provider credentials.

A full-access turn with an explicit native execution prompt rule also raised
`item/commandExecution/requestApproval`; Enough accepted the typed request and
the runtime executed the command. This verifies the actual bidirectional route,
without claiming that every full-access command receives a native prompt.

The committed response schemas under `protocol/codex-0.160.0` were generated by
`codex app-server generate-json-schema`. Regenerate and adapt protocol handlers
when deliberately changing the runtime pin. See [official app-server
documentation](https://learn.chatgpt.com/docs/app-server) and the [SDK bridge
protocol](../../runtime/agents/README.md).
