# EnoughFactory agents

The device service owns these runtime connections. Existing turns run inside
containers on EnoughFactory's dedicated managed Docker runtime. An explicitly
configured `host-macos` target runs pinned Codex in a private worker checkout.
Container turns receive full root access without the host Docker socket. Host
turns have same-user host access: a private checkout protects the main working
tree but is not a security sandbox. There is no user-Docker fallback.

```ts
const agents = new AgentManager({ dockerEndpoint: managedRuntime.endpoint, copyHostAuth: true });
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

Every container operation requires `dockerEndpoint: {host,cliPath,configDirectory}` from
EnoughFactory's runtime manager. The shared runtime invocation supplies explicit
`--host` and `--config` flags and clears inherited context/TLS selectors. This
includes provisioning, private credential writes and cancellation. An absent
descriptor fails with `MANAGED_RUNTIME_UNCONFIGURED`; it cannot select Docker
Desktop, Colima's default profile or the user's current CLI context. The caller
starts the owned runtime before launching a session or agent.

`availability(containerId)` reports real executable/package versions.
`provision(containerId, runtime, {copyHostAuth})` installs pinned runtime packages
inside the container and uploads the SDK bridge. Runtime pins are in `types.ts`:
Codex 0.160.0, Claude Code 2.1.289 and Google Antigravity SDK 0.1.20. The installer
uses an isolated Node 22.22.0 prefix where required and verifies its archive
against the release checksum. Envmux's configured `ENVMUX_WORKDIR` is respected,
with `/work` as the default.

## Native Mac authoring

Configure `hostRuntimeDir` and `hostWorkspaceRoots` on `AgentManager`. These are
EnoughFactory-owned payload/state and private worker workspace directories; the
device service additionally validates the exact session workspace. A native
turn sets `executionTarget: "host-macos"`, omits `containerId`, supplies an
absolute private `cwd`, and uses the Codex app-server adapter. It can run with
Docker stopped or unconfigured.

`provisionHostRuntime(signal?)` installs and verifies the pinned Node/Codex
payload, including the Darwin native package. `hostAvailability()` probes that
payload rather than selecting an arbitrary global executable. Downloads use
verified Node checksums, private npm configuration/cache, ownership receipts,
atomic publication and bounded cleanup. Provider state lives separately in a
private home per session. Only explicitly selected `auth.json` is copied;
personal provider configuration and chats are not. A resumed session preserves
its own refreshed authentication and provider thread state.

`HostProcess` journals its uniquely identified supervisor and detached process
group. Cancellation verifies each owned descendant, including tools that create
another process group. Concurrent interruption and teardown wait for the same
confirmed process exit. `hostProcesses()` reconciles ownership after restart;
`cancelHostSession()` refuses recycled or unverifiable PIDs. An active or unknown
prior owner fences a replacement until the service reconciles it.

After an independent verifier has ended and its conversation/source are durable,
the service can call `retireHostSession(sessionId, expectedCwd)`. It rejects live
or unknown process ownership, records a durable retirement tombstone, and removes
duplicate provider rollouts, images and temporary files. Tiny ownership/process
journals remain to fence accidental resume. Ordinary author homes remain available
for supported thread continuation.

## Inspection tools and image retention

`TurnInput.mcpServers` configures Factory-owned stdio or HTTP MCP servers through
the pinned app-server's private per-thread config. No personal MCP configuration
is copied, and shared-container turns do not overwrite a global tool config.
Factory Codex processes disable personal account apps/plugins, global hooks and
the desktop-specific browser/computer backends at startup. Explicit Factory
MCP, shell, image viewing and ordinary web search remain available.
`toolEnvironment` carries scoped credentials without including values in process
arguments. This route is supported for Codex app-server; the CLI and other
provider adapters reject inspection configurations that they cannot support.

MCP image bytes reach Codex directly. `onToolImage` retains those original bytes
and returns an artifact reference. Tool history contains the reference, MIME
type, byte count and SHA-256 instead of repeated base64 bodies. A mismatched
reference fails retention. If no retention callback is provided, the event says
the image was not retained and keeps only its digest/size.

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
ENOUGHFACTORY_AGENT_CONTAINER=your-disposable-container \
ENOUGHFACTORY_AGENT_TEST_ENDPOINT=managed \
ENOUGHFACTORY_AGENT_TEST_DOCKER_HOST=unix:///path/to/enoughfactory/docker.sock \
ENOUGHFACTORY_AGENT_TEST_DOCKER_CLI=/path/to/bundled/docker \
ENOUGHFACTORY_AGENT_TEST_DOCKER_CONFIG=/path/to/private/docker-config \
pnpm --filter @enoughfactory/agents verify
```

The focused suite covers service-owned Approve all, deny rules, stale manual
answers, native request resolution and generated Codex response shapes. The
optional Docker check covers connection lifetime and descendant interruption.
For an existing external development fixture, explicitly select
`ENOUGHFACTORY_AGENT_TEST_ENDPOINT=external-development` and its full descriptor.
This test opt-in does not alter product runtime selection.

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

On 2026-10-08 the privately provisioned Darwin Codex 0.160.0 route invoked a
Factory MCP fixture, identified its image-only green/purple panels, retained the
original PNG once and compiled/ran a Swift program importing AppKit. The same
thread resumed with its identity preserved. This verifies native authoring and
the image/tool transport; it is not native product UI acceptance evidence.

The committed response schemas under `protocol/codex-0.160.0` were generated by
`codex app-server generate-json-schema`. Regenerate and adapt protocol handlers
when deliberately changing the runtime pin. See [official app-server
documentation](https://learn.chatgpt.com/docs/app-server) and the [SDK bridge
protocol](../../runtime/agents/README.md).
