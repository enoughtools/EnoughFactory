//! tmux control-mode client over an exec stream.
//!
//! The daemon holds one long-lived exec per workspace running
//! `tmux -CC -u attach -t envmux`. [`protocol`] turns the control-mode wire
//! format (`%begin`/`%end`/`%error` framed replies, `%output`, `%window-add`,
//! `%exit`, …) into typed events; [`client::TmuxClient`] writes commands as
//! lines and matches replies by the begin/end framing.
//!
//! Control-mode features used are restricted to the tmux ≥ 3.2 baseline; the
//! base-container verification step runs `tmux -V` and refuses older images.

pub mod client;
pub mod protocol;
pub mod wrap;

pub use client::{TmuxClient, TmuxError, WindowInfo};
pub use protocol::{ControlEvent, Parser, Reply};
pub use wrap::{sh_quote, wrap_task_command};

/// The one session name envmux uses inside every workspace container.
pub const SESSION: &str = "envmux";

/// The session's interactive window: the one a plain attach lands in, running
/// `[workspace] terminal`.
///
/// It is named rather than left to an index because its program is *allowed*
/// to exit — that is what `exit` means — and a reconnect has to find it, or
/// find it missing, by something stable. Windows come and go around it; the
/// name is reserved for this one.
pub const TERMINAL_WINDOW: &str = "terminal";

/// Directory inside the workspace where task exit files land.
pub const RUN_DIR: &str = "/run/envmux";
