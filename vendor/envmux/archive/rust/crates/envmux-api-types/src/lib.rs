//! Request/response DTOs shared by the daemon and the CLI. This crate is the
//! single source of truth for the wire.
//!
//! Wire conventions: JSON everywhere; timestamps are RFC 3339 UTC strings;
//! the API is `/v1` and additive-only until `/v2`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub use envmux_core::{ReapStep, WorkspaceState};

/// RFC 3339 UTC timestamp on the wire.
pub type Rfc3339 = String;

// ---------------------------------------------------------------------------
// Namespaces

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct NamespaceSummary {
    pub name: String,
    pub repo_remote: Option<String>,
    pub created_at: Rfc3339,
    pub mirror_last_fetch: Option<Rfc3339>,
    pub mirror_fetch_mode: String,
    pub workspaces: u32,
    pub services: Vec<ServiceSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MirrorFetchResponse {
    pub fetched_at: Rfc3339,
}

// ---------------------------------------------------------------------------
// Workspaces

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct WorkspaceSummary {
    pub id: String,
    pub namespace: String,
    pub name: String,
    pub state: WorkspaceState,
    pub branch_requested: String,
    pub config_hash: String,
    /// Whether the config hash still matches the active file (information,
    /// not a prompt to migrate).
    pub config_current: bool,
    pub created_at: Rfc3339,
    pub death_date: Option<Rfc3339>,
    pub container_id: Option<String>,
    pub observation: Option<Observation>,
    /// Routed URLs for this workspace's declared ports, keyed by route name.
    pub routes: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CreateWorkspaceRequest {
    /// Explicit repo reference; absent uses the namespace mirror remote.
    pub repo: Option<String>,
    pub branch: Option<String>,
    /// Requested name; absent generates one per the naming strategy.
    pub name: Option<String>,
    /// Creation-time overrides (highest precedence), TOML text fragment.
    pub overrides: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CreateWorkspaceResponse {
    pub workspace: WorkspaceSummary,
    /// True when an existing live workspace of the same name was reused.
    pub reused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", tag = "op")]
pub enum LeaseRequest {
    /// Extend by a duration from now (e.g. "24h").
    Extend { by: String },
    /// Set the death date outright.
    Until { at: Rfc3339 },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LeaseResponse {
    pub death_date: Option<Rfc3339>,
    pub pinned: bool,
}

// ---------------------------------------------------------------------------
// Observation

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Observation {
    pub observed_at: Rfc3339,
    pub branch: Option<String>,
    pub head: Option<String>,
    /// Dirty file count; `None` in cheap mode when the tree is dirty but
    /// uncounted. Pair with `dirty`.
    pub dirty_files: Option<u32>,
    pub dirty: bool,
    /// Counts truncated at the configured cap.
    pub truncated: bool,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub tasks: Vec<TaskStatus>,
    pub last_attach_at: Option<Rfc3339>,
    pub last_capture_at: Option<Rfc3339>,
    /// Repository state flags: rebase/merge/conflict markers.
    pub flagged_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TaskStatus {
    pub name: String,
    pub state: TaskState,
    pub exit_code: Option<i32>,
    pub restarts: u32,
}

// ---------------------------------------------------------------------------
// Task graph

/// The declared task graph of one workspace, joined with live status.
///
/// Read from the workspace's frozen `config_toml` rather than the current file
/// on disk: a workspace is a product of the configuration it was created from
/// and is never upgraded in place (CONCEPT §13), so this is what it is
/// *actually* running, not what the repository declares today.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TaskGraph {
    pub workspace_id: String,
    pub workspace_name: String,
    pub config_hash: String,
    /// Whether `config_hash` still matches the active file — information, not
    /// a prompt to migrate.
    pub config_current: bool,
    pub tasks: Vec<TaskNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TaskNode {
    pub name: String,
    pub command: String,
    pub cwd: Option<String>,
    /// Internal dependencies: tasks that must run first.
    pub after: Vec<String>,
    /// External dependencies: services that must be healthy.
    pub requires: Vec<String>,
    pub long_running: bool,
    /// Restart policy, rendered for display (`never`, `on-failure max=3 ...`).
    pub restart: String,
    /// Readiness/completion check, rendered for display.
    pub check: Option<String>,
    pub exports: std::collections::BTreeMap<String, String>,
    /// Live status; absent when the engine has not reported this task yet.
    pub status: Option<TaskStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Waiting,
    Running,
    Ready,
    Exited,
    Failed,
}

// ---------------------------------------------------------------------------
// Captures / shadow history

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CaptureSummary {
    pub id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub branch: Option<String>,
    pub captured_at: Rfc3339,
    pub shadow_ref: String,
    pub commit_oid: String,
    pub torn: bool,
    pub flagged_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FromCaptureRequest {
    pub capture_id: String,
    pub name: Option<String>,
}

// ---------------------------------------------------------------------------
// Services / slices

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ServiceSummary {
    pub name: String,
    pub kind: String,
    pub image: String,
    pub healthy: Option<bool>,
    pub container_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SliceSummary {
    pub id: String,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub service: String,
    pub slice_key: String,
    pub state: String,
    pub created_at: Rfc3339,
    pub last_error: Option<String>,
    /// True when the slice exists server-side with no live workspace behind it.
    pub orphan: bool,
}

// ---------------------------------------------------------------------------
// Config / disk / events

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConfigInfo {
    pub active_file: String,
    pub path: String,
    pub hash: String,
    pub drift: DriftInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum DriftInfo {
    NotApplicable,
    Untracked,
    Clean,
    BaseMoved { recorded: String, current: String },
    BaseMissing,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DiskReport {
    pub polled_at: Rfc3339,
    pub total_bytes: u64,
    pub threshold_percent: u8,
    pub alert: bool,
    pub items: Vec<DiskItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DiskItem {
    pub namespace: Option<String>,
    pub workspace: Option<String>,
    pub class: Option<String>,
    pub volume: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EventRecord {
    pub id: i64,
    pub at: Rfc3339,
    pub level: String,
    pub namespace: Option<String>,
    pub workspace: Option<String>,
    pub component: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// File transfer

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified: Option<Rfc3339>,
}

// ---------------------------------------------------------------------------
// Terminal attach WS control frames

/// Client → server text frames on an attach WebSocket. Binary frames are raw
/// PTY bytes.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AttachControl {
    Resize { cols: u16, rows: u16 },
    Mode { mode: AttachMode },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AttachMode {
    Rw,
    Ro,
}

/// Server → client text frames: task/window events.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", tag = "event")]
pub enum AttachEvent {
    WindowChanged {
        task: String,
    },
    TaskExited {
        task: String,
        exit_code: Option<i32>,
    },
    /// The client left a session that is still standing. Nothing to reopen.
    Detached,
    /// The other end is gone: the terminal's program exited, closing its
    /// window and — if it was the last one — the tmux session with it. The
    /// stream looks identical to a detach, which is why the daemon says which
    /// it was: a read-write client reconnects on this and lands in a fresh
    /// terminal, instead of reporting a dead socket at someone who typed
    /// `exit`.
    TerminalExited,
}

// ---------------------------------------------------------------------------
// Errors

/// Uniform error body for non-2xx responses.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_control_wire_shape() {
        let f: AttachControl = serde_json::from_str(r#"{"resize":{"cols":80,"rows":24}}"#).unwrap();
        assert!(matches!(f, AttachControl::Resize { cols: 80, rows: 24 }));
        let f: AttachControl = serde_json::from_str(r#"{"mode":{"mode":"ro"}}"#).unwrap();
        assert!(matches!(
            f,
            AttachControl::Mode {
                mode: AttachMode::Ro
            }
        ));
    }

    /// The two ways an attach ends are told apart on the wire, and the client
    /// decides whether to reconnect by reading them.
    #[test]
    fn attach_events_name_how_the_session_ended() {
        assert_eq!(
            serde_json::to_string(&AttachEvent::TerminalExited).unwrap(),
            r#"{"event":"terminal_exited"}"#
        );
        assert_eq!(
            serde_json::to_string(&AttachEvent::Detached).unwrap(),
            r#"{"event":"detached"}"#
        );
        let e: AttachEvent = serde_json::from_str(r#"{"event":"terminal_exited"}"#).unwrap();
        assert!(matches!(e, AttachEvent::TerminalExited));
    }

    #[test]
    fn schemas_generate() {
        // Client types can be generated from these schemas; make
        // sure generation itself never panics.
        let _ = schemars::schema_for!(WorkspaceSummary);
        let _ = schemars::schema_for!(CreateWorkspaceRequest);
        let _ = schemars::schema_for!(Observation);
        let _ = schemars::schema_for!(DiskReport);
    }
}
