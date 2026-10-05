//! `envmux install` — the second step, once someone has decided to keep it.
//!
//! The first step is running the binary from wherever it was unpacked. This is
//! what turns that into something on `PATH` that survives deleting the
//! download, and it lives in the binary rather than a shell script so it works
//! the same on every platform — `scripts/install.ps1` predates this and only
//! ever helped Windows.
//!
//! Deliberately small: copy the executable, put the directory on `PATH`, say
//! what happened. No service unit, no scheduled task, no elevation. The daemon
//! starts on demand and stops with the machine, so a per-user install needs
//! none of that, and every one of them is a thing that can be left behind.

use std::path::{Path, PathBuf};

use anyhow::Context as _;

/// What an install is about to do, worked out before anything is touched.
pub struct Plan {
    /// Where the binary is now.
    pub source: PathBuf,
    /// The directory being installed into.
    pub dir: PathBuf,
    /// Where the binary is going.
    pub destination: PathBuf,
    /// Whether `dir` is already on `PATH`.
    pub on_path: bool,
    /// Whether the source is already the destination — installing over itself.
    pub already_installed: bool,
    /// The state directory this copy is using, and how it chose it. An install
    /// from a portable copy does not carry the state with it, which is worth
    /// saying out loud rather than discovering later.
    pub portable_source: bool,
}

/// The per-user install directory.
///
/// No elevation, no `/usr/local`: envmux is a per-user tool that talks to a
/// per-user daemon, and asking for admin to install one is asking for more
/// than it needs.
#[must_use]
pub fn default_dir() -> PathBuf {
    #[cfg(windows)]
    {
        dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("Programs")
            .join("envmux")
    }
    #[cfg(unix)]
    {
        dirs::home_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join(".local")
            .join("bin")
    }
}

const EXE: &str = if cfg!(windows) {
    "envmux.exe"
} else {
    "envmux"
};

/// Work out what would happen, without doing any of it.
///
/// # Errors
/// If the running executable cannot be located.
pub fn plan(dir: Option<PathBuf>) -> anyhow::Result<Plan> {
    let source = std::env::current_exe().context("locating the running executable")?;
    let dir = dir.unwrap_or_else(default_dir);
    let destination = dir.join(EXE);

    let (_, kind) = envmux_core::state_dir_with_kind();
    Ok(Plan {
        already_installed: same_file(&source, &destination),
        on_path: dir_on_path(&dir),
        portable_source: matches!(kind, envmux_core::StateDirKind::Portable),
        source,
        dir,
        destination,
    })
}

/// What an install actually did, for reporting.
pub struct Report {
    pub path_updated: bool,
}

/// Carry out `plan`.
///
/// # Errors
/// If the destination cannot be written, or the executable cannot be replaced.
pub fn run(plan: &Plan, update_path: bool) -> anyhow::Result<Report> {
    anyhow::ensure!(
        !plan.already_installed,
        "already running from {} — nothing to do",
        plan.destination.display()
    );

    std::fs::create_dir_all(&plan.dir)
        .with_context(|| format!("creating {}", plan.dir.display()))?;

    replace(&plan.source, &plan.destination)?;

    // The in-container agent travels with the host binary when the release
    // archive shipped one: the daemon looks for it beside its own executable,
    // and the credential shim silently does not exist without it.
    if let Some(source_dir) = plan.source.parent() {
        let agent = source_dir.join("envmux-agent-linux-amd64");
        if agent.is_file() {
            std::fs::copy(&agent, plan.dir.join("envmux-agent-linux-amd64"))
                .with_context(|| format!("copying {}", agent.display()))?;
        }
    }

    let path_updated = if update_path && !plan.on_path {
        add_to_path(&plan.dir)?
    } else {
        false
    };

    Ok(Report { path_updated })
}

/// Copy `source` over `destination`, working around a running executable.
///
/// Windows refuses to overwrite a file that is mapped as a running image, but
/// it does allow *renaming* one. Moving the old binary aside first is the
/// standard trick, and it means installing over a copy that is currently
/// serving a daemon works instead of failing halfway.
fn replace(source: &Path, destination: &Path) -> anyhow::Result<()> {
    if destination.exists() {
        let aside = destination.with_extension("old");
        let _ = std::fs::remove_file(&aside);
        if std::fs::rename(destination, &aside).is_err() {
            // Not running, or the rename is not needed: try a plain remove.
            std::fs::remove_file(destination)
                .with_context(|| format!("replacing {}", destination.display()))?;
        }
    }
    std::fs::copy(source, destination)
        .with_context(|| format!("copying to {}", destination.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        // `copy` preserves the mode, but a source unpacked from an archive
        // that lost the executable bit would install unusable.
        let mut perms = std::fs::metadata(destination)?.permissions();
        perms.set_mode(perms.mode() | 0o755);
        std::fs::set_permissions(destination, perms)?;
    }
    Ok(())
}

/// Whether `dir` is already an entry in `PATH`.
///
/// Compared as paths rather than strings so a trailing separator or a
/// different case on Windows does not produce a duplicate entry.
#[must_use]
pub fn dir_on_path(dir: &Path) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|entry| same_dir(&entry, dir))
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let normal = |p: &Path| {
        let text = p.to_string_lossy().replace('\\', "/");
        let trimmed = text.trim_end_matches('/').to_owned();
        if cfg!(windows) {
            trimmed.to_lowercase()
        } else {
            trimmed
        }
    };
    normal(a) == normal(b)
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => same_dir(a, b),
    }
}

/// Add `dir` to the user's `PATH`, persistently.
///
/// # Errors
/// If the platform's mechanism for it fails.
// Only the Windows arm can fail, and one signature has to serve both — so on
// Unix clippy sees a `Result` that is always `Ok`, correctly, and there is
// nothing to do about it that would not make the Windows arm worse. Scoped to
// `unix` so the lint still speaks up if that arm ever stops being fallible.
#[cfg_attr(unix, allow(clippy::unnecessary_wraps))]
fn add_to_path(dir: &Path) -> anyhow::Result<bool> {
    #[cfg(windows)]
    {
        // Through PowerShell's environment API rather than `setx`, which
        // truncates `PATH` at 1024 characters — a genuinely destructive
        // failure that people have been losing PATH entries to for decades.
        let script = format!(
            "$dir = '{}'; \
             $current = [Environment]::GetEnvironmentVariable('Path','User'); \
             $entries = @(); \
             if ($current) {{ $entries = $current -split ';' | Where-Object {{ $_ }} }}; \
             if ($entries -notcontains $dir) {{ \
               [Environment]::SetEnvironmentVariable('Path', (($entries + $dir) -join ';'), 'User') \
             }}",
            dir.display().to_string().replace('\'', "''")
        );
        let status = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status()
            .context("running powershell to update PATH")?;
        anyhow::ensure!(status.success(), "powershell could not update PATH");
        Ok(true)
    }
    #[cfg(unix)]
    {
        // Appending to a shell profile means guessing which shell, which file,
        // and whether it is already handled — and getting any of those wrong
        // edits a file the user owns. Printing the line is honest and the
        // usual location is on PATH already on most systems.
        let _ = dir;
        Ok(false)
    }
}

/// The command to put `dir` on `PATH` by hand, for when this did not do it.
///
/// Not `setx`, ever: it truncates `PATH` at 1024 characters and silently
/// destroys whatever was past the cut. Telling someone to run it would undo
/// the care taken to avoid it two functions up.
#[must_use]
pub fn path_hint(dir: &Path) -> String {
    if cfg!(windows) {
        format!(
            "powershell -NoProfile -Command \"[Environment]::SetEnvironmentVariable('Path', \
             [Environment]::GetEnvironmentVariable('Path','User') + ';{}', 'User')\"",
            dir.display()
        )
    } else {
        format!(
            "export PATH=\"{}:$PATH\"   # add to your shell profile",
            dir.display()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_membership_ignores_trailing_separators() {
        // Otherwise a second install appends a duplicate entry every time.
        assert!(same_dir(
            Path::new("/home/u/.local/bin/"),
            Path::new("/home/u/.local/bin")
        ));
        assert!(!same_dir(
            Path::new("/home/u/.local/bin"),
            Path::new("/home/u/.local")
        ));
    }

    #[test]
    #[cfg(windows)]
    fn path_membership_ignores_case_and_separator_style_on_windows() {
        assert!(same_dir(
            Path::new(r"C:\Users\U\AppData\Local\Programs\envmux"),
            Path::new("c:/users/u/appdata/local/programs/envmux"),
        ));
    }

    #[test]
    fn the_path_hint_never_suggests_setx() {
        // setx truncates PATH at 1024 characters and drops the rest. The code
        // avoids it deliberately; the advice must not undo that.
        let hint = path_hint(Path::new("/opt/envmux"));
        assert!(!hint.to_lowercase().contains("setx"), "{hint}");
    }

    #[test]
    fn the_default_directory_is_per_user_and_named() {
        let dir = default_dir();
        assert!(
            dir.to_string_lossy().contains("envmux") || dir.ends_with("bin"),
            "unexpected install directory: {}",
            dir.display()
        );
        // Never a system location: installing a per-user tool must not want
        // administrator.
        let text = dir.to_string_lossy().to_lowercase();
        assert!(!text.starts_with("/usr"), "{text} needs elevation");
        assert!(!text.contains("program files"), "{text} needs elevation");
    }

    #[test]
    fn replacing_a_binary_works_when_one_is_already_there() {
        let root = std::env::temp_dir().join(format!("envmux-install-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("temp dir");
        let source = root.join("src.bin");
        let destination = root.join("dst.bin");
        std::fs::write(&source, b"new").expect("write source");
        std::fs::write(&destination, b"old").expect("write destination");

        replace(&source, &destination).expect("replace");
        assert_eq!(std::fs::read(&destination).expect("read"), b"new");

        let _ = std::fs::remove_dir_all(&root);
    }
}
