//! Spawning the editor: hand off and get out of the way.
//!
//! The editor is a GUI with its own lifetime; envmux's job ends at a
//! successful spawn. So: no shell, ever — the URI travels as one argv element
//! through `Command` — stdin and stdout to null, stderr piped, and a detached
//! reap thread that waits the child out so nothing zombies and a fast
//! non-zero exit still surfaces as a late warning. Never `--wait`, never a
//! blocked UI.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use super::EditorError;

/// Exactly what will be executed — built once, inspectable by tests.
#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub editor: PathBuf,
    pub uri: String,
    /// `--new-window` per `[editor] window = "new"`.
    pub new_window: bool,
    /// Propagated from the envmux process env when set, so the editor's own
    /// docker calls talk to the same daemon envmux inspected.
    pub docker_host: Option<String>,
}

impl LaunchPlan {
    /// The argv after the program: the URI is always a single element, and
    /// `--folder-uri` is always its own — no `=`-joining, no re-parsing.
    fn args(&self) -> Vec<&str> {
        let mut args = Vec::with_capacity(3);
        if self.new_window {
            args.push("--new-window");
        }
        args.push("--folder-uri");
        args.push(self.uri.as_str());
        args
    }
}

/// A launch that has been handed off. Success here means only that the
/// process started; whether the attach succeeds is between VS Code and
/// Docker, in VS Code's window.
pub struct Launched {
    state: Arc<Mutex<ReapState>>,
}

#[derive(Default)]
struct ReapState {
    done: bool,
    warning: Option<String>,
}

impl Launched {
    /// A late warning from the reap thread, if one has arrived. Takes it, so
    /// each warning is reported once.
    pub fn try_warning(&self) -> Option<String> {
        self.state.lock().ok()?.warning.take()
    }

    /// Whether the editor process has been reaped (any exit status).
    pub fn is_done(&self) -> bool {
        self.state.lock().is_ok_and(|s| s.done)
    }
}

/// Spawn the editor and detach.
pub fn launch(plan: &LaunchPlan) -> Result<Launched, EditorError> {
    let mut cmd = Command::new(&plan.editor);
    cmd.args(plan.args());
    if let Some(host) = &plan.docker_host {
        cmd.env("DOCKER_HOST", host);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let child = cmd.spawn().map_err(EditorError::Spawn)?;

    let state = Arc::new(Mutex::new(ReapState::default()));
    let slot = Arc::clone(&state);
    // Detached on purpose: the thread owns the child and blocks in wait, so
    // the exit status is always collected (no zombies) without the caller
    // ever blocking. If the process ends first the OS inherits the child,
    // which is exactly the hand-off the spec asks for.
    std::thread::Builder::new()
        .name("editor-reap".to_owned())
        .spawn(move || {
            let outcome = child.wait_with_output();
            if let Ok(mut s) = slot.lock() {
                s.done = true;
                if let Ok(out) = outcome
                    && !out.status.success()
                {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    let stderr = stderr.trim();
                    s.warning = Some(if stderr.is_empty() {
                        format!("the editor exited with {}", out.status)
                    } else {
                        format!("the editor exited with {}: {stderr}", out.status)
                    });
                }
            }
        })
        .map_err(EditorError::Spawn)?;

    Ok(Launched { state })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_argv_is_folder_uri_and_the_uri_and_nothing_else() {
        let uri = "vscode-remote://attached-container+7b7d/work".to_owned();
        let plan = LaunchPlan {
            editor: PathBuf::from("code"),
            uri: uri.clone(),
            new_window: false,
            docker_host: None,
        };
        assert_eq!(plan.args(), vec!["--folder-uri", uri.as_str()]);

        let windowed = LaunchPlan {
            new_window: true,
            ..plan
        };
        assert_eq!(
            windowed.args(),
            vec!["--new-window", "--folder-uri", uri.as_str()]
        );
    }

    /// The real thing: spawn a fake editor that records its argv to a file,
    /// and assert it received exactly `["--folder-uri", "<uri>"]` — one
    /// element each, no shell re-splitting, nothing extra.
    #[test]
    fn a_fake_editor_receives_exactly_the_planned_argv() {
        let dir = std::env::temp_dir().join(format!(
            "envmux-fake-editor-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let record = dir.join("argv.txt");

        // The record path is baked into the shim rather than passed through
        // the environment: `std::env::set_var` is unsafe under parallel tests.
        let shim = write_shim(&dir, &record);

        let uri =
            "vscode-remote://attached-container+7b22636f6e7461696e65724e616d65223a222f74657374227d/work"
                .to_owned();
        let plan = LaunchPlan {
            editor: shim,
            uri: uri.clone(),
            new_window: false,
            docker_host: None,
        };
        let launched = launch(&plan).expect("spawning the fake editor");

        // The launch call must not block, so wait for the reap thread to see
        // the child out, bounded.
        for _ in 0..100 {
            if launched.is_done() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(launched.is_done(), "the fake editor never finished");
        assert!(
            launched.try_warning().is_none(),
            "a clean exit must not warn"
        );

        let recorded = std::fs::read_to_string(&record).expect("the shim recorded its argv");
        let argv: Vec<&str> = recorded.lines().map(str::trim_end).collect();
        assert_eq!(argv, vec!["--folder-uri", uri.as_str()]);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A fast-failing editor surfaces as a late warning, not a launch error.
    #[test]
    fn a_nonzero_exit_becomes_a_late_warning() {
        let dir =
            std::env::temp_dir().join(format!("envmux-fake-editor-fail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let shim = write_failing_shim(&dir);

        let plan = LaunchPlan {
            editor: shim,
            uri: "vscode-remote://attached-container+7b7d/".to_owned(),
            new_window: false,
            docker_host: None,
        };
        let launched = launch(&plan).expect("spawn still succeeds");
        for _ in 0..100 {
            if launched.is_done() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let warning = launched.try_warning().expect("a late warning");
        assert!(warning.contains("no attach for you"), "{warning}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A shim that appends each argv element to `record`, one per line.
    fn write_shim(dir: &std::path::Path, record: &std::path::Path) -> PathBuf {
        if cfg!(windows) {
            let path = dir.join("fake-code.cmd");
            // `%~1` strips the quotes Rust's .cmd escaping adds; the
            // redirect-first form avoids a trailing space on each line.
            let script = format!(
                "@echo off\r\n:loop\r\nif \"%~1\"==\"\" goto :eof\r\n>>\"{}\" echo %~1\r\nshift\r\ngoto loop\r\n",
                record.display()
            );
            std::fs::write(&path, script).expect("writing the shim");
            path
        } else {
            let path = dir.join("fake-code");
            let script = format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"{}\"\n",
                record.display()
            );
            std::fs::write(&path, script).expect("writing the shim");
            make_executable(&path);
            path
        }
    }

    /// A shim that prints to stderr and exits 3.
    fn write_failing_shim(dir: &std::path::Path) -> PathBuf {
        if cfg!(windows) {
            let path = dir.join("fake-fail.cmd");
            std::fs::write(
                &path,
                "@echo off\r\necho no attach for you>&2\r\nexit /b 3\r\n",
            )
            .expect("writing the shim");
            path
        } else {
            let path = dir.join("fake-fail");
            std::fs::write(&path, "#!/bin/sh\necho 'no attach for you' >&2\nexit 3\n")
                .expect("writing the shim");
            make_executable(&path);
            path
        }
    }

    fn make_executable(path: &std::path::Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod +x");
        }
        #[cfg(not(unix))]
        {
            let _ = path;
        }
    }
}
