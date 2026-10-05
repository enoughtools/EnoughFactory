//! The shadow origin: a bare repository on a local namespace volume, holding
//! periodic snapshots of each workspace's tree. Local only; never pushed
//! anywhere. Maintenance is explicit and daemon-owned, serialized against
//! capture by a per-namespace lock held by the caller.

use std::path::PathBuf;

use crate::host::{GitError, GitRunner};

#[derive(Debug, Clone)]
pub struct ShadowRepo {
    pub dir: PathBuf,
    git: GitRunner,
}

/// `chmod -R a+rwX` in Rust: directories and already-executable files get the
/// execute bit, everything gets read and write. Unix only — the modes it
/// relaxes have no meaning on Windows, where a bind mount does not enforce
/// them in the first place.
#[cfg(unix)]
fn chmod_tree_world_writable(root: &std::path::Path) -> Result<(), GitError> {
    use std::os::unix::fs::PermissionsExt as _;

    let meta = std::fs::metadata(root).map_err(GitError::Io)?;
    let mode = meta.permissions().mode();
    // 0o111 in the low bits: X in `a+rwX` means "execute where execute is
    // already set for somebody", which is what keeps data files unexecutable.
    let relaxed = mode
        | 0o666
        | if meta.is_dir() || mode & 0o111 != 0 {
            0o111
        } else {
            0
        };
    if relaxed != mode {
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(relaxed))
            .map_err(GitError::Io)?;
    }
    if meta.is_dir() {
        for entry in std::fs::read_dir(root).map_err(GitError::Io)? {
            let entry = entry.map_err(GitError::Io)?;
            // Symlinks are not followed: the shadow holds none, and chasing
            // one out of the repository would be a surprising thing for a
            // permission fixup to do.
            if entry.file_type().map_err(GitError::Io)?.is_symlink() {
                continue;
            }
            chmod_tree_world_writable(&entry.path())?;
        }
    }
    Ok(())
}

/// One snapshot ref in the shadow repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRef {
    pub workspace: String,
    /// Ref-safe timestamp component of the snap ref.
    pub stamp: String,
    pub full_ref: String,
    pub commit: String,
    pub torn: bool,
    pub flagged: Option<String>,
}

impl ShadowRepo {
    #[must_use]
    pub fn new(dir: PathBuf, git: GitRunner) -> Self {
        Self { dir, git }
    }

    #[must_use]
    pub fn exists(&self) -> bool {
        self.dir.join("HEAD").exists()
    }

    /// Init a bare shadow repo with automatic gc disabled.
    ///
    /// `--shared=0777` is not paranoia about who may read it — the shadow
    /// holds a copy of source the same user already owns. It is that two
    /// different uids write this repository: the daemon on the host, and git
    /// inside a workspace container, pushing captures through the bind mount.
    /// The images envmux ships run as uid 1000, which is the host user on most
    /// Linux desktops and *not* the host user everywhere else. `--shared` is
    /// git's own answer: it relaxes the modes now and records
    /// `core.sharedRepository`, so objects written later stay writable by
    /// whichever of the two got there second.
    pub async fn init(&self) -> Result<(), GitError> {
        std::fs::create_dir_all(&self.dir).map_err(GitError::Io)?;
        self.git
            .run(&self.dir, &["init", "--bare", "--shared=0777", "."])
            .await?;
        self.git.run(&self.dir, &["config", "gc.auto", "0"]).await?;
        Ok(())
    }

    /// Bring an already-initialized shadow up to the sharing [`init`] now
    /// gives a new one, so a project that predates it is not the one project
    /// whose captures fail once its workspaces stop running as root.
    ///
    /// Idempotent and cheap after the first call: the config read short-
    /// circuits before the recursive chmod, which only ever has to run once.
    ///
    /// [`init`]: Self::init
    pub async fn ensure_shared(&self) -> Result<(), GitError> {
        let (code, _, _) = self
            .git
            .try_run(&self.dir, &["config", "--get", "core.sharedRepository"])
            .await?;
        if code == 0 {
            return Ok(());
        }
        // Re-running init is how the setting gets written exactly as a fresh
        // repository would have it — git normalizes the mode it records — and
        // re-initializing an existing repository is a documented no-op beyond
        // reapplying options like this one.
        self.init().await?;
        // git relaxes modes only on paths it writes from here on, so the
        // objects already sitting in the repository need doing by hand.
        #[cfg(unix)]
        chmod_tree_world_writable(&self.dir)?;
        Ok(())
    }

    /// Current tip of a workspace's snapshot line, if any.
    pub async fn tip(&self, workspace: &str) -> Result<Option<String>, GitError> {
        let (code, out, _) = self
            .git
            .try_run(
                &self.dir,
                &[
                    "rev-parse",
                    "--verify",
                    &format!("refs/envmux/ws/{workspace}/head"),
                ],
            )
            .await?;
        Ok((code == 0).then(|| out.trim().to_owned()))
    }

    /// List snapshot refs, newest first, optionally for one workspace.
    /// Torn/flagged are read from the annotated tag's TOML payload.
    pub async fn snapshots(&self, workspace: Option<&str>) -> Result<Vec<SnapshotRef>, GitError> {
        // Globless patterns are prefix matches on full path components, which
        // is what we want (`*` would not cross `/`).
        let pattern = match workspace {
            Some(ws) => format!("refs/envmux/snap/{ws}"),
            None => "refs/envmux/snap".to_owned(),
        };
        let out = self
            .git
            .run(
                &self.dir,
                &[
                    "for-each-ref",
                    "--sort=-refname",
                    "--format=%(refname)%09%(*objectname)%09%(contents)",
                    &pattern,
                ],
            )
            .await?;
        let mut snaps = Vec::new();
        for record in out.split('\n').filter(|l| !l.trim().is_empty()) {
            let mut parts = record.splitn(3, '\t');
            let (Some(refname), Some(commit)) = (parts.next(), parts.next()) else {
                continue;
            };
            let payload = parts.next().unwrap_or_default();
            // refs/envmux/snap/<workspace>/<stamp>
            let mut segs = refname.splitn(5, '/');
            let (_, _, _, ws, stamp) = (
                segs.next(),
                segs.next(),
                segs.next(),
                segs.next().unwrap_or_default(),
                segs.next().unwrap_or_default(),
            );
            let torn = payload.lines().any(|l| l.trim() == "torn = true");
            let flagged = payload.lines().find_map(|l| {
                l.trim()
                    .strip_prefix("flagged = \"")
                    .and_then(|v| v.strip_suffix('"'))
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned)
            });
            snaps.push(SnapshotRef {
                workspace: ws.to_owned(),
                stamp: stamp.to_owned(),
                full_ref: refname.to_owned(),
                commit: commit.trim().to_owned(),
                torn,
                flagged,
            });
        }
        Ok(snaps)
    }

    /// Delete snapshot refs older than the retention horizon. Reclaims no
    /// disk by itself; [`Self::gc`] does that, on its own schedule.
    pub async fn prune_refs(&self, older_than: jiff::Timestamp) -> Result<u32, GitError> {
        let cutoff = crate::scripts::ref_safe_timestamp(&older_than);
        let snaps = self.snapshots(None).await?;
        let mut pruned = 0;
        for snap in snaps {
            // Ref-safe stamps sort lexicographically like their timestamps.
            if snap.stamp.as_str() < cutoff.as_str() {
                self.git
                    .run(&self.dir, &["update-ref", "-d", &snap.full_ref])
                    .await?;
                pruned += 1;
            }
        }
        Ok(pruned)
    }

    /// Expire reflogs and collect unreachable objects past the horizon.
    /// The caller holds the per-namespace capture/maintenance lock.
    pub async fn gc(&self, prune_horizon: &str) -> Result<(), GitError> {
        self.git
            .run(&self.dir, &["reflog", "expire", "--expire=now", "--all"])
            .await?;
        self.git
            .run(&self.dir, &["gc", &format!("--prune={prune_horizon}")])
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("envmux-shadow-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[tokio::test]
    async fn the_shadow_is_writable_by_the_container_as_well_as_the_host() {
        // Captures are pushed from inside a workspace, by a user that is not
        // the host user — the images run as uid 1000 and the host may be
        // anything. `core.sharedRepository` is what keeps the objects git
        // writes on one side writable from the other.
        let git = GitRunner::new();
        let shadow = ShadowRepo::new(tmp("shared"), git.clone());
        shadow.init().await.unwrap();

        // Git records the mode it will use for files, not the argument as
        // given — 0777 comes back as 0666, since it adds the execute bit for
        // directories itself. Assert the property that matters instead of the
        // spelling: somebody other than the owner can write.
        let other_can_write = async |dir: &PathBuf| {
            let shared = git
                .run(dir, &["config", "--get", "core.sharedRepository"])
                .await
                .unwrap();
            let mode = u32::from_str_radix(shared.trim().trim_start_matches("0o"), 8)
                .unwrap_or_else(|_| panic!("core.sharedRepository is {shared:?}, not a mode"));
            mode & 0o002 != 0
        };
        assert!(other_can_write(&shadow.dir).await);

        // A shadow from before this was true is brought up to it, without
        // disturbing what it already holds, and asking twice changes nothing.
        git.run(&shadow.dir, &["config", "--unset", "core.sharedRepository"])
            .await
            .unwrap();
        std::fs::write(shadow.dir.join("marker"), "kept").unwrap();
        shadow.ensure_shared().await.unwrap();
        shadow.ensure_shared().await.unwrap();
        assert!(other_can_write(&shadow.dir).await);
        assert_eq!(
            std::fs::read_to_string(shadow.dir.join("marker")).unwrap(),
            "kept"
        );
        // Re-init must not have undone the settings init makes alongside it.
        let gc = git
            .run(&shadow.dir, &["config", "--get", "gc.auto"])
            .await
            .unwrap();
        assert_eq!(gc.trim(), "0");
    }

    async fn seed_snapshot(
        git: &GitRunner,
        work: &Path,
        shadow: &ShadowRepo,
        ws: &str,
        stamp: &str,
        torn: bool,
    ) {
        // Build a commit in the work repo and push it as a snapshot with an
        // annotated tag carrying the TOML payload, mirroring CAPTURE_SCRIPT.
        std::fs::write(work.join(format!("{stamp}.txt")), stamp).unwrap();
        git.run(work, &["add", "-A"]).await.unwrap();
        git.run(work, &["commit", "-m", &format!("snap {stamp}")])
            .await
            .unwrap();
        let commit = git
            .run(work, &["rev-parse", "HEAD"])
            .await
            .unwrap()
            .trim()
            .to_owned();
        let payload = format!(
            "object {commit}\ntype commit\ntag snap-{stamp}\ntagger envmux <envmux@local> 1700000000 +0000\n\ntorn = {torn}\nflagged = \"\"\n",
        );
        // mktag needs stdin, which GitRunner doesn't pipe; run it directly.
        let out = std::process::Command::new("git")
            .args(["mktag"])
            .current_dir(work)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut c| {
                use std::io::Write as _;
                c.stdin.take().unwrap().write_all(payload.as_bytes())?;
                c.wait_with_output()
            })
            .unwrap();
        assert!(out.status.success(), "mktag failed");
        let tag = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        let shadow_path = shadow.dir.display().to_string();
        git.run(
            work,
            &[
                "push",
                "--force",
                &shadow_path,
                &format!("{commit}:refs/envmux/ws/{ws}/head"),
                &format!("{tag}:refs/envmux/snap/{ws}/{stamp}"),
            ],
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn shadow_snapshots_prune_and_gc() {
        let git = GitRunner::new();
        let shadow = ShadowRepo::new(tmp("repo"), git.clone());
        shadow.init().await.unwrap();
        assert!(shadow.exists());
        assert_eq!(shadow.tip("ws1").await.unwrap(), None);

        let work = tmp("work");
        std::fs::create_dir_all(&work).unwrap();
        git.run(&work, &["init", "-b", "main"]).await.unwrap();
        git.run(&work, &["config", "user.email", "t@e.st"])
            .await
            .unwrap();
        git.run(&work, &["config", "user.name", "t"]).await.unwrap();

        seed_snapshot(&git, &work, &shadow, "ws1", "2026-01-01T00-00-00Z", false).await;
        seed_snapshot(&git, &work, &shadow, "ws1", "2026-06-01T00-00-00Z", true).await;

        assert!(shadow.tip("ws1").await.unwrap().is_some());
        let snaps = shadow.snapshots(Some("ws1")).await.unwrap();
        assert_eq!(snaps.len(), 2);
        // Newest first.
        assert_eq!(snaps[0].stamp, "2026-06-01T00-00-00Z");
        assert!(snaps[0].torn);
        assert!(!snaps[1].torn);

        // Prune refs older than March: the January snapshot goes.
        let cutoff: jiff::Timestamp = "2026-03-01T00:00:00Z".parse().unwrap();
        assert_eq!(shadow.prune_refs(cutoff).await.unwrap(), 1);
        assert_eq!(shadow.snapshots(Some("ws1")).await.unwrap().len(), 1);

        shadow.gc("now").await.unwrap();
        // The surviving snapshot still resolves after gc.
        assert_eq!(shadow.snapshots(Some("ws1")).await.unwrap().len(), 1);
    }
}
