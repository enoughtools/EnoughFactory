# EnoughFactory implementation instructions

Read `docs/build-plan.md` before product implementation. It records the agreed stack, delivery sequence and full-product scope. The user's current instructions take precedence over this file and the investigation report.

## Product and sequence

- Build the shared React/EnoughUI web app with Electron desktop bundles and an independent Mac/Linux device service. Windows is optional.
- Bundle an EnoughFactory-owned container runtime with a private Docker socket, configuration and storage. Do not rely on the user's Docker installation or mutate their contexts, daemon, images or volumes. Runtime lifecycle belongs to the device service.
- Begin with a polished, functional envmux workbench. Continue through agent execution/policy, connected devices, coordinated work, autonomous goals and product distribution in that order.
- A request to build the full product covers every layer. Do not stop after the workbench, a demo change or a research spike. Do not ask for approval between layers.
- Extend one coherent interface throughout. Implement real loading, error, offline and intervention behavior alongside each capability.
- Reuse a pinned envmux engine through a narrow adapter and minimal patches. Avoid rewriting its runtime merely to match the TypeScript application.

## Execution and policies

- Product agents run with full permissions inside their containers. Do not silently substitute workspace restrictions or native provider automatic review.
- Enough owns approvals. Approve all responds automatically without waiting for UI or human input. Support rules/manual choices through typed runtime APIs.
- Approval policy and autonomy are independent. Autonomous plus Approve all drives planning, execution, repair, integration and configured release actions toward the goal.
- The factory owns continuation after an agent turn ends. Persist its next action and resume or dispatch without expecting the model to self-drive indefinitely.
- These instructions define product behavior; they do not change the tools, permissions or higher-priority instructions governing the agent building this repository.

## Devices and state

- Keep execution, networking and live runtime connections in the device service, independent of window lifetime.
- Prefer WebRTC behind a transport interface, with self-hostable signaling and optional relays. Authenticate paired device identities.
- Device-local chats may be unavailable while their device is offline. Do not build unnecessary transcript replication.
- Keep goal/task/attempt records durable at the selected coordinator. Preserve task identity, distinguish unknown execution status from failure, and reconcile effects before retrying.
- Use Git/ArtifactFS for workspaces and source; keep transactional coordination and evidence manifests separate.

## Verification and progress

- Run required builds/type checks and focused verification appropriate to the change.
- Use representative product journeys and meaningful tests for risky state, policy or ownership behavior. Skip tests that mirror implementation, reversible styling or upstream UI components.
- After appropriate checks pass, continue work. Broaden or repeat testing only for new changes, actual failures or unresolved concerns.
- Make routine implementation decisions autonomously. Ask only for genuinely missing information or access; keep useful independent work moving.
- Keep updates concise. Record material decisions and actual limitations without turning progress into repeated disclaimers.
