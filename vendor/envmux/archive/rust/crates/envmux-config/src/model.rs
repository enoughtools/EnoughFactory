//! The typed model of `.envmux.toml`. Flat where possible, explicit rather
//! than clever, tolerant of being regenerated wholesale.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::duration::HumanDuration;

/// The whole file. Every section is optional in the source; defaults are
/// applied through the accessors and `Default` impls (precedence: daemon
/// defaults → active file → creation-time overrides, applied by the caller).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub meta: Meta,
    pub image: Image,
    #[serde(default)]
    pub mirror: Mirror,
    #[serde(default)]
    pub workspace: Workspace,
    #[serde(default)]
    pub services: BTreeMap<String, Service>,
    #[serde(default)]
    pub tasks: BTreeMap<String, Task>,
    #[serde(default)]
    pub volumes: Volumes,
    #[serde(default)]
    pub capture: Capture,
    #[serde(default)]
    pub observe: Observe,
    #[serde(default)]
    pub routes: BTreeMap<String, u16>,
    #[serde(default)]
    pub routing: Routing,
    #[serde(default)]
    pub secrets: BTreeMap<String, Secret>,
    #[serde(default)]
    pub lease: Lease,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub editor: Editor,
}

/// How `envmux code` (and the TUI's editor bindings) open a workspace in a
/// local VS Code-family editor.
///
/// Editor location and window habits are machine-specific, so this section
/// belongs in `.envmux.local.toml` — the whole-file override — more often
/// than in the committed file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Editor {
    /// Absolute path to the editor executable. Absent means discovery:
    /// `$VSCODE_BIN`, then PATH, then the platform's well-known installs.
    #[serde(default)]
    pub path: Option<String>,
    /// Whether a launch reuses an existing editor window or opens a new one.
    #[serde(default)]
    pub window: EditorWindow,
    /// Container-side folder to open when nothing better is known. The
    /// workspace `workdir` (where envmux cloned the repository) normally wins
    /// before this is consulted.
    #[serde(default = "default_editor_folder")]
    pub default_folder: String,
    /// Per-workspace folder overrides, keyed by workspace name. Values are
    /// absolute container-side paths.
    #[serde(default)]
    pub folders: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum EditorWindow {
    /// Let the editor reuse an existing window (its own default).
    #[default]
    Reuse,
    /// Pass `--new-window`.
    New,
}

fn default_editor_folder() -> String {
    "/".to_owned()
}

impl Default for Editor {
    fn default() -> Self {
        Self {
            path: None,
            window: EditorWindow::default(),
            default_folder: default_editor_folder(),
            folders: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Meta {
    /// Config schema version. `2` is current; `1` is still accepted and
    /// parses with no behavior change, so existing files keep working.
    #[serde(default = "default_schema")]
    pub schema: u32,
    /// Namespace name; absent implies the repository name.
    #[serde(default)]
    pub namespace: Option<String>,
}

fn default_schema() -> u32 {
    2
}

impl Default for Meta {
    fn default() -> Self {
        Self {
            schema: 2,
            namespace: None,
        }
    }
}

/// The one image backing the base container and every workspace: a reference
/// to pull, or a Dockerfile to build.
///
/// envmux does not *implement* building — it shells out to `docker build`,
/// which already handles `.dockerignore`, BuildKit, caching, and streaming the
/// context. Declaring a `dockerfile` is a convenience for repositories that
/// keep their environment definition beside the code; anything more demanding
/// (multi-arch, registries, build secrets) belongs in compose or CI, with the
/// result referenced here.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Image {
    /// Path to a Dockerfile, relative to the repository root.
    #[serde(default)]
    pub dockerfile: Option<String>,
    /// Build context directory (with `dockerfile`); defaults to the repo root.
    #[serde(default)]
    pub context: Option<String>,
    /// Build args (with `dockerfile`), passed as `--build-arg`.
    #[serde(default)]
    pub args: BTreeMap<String, String>,
    /// Image reference to pull, e.g. `ghcr.io/acme/dev:2026.08`. Mutually
    /// exclusive with `dockerfile`.
    ///
    /// Prefer an immutable digest for reproducibility: a workspace is a product
    /// of the config it was created from, and a moving tag quietly breaks that.
    #[serde(default)]
    pub reference: Option<String>,
}

/// How the in-session router spells structured routing hosts.
///
/// The host is a **single label** — `<namespace><delimiter><workspace><delimiter><route>.<domain>`
/// — so one `*.<domain>` certificate covers every workspace and route that
/// will ever exist. Nesting labels would need a certificate per workspace,
/// because RFC 6125 wildcards match exactly one label.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Routing {
    /// Loopback port the router listens on. Absent means the router's
    /// default, and the router handles fallback when that default is taken.
    #[serde(default)]
    pub port: Option<u16>,
    /// Domain the hosts hang off. Absent means the platform default — see
    /// [`Routing::effective_domain`]. A custom domain needs a wildcard DNS
    /// record resolving to 127.0.0.1 for the host form to work.
    #[serde(default)]
    pub domain: Option<String>,
    /// Separator between the fields of the host label.
    ///
    /// `_` by default: not a legal hostname character under RFC 952/1123, but
    /// accepted in practice, and it cannot collide with generated workspace
    /// names, which are lowercase ASCII and hyphens.
    #[serde(default = "default_route_delimiter")]
    pub delimiter: String,
}

/// Platform-default routing domain.
///
/// On Windows, `*.localhost` resolution is unreliable — subdomains of
/// `localhost` are handed to the system resolver, which often fails to answer
/// them, and even browsers there do not consistently special-case them the
/// way they do on other platforms. `strigops.xyz` is public wildcard DNS
/// resolving to loopback, so the host form just works without hosts-file
/// editing. Everywhere else, `*.localhost` reliably resolves to loopback.
#[cfg(windows)]
const DEFAULT_ROUTE_DOMAIN: &str = "strigops.xyz";
#[cfg(not(windows))]
const DEFAULT_ROUTE_DOMAIN: &str = "localhost";

fn default_route_delimiter() -> String {
    "_".to_owned()
}

impl Default for Routing {
    fn default() -> Self {
        Self {
            port: None,
            domain: None,
            delimiter: default_route_delimiter(),
        }
    }
}

impl Routing {
    /// The domain hosts hang off: the configured value, or the compiled-in
    /// platform default — `strigops.xyz` on Windows, where `*.localhost`
    /// resolution is unreliable, and `localhost` everywhere else.
    #[must_use]
    pub fn effective_domain(&self) -> &str {
        self.domain.as_deref().unwrap_or(DEFAULT_ROUTE_DOMAIN)
    }

    /// The host serving one named route of one workspace.
    #[must_use]
    pub fn host_for(&self, namespace: &str, workspace: &str, route: &str) -> String {
        format!(
            "{namespace}{d}{workspace}{d}{route}.{domain}",
            d = self.delimiter,
            domain = self.effective_domain()
        )
    }

    /// Certificate SANs covering every host this scheme can produce.
    #[must_use]
    pub fn wildcard_sans(&self) -> Vec<String> {
        let domain = self.effective_domain();
        vec![format!("*.{domain}"), domain.to_owned()]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FetchMode {
    /// Fetch on the configured interval.
    #[default]
    Periodic,
    /// Fetch only at workspace creation for unknown refs, or on explicit request.
    OnDemand,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Mirror {
    /// Upstream remote URL; absent means detect from the repository's `origin`.
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub fetch: FetchMode,
    /// Fetch interval when `fetch = "periodic"`.
    #[serde(default = "default_mirror_interval")]
    pub interval: HumanDuration,
}

fn default_mirror_interval() -> HumanDuration {
    HumanDuration::from_secs(15 * 60)
}

impl Default for Mirror {
    fn default() -> Self {
        Self {
            remote: None,
            fetch: FetchMode::default(),
            interval: default_mirror_interval(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum NamingStrategy {
    /// Fully random petname.
    #[default]
    Random,
    /// `<branch>-<random suffix>`.
    Branch,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    /// Where the checkout lives inside the container.
    #[serde(default = "default_workdir")]
    pub workdir: String,
    /// Container user for workspace processes.
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub naming: NamingStrategy,
    /// What a session drops you into.
    ///
    /// `"shell"` (or unset) keeps the image's default shell. `"manage"` lands
    /// in the management view on the host instead of attaching. Anything else
    /// is a command run in the workspace's first tmux window — `"claude"`,
    /// `"codex"`, or any command line the image can execute. When the command
    /// exits, the window closes; task windows are unaffected. Attaching again
    /// runs it again: the terminal is recreated on demand, so exiting is not
    /// a one-way door.
    #[serde(default)]
    pub terminal: Option<String>,
    /// Optional CPU cap in cores, e.g. `4.0`; passed to Docker as `NanoCpus`.
    ///
    /// **Absent means no limit** — the workspace uses whatever the host will
    /// give it. Capping is opt-in because the right number depends entirely on
    /// the machine, and a value baked into a committed file is wrong on every
    /// other machine that clones the repository.
    #[serde(default)]
    pub cpus: Option<f64>,
    /// Optional memory cap, e.g. `"8g"`. Absent means no limit.
    ///
    /// Parsed at config load, so an unparseable value is a diagnostic rather
    /// than a limit that silently is not applied.
    #[serde(default)]
    pub memory: Option<crate::ByteSize>,
    /// Workspace outbound-network policy. Restricted modes are schema-visible
    /// but rejected by v1 validation until enforcement is available on every
    /// supported Docker Desktop/native platform.
    #[serde(default)]
    pub egress: EgressPolicy,
    /// UNSAFE: bind the host Docker socket into the workspace. This is
    /// Linux-only and gives the workspace effective root-equivalent control
    /// of the host Docker daemon.
    #[serde(default)]
    pub dangerously_mount_docker_socket: bool,
    /// UNSAFE: run a nested Docker daemon in a privileged workspace. This
    /// disables the container isolation boundary and is intended for demos.
    #[serde(default)]
    pub dangerously_enable_dind: bool,
}

impl Workspace {
    /// The command the session's first tmux window should run, when the
    /// configured terminal is an in-container command rather than one of the
    /// reserved words (`shell` keeps the default shell, `manage` never
    /// attaches at all).
    #[must_use]
    pub fn terminal_command(&self) -> Option<&str> {
        match self.terminal.as_deref().map(str::trim) {
            None | Some("" | "shell" | "manage") => None,
            Some(command) => Some(command),
        }
    }

    /// Whether a session should open the management view instead of
    /// attaching into the workspace.
    #[must_use]
    pub fn terminal_is_manage(&self) -> bool {
        self.terminal.as_deref().map(str::trim) == Some("manage")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "kebab-case", deny_unknown_fields)]
pub enum EgressPolicy {
    #[default]
    Unrestricted,
    ProxyOnly {
        proxy: String,
    },
    Allowlist {
        hosts: Vec<String>,
    },
}

fn default_workdir() -> String {
    "/work".to_owned()
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            workdir: default_workdir(),
            user: None,
            naming: NamingStrategy::default(),
            terminal: None,
            cpus: None,
            memory: None,
            egress: EgressPolicy::default(),
            dangerously_mount_docker_socket: false,
            dangerously_enable_dind: false,
        }
    }
}

/// Supported service kinds; a closed set in v1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceKindName {
    Postgres,
    Minio,
    Redis,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Service {
    pub kind: ServiceKindName,
    /// Image reference; absent uses the kind's pinned default.
    #[serde(default)]
    pub image: Option<String>,
    /// Version/tag; absent uses the kind's pinned default.
    #[serde(default)]
    pub version: Option<String>,
    /// Service-specific configuration (env for the container).
    #[serde(default)]
    pub config: BTreeMap<String, String>,
    /// Health check command override; absent uses the kind's default probe.
    #[serde(default)]
    pub health: Option<HealthCheck>,
    /// Named data volume; absent derives `<namespace>-<service>-data`.
    #[serde(default)]
    pub data_volume: Option<String>,
    /// Whether to provision a per-workspace slice of this service.
    #[serde(default = "default_true")]
    pub provision: bool,
    /// Upper bound for each provision/deprovision operation.
    #[serde(default = "default_provision_timeout")]
    pub provision_timeout: HumanDuration,
}

fn default_true() -> bool {
    true
}

fn default_provision_timeout() -> HumanDuration {
    HumanDuration::from_secs(120)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HealthCheck {
    /// Command run inside the service container.
    pub cmd: String,
    #[serde(default = "default_health_interval")]
    pub interval: HumanDuration,
    #[serde(default = "default_health_retries")]
    pub retries: u32,
}

fn default_health_interval() -> HumanDuration {
    HumanDuration::from_secs(5)
}
fn default_health_retries() -> u32 {
    5
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub command: String,
    /// Working directory; absent uses the workspace workdir.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Internal dependencies: run after these named tasks.
    #[serde(default)]
    pub after: Vec<String>,
    /// External dependencies: named services that must be healthy and, where
    /// declared, have their slice provisioned.
    #[serde(default)]
    pub requires: Vec<String>,
    /// Readiness (long-running) or completion (one-shot) check.
    #[serde(default)]
    pub check: Option<Check>,
    /// Environment exported for interpolation by dependent tasks.
    #[serde(default)]
    pub exports: BTreeMap<String, String>,
    /// Long-running tasks are not expected to exit and follow `restart`.
    #[serde(default)]
    pub long_running: bool,
    #[serde(default)]
    pub restart: RestartPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Check {
    /// Command in the workspace; exit 0 = satisfied.
    Exec {
        cmd: String,
        #[serde(default = "default_check_interval")]
        interval: HumanDuration,
        #[serde(default = "default_check_timeout")]
        timeout: HumanDuration,
    },
    /// Orchestrator-side GET against the workspace port; 2xx = satisfied.
    Http {
        port: u16,
        #[serde(default = "default_http_path")]
        path: String,
        #[serde(default = "default_check_interval")]
        interval: HumanDuration,
        #[serde(default = "default_check_timeout")]
        timeout: HumanDuration,
    },
    /// TCP connect against the workspace port.
    Port {
        port: u16,
        #[serde(default = "default_check_interval")]
        interval: HumanDuration,
        #[serde(default = "default_check_timeout")]
        timeout: HumanDuration,
    },
}

fn default_check_interval() -> HumanDuration {
    HumanDuration::from_secs(2)
}
fn default_check_timeout() -> HumanDuration {
    HumanDuration::from_secs(60)
}
fn default_http_path() -> String {
    "/".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(tag = "policy", rename_all = "kebab-case", deny_unknown_fields)]
pub enum RestartPolicy {
    #[default]
    Never,
    OnFailure {
        #[serde(default = "default_restart_max")]
        max: u32,
        #[serde(default = "default_backoff")]
        backoff: HumanDuration,
    },
    Always {
        #[serde(default = "default_backoff")]
        backoff: HumanDuration,
    },
}

fn default_restart_max() -> u32 {
    3
}
fn default_backoff() -> HumanDuration {
    HumanDuration::from_secs(5)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum VolumeMode {
    /// One volume shared read-write across workspaces.
    #[default]
    Shared,
    /// Each workspace gets its own copy at create and diverges harmlessly.
    CopyOnStart,
    /// Volume disabled.
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum VolumeClassName {
    #[default]
    Cache,
    Tools,
    Sync,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VolumeDecl {
    #[serde(default)]
    pub class: VolumeClassName,
    /// Mount path inside workspace containers.
    pub path: String,
    #[serde(default)]
    pub mode: VolumeMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CloneStrategy {
    /// `git clone -s` against the read-only mirror mount (default).
    #[default]
    Shared,
    /// Full self-contained clone; no mirror mount.
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct Volumes {
    /// Clone strategy for workspace source volumes.
    #[serde(default)]
    pub clone: CloneStrategy,
    /// Named cache/tools/sync volumes.
    #[serde(default)]
    pub named: BTreeMap<String, VolumeDecl>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Capture {
    #[serde(default = "default_capture_interval")]
    pub interval: HumanDuration,
    /// How long shadow refs outlive the workspaces that produced them.
    #[serde(default = "default_retention")]
    pub retention: HumanDuration,
    /// Cadence of shadow maintenance (ref pruning + gc).
    #[serde(default = "default_maintenance")]
    pub maintenance: HumanDuration,
}

fn default_capture_interval() -> HumanDuration {
    HumanDuration::from_secs(10 * 60)
}
fn default_retention() -> HumanDuration {
    HumanDuration::from_secs(30 * 86400)
}
fn default_maintenance() -> HumanDuration {
    HumanDuration::from_secs(86400)
}

impl Default for Capture {
    fn default() -> Self {
        Self {
            interval: default_capture_interval(),
            retention: default_retention(),
            maintenance: default_maintenance(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ObserveDepth {
    /// `status --porcelain=v2` with counts, bounded.
    #[default]
    Full,
    /// A dirty/clean bit via `diff --quiet`.
    Cheap,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Observe {
    #[serde(default = "default_observe_interval")]
    pub interval: HumanDuration,
    #[serde(default)]
    pub depth: ObserveDepth,
    /// Cap on counted dirty entries before truncation.
    #[serde(default = "default_status_cap")]
    pub status_cap: u32,
}

fn default_observe_interval() -> HumanDuration {
    HumanDuration::from_secs(60)
}
fn default_status_cap() -> u32 {
    10_000
}

impl Default for Observe {
    fn default() -> Self {
        Self {
            interval: default_observe_interval(),
            depth: ObserveDepth::default(),
            status_cap: default_status_cap(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Secret {
    /// Mount path inside the container; absent mounts at
    /// `/run/envmux/secrets/<name>`.
    #[serde(default)]
    pub mount: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Lease {
    /// Initial lifetime stamped at creation.
    #[serde(default = "default_lease_initial")]
    pub initial: HumanDuration,
    /// Extension applied on brokered read-write attach.
    #[serde(default = "default_attach_extension")]
    pub attach_extension: HumanDuration,
    /// Maximum concurrent live workspaces in the namespace.
    #[serde(default = "default_max_workspaces")]
    pub max_workspaces: u32,
}

fn default_lease_initial() -> HumanDuration {
    HumanDuration::from_secs(7 * 86400)
}
fn default_attach_extension() -> HumanDuration {
    HumanDuration::from_secs(86400)
}
fn default_max_workspaces() -> u32 {
    32
}

impl Default for Lease {
    fn default() -> Self {
        Self {
            initial: default_lease_initial(),
            attach_extension: default_attach_extension(),
            max_workspaces: default_max_workspaces(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_terminal_choice_distinguishes_reserved_words_from_commands() {
        let cfg: Config = toml::from_str("[image]\nreference = \"x:1\"").expect("minimal config");
        let mut ws = cfg.workspace;
        // Unset and "shell" both mean the image's own shell: no command.
        assert_eq!(ws.terminal_command(), None);
        assert!(!ws.terminal_is_manage());
        ws.terminal = Some("shell".into());
        assert_eq!(ws.terminal_command(), None);
        // "manage" never attaches, so it is not a window command either.
        ws.terminal = Some("manage".into());
        assert_eq!(ws.terminal_command(), None);
        assert!(ws.terminal_is_manage());
        // Everything else is a command line, passed through whole.
        ws.terminal = Some("claude --continue".into());
        assert_eq!(ws.terminal_command(), Some("claude --continue"));
        assert!(!ws.terminal_is_manage());
    }

    #[test]
    fn minimal_config_parses_with_defaults() {
        let cfg: Config = toml::from_str(
            r#"
            [image]
            reference = "ghcr.io/envmux/default:latest"
            "#,
        )
        .unwrap();
        assert_eq!(cfg.meta.schema, 2);
        assert_eq!(cfg.lease.initial.as_secs(), 7 * 86400);
        assert_eq!(cfg.lease.attach_extension.as_secs(), 86400);
        assert_eq!(cfg.capture.interval.as_secs(), 600);
        assert_eq!(cfg.workspace.workdir, "/work");
        assert_eq!(cfg.volumes.clone, CloneStrategy::Shared);
    }

    #[test]
    fn full_config_round_trips() {
        let src = r#"
            [meta]
            schema = 1
            namespace = "acme"

            [image]
            reference = "ghcr.io/acme/dev:1.0"

            [mirror]
            fetch = "periodic"
            interval = "10m"

            [workspace]
            workdir = "/work/acme"
            user = "dev"
            naming = "branch"
            cpus = 4.0
            memory = "8g"
            dangerously_mount_docker_socket = true

            [services.db]
            kind = "postgres"
            version = "16"

            [services.cache]
            kind = "redis"
            provision = false

            [tasks.migrate]
            command = "cargo run -p migrations"
            requires = ["db"]

            [tasks.dev]
            command = "cargo run"
            after = ["migrate"]
            long_running = true
            check = { kind = "port", port = 8080 }
            restart = { policy = "on-failure", max = 5 }

            [volumes.named.cargo]
            class = "cache"
            path = "/home/dev/.cargo"

            [routes]
            web = 8080
            editor = 3000

            [secrets.api-key]
            mount = "/run/envmux/secrets/api-key"

            [lease]
            initial = "3d"

            [env]
            RUST_LOG = "debug"
        "#;
        let cfg: Config = toml::from_str(src).unwrap();
        assert_eq!(cfg.meta.namespace.as_deref(), Some("acme"));
        assert_eq!(cfg.services.len(), 2);
        assert_eq!(cfg.tasks["dev"].after, vec!["migrate"]);
        assert!(matches!(
            cfg.tasks["dev"].restart,
            RestartPolicy::OnFailure { max: 5, .. }
        ));
        assert_eq!(cfg.routes["web"], 8080);
        assert!(cfg.workspace.dangerously_mount_docker_socket);
        assert_eq!(cfg.lease.initial.as_secs(), 3 * 86400);

        // Round-trip through toml and back preserves the model.
        let text = toml::to_string(&cfg).unwrap();
        let back: Config = toml::from_str(&text).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn the_editor_section_parses_and_defaults_sensibly() {
        // Absent entirely: discovery, window reuse, root fallback.
        let cfg: Config = toml::from_str("[image]\nreference = 'x'\n").unwrap();
        assert_eq!(cfg.editor, Editor::default());
        assert_eq!(cfg.editor.path, None);
        assert_eq!(cfg.editor.window, EditorWindow::Reuse);
        assert_eq!(cfg.editor.default_folder, "/");
        assert!(cfg.editor.folders.is_empty());

        let cfg: Config = toml::from_str(
            r#"
            [image]
            reference = "x"
            [editor]
            path = "/usr/local/bin/code"
            window = "new"
            default_folder = "/srv"
            [editor.folders]
            wobbly-otter = "/work/backend"
            "#,
        )
        .unwrap();
        assert_eq!(cfg.editor.path.as_deref(), Some("/usr/local/bin/code"));
        assert_eq!(cfg.editor.window, EditorWindow::New);
        assert_eq!(cfg.editor.default_folder, "/srv");
        assert_eq!(
            cfg.editor.folders.get("wobbly-otter").map(String::as_str),
            Some("/work/backend")
        );

        // Round-trips like every other section.
        let text = toml::to_string(&cfg).unwrap();
        let back: Config = toml::from_str(&text).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn editor_unknown_keys_and_window_values_are_rejected() {
        let err = toml::from_str::<Config>(
            "[image]\nreference = 'x'\n[editor]\nbinary = '/usr/bin/code'\n",
        )
        .unwrap_err();
        assert!(err.to_string().contains("binary"), "{err}");

        // Only "reuse" and "new" are window modes.
        assert!(
            toml::from_str::<Config>("[image]\nreference = 'x'\n[editor]\nwindow = 'maximised'\n")
                .is_err()
        );
    }

    #[test]
    fn unknown_keys_are_rejected() {
        let err = toml::from_str::<Config>(
            r#"
            [image]
            reference = "x"
            [workspace]
            workdri = "/typo"
            "#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("workdri"));
    }
}

#[cfg(test)]
mod routing_tests {
    use super::*;

    #[test]
    fn hosts_are_a_single_label_under_the_domain() {
        let r = Routing::default();
        assert_eq!(
            r.host_for("acme", "wobbly-otter", "web"),
            format!("acme_wobbly-otter_web.{}", r.effective_domain())
        );
        // One label is the whole point: it is what a `*.domain` certificate
        // can cover. Anything nested would need a certificate per workspace.
        let host = r.host_for("acme", "ws", "editor");
        let label = host
            .strip_suffix(&format!(".{}", r.effective_domain()))
            .unwrap();
        assert!(!label.contains('.'), "the host label must not nest: {host}");
    }

    #[test]
    fn the_default_domain_is_platform_specific() {
        // Windows resolves *.localhost unreliably even in browsers, so the
        // default there is public wildcard DNS to loopback.
        let r = Routing::default();
        assert_eq!(r.domain, None);
        #[cfg(windows)]
        assert_eq!(r.effective_domain(), "strigops.xyz");
        #[cfg(not(windows))]
        assert_eq!(r.effective_domain(), "localhost");
    }

    #[test]
    fn the_delimiter_cannot_collide_with_generated_names() {
        // Workspace names are petnames, and branch naming appends a suffix:
        // lowercase ASCII and hyphens throughout. The delimiter must not be
        // one of those, or a name would split the host into the wrong fields.
        let r = Routing::default();
        assert!(!r.delimiter.contains('-'));
        assert!(!r.delimiter.chars().any(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn wildcard_sans_cover_the_scheme() {
        let r = Routing::default();
        let domain = r.effective_domain().to_owned();
        assert_eq!(r.wildcard_sans(), vec![format!("*.{domain}"), domain]);
    }

    #[test]
    fn domain_delimiter_and_port_are_configurable() {
        let cfg: Config = toml::from_str(
            "[image]\nreference = 'x'\n[routing]\nport = 8443\ndomain = 'dev.example.test'\ndelimiter = '--'\n",
        )
        .expect("parses");
        assert_eq!(cfg.routing.port, Some(8443));
        assert_eq!(cfg.routing.effective_domain(), "dev.example.test");
        assert_eq!(
            cfg.routing.host_for("acme", "ws", "web"),
            "acme--ws--web.dev.example.test"
        );
    }

    #[test]
    fn the_router_port_defaults_to_none() {
        // None means "the router's default, with fallback" — the config layer
        // deliberately does not know the number.
        let cfg: Config = toml::from_str("[image]\nreference = 'x'\n[routing]\ndelimiter = '_'\n")
            .expect("parses");
        assert_eq!(cfg.routing.port, None);
    }
}
