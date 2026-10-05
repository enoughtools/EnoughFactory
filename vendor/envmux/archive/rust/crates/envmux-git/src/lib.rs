//! The git subsystem.
//!
//! Policy: the system `git` binary is the execution engine for anything that
//! mutates or must match git's exact semantics. Two hard rules:
//!
//! 1. In-workspace git always runs *inside the container* (via exec), using
//!    the image's git — never the host's. This crate therefore ships the
//!    container-side operations as versioned, embedded shell scripts
//!    ([`scripts`]) plus parsers for their structured output; the daemon
//!    wires them to Docker exec.
//! 2. Mirror and shadow git runs on the host against the mounted volumes
//!    ([`host`], [`mirror`], [`shadow`]), using a pinned minimum git version
//!    checked at daemon start.

pub mod host;
pub mod mirror;
pub mod scripts;
pub mod shadow;

pub use host::{GitError, GitRunner};
pub use mirror::Mirror;
pub use scripts::{
    CaptureOutcome, CloneParams, ObservationData, parse_capture_output, parse_observation_output,
};
pub use shadow::{ShadowRepo, SnapshotRef};

/// Minimum host git version envmux requires (checked at daemon start).
pub const MIN_GIT_VERSION: (u32, u32) = (2, 40);

/// Minimum tmux version — recorded here alongside the other substrate pin so
/// base-container verification has one place to read both.
pub const MIN_TMUX_VERSION: (u32, u32) = (3, 2);
