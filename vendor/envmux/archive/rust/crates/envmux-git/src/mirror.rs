//! The per-namespace bare mirror: sync point with upstream and clone origin
//! for every workspace.
//!
//! gc policy (the alternates containment): `gc.auto=0` at init; maintenance
//! runs `git repack -a -d -k` (keep existing packs); object *pruning* runs
//! only when the caller can prove no live workspace clone lists the mirror in
//! its alternates — i.e. zero non-reaped workspaces in the namespace.

use std::path::{Path, PathBuf};

use crate::host::{GitError, GitRunner};

#[derive(Debug, Clone)]
pub struct Mirror {
    pub dir: PathBuf,
    git: GitRunner,
}

impl Mirror {
    #[must_use]
    pub fn new(dir: PathBuf, git: GitRunner) -> Self {
        Self { dir, git }
    }

    #[must_use]
    pub fn exists(&self) -> bool {
        self.dir.join("HEAD").exists()
    }

    /// `git clone --mirror <remote>` into the mirror directory, with
    /// automatic gc disabled from birth.
    pub async fn init(&self, remote: &str) -> Result<(), GitError> {
        std::fs::create_dir_all(&self.dir).map_err(GitError::Io)?;
        let parent = self.dir.parent().unwrap_or(Path::new("."));
        let dir_str = self.dir.display().to_string();
        self.git
            .run(parent, &["clone", "--mirror", remote, &dir_str])
            .await?;
        self.git.run(&self.dir, &["config", "gc.auto", "0"]).await?;
        Ok(())
    }

    /// Fetch from the project remote, pruning refs that vanished upstream.
    /// Serialization per namespace is the caller's job (a tokio `Mutex`).
    pub async fn fetch(&self) -> Result<(), GitError> {
        self.git.run(&self.dir, &["fetch", "--prune"]).await?;
        Ok(())
    }

    /// Whether the mirror knows a ref (branch or tag).
    pub async fn has_ref(&self, name: &str) -> Result<bool, GitError> {
        let (code, _, _) = self
            .git
            .try_run(
                &self.dir,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{name}"),
                ],
            )
            .await?;
        if code == 0 {
            return Ok(true);
        }
        let (code, _, _) = self
            .git
            .try_run(
                &self.dir,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/tags/{name}"),
                ],
            )
            .await?;
        Ok(code == 0)
    }

    /// The configured upstream remote URL.
    pub async fn remote_url(&self) -> Result<String, GitError> {
        Ok(self
            .git
            .run(&self.dir, &["remote", "get-url", "origin"])
            .await?
            .trim()
            .to_owned())
    }

    /// Maintenance repack: keep existing packs so alternates-dependent
    /// objects never vanish under a sharing clone.
    pub async fn repack_keep(&self) -> Result<(), GitError> {
        self.git
            .run(&self.dir, &["repack", "-a", "-d", "-k"])
            .await?;
        Ok(())
    }

    /// Object pruning — call ONLY when zero live workspace clones share this
    /// mirror. `deferred` should come from the workspace ledger.
    pub async fn prune_if_safe(&self, live_sharing_clones: usize) -> Result<bool, GitError> {
        if live_sharing_clones > 0 {
            return Ok(false);
        }
        self.git
            .run(&self.dir, &["prune", "--expire", "now"])
            .await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make_upstream(dir: &Path) -> GitRunner {
        let git = GitRunner::new();
        std::fs::create_dir_all(dir).unwrap();
        git.run(dir, &["init", "-b", "main"]).await.unwrap();
        git.run(dir, &["config", "user.email", "t@e.st"])
            .await
            .unwrap();
        git.run(dir, &["config", "user.name", "test"])
            .await
            .unwrap();
        std::fs::write(dir.join("README.md"), "hello").unwrap();
        git.run(dir, &["add", "-A"]).await.unwrap();
        git.run(dir, &["commit", "-m", "init"]).await.unwrap();
        git
    }

    fn tmp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("envmux-git-mirror-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[tokio::test]
    async fn mirror_init_fetch_and_refs() {
        let up = tmp("upstream");
        let git = make_upstream(&up).await;
        let mdir = tmp("mirror");
        let mirror = Mirror::new(mdir.clone(), git.clone());
        assert!(!mirror.exists());
        mirror.init(&up.display().to_string()).await.unwrap();
        assert!(mirror.exists());
        assert!(mirror.has_ref("main").await.unwrap());
        assert!(!mirror.has_ref("nope").await.unwrap());

        // gc.auto is off from birth.
        let v = git.run(&mdir, &["config", "gc.auto"]).await.unwrap();
        assert_eq!(v.trim(), "0");

        // New upstream branch appears after fetch.
        git.run(&up, &["checkout", "-b", "feature"]).await.unwrap();
        std::fs::write(up.join("f.txt"), "f").unwrap();
        git.run(&up, &["add", "-A"]).await.unwrap();
        git.run(&up, &["commit", "-m", "feature"]).await.unwrap();
        assert!(!mirror.has_ref("feature").await.unwrap());
        mirror.fetch().await.unwrap();
        assert!(mirror.has_ref("feature").await.unwrap());

        // Maintenance is safe to run; pruning defers while clones share.
        mirror.repack_keep().await.unwrap();
        assert!(!mirror.prune_if_safe(3).await.unwrap());
        assert!(mirror.prune_if_safe(0).await.unwrap());
    }
}
