//! Domain types for envmux: validated newtypes, the workspace lifecycle state
//! machine, the label schema, and shared error types.
//!
//! This crate depends on nothing internal. Raw strings do not cross crate
//! boundaries — every name that identifies a domain object is a newtype with a
//! validated constructor.

pub mod error;
pub mod ids;
pub mod labels;
pub mod paths;
pub mod state;

pub use error::CoreError;
pub use ids::{
    ConfigHash, NamespaceName, ServiceName, SliceKey, TaskName, VolumeName, WorkspaceId,
    WorkspaceName,
};
pub use labels::{Labels, Role, VolumeClass};
pub use paths::{
    PORTABLE_DIR, PROJECT_DIR, StateDirKind, ipc_endpoint, project_state_dir, state_dir,
    state_dir_with_kind,
};
pub use state::{InvalidTransition, ReapStep, WorkspaceState};
