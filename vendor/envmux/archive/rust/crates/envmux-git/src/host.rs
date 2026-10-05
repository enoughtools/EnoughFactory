//! Host-side git execution: a small runner around the system `git` binary
//! used for mirror and shadow repositories on mounted volumes.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use thiserror::Error;
use tokio::process::Command;

#[derive(Debug, Error)]
pub enum GitError {
    #[error("git not found on the host: {0}")]
    Missing(String),
    #[error("host git {found} is older than required {required}")]
    TooOld { found: String, required: String },
    #[error("git {args:?} in {dir}: exit {code}: {stderr}")]
    Failed {
        args: Vec<String>,
        dir: String,
        code: i32,
        stderr: String,
    },
    #[error("io running git: {0}")]
    Io(#[from] std::io::Error),
    #[error("unexpected git output: {0}")]
    Parse(String),
}

/// Runs host git commands in a working directory.
#[derive(Debug, Clone)]
pub struct GitRunner {
    git: PathBuf,
}

/// A `git` invocation that never opens a console window.
///
/// The v2 daemon runs detached with no console. On Windows, a
/// console-subsystem child of a console-less parent gets a brand-new console
/// *window* allocated — a blank black box popping into the foreground for
/// every mirror fetch and shadow push. `CREATE_NO_WINDOW` suppresses it; the
/// output still arrives through the pipes, and a parent that does have a
/// console loses nothing.
pub(crate) fn quiet_command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

impl GitRunner {
    #[must_use]
    pub fn new() -> Self {
        Self {
            git: PathBuf::from("git"),
        }
    }

    #[must_use]
    pub fn with_binary(git: PathBuf) -> Self {
        Self { git }
    }

    /// Check the host git exists and meets [`crate::MIN_GIT_VERSION`].
    pub async fn verify_version(&self) -> Result<String, GitError> {
        let out = quiet_command(&self.git)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| GitError::Missing(e.to_string()))?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        // "git version 2.54.0.windows.1"
        let version = text
            .split_whitespace()
            .nth(2)
            .ok_or_else(|| GitError::Parse(text.clone()))?;
        let mut parts = version.split('.');
        let major: u32 = parts
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| GitError::Parse(text.clone()))?;
        let minor: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let (req_major, req_minor) = crate::MIN_GIT_VERSION;
        if (major, minor) < (req_major, req_minor) {
            return Err(GitError::TooOld {
                found: version.to_owned(),
                required: format!("{req_major}.{req_minor}"),
            });
        }
        Ok(version.to_owned())
    }

    /// Run git with args in `dir`; error on nonzero exit.
    pub async fn run(&self, dir: &Path, args: &[&str]) -> Result<String, GitError> {
        let out = quiet_command(&self.git)
            .args(args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;
        if !out.status.success() {
            return Err(GitError::Failed {
                args: args.iter().map(|s| (*s).to_owned()).collect(),
                dir: dir.display().to_string(),
                code: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Run git that may legitimately fail (e.g. probing); returns exit code.
    pub async fn try_run(
        &self,
        dir: &Path,
        args: &[&str],
    ) -> Result<(i32, String, String), GitError> {
        let out = quiet_command(&self.git)
            .args(args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;
        Ok((
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ))
    }
}

impl Default for GitRunner {
    fn default() -> Self {
        Self::new()
    }
}
