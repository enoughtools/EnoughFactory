# EnoughFactory

**Your devices. One software factory.**

EnoughFactory brings isolated development environments, agent conversations and autonomous goals into one desktop workspace. Run it on your Mac and Linux machines, connect the devices you own, and give the factory an outcome to work toward.

The shared React interface uses [EnoughUI](https://github.com/enoughtools/enough-ui). Electron provides desktop integration; an independent device service keeps environments, agent connections and coordination running after the window closes. EnoughFactory owns its container runtime: a private Lima VM on Mac and a private rootless Docker Engine on Linux. The environment engine is a pinned, narrowly patched [envmux](https://github.com/envmux/envmux).

## What it does

- Open Docker-backed environments with services, logs, independent terminals, previews and recoverable Git changes.
- Work with Codex, Antigravity or Claude in container-owned conversations. Enough owns the supported approval decisions.
- Pair devices through authenticated WebRTC, with hosted or self-hosted signaling and encrypted WebSocket fallback. TURN is optional.
- Coordinate dependent tasks using isolated Git or ArtifactFS workspaces, immutable candidates and serialized integration.
- Run autonomous goals through planning, execution, evaluation and repair. An agent finishing a turn does not finish the factory's responsibility to a goal.

Agents have full permissions **inside their containers**. Approval policy—Approve all, Rules or Manual—is independent of autonomy. Approve all runs immediately without waiting for a window or person. Selective policies cover each adapter's actual typed requests; they do not intercept every effect inside an allowed command. Provider accounts and credentials are supplied by you.

Chats stay on their owning device. If that device is offline, its conversations and live tools are unavailable until it returns. The coordinator retains durable task identity and reconciles uncertain execution before dispatching a replacement.

## Run from source

Source builds need Node 22.14 or newer, pnpm **10.34.5**, Git, the **.NET 10 SDK**, Python 3.10 or newer, and build tools (`make`, `gperf`, `tar`, `file`, binutils and standard shell utilities; Xcode Command Line Tools on Mac). Runtime preparation downloads pinned Go/Zig toolchains and builds the engine components with their source and relink materials. Desktop distributions bundle their application and container-runtime tools; Mac includes its pinned guest OS image and uses Apple virtualization. Linux needs the host's user-namespace and UID-mapping prerequisites described in [installation](docs/install.md#linux-runtime-prerequisites). An existing Docker installation is not required.

```sh
git clone https://github.com/enoughtools/EnoughFactory.git
cd EnoughFactory
pnpm install --frozen-lockfile
pnpm --filter @enoughfactory/envmux build:engine
node scripts/prepare-container-runtime.mjs
pnpm build
pnpm desktop
```

The desktop starts or reconnects to your local device service. Prepare and start the private container runtime, add a Git repository, create an environment, and connect the selected agent's credentials in that environment. The service stores local state under `~/.enoughfactory` by default. Asset preparation verifies pinned archive digests and does not invoke a host Docker daemon.

Use **Workbench** or the logo to return to all projects. Remove an environment with its trash action, or remove a project in **Project settings**. Removal hides catalog entries and preserves repository files, branches, chats and factory evidence; **Workbench → Removed** restores them. Active environments and unresolved factory work must end or reconcile first.

A goal’s **Activity** tab shows its planner, diagnosis and evaluator conversations, recorded instructions, tool activity and preparation output, including before the first tasks exist. **Settings** shows the connected device-service version.

For live interface development, run `pnpm dev`, then `pnpm --filter @enoughfactory/desktop dev` in another terminal. This starts the device service on port 4317 and Vite on port 4318. See [installation and first use](docs/install.md) for browser connections, startup service installation and removal.

## Documentation

- [Install, connect an agent and create a goal](docs/install.md)
- [Try a complete example project](examples/status-board/README.md)
- [Inspect tasks, attempts and factory progress](docs/task-workspace.md)
- [Plan parallel work and configure device capacity](docs/parallel-work.md)
- [Hosted networking, capacity and optional TURN](services/signaling-cloudflare/README.md)
- [Self-host signaling, relays and browser previews](docs/self-hosting.md)
- [Desktop distribution and native packaging](docs/desktop-distribution.md)
- [Build plan and product architecture](docs/build-plan.md)
- [Release progress and verification evidence](docs/release-progress.md)
- [Contributing](CONTRIBUTING.md), [security](SECURITY.md) and [third-party notices](THIRD_PARTY_NOTICES.md)

## Project layout

| Path | Responsibility |
| --- | --- |
| `apps/web` | Shared EnoughUI workbench |
| `apps/desktop` | Electron shell and isolated session browser |
| `apps/device` | Device-owned sessions, chats, networking and factory integration |
| `packages` | Contracts, envmux adapter, runtimes, peers, previews, workspaces and coordinator |
| `services/signaling` | Self-hostable presence, negotiation and optional relay |
| `services/signaling-cloudflare` | Hibernating hosted signaling and encrypted fallback, with shared capacity limits |
| `runtime` | Container agent bridges and ArtifactFS manager image |
| `apps/marketing` | Product website and launch assets |
| `vendor` | Pinned envmux and EnoughUI with provenance and original licenses |

## License

EnoughFactory's original code is [MIT licensed](LICENSE). Vendored code, native runtimes, fonts and optional images retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Model services and third-party agent accounts are separate dependencies. Core functionality and self-hosting do not require an Enough-hosted account.
