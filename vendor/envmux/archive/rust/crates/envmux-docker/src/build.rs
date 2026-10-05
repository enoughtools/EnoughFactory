//! Image building by orchestrating the `docker` CLI.
//!
//! envmux drives the engine through the API for everything it *owns* —
//! labelled creates, filtered lists, exec, file transfer. Building is
//! deliberately not one of those things. The API's `/build` takes a context
//! tar the client must assemble, which means reimplementing `.dockerignore` (a
//! client-side convention the daemon never sees), holding the whole context in
//! memory, and streaming it in one request. `docker build` already does all of
//! that — correctly, with BuildKit, incrementally, and identically on Linux,
//! macOS, and Windows.
//!
//! So envmux orchestrates the build rather than implementing it: no bespoke
//! context packing, no bespoke ignore matcher, no large in-memory buffer, and
//! no named-pipe upload to get wrong.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt as _, BufReader};
use tokio::process::Command;

use crate::DockerError;

/// A `docker` invocation that never opens a console window.
///
/// The v2 daemon runs detached with no console; on Windows a console-subsystem
/// child of a console-less parent gets a brand-new console window — a blank
/// black box in the foreground for the whole build, showing nothing because
/// the output goes to our pipes. `CREATE_NO_WINDOW` suppresses it.
fn docker_command() -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new("docker");
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// How many trailing output lines to quote when a build fails.
const ERROR_TAIL_LINES: usize = 40;

/// Everything needed to invoke `docker build`.
#[derive(Debug, Clone)]
pub struct BuildRequest {
    pub tag: String,
    /// Dockerfile path on the host.
    pub dockerfile: PathBuf,
    /// Build context directory on the host.
    pub context: PathBuf,
    pub build_args: BTreeMap<String, String>,
}

/// Build the argument vector for `docker`.
///
/// Split out from the spawn so the command line is unit-testable without a
/// Docker daemon — the shape of this argv is the whole contract with the CLI.
#[must_use]
pub fn build_argv(request: &BuildRequest) -> Vec<String> {
    let mut argv = vec![
        "build".to_owned(),
        "--tag".to_owned(),
        request.tag.clone(),
        "--file".to_owned(),
        request.dockerfile.display().to_string(),
    ];
    for (key, value) in &request.build_args {
        argv.push("--build-arg".to_owned());
        argv.push(format!("{key}={value}"));
    }
    // Line-oriented output: the fancy TTY renderer rewrites in place, which is
    // noise in a log file and useless in an error message.
    argv.push("--progress=plain".to_owned());
    argv.push(request.context.display().to_string());
    argv
}

/// Whether this docker CLI has BuildKit (the buildx component).
///
/// `--progress=plain` is a BuildKit flag; the legacy builder dies on it with
/// `unknown flag: --progress` before building anything. Debian's `docker.io`
/// client ships without buildx, and that is exactly what runs inside the
/// dind demo — so a build that works on the host fails one level down
/// unless the flag is dropped where BuildKit is absent.
pub async fn buildkit_available() -> bool {
    docker_command()
        .args(["buildx", "version"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Verify the `docker` CLI is usable, returning its client version.
///
/// Checked when a build is actually needed rather than at daemon start: a
/// namespace that pulls an image by reference never builds, and should not be
/// blocked by a missing CLI.
pub async fn cli_version() -> Result<String, DockerError> {
    let out = docker_command()
        .args(["version", "--format", "{{.Client.Version}}"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| {
            DockerError::Build(format!(
                "the `docker` CLI is required to build an image from a Dockerfile, \
                 and could not be run: {e}. Install the Docker CLI, or declare \
                 `[image] reference` to pull a prebuilt image instead."
            ))
        })?;
    if !out.status.success() {
        return Err(DockerError::Build(format!(
            "`docker version` failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// Run `docker build`, streaming its output to `on_line` as it arrives.
///
/// Output is streamed rather than captured wholesale so a long build is
/// observable while it runs; only the tail is retained for the error message.
pub async fn build_image(
    request: &BuildRequest,
    mut on_line: impl FnMut(&str) + Send,
) -> Result<(), DockerError> {
    if !request.dockerfile.is_file() {
        return Err(DockerError::Build(format!(
            "dockerfile {} does not exist",
            request.dockerfile.display()
        )));
    }
    if !request.context.is_dir() {
        return Err(DockerError::Build(format!(
            "build context {} is not a directory",
            request.context.display()
        )));
    }

    let mut argv = build_argv(request);
    if !buildkit_available().await {
        tracing::info!("docker CLI has no buildx; using the legacy builder");
        argv.retain(|arg| arg != "--progress=plain");
    }
    tracing::info!(tag = request.tag, args = ?argv, "docker build");

    let mut child = docker_command()
        .args(&argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // BuildKit writes progress to stderr; both are captured so the caller
        // sees the whole build.
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            DockerError::Build(format!(
                "could not run `docker build`: {e}. Install the Docker CLI, or \
                 declare `[image] reference` to pull a prebuilt image instead."
            ))
        })?;

    let mut stdout = BufReader::new(child.stdout.take().expect("stdout piped")).lines();
    let mut stderr = BufReader::new(child.stderr.take().expect("stderr piped")).lines();

    let mut tail: Vec<String> = Vec::with_capacity(ERROR_TAIL_LINES);
    let mut record = |line: String, on_line: &mut dyn FnMut(&str)| {
        on_line(&line);
        if tail.len() == ERROR_TAIL_LINES {
            tail.remove(0);
        }
        tail.push(line);
    };

    // Read both streams until each is exhausted; `None` marks a closed stream
    // rather than the end of the build.
    let (mut out_open, mut err_open) = (true, true);
    while out_open || err_open {
        tokio::select! {
            line = stdout.next_line(), if out_open => match line {
                Ok(Some(line)) => record(line, &mut on_line),
                Ok(None) | Err(_) => out_open = false,
            },
            line = stderr.next_line(), if err_open => match line {
                Ok(Some(line)) => record(line, &mut on_line),
                Ok(None) | Err(_) => err_open = false,
            },
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| DockerError::Build(format!("waiting for `docker build`: {e}")))?;
    if status.success() {
        return Ok(());
    }
    Err(DockerError::Build(format!(
        "`docker build` failed ({}). Last output:\n{}",
        status
            .code()
            .map_or_else(|| "signal".to_owned(), |c| format!("exit {c}")),
        tail.join("\n")
    )))
}

/// Resolve a config-declared Dockerfile path against the repository root.
///
/// The config documents `dockerfile` as repository-relative; an absolute path
/// is honoured as given.
#[must_use]
pub fn resolve_dockerfile(repo_dir: &Path, dockerfile: &str) -> PathBuf {
    let candidate = Path::new(dockerfile);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        repo_dir.join(candidate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> BuildRequest {
        BuildRequest {
            tag: "envmux-demo:abc123".to_owned(),
            dockerfile: PathBuf::from("/repo/images/rust-node.Dockerfile"),
            context: PathBuf::from("/repo"),
            build_args: BTreeMap::new(),
        }
    }

    #[test]
    fn argv_has_tag_file_and_context() {
        let argv = build_argv(&request());
        assert_eq!(argv[0], "build");
        assert!(argv.contains(&"--tag".to_owned()));
        assert!(argv.contains(&"envmux-demo:abc123".to_owned()));
        assert!(argv.contains(&"--file".to_owned()));
        // The context is positional and must come last.
        assert_eq!(argv.last().unwrap(), &"/repo".to_string());
    }

    #[test]
    fn build_args_become_repeated_flags() {
        let mut r = request();
        r.build_args
            .insert("RUST_TOOLCHAIN".to_owned(), "1.95.0".to_owned());
        r.build_args
            .insert("NODE_MAJOR".to_owned(), "24".to_owned());
        let argv = build_argv(&r);
        // BTreeMap ordering keeps the command line deterministic, which makes
        // it reproducible and testable.
        let joined = argv.join(" ");
        assert!(joined.contains("--build-arg NODE_MAJOR=24"));
        assert!(joined.contains("--build-arg RUST_TOOLCHAIN=1.95.0"));
        assert_eq!(argv.iter().filter(|a| *a == "--build-arg").count(), 2);
    }

    #[test]
    fn progress_is_plain_so_output_is_line_oriented() {
        assert!(build_argv(&request()).contains(&"--progress=plain".to_owned()));
    }

    #[test]
    fn dockerfile_resolves_against_the_repository_root() {
        let repo = Path::new("/repo");
        assert_eq!(
            resolve_dockerfile(repo, "images/rust-node.Dockerfile"),
            PathBuf::from("/repo/images/rust-node.Dockerfile")
        );
        let abs = if cfg!(windows) {
            "C:/elsewhere/Dockerfile"
        } else {
            "/elsewhere/Dockerfile"
        };
        assert_eq!(resolve_dockerfile(repo, abs), PathBuf::from(abs));
    }

    #[tokio::test]
    async fn missing_dockerfile_is_reported_before_spawning() {
        let mut r = request();
        r.dockerfile = PathBuf::from("/definitely/not/here/Dockerfile");
        r.context = std::env::temp_dir();
        let err = build_image(&r, |_| {}).await.unwrap_err();
        assert!(
            err.to_string().contains("does not exist"),
            "unexpected: {err}"
        );
    }
}
