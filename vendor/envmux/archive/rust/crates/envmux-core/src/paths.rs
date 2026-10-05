//! Where envmux keeps its state.
//!
//! This lives in `envmux-core` because the daemon, the CLI, and the desktop
//! app must all agree. They previously each had their own copy, which is a
//! disagreement waiting to happen — and a disagreement here is invisible until
//! the CLI reads a credential the daemon never wrote and reports a bare 401.

use std::path::{Path, PathBuf};

/// The directory name that makes an installation portable.
pub const PORTABLE_DIR: &str = "state";

/// How the state directory was chosen. Worth surfacing: "where did my
/// workspaces go" is the obvious failure when a portable copy and an installed
/// one are both on the machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateDirKind {
    /// `$ENVMUX_STATE_DIR` — an explicit instruction, so it wins.
    Explicit,
    /// A `state` directory beside the executable.
    Portable,
    /// The platform data directory.
    Platform,
}

impl StateDirKind {
    /// A stable word for logs and `--json` output.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Explicit => "explicit",
            Self::Portable => "portable",
            Self::Platform => "installed",
        }
    }
}

/// Resolve the state directory, and say why.
///
/// Order:
///
/// 1. `$ENVMUX_STATE_DIR`, because being explicit should beat any heuristic.
/// 2. A `state` directory beside the executable — the portable case. Create
///    one next to an extracted archive and everything stays inside the folder:
///    mirrors, shadow history, the certificate authority, the database. Delete
///    the folder and nothing is left behind.
/// 3. The platform data directory, which is what an installed copy uses.
#[must_use]
pub fn state_dir_with_kind() -> (PathBuf, StateDirKind) {
    let explicit = std::env::var("ENVMUX_STATE_DIR").ok();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    resolve(explicit.as_deref(), exe_dir.as_deref())
}

/// The decision itself, with the environment passed in.
///
/// Separated so it can be tested without mutating process state — which
/// edition 2024 makes `unsafe`, and this workspace forbids, for the good
/// reason that another thread reading the environment mid-write is a real
/// hazard.
fn resolve(explicit: Option<&str>, exe_dir: Option<&Path>) -> (PathBuf, StateDirKind) {
    if let Some(dir) = explicit
        && !dir.trim().is_empty()
    {
        return (PathBuf::from(dir), StateDirKind::Explicit);
    }

    if let Some(portable) = exe_dir
        .map(|dir| dir.join(PORTABLE_DIR))
        .filter(|candidate| candidate.is_dir())
    {
        return (portable, StateDirKind::Portable);
    }

    let platform = dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("envmux");
    (platform, StateDirKind::Platform)
}

/// Resolve the state directory.
#[must_use]
pub fn state_dir() -> PathBuf {
    state_dir_with_kind().0
}

/// The directory a project keeps its envmux artifacts in, relative to the
/// repository root. Gitignored at onboarding; everything under it is
/// disposable except the shadow remote's history.
pub const PROJECT_DIR: &str = ".envmux";

/// The state directory for a v2 per-folder daemon: inside the project itself.
///
/// v2 scopes one daemon to one project directory. Keeping its state under the
/// project's own `.envmux/` means every project gets a distinct IPC endpoint
/// for free ([`ipc_endpoint`] already derives from the state dir), and
/// deleting the folder leaves nothing of envmux behind — the same property
/// the portable mode bought, now per project.
#[must_use]
pub fn project_state_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(PROJECT_DIR).join("state")
}

/// The local IPC endpoint for a daemon owning `state_dir`.
///
/// On Unix this is a socket file inside the state directory, so two daemons
/// with different state directories cannot collide. Windows named pipes have
/// no such natural scoping — they live in one machine-wide namespace — so the
/// name carries a digest of the state directory to buy the same property.
///
/// Without this, a portable daemon and an installed one race for `\\.\pipe\
/// envmux`, and a CLI resolving one state directory silently connects to the
/// daemon of the other. It then presents a credential from the wrong directory
/// and is rejected: a bare 401 whose cause is nowhere near it.
#[must_use]
pub fn ipc_endpoint(state_dir: &Path) -> String {
    #[cfg(windows)]
    {
        // Canonicalize so `state`, `.\state`, and a trailing separator agree.
        // It fails when the directory does not exist yet, which is fine: the
        // un-normalized path is stable for a given caller, and by the time a
        // client connects the daemon has created it.
        let canonical =
            std::fs::canonicalize(state_dir).unwrap_or_else(|_| state_dir.to_path_buf());
        let digest = blake3::hash(canonical.to_string_lossy().to_lowercase().as_bytes());
        format!(r"\\.\pipe\envmux-{}", &digest.to_hex()[..16])
    }
    #[cfg(unix)]
    {
        state_dir.join("daemon.sock").to_string_lossy().into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_directory_wins_over_a_portable_marker() {
        let dir = std::env::temp_dir();
        // Even with a portable marker present, an explicit instruction wins.
        let (path, kind) = resolve(Some("/tmp/explicit-envmux"), Some(&dir));
        assert_eq!(kind, StateDirKind::Explicit);
        assert_eq!(path, PathBuf::from("/tmp/explicit-envmux"));
    }

    #[test]
    fn an_empty_variable_is_not_an_instruction() {
        // An exported-but-empty variable is a shell accident, not a choice.
        let (_, kind) = resolve(Some("   "), None);
        assert_eq!(kind, StateDirKind::Platform);
    }

    #[test]
    fn a_state_directory_beside_the_executable_is_portable() {
        let root = std::env::temp_dir().join(format!("envmux-portable-{}", std::process::id()));
        let marker = root.join(PORTABLE_DIR);
        std::fs::create_dir_all(&marker).expect("create marker");

        let (path, kind) = resolve(None, Some(&root));
        assert_eq!(kind, StateDirKind::Portable);
        assert_eq!(path, marker);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn without_a_marker_it_falls_back_to_the_platform_directory() {
        let empty = std::env::temp_dir().join(format!("envmux-nomarker-{}", std::process::id()));
        std::fs::create_dir_all(&empty).expect("create dir");

        let (path, kind) = resolve(None, Some(&empty));
        assert_eq!(kind, StateDirKind::Platform);
        assert!(path.ends_with("envmux"));

        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn different_state_directories_get_different_ipc_endpoints() {
        // The whole point: a portable daemon and an installed one must not
        // share an endpoint, or each CLI reaches whichever started first.
        let a = std::env::temp_dir().join("envmux-ipc-a");
        let b = std::env::temp_dir().join("envmux-ipc-b");
        assert_ne!(ipc_endpoint(&a), ipc_endpoint(&b));
        // ...and the same directory must resolve identically every time, or
        // the daemon and the CLI never meet at all.
        assert_eq!(ipc_endpoint(&a), ipc_endpoint(&a));
    }

    #[test]
    fn a_file_named_state_does_not_make_it_portable() {
        // Only a directory counts; a stray file must not silently redirect
        // every mirror and certificate.
        let root = std::env::temp_dir().join(format!("envmux-statefile-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create dir");
        std::fs::write(root.join(PORTABLE_DIR), b"not a directory").expect("write");

        assert_eq!(resolve(None, Some(&root)).1, StateDirKind::Platform);

        let _ = std::fs::remove_dir_all(&root);
    }
}
