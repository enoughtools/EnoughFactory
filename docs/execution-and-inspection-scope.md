# Execution and inspection scope

Agreed implementation scope, 8 October 2026. The sections below record the design; implementation status is recorded separately at the end.

## Outcome and recommendation

An agent must be able to run the product it is building, inspect the actual interface, exercise its workflows, repair failures and verify the new result. The factory should select the necessary device and tools automatically within the project's configured execution policy. Users continue to give it a goal and an agent limit; environments stay internal.

Support two complementary routes:

1. **Container authoring with delegated tools.** An agent edits in its Linux environment and requests browser or Mac build/UI sessions. It receives real screenshots, interface observations and results in its conversation, then continues editing. This is the first native milestone and unblocks many existing tasks without replacing their authoring runtime.
2. **Native Mac authoring.** An agent runs on a Mac in an isolated project workspace when its normal development loop requires macOS commands, SDKs or native dependencies. It uses the same inspection tools, evidence and factory lifecycle. This is part of the scope, with its own process adapter; a Mac device that runs a Linux container does not satisfy it.

Keep execution location separate from tool capabilities. A container author can use a Mac tool remotely, and a Mac host worker still needs explicit UI tools. Moving Codex onto macOS alone does not reproduce the feedback loop available in the Codex desktop app.

## Verified starting point

| Area | Current implementation | Change needed |
| --- | --- | --- |
| Agent execution | `TurnInput.containerId` is required; `AgentManager` creates `ContainerProcess` for Codex and other providers | Explicit execution targets and a Mac host process/workspace adapter |
| Placement | Device identity, availability, workspace support and container capacity | Target capabilities, readiness, tool placement and separate resource leases |
| Native compilation | Exact-source Apple build profiles retain reports and unsigned app products | Reuse them; add native UI sessions and test execution |
| Browser inspection | Human preview gateway exists; Factory does not provision agent browser automation | Managed, pinned browser tools available to agents |
| Image understanding | Container Codex has actually viewed supplied screenshot files | Supply fresh images from its own inspection sessions automatically |
| Evidence | Immutable candidates, content-addressed artifacts and paired transfers exist | Structured inspection/job records and image delivery into agent context |
| Continuation | Durable task/attempt state and prerequisite waits exist | Wake on job/capability results without repeating successful authoring |

Important seams: [agent types](../packages/agents/src/types.ts), [agent manager](../packages/agents/src/index.ts), [Codex adapter](../packages/agents/src/codex.ts), [contracts](../packages/contracts/src/index.ts), [scheduler](../packages/factory/src/scheduler.ts), [coordinator](../packages/factory/src/coordinator.ts), [device factory](../apps/device/src/factory.ts), [Apple executor](../packages/workspaces/src/apple-checks.ts), [controller context](../apps/device/src/controller-context.ts), [artifact store](../packages/workspaces/src/artifacts.ts) and [preview gateway](../packages/previews/src/index.ts).

Two existing couplings need deliberate correction. Apple checks currently enter `withRuntimeOperation`, which depends on container-runtime admission; host work needs independent service admission. Also, `checkResults()` flattens command results, while controller context carries external artifact references without their bodies. Native reports and actual image bytes must survive these paths.

## Shared execution model

### Targets, capabilities and readiness

Add an additive task execution contract: an execution target preference (`auto`, `container`, `host-macos`) and required capabilities. Distinguish capabilities required where the agent runs from tools that may be delegated. Exact field names can follow the existing contract conventions; this distinction is required.

Start with a small registry: Linux shell, Mac shell, Chromium inspection, Apple compilation, macOS app inspection and iOS Simulator inspection. Avoid a general resource-description language.

A device advertises supported targets, compatible protocol/tool versions and current readiness. Probe real prerequisites: installed provider, Xcode/toolchain, simulator runtime, helper connection, usable GUI session and OS permissions. A Mac host's platform string is not capability proof. Report `ready`, `preparing`, `busy`, `offline`, `setup-required` or `unsupported`, with a concrete reason and setup action where applicable.

`auto` prefers the existing container route when it meets local requirements, delegates tools when available, and chooses a configured Mac host worker for Mac-shell requirements. The planner receives this capability inventory and must not assign work to a nonexistent executor. The scheduler independently validates the plan before allocating an attempt. A transiently busy tool queues its job; a permanently absent required capability produces a durable wait without burning author attempts. Independent tasks continue.

Keep resource pools distinct: container workers, host CPU/memory/build jobs, browser sessions, owned simulator devices and the logged-in desktop. Start with one foreground native UI lease per user session and one owner per simulator. Multiple authors may work while their native inspection jobs queue. Goal agent limits still bound active model workers; tool-job concurrency has its own device resource accounting.

### Durable jobs and interactive sessions

Add a reusable tool-job/session lifecycle to the existing coordinator and device service, rather than a second scheduler or history database. A job records its goal revision/authority generation, task and author attempt, owner device/target, policy revision, source snapshot, requested profile and resource leases. An interactive session can contain multiple journaled actions and observations.

Persist queued, preparing, running, waiting, cancellation-requested, unknown and terminal outcomes. Distinguish a job's identity from the author attempt: waiting for a Mac or retrying an interrupted build must not retire successful source authoring. A genuine source repair can create the next author generation through the existing factory loop.

The service owns jobs, processes and artifacts independently of Electron windows. On restart or reconnect, discover and reconcile owned processes/simulators/sessions before starting replacements. A lost connection does not prove an action failed. Unconfirmed cancellation retains the reservation and prevents a competing replacement. Retired attempts and stale tool credentials cannot operate newer sessions or publish successful evidence.

Separate long jobs from tool-call timeouts. Tools return durable job IDs and progress; completion resumes the current author or a focused repair through the factory's persisted continuation. Capability readiness changes and job completion wake waits; periodic model turns saying the prerequisite is still missing do not.

### Agent tools and evidence delivery

Use a small, application-owned MCP bridge for delegated native tools. Configure it privately for each supported runtime using attempt-scoped authority. Do not expose the device service's master connection token or mount a Docker socket inside the author environment. Use existing authenticated paired-device transport for remote ownership.

For Codex, prefer supported MCP configuration over adding experimental dynamic tools to the first implementation. The current adapter disables experimental APIs. Official documentation confirms both MCP transports and an experimental app-server dynamic-tool route; the pinned runtime must pass an integration check before advertising either. Keep a compact tool set and bounded observations to avoid recreating controller-context budget failures. [OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [app-server documentation](https://learn.chatgpt.com/docs/app-server).

Return screenshot content as actual image input/tool output, plus a concise UI tree, console/process errors and structured action outcomes. Also persist the original bytes once in ArtifactStore. Chat events retain artifact references and metadata rather than repeated base64 image bodies. A pathname, receipt hash or statement that a screenshot was saved does not establish that the model saw it.

Advertise support per provider/adapter route after testing image delivery and tool invocation. Codex is first. Existing Claude/Antigravity routes remain available for their existing capabilities; do not silently claim they gained visual tools. A verified image staged into the author's workspace is a fallback when direct image tool output is unsupported.

## Browser capability

Reuse pinned Playwright/Chromium and its maintained automation interface. Prefer the existing Playwright MCP for interactive exploration; ordinary Playwright scripts/tests remain available for concise repeatable regression checks. Do not write a browser-control engine or require the user's personal browser. [Playwright MCP](https://github.com/microsoft/playwright-mcp).

Prepare one lazy, immutable browser tooling image in EnoughFactory's private runtime, shared across development toolchains. Pin the package lock, browser revision, image digest and supported architecture. Allocate an ephemeral sidecar only when a session needs a browser. Share the author container's network namespace so its app's `localhost` remains correct, including loopback-only servers. Bind control privately without publishing a host port. Each attempt gets its own browser state and output ownership. Playwright documents isolated contexts and version-matched container tooling. [Isolation](https://playwright.dev/docs/browser-contexts), [container setup](https://playwright.dev/docs/docker).

Provide navigation, DOM/accessibility observation, click/type/key/scroll, screenshots, viewport changes and console/network failures. Preserve a session across useful continuation turns; bounded idle retirement must make state loss explicit rather than pretend a fresh browser is the old one. Keep the human PreviewGateway as the user viewing route. Agent traffic stays within the execution session.

The device service owns preparation, leases, sidecar recovery, evidence ingestion and cleanup. Browser tooling should not be downloaded independently into every worker or archived as task history. Cold setup reports progress and a real setup failure before model dispatch when the capability is required.

## Mac and iOS capability

### Native inspection broker

Extend the existing Apple build path with a separate native session runner. Launch an exact built product in declared fixture/test configuration; identify the actual owned process, app/window and simulator, not just a matching bundle ID. A rebuilt product requires an explicit replacement launch so an old running app cannot silently satisfy the new check.

Require a verified isolated data/credential profile by default. An exact `.app` can still open or migrate the user's existing mail database, preferences and keychain through its bundle identity; a temporary directory or changed `HOME` is not proof of isolation. The author can add an appropriate fixture/test route as normal project work. Otherwise report the missing setup or use a deliberately configured live profile under project policy. Keep the existing build-only executor separate from the broader GUI runner and its readiness/authorization.

Expose a deliberately small interactive surface: start/build, observe, screenshot, click, type, key, scroll, run project UI tests and stop. Fresh observations identify actionable elements with session/observation IDs; stale element references fail safely. Coordinate input requires a matching fresh screenshot, viewport and scale. A completed click is not workflow success: inspect the resulting state or assert the expected behavior.

Foreground leases arbitrate agents, not the human using the Mac. Prefer app-targeted accessibility actions. Immediately before keyboard or coordinate input, revalidate the owned foreground window and user session; pause/yield on focus changes, session locking or human interference. Resume from a fresh observation when ownership is usable again, without repeatedly stealing focus or adding per-click approval prompts. Continuous unattended GUI testing needs a usable dedicated user session or paired Mac.

Reuse Apple UI testing for repeatable iOS/macOS journeys and retained attachments. macOS interactive inspection needs an app-bound accessibility/capture helper; iOS needs an owned Simulator plus a UI-test runner capable of querying and interacting, not screenshot-only `simctl` commands. Reuse a distributable automation backend where its license and deployment model fit. Our current Codex computer-use tool is not an assumed redistributable product dependency. Validate the backend choice before expanding the tool surface. [Apple UI application API](https://developer.apple.com/documentation/xcuiautomation/xcuiapplication), [screenshots](https://developer.apple.com/documentation/xcuiautomation/xcuiscreenshot), [test attachments](https://developer.apple.com/documentation/xctest/adding-attachments-to-tests-activities-and-issues).

A stable, signed per-user helper owns GUI operations. The independent service owns its jobs and IPC connection. Closing a Factory window must not terminate the helper. A headless service or sleeping/locked user session is not automatically a usable native UI worker; background build readiness remains separate. Show actual Accessibility/capture/Xcode readiness and the required OS setup. Enough's Approve all cannot grant macOS privacy permissions. Never reset, erase or take over an unrelated user simulator.

### Native host authoring

Generalize the process/turn interface to container and host transports, with a dedicated `HostProcess` adapter. Initially support the pinned Codex app-server route on macOS. Do not reuse container provisioning scripts against the user's system or depend on an arbitrary global Codex installation.

Each author attempt receives EnoughFactory-owned Git workspaces and independently captured additional repositories/directories. Reuse existing snapshot, multi-root capture and primary-only automatic integration rules. The user's main checkout is not the worker directory. Keep provider configuration, credentials, process ownership, cancellation, supported thread resume and retained chats under the device service's lifecycle.

Host execution is a configured project/device capability with a clear access description. A private worktree protects the working checkout; it is not a security sandbox for a same-user host process. Do not present full host access as container isolation or promise every shell effect is intercepted. Enough owns approval policy, and Approve all continues automatically within configured capabilities. Tools, authorization and scope stay separate from autonomy.

Host workers use the same native inspection bridge rather than receiving a second incompatible set of GUI tools. Host-only work must continue when the private Docker runtime is stopped, provided its own required capabilities are ready.

## Source identity, acceptance and storage

Inspection must work during development. Capture temporary immutable snapshots including dirty/untracked source and all declared roots; do not force commits merely to see the UI. Record source manifest/digests, build recipe/toolchain, original product hashes, launch arguments, fixture/data identity, device/session, viewport/scale, actions, observations and assertion outcomes. If source changes during a build, the result belongs to the captured snapshot, not the newer working tree.

Final verification uses the actual saved candidate and integrated commit as appropriate. Preserve their distinct identities, even when their trees match. Keep original reports whole, including multi-command reports; normalize through a versioned manifest/adapter rather than relabeling reports or repeating successful builds solely to satisfy an incompatible receipt format. A model-written success statement or a screenshot's presence cannot substitute for configured workflow assertions.

UI acceptance combines functional outcomes with actual visual inspection against the project's reference and design system. For material UI work, retain the screens and observations supporting judgments about clipping, spacing, hierarchy, focus and platform behavior. A build or accessibility tree alone cannot judge visual quality. Keep review proportionate; this does not require a new reviewer ceremony for every small change.

Use ArtifactStore and existing peer transfer. Retain selected checkpoints, useful failure screenshots, logs, assertions and failure traces. Continuous recording is optional. Bound scratch output and reusable build/browser caches; share immutable toolchain layers and reference-count retained products. After durable capture, retire owned browser profiles, preview processes, scratch workspaces and exclusively owned volumes. Active/unknown jobs keep what they need, and evidence referenced by an accepted result cannot be pruned as disposable cache. No per-task Mac VM is required for the initial design.

## Delivery sequence and completion gates

This is a substantial execution feature, not a settings toggle. Organize it into three implementation lanes after the shared contracts: coordination/evidence, browser tooling and Mac execution. Keep native GUI work serialized while authors work in parallel. Avoid adding more agents than the ownership boundaries support.

| Milestone | Deliverable | Exit condition |
| --- | --- | --- |
| 0. Prove the hard interfaces | Pinned Codex image/tool response; packaged Mac helper and owned iOS runner prototype | On current EnoughMail Mac and iPhone products, the agent completes two runtime-selected observe/action cycles in one owned session, edits text and sees the result; stale references fail and original app hashes are verified. A fixed UI test alone cannot satisfy this gate |
| 1. Shared foundation | Explicit targets/capabilities, readiness, durable tool jobs, scoped tool authority, evidence delivery and independent host admission | Missing capability waits before author allocation; successful source survives verifier waits/restart; stale/retired actions are rejected |
| 2a. Native development loop | Container author uses Mac build/inspection broker, original evidence and automatic continuation | Repair a real visible/workflow defect, rebuild and verify the new source on Mac and iOS without manual artifact export |
| 2b. Browser development loop | Pinned lazy tooling sidecar, private session networking, images/observations, diagnostics and cleanup | Fresh web task operates its own loopback app, sees a defect, repairs it and retains passing evidence; concurrent sessions remain separate |
| 3. Native authoring target | Mac host Codex process, private multi-root workspaces, provider state, capture/integration, shared inspection tools | SDK-dependent task completes its edit/build/inspect/repair lifecycle on the host without using the primary checkout; cancel/restart/resume are verified |
| 4. Product rollout | Device setup/readiness, understandable waits, task evidence, remote routing, migrations and packaged verification | Existing goals survive upgrade; a Linux author uses a paired Mac; window closure and service restart do not duplicate actions or lose evidence |

Begin the Mac/iOS backend proof immediately; browser work can proceed alongside it. Do not finish a generic framework first and discover that Simulator interaction or helper packaging does not work. Native host authoring remains a required milestone in this scope, even though the delegated-tool route can unblock EnoughMail earlier.

Milestone 0 also establishes packaging/OS-session constraints. Any rebuilt, resigned or instrumented app used by a backend gets a distinct product identity and derivation record; it cannot be presented as the original tested artifact.

### EnoughMail pilot

Use the current retained implementation and original completion criteria. Preserve accepted tasks and failed-attempt history; add focused repairs based on observed defects. Do not restart feature discovery or replace the criteria with a smaller demo.

The first native loop should reproduce the observed composer-close failure: open a message, reply, edit, close-and-keep-draft, assert the composer disappears, reopen the draft and verify its content, including an isolated application restart. Capture the current sidebar/reader clipping at representative window sizes and have the agent compare actual screenshots with the intended EnoughUI/EnoughMail UX. Run equivalent relevant journeys on the owned iPhone Simulator. Keep synthetic mail separate from live services and signing/distribution requirements.

This pilot proves the new execution/inspection capability. It does not automatically satisfy every existing mail parity scenario. The remaining goal criteria must each acquire genuine results, with unavailable live-service credentials or signing prerequisites represented separately.

### Cross-cutting acceptance

- Same app port in two browser sessions resolves to each session's own app; cookies, files and screenshots do not leak between attempts.
- Mac UI leases queue fairly; no competing agents type into the same desktop, and an unrelated running app is never mistaken for the owned product.
- Human focus changes pause unsafe input, and default native fixtures cannot load or migrate the user's real mail data or credentials.
- A source edit invalidates acceptance for the previous snapshot; an older image/product cannot be presented as the new result.
- Offline Mac, locked session, missing OS permission, quota and source failure produce distinct accurate states. Ready events resume work without repeated futile author attempts.
- Closing desktop/web UI leaves service-owned work running. Restart and cancellation reconcile owned processes, sessions and uncertain effects before replay.
- Host jobs operate with the container runtime stopped. A container author still needs its container, but native tool ownership does not depend on that container remaining alive after submission.
- A paired Linux author receives actual Mac/iOS images and results; large artifacts use existing bounded transfers and do not block control.
- A second browser/native task reuses prepared tooling/caches. Terminal resources retire, useful evidence remains accessible, and cache limits prevent another uncontrolled storage accumulation.
- Every advertised provider/adapter combination demonstrates real tool invocation and image consumption; unsupported combinations are reported honestly.

## Rollout boundaries and remaining implementation choices

Legacy tasks retain container execution unless explicitly revised; absent new fields preserve current behavior. Negotiate target/tool protocol support before remote dispatch, and treat older peers as lacking the new capabilities. Keep existing verification-input gates for compatibility, then let authenticated job completion supply typed evidence references automatically. Users should never need to discover acceptance environment-variable names to move normal work forward.

Show simple status and actions: “Building on MBP 16”, “Testing on iPhone Simulator”, “Waiting for your Mac to unlock”, “Set up Mac testing” and “View screenshots/results”. Put executor details in task inspection. Do not introduce an environments-first navigation hierarchy or a second agent panel.

Resolve these choices in milestone 0: distributable native automation backend and license; reliable iOS interactive runner/harness; macOS helper signing/permission identity across updates; exact pinned-runtime MCP image behavior; browser sidecar process/namespace behavior on both supported Linux architectures. Record measured setup latency, build/interaction reliability and disk use before picking defaults.

Initial scope excludes physical iOS device automation, universal Windows/Linux desktop automation, personal-browser control, automated signing-account setup and a per-task Mac virtualization fleet. It includes project-defined UI tests and exploratory inspection; either one alone is insufficient for the intended agent feedback loop.

## Implementation status

The implementation now includes explicit Mac/container placement, pinned host Codex execution, private Chromium inspection, Mac Accessibility/window capture, an owned iOS Simulator runner, authenticated paired-device tool jobs, and original image delivery into Codex. Native compilation uses a durable worker with a recorded start gate and confirmed teardown receipts. Source snapshots include every declared root; completed execution copies can retire after source, SQLite history and useful artifacts are retained.

Explicit UI requirements now gate both candidate and integration checks. Missing evidence starts a separate verifier against the saved source. Capability/setup waits preserve successful authoring. Final evaluation verifies the current canonical project, reads original assertions and references, views actual screenshots, and critiques hierarchy, spacing, clipping, typography, controls and states. See `native-quality-acceptance.md` for the contract and EnoughMail journeys. This checks evidence and review coverage; it does not turn component imports or a successful compile into a beauty score.

Native UI testing currently requires a coordinator-configured build/isolated-fixture profile, Xcode and the bundled testing assets. Mac interaction also needs an unlocked desktop and OS permissions. These prerequisites are probed; unavailable access does not count as passing. Fixture results remain separate from live-service, feature-parity, signing and distribution acceptance. The existing EnoughMail requirements are preserved.
