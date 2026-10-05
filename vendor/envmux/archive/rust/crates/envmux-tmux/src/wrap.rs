//! Task command wrapping: each task runs under `sh -c` with its exit code
//! written to `$RUN_DIR/<task>.exit`, so the engine reads a real exit code
//! from a file rather than inferring from `pane_dead_status` across tmux
//! versions.

use crate::RUN_DIR;

/// Single-quote a string for POSIX sh: `'` becomes `'\''`.
#[must_use]
pub fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Wrap a declared task command. The wrapper:
/// - runs in the task's working directory,
/// - exports declared env pairs,
/// - executes the command via `sh -c`,
/// - writes the exit code to `RUN_DIR/<task>.exit` (atomically via rename so
///   a half-written file is never read as a status).
#[must_use]
pub fn wrap_task_command(task: &str, command: &str, cwd: &str, env: &[(String, String)]) -> String {
    let mut exports = String::new();
    for (k, v) in env {
        exports.push_str(&format!("export {}={}; ", k, sh_quote(v)));
    }
    let exit_file = format!("{RUN_DIR}/{task}.exit");
    format!(
        "sh -c {}",
        sh_quote(&format!(
            "cd {cwd_q} && {exports}rm -f {exit_q}; sh -c {cmd_q}; ec=$?; echo $ec > {exit_q}.tmp && mv {exit_q}.tmp {exit_q}; exit $ec",
            cwd_q = sh_quote(cwd),
            exports = exports,
            cmd_q = sh_quote(command),
            exit_q = exit_file,
        ))
    )
}

/// Path of a task's exit file (the engine reads it via exec `cat`).
#[must_use]
pub fn exit_file(task: &str) -> String {
    format!("{RUN_DIR}/{task}.exit")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_handles_single_quotes() {
        assert_eq!(sh_quote("plain"), "'plain'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote(""), "''");
    }

    #[test]
    fn wrapped_command_shape() {
        let w = wrap_task_command(
            "dev",
            "cargo run --bin server",
            "/work",
            &[("RUST_LOG".into(), "debug".into())],
        );
        assert!(w.starts_with("sh -c '"));
        assert!(w.contains("cd '\\''/work'\\''"));
        assert!(w.contains("export RUST_LOG="));
        assert!(w.contains("/run/envmux/dev.exit"));
        assert!(w.contains("mv "));
    }

    /// The wrapper must survive being run by a real POSIX sh.
    #[test]
    fn wrapped_command_is_valid_sh() {
        // Windows CI machines may not have sh; skip quietly there.
        let sh = which_sh();
        let Some(sh) = sh else {
            eprintln!("sh not found; skipping execution check");
            return;
        };
        let dir = std::env::temp_dir().join(format!("envmux-wrap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Rebuild the wrapper against a temp RUN_DIR by string surgery: the
        // shape is what's under test, not the constant.
        let wrapped = wrap_task_command("t", "echo ok; exit 7", ".", &[])
            .replace(RUN_DIR, &dir.display().to_string().replace('\\', "/"));
        // Ensure the inner `sh -c` resolves when invoking Git's sh.exe
        // outside a Git Bash environment.
        let sh_dir = sh.parent().unwrap().display().to_string();
        let path = format!("{};{}", sh_dir, std::env::var("PATH").unwrap_or_default());
        let status = std::process::Command::new(sh)
            .arg("-c")
            .arg(&wrapped)
            .env("PATH", path)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(7));
        let exit = std::fs::read_to_string(dir.join("t.exit")).unwrap();
        assert_eq!(exit.trim(), "7");
    }

    fn which_sh() -> Option<std::path::PathBuf> {
        if cfg!(windows) {
            for candidate in [
                r"C:\Program Files\Git\usr\bin\sh.exe",
                r"C:\Program Files\Git\bin\sh.exe",
            ] {
                let p = std::path::PathBuf::from(candidate);
                if p.exists() {
                    return Some(p);
                }
            }
            None
        } else {
            Some(std::path::PathBuf::from("sh"))
        }
    }
}
