//! Shared daemon context: database, Docker handle, secrets chain, and the
//! per-namespace runtime registry. Components read shared state through this
//! and the database — no `Arc<Mutex<World>>`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use envmux_config::ResolvedConfig;
use envmux_core::NamespaceName;
use envmux_docker::{DiskUsageCache, DockerHandle};
use envmux_git::{GitRunner, Mirror, ShadowRepo};
use tokio::sync::{Mutex, RwLock, broadcast};

use crate::state::Db;
use crate::tasks_engine::TaskStatusMap;

/// One namespace's live runtime: paths, serialization locks, resolved config.
pub struct NamespaceCtx {
    pub name: NamespaceName,
    /// Host directory of the repository this namespace was registered from.
    pub repo_dir: PathBuf,
    /// Resolved at registration; re-resolved on demand for drift/info calls.
    pub resolved: RwLock<ResolvedConfig>,
    pub mirror: Mirror,
    pub shadow: ShadowRepo,
    /// The repository's real remote: what workspaces' `origin` points at and
    /// what the credential shim allowlists. Distinct from the mirror's clone
    /// source, which in v2 is the local repository itself.
    pub origin_remote: String,
    /// Serializes mirror fetches per namespace.
    pub mirror_lock: Mutex<()>,
    /// Serializes capture against shadow maintenance per namespace.
    pub shadow_lock: Mutex<()>,
    /// Image reference/tag this namespace's containers run.
    pub image: String,
}

impl NamespaceCtx {
    #[must_use]
    pub fn network_name(&self) -> String {
        format!("envmux-{}", self.name)
    }

    #[must_use]
    pub fn base_container_name(&self) -> String {
        format!("envmux-{}-base", self.name)
    }

    #[must_use]
    pub fn service_container_name(&self, service: &str) -> String {
        format!("envmux-{}-svc-{}", self.name, service)
    }

    #[must_use]
    pub fn workspace_container_name(&self, workspace: &str) -> String {
        format!("envmux-{}-ws-{}", self.name, workspace)
    }

    #[must_use]
    pub fn source_volume_name(&self, workspace: &str) -> String {
        format!("envmux-{}-src-{}", self.name, workspace)
    }
}

/// The daemon-wide context handed to every component.
pub struct Ctx {
    pub db: Db,
    pub docker: DockerHandle,
    pub secrets: Arc<envmux_secrets::Chain>,
    pub git: GitRunner,
    pub state_dir: PathBuf,
    pub namespaces: RwLock<HashMap<String, Arc<NamespaceCtx>>>,
    pub disk: DiskUsageCache,
    /// Disk alert threshold as a percent of total disk.
    pub disk_threshold_percent: u8,
    /// Live task status per workspace id (engine writes, observer reads).
    pub task_status: TaskStatusMap,
    /// Fan-out for the events WS stream.
    pub events_tx: broadcast::Sender<envmux_api_types::EventRecord>,
    /// Capability required on local IPC (defense in depth for named pipes).
    pub ipc_token: String,
    /// Client liveness for the ephemeral daemon's dead-man switch: every
    /// in-flight IPC request and open attach stream counts, and the idle
    /// worker shuts the world down once none have existed for the grace
    /// period.
    pub activity: Arc<crate::workers::idle::Activity>,
    /// Serializes namespace registration. IPC now opens before boot
    /// rehydration, so an on-demand register can arrive while rehydration is
    /// mid-flight for the same namespace; one lock makes those strictly
    /// sequential, and the second entrant adopts what the first built.
    pub register_lock: tokio::sync::Mutex<()>,
    /// Process-wide graceful shutdown trigger (signals, API, supervision).
    pub shutdown: tokio_util::sync::CancellationToken,
    /// The loopback port the in-session router actually bound, recorded once
    /// at bind time so API summaries can print real URLs.
    pub router_port: std::sync::OnceLock<u16>,
}

pub type SharedCtx = Arc<Ctx>;

impl Ctx {
    pub async fn namespace(&self, name: &str) -> Option<Arc<NamespaceCtx>> {
        self.namespaces.read().await.get(name).cloned()
    }

    /// Record an audit event in the database and fan it out to WS listeners.
    pub async fn event(
        &self,
        level: &str,
        namespace: Option<&str>,
        workspace: Option<&str>,
        component: &str,
        message: &str,
    ) {
        if let Err(e) = self
            .db
            .record_event(level, namespace, workspace, component, message)
            .await
        {
            tracing::warn!(error = %e, "failed to record event");
        }
        let _ = self.events_tx.send(envmux_api_types::EventRecord {
            id: 0,
            at: jiff::Timestamp::now().to_string(),
            level: level.to_owned(),
            namespace: namespace.map(str::to_owned),
            workspace: workspace.map(str::to_owned),
            component: component.to_owned(),
            message: message.to_owned(),
        });
    }

    /// The mirror's host-side path. It lives in the state dir (host
    /// filesystem) and is bind-mounted into containers, because host git must
    /// reach it directly on every platform.
    #[must_use]
    pub fn mirror_dir(&self, ns: &str) -> PathBuf {
        self.state_dir.join("namespaces").join(ns).join("mirror")
    }

    /// Where the shadow lived before it moved into the project's
    /// `.envmux/git`. Only namespace registration reads this, to migrate an
    /// old repo into place — never use it for the live shadow path.
    #[must_use]
    pub fn shadow_dir(&self, ns: &str) -> PathBuf {
        self.state_dir.join("namespaces").join(ns).join("shadow")
    }
}

// The state directory is resolved by `envmux_core::state_dir_with_kind`. It
// lives there because the daemon and the CLI must land in the same directory
// or the CLI reads credentials the daemon never wrote — a disagreement that
// surfaces as a bare 401, nowhere near its cause.
