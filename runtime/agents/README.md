# Container agent bridges

The device service launches these adapters inside an isolated agent container.
Keep the JSONL stdin connection open until a terminal result/error or confirmed
interruption. Closing an application window must not close that connection; the
device service owns it. Full SDK execution is intentional inside the container.

## Antigravity

Use Python 3.12 (the SDK requires Python >=3.10) and install the published,
platform-specific wheel, which includes Google's native `localharness` binary:

```sh
python3 -m venv /opt/enoughfactory/antigravity
/opt/enoughfactory/antigravity/bin/python -m pip install google-antigravity==0.1.20
```

Linux x64 and ARM64 wheels are published. Installing the source checkout alone
does not supply the runtime. Preserve its Apache-2.0 notices in distribution.
The adapter accepts the SDK's environment authentication: `GEMINI_API_KEY`, or
Google's supported Vertex/ADC configuration. Provision credentials through the
project's container configuration; JSONL does not carry credential values.
The SDK's Gemini/Vertex authentication is separate from Antigravity IDE/CLI sign-in.

Launch from the repository directory inside the container:

```sh
/opt/enoughfactory/antigravity/bin/python -u /opt/enoughfactory/agents/antigravity_bridge.py
```

`--check` verifies the pinned SDK installation and reports the bridge protocol
version without inference or authentication. Save trajectories on a persistent
container volume. Pass `saveDir`, set `ENOUGHFACTORY_AGY_SAVE_DIR`, or use the
default `~/.local/share/EnoughFactory/antigravity`. Keep that directory alongside
the provider thread ID when restoring a chat. A `threadId` uses the SDK's explicit
`RESUME` mode: missing context errors instead of silently creating another chat.

### JSONL input

The first record starts one turn. An omitted `type` is accepted for compatibility:

```json
{"type":"start","prompt":"Implement the task in this repository.","approvalMode":"approve-all","saveDir":"/state/antigravity"}
```

Optional start fields are `threadId` (the SDK's conversation ID), `model` and
`systemInstructions`. Modes are `approve-all`, `rules` and `manual`. All modes
forward native typed tool callbacks to Enough's policy service. Approve all must
reply immediately from that service; it never requires a renderer or operator.

```json
{"type":"approval-response","id":"enough-request-uuid","approved":true}
{"type":"question-response","id":"enough-question-uuid","answers":[{"freeform_response":"Choose the approach that best satisfies the goal."}]}
{"type":"cancel"}
```

Question responses use the SDK schema: `selected_option_ids`, `freeform_response`
and `skipped`, with optional top-level `cancelled`. The `answers` list also accepts
the SDK's `responses` alias. Questions are independent of
approval policy. The factory supervisor answers them in autonomous mode; a user
can answer them in the conversation workspace. Approval response `approved` must
be a JSON boolean. Malformed, mismatched and stale responses do not grant access.

### JSONL output

Records carry the process-local `turnId`; request IDs are independently allocated
UUIDs even when the SDK supplies a native tool ID.

- `event`: `event.kind` is `runtime-starting`, `thread-started`, `text-delta`,
  `tool-call`, `tool-result`, `runtime-event`, `request-resolved`,
  `request-ignored` or `interrupted`. SDK tool records retain their native schema.
- `approval`: `id`, `action`, `arguments`, `nativeId`, `stepId`, `canonicalPath`,
  `serverName`, `reason` and `approvalMode` describe the actual SDK callback.
- `question`: `id` and the SDK's typed `questions` list.
- `result`: `threadId`, `text`, `usage`, `stopReason`, `structuredOutput` and
  `saveDir`. This means a provider turn finished; Enough evaluates goal completion
  separately. Quota/budget stop reasons remain visible to the factory supervisor.
- `error`: `code` and `message`. `invalid-input` reports a rejected response while
  a turn can remain active; `missing-sdk`/`runtime-error` are terminal with exit 1.

SDK diagnostics go to stderr; stdout contains only protocol records. The bridge
does not expose private reasoning as chat text. EOF, SIGINT, SIGTERM, `cancel` and
`shutdown` retire pending callbacks, request native cancellation and close the SDK
connection. Interrupted processes exit 130. The parent must also terminate the
container process group if shutdown cannot finish, then retire that attempt's
authority before accepting any delayed response.

### Full access and coverage

The bridge explicitly enables `BuiltinTools.all_tools()`, unsandboxed commands,
daemon commands and a general worker subagent with the same full tool capability.
Its policies combine `allow_all()` (which disables workspace containment) with
the higher-priority wildcard `ask_user` callback. It does not use provider auto
review or read-only defaults. Effects performed inside an accepted shell command
are not separately intercepted; Enough must represent this coverage honestly.

Implementation references: [SDK 0.1.20 release](https://pypi.org/project/google-antigravity/0.1.20/),
[policy documentation](https://www.antigravity.google/docs/sdk/policies/),
[policy source](https://github.com/google-antigravity/antigravity-sdk-python/blob/12f9a4c3becf487302dc799b0f59054f01f3ddb9/google/antigravity/hooks/policy.py),
and [session persistence example](https://github.com/google-antigravity/antigravity-sdk-python/blob/12f9a4c3becf487302dc799b0f59054f01f3ddb9/examples/getting_started/persistence.py).
