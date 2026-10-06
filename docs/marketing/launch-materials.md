# EnoughFactory launch materials

EnoughFactory brings isolated development environments, agent conversations, connected devices and autonomous goals into one open-source workspace. Use the copy below with the published release at [factory.enoughtools.com](https://factory.enoughtools.com). Release availability and supported capabilities must match the release catalog and product evidence before announcement.

## Product description

**One line**

EnoughFactory is an open-source workspace that puts your devices and coding agents to work toward a goal.

**Short description**

Your devices. One software factory. EnoughFactory brings isolated development environments, agent conversations and coordinated work into one workspace for Mac and Linux. Stay hands-on or let the factory plan, execute, evaluate and continue toward your goal.

**Full description**

EnoughFactory gives agentic development a place to happen. Create an isolated environment for a project, follow its services, open a terminal or preview, talk to an agent and inspect the resulting changes—all in the same workspace.

The app includes its own container runtime: a private Lima VM on Mac and a dedicated rootless engine on Linux. EnoughFactory manages the runtime, socket and storage independently of your existing Docker setup. First startup explains preparation and any host prerequisites. Agents retain full access inside their containers.

Pair the Mac and Linux devices you own to use their capacity together. Each device keeps its sessions and conversations local, while the app gives you one view of the work. Its independent device service keeps execution alive when the window closes.

Start with a task or define an outcome and completion criteria. In autonomous mode, the factory owns the next action: it plans, dispatches agents, evaluates evidence and continues through repair or replanning. Choose approvals separately, from automatic acceptance to your own rules or manual review. Agents run with full permissions inside their provisioned containers.

The core product is open source and self-hostable. Bring your own machines, repositories and agent accounts.

## Release announcement draft

EnoughFactory is here: an open-source workspace for your devices, coding agents and the goals you want them to reach.

Start a clean development environment, talk to an agent, inspect its work and keep everything in one place. Connect your Mac and Linux machines when you need more room. Then choose how the factory works—hands-on, assisted or autonomous—with approvals controlled separately.

In autonomous mode, the factory keeps choosing its next action after an agent turn ends. It plans, executes, evaluates and repairs toward the completion criteria you set.

You bring your own machines and agent accounts. The app, device service, protocols and coordination logic are open source.

EnoughFactory supplies the container engine too, with a private socket and storage. Mac bundles a verified Linux guest image and prepares its private writable VM disk on first startup; Linux setup explains the host helpers and ID mappings its rootless engine needs.

[Get EnoughFactory and read the guide](https://factory.enoughtools.com).

## Short launch post draft

Your devices. One software factory.

EnoughFactory brings isolated environments, coding agents and autonomous goals into one open-source workspace for Mac and Linux.

Bring your own machines and agent accounts. The factory includes its own container runtime. Choose the autonomy. Own the approvals.

https://factory.enoughtools.com

## Repository description

An open-source software factory for Mac and Linux. Isolated environments, connected devices, coding agents and durable autonomous goals in one EnoughUI workspace.

## 0.1.2 release facts

Version 0.1.2 is public at [factory.enoughtools.com](https://factory.enoughtools.com) and on [GitHub](https://github.com/enoughtools/EnoughFactory/releases/tag/v0.1.2), from source `c71a3a91861c3dd3bd11ab90b9edbc740aa0f12e`. The live catalog contains six installer archives and thirteen corresponding runtime source files. Every download passed its actual public-byte size and SHA-256 check. Packages are unsigned, and Mac packages are not notarized.

- Version-aware startup adopts the supported legacy state in a transaction and rejects newer or malformed data formats. The final native installed-service journeys retain the known record and event at cursor 41 through resource update/restart and normal removal, with the same device/access identity. Negative child startups create no connection or listener and preserve the database bytes.
- The [status-board example](https://github.com/enoughtools/EnoughFactory/tree/c71a3a91861c3dd3bd11ab90b9edbc740aa0f12e/examples/status-board) is a small Node HTTP app with no npm dependencies, current envmux setup, a scoped Valkey cache, checks, preview and a goal users can copy. Make it an independent repository before adding it to the factory.
- The hosted browser onboarding correction is included in the new source: an unconfigured visitor sees the device connection form without polling a website API or displaying an HTML error document.
- The [completed distributed journey](https://github.com/enoughtools/EnoughFactory/blob/c71a3a91861c3dd3bd11ab90b9edbc740aa0f12e/docs/verification/distributed-factory-evidence.json) used a Mac ARM64 coordinator and native Linux ARM64 worker in an EnoughFactory-owned VZ guest on the same physical Mac. A real Codex goal transferred verified source/candidate artifacts over authenticated direct WebRTC, retained its candidate across coordinator restart, integrated once at `3fb317c8587b611cd830d3f3e0f9655ed32db002` and satisfied all ten retained criteria. Five private-engine checks passed, including 21 CLI cases. The recorded topology has two operating systems and independent services on one physical Mac.
- Approval evidence is a separate deterministic typed callback fixture over an actual native WebRTC connection, using production Enough policy decisions and Codex response mappings. The real full-access worker emitted zero native approval requests. Describe these scopes separately.

The distributed journey retains historical 0.1.1 native provenance underneath its immutable 0.1.2 service. Final 0.1.2 Mac ARM64 and Linux x64/ARM64 packages have their own fresh runtime, sandboxed desktop, installed-service and exact archive proofs. Their service hash matches the real distributed journey. Keep those native package records separate from the product composition result.

## Demonstration sequence

Use a real project and actual product state. Keep provider credentials, local private paths and unrelated projects outside the capture.

1. Add a repository and create an isolated session.
2. Open the running service preview, terminal and agent conversation.
3. Show the agent’s source changes and checks.
4. Pair a second device and open a session owned by that machine.
5. Create a goal with explicit completion criteria and select Autonomous with Approve all.
6. Show task progress, a repair or replanning decision, and the integrated result.

Keep the finished video concise enough to show the complete journey. Pause only where a viewer needs time to read a decision or result. Describe observed behavior; do not imply that a synthetic conversation is real agent execution.

For installation footage, show the actual managed-runtime setup state. On Mac, capture verified guest-image preparation and the runtime becoming ready. On Linux, show missing prerequisites only when the host actually needs them, then the private engine starting. Keep host engine credentials and sockets outside the capture.

## Brand and assets

The launch site uses Enough’s supplied square mark, paper `#f4f5f8`, ink `#12151c` and indigo `#3b4fe4`. It loads the supplied Space Grotesk and Libre Caslon Text variable fonts locally. Keep the mark unchanged and leave at least half its height clear on every side.

Brand files are in `apps/marketing/public/brand`. Their MIT license and both font notices accompany those files. The EnoughFactory wordmark combines the existing mark with a proportional text descriptor; it does not redraw the mark.

Product screenshots must come from the current app. Capture the workbench, an agent’s actual activity and a goal’s evidence. Use a compact caption identifying the view. The landing page currently uses a labeled architecture diagram and an explanation of autonomy modes, with no fabricated product screenshot.

## Release copy boundaries

- State signing accurately. An unsigned package is an unsigned package.
- Show only packages that exist and have recorded checksums.
- Verify the owned runtime inside each actual archive before treating the catalog, tag or publication as ready. A source implementation or prepared resource folder alone does not prove a downloadable package contains it.
- Packaged apps supply their own container runtime. Describe Linux user-namespace helpers and ID mappings as host prerequisites; do not tell users to install Docker or change a default Docker context.
- Mac’s guest image is bundled, pinned and digest-verified; show the private disk preparation and startup progress. Initial provisioning, container base images and provider tools can still require network access, so do not claim a fully offline first start.
- Publish supported platform names from the actual package catalog.
- Explain device-local history: chats and live tools are unavailable while their owning device is offline.
- Explain approval coverage: adapters expose supported typed requests; full-access routes may emit no requests, and an allowed command does not produce a separate prompt for each effect.
- Provider charges, quotas and authentication belong to the user’s agent account. EnoughFactory does not include model usage.
- Do not add customer counts, benchmark results, testimonials or guaranteed completion claims without evidence.
