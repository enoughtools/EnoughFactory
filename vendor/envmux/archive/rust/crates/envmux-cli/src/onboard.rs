//! The parts of a project envmux needs beside the config file.
//!
//! Choosing *what* to write is the setup screen's job now — it can show the
//! file before it lands, which a `[Y/n]` on a cooked terminal never could. What
//! is left here is the half that has no question attached: the `.envmux/`
//! folder (state, and the shared shadow remote in `.envmux/git`) and the
//! ignore entries that keep it out of a commit.
//!
//! This runs on every boot, not just the first, because a project configured
//! before the folder existed still needs it — and because the failure it
//! prevents, live state landing in someone's history, is not one you notice
//! until it is committed.

use std::path::Path;

use anyhow::Context as _;

/// Create `.envmux/` and keep it out of git — belt and braces.
///
/// The entry goes in the repository's `.gitignore`, and `.envmux/.gitignore`
/// containing `*` covers the repository whose `.gitignore` was hand-edited
/// later (the same trick `target/` uses via cargo).
pub fn ensure_project_dir(root: &Path) -> anyhow::Result<()> {
    let project = root.join(envmux_core::PROJECT_DIR);
    std::fs::create_dir_all(&project).with_context(|| format!("creating {}", project.display()))?;
    std::fs::write(project.join(".gitignore"), "*\n").context("writing .envmux/.gitignore")?;

    // Only touch the repository's .gitignore when this actually is one.
    if root.join(".git").exists() {
        ensure_gitignore_entry(&root.join(".gitignore"))?;
    }
    // A project that builds its image from a Dockerfile must not ship the
    // live state dir in the build context (the WAL alone can be locked on
    // Windows and fail the upload). Only append where a .dockerignore
    // already exists — creating one uninvited would change build behaviour
    // for projects that deliberately have none.
    let dockerignore = root.join(".dockerignore");
    if dockerignore.exists() {
        ensure_ignore_line(&dockerignore, envmux_core::PROJECT_DIR)?;
    }
    Ok(())
}

/// Append `line` to an ignore-style file unless a spelling of it is present.
fn ensure_ignore_line(file: &Path, line: &str) -> anyhow::Result<()> {
    let existing =
        std::fs::read_to_string(file).with_context(|| format!("reading {}", file.display()))?;
    let already_there = existing.lines().map(str::trim).any(|l| {
        l == line || l == format!("{line}/") || l == format!("/{line}") || l == format!("/{line}/")
    });
    if already_there {
        return Ok(());
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(line);
    text.push('\n');
    std::fs::write(file, text).with_context(|| format!("updating {}", file.display()))
}

/// Append `.envmux/` to a .gitignore unless some spelling of it is present.
fn ensure_gitignore_entry(gitignore: &Path) -> anyhow::Result<()> {
    let entry = format!("{}/", envmux_core::PROJECT_DIR);
    let existing = match std::fs::read_to_string(gitignore) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e).with_context(|| format!("reading {}", gitignore.display())),
    };
    let already_there = existing.lines().map(str::trim).any(|line| {
        line == entry || line == envmux_core::PROJECT_DIR || line == format!("/{entry}")
    });
    if already_there {
        return Ok(());
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&entry);
    text.push('\n');
    std::fs::write(gitignore, text).with_context(|| format!("updating {}", gitignore.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("envmux-onboard-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn the_project_dir_and_its_ignore_entry_are_created() {
        let root = scratch("fresh");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        ensure_project_dir(&root).unwrap();
        assert!(root.join(".envmux").is_dir());
        let ignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(ignore.lines().any(|l| l == ".envmux/"), "{ignore}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn running_it_again_changes_nothing() {
        // It runs on every boot, not just the first, so a second call has to
        // be a no-op rather than a second `.envmux/` line in the ignore file.
        let root = scratch("dupes");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n.envmux/\n").unwrap();
        ensure_project_dir(&root).unwrap();
        ensure_project_dir(&root).unwrap();
        let ignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert_eq!(
            ignore.lines().filter(|l| l.trim() == ".envmux/").count(),
            1,
            "{ignore}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_directory_without_git_gets_no_gitignore() {
        let root = scratch("nogit");
        ensure_project_dir(&root).unwrap();
        assert!(!root.join(".gitignore").exists());
        // But the project dir still defends itself for a later `git init`.
        assert!(root.join(".envmux").join(".gitignore").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
