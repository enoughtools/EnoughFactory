//! Tar packing/unpacking for the archive endpoints, run in `spawn_blocking`,
//! with path-traversal defense on extraction.

use std::path::{Component, Path, PathBuf};

use bytes::Bytes;
use futures_util::StreamExt as _;

use crate::{DockerError, DockerHandle};

/// Summary of one entry in a container archive listing.
#[derive(Debug, Clone)]
pub struct TarEntrySummary {
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub mtime: Option<u64>,
}

/// Reject entries that would escape the extraction root.
fn safe_join(root: &Path, entry_path: &Path) -> Result<PathBuf, DockerError> {
    let mut out = root.to_path_buf();
    for comp in entry_path.components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            _ => {
                return Err(DockerError::PathTraversal {
                    path: entry_path.display().to_string(),
                });
            }
        }
    }
    Ok(out)
}

/// Unpack tar bytes into a host directory with traversal defense.
pub async fn unpack_tar_to_dir(data: Bytes, dir: PathBuf) -> Result<(), DockerError> {
    tokio::task::spawn_blocking(move || {
        let mut archive = tar::Archive::new(data.as_ref());
        for entry in archive
            .entries()
            .map_err(|e| DockerError::Archive(e.to_string()))?
        {
            let mut entry = entry.map_err(|e| DockerError::Archive(e.to_string()))?;
            let path = entry
                .path()
                .map_err(|e| DockerError::Archive(e.to_string()))?
                .into_owned();
            let target = safe_join(&dir, &path)?;
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    DockerError::Archive(format!("mkdir {}: {e}", parent.display()))
                })?;
            }
            entry
                .unpack(&target)
                .map_err(|e| DockerError::Archive(format!("unpack {}: {e}", target.display())))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| DockerError::Archive(format!("unpack task panicked: {e}")))?
}

impl DockerHandle {
    /// Upload a tar stream into a container path (archive endpoint).
    pub async fn upload_tar(
        &self,
        container: &str,
        path: &str,
        tar_bytes: Bytes,
    ) -> Result<(), DockerError> {
        self.raw()
            .upload_to_container(
                container,
                Some(bollard::container::UploadToContainerOptions {
                    path: path.to_owned(),
                    ..Default::default()
                }),
                tar_bytes,
            )
            .await?;
        Ok(())
    }

    /// Download a container path as tar bytes (archive endpoint).
    pub async fn download_tar(&self, container: &str, path: &str) -> Result<Bytes, DockerError> {
        let mut stream = self.raw().download_from_container(
            container,
            Some(bollard::container::DownloadFromContainerOptions {
                path: path.to_owned(),
            }),
        );
        let mut out = Vec::new();
        while let Some(chunk) = stream.next().await {
            out.extend_from_slice(&chunk?);
        }
        Ok(Bytes::from(out))
    }

    /// List entries of a downloaded container path without extracting.
    pub async fn list_tar(
        &self,
        container: &str,
        path: &str,
    ) -> Result<Vec<TarEntrySummary>, DockerError> {
        let data = self.download_tar(container, path).await?;
        tokio::task::spawn_blocking(move || {
            let mut archive = tar::Archive::new(data.as_ref());
            let mut entries = Vec::new();
            for entry in archive
                .entries()
                .map_err(|e| DockerError::Archive(e.to_string()))?
            {
                let entry = entry.map_err(|e| DockerError::Archive(e.to_string()))?;
                let header = entry.header();
                entries.push(TarEntrySummary {
                    path: entry
                        .path()
                        .map_err(|e| DockerError::Archive(e.to_string()))?
                        .display()
                        .to_string(),
                    size: header.size().unwrap_or(0),
                    is_dir: header.entry_type().is_dir(),
                    mtime: header.mtime().ok(),
                });
            }
            Ok(entries)
        })
        .await
        .map_err(|e| DockerError::Archive(format!("list task panicked: {e}")))?
    }

    /// Write files into a container by building a tar in memory. Used for
    /// secrets delivery (`/run/envmux/secrets/<name>`, mode 0400) so values
    /// never appear in Docker env output.
    pub async fn write_files(
        &self,
        container: &str,
        dest_dir: &str,
        files: Vec<(String, Vec<u8>, u32)>,
    ) -> Result<(), DockerError> {
        let tar_bytes = tokio::task::spawn_blocking(move || -> Result<Bytes, DockerError> {
            let mut builder = tar::Builder::new(Vec::new());
            for (name, contents, mode) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(contents.len() as u64);
                header.set_mode(mode);
                header.set_mtime(0);
                header.set_cksum();
                builder
                    .append_data(&mut header, &name, contents.as_slice())
                    .map_err(|e| DockerError::Archive(e.to_string()))?;
            }
            let data = builder
                .into_inner()
                .map_err(|e| DockerError::Archive(e.to_string()))?;
            Ok(Bytes::from(data))
        })
        .await
        .map_err(|e| DockerError::Archive(format!("tar task panicked: {e}")))??;

        // Ensure the destination exists before the archive lands.
        self.run_exec(
            container,
            vec!["mkdir".into(), "-p".into(), dest_dir.into()],
            Some("root"),
            None,
            vec![],
            None,
        )
        .await?;
        self.upload_tar(container, dest_dir, tar_bytes).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_allows_normal_paths() {
        let root = Path::new("/x");
        assert_eq!(
            safe_join(root, Path::new("a/b.txt")).unwrap(),
            PathBuf::from("/x/a/b.txt")
        );
        assert_eq!(
            safe_join(root, Path::new("./a")).unwrap(),
            PathBuf::from("/x/a")
        );
    }

    #[test]
    fn safe_join_rejects_escapes() {
        let root = Path::new("/x");
        assert!(safe_join(root, Path::new("../etc/passwd")).is_err());
        assert!(safe_join(root, Path::new("a/../../etc")).is_err());
        assert!(safe_join(root, Path::new("/abs/path")).is_err());
    }

    /// A tar with the given `(path, contents)` entries.
    fn tar_of(entries: &[(&str, &[u8])]) -> Bytes {
        let mut builder = tar::Builder::new(Vec::new());
        for (path, contents) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *contents).unwrap();
        }
        Bytes::from(builder.into_inner().unwrap())
    }

    #[tokio::test]
    async fn unpack_writes_nested_entries() {
        let dst = std::env::temp_dir().join(format!("envmux-tar-dst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dst);

        let tar = tar_of(&[("a.txt", b"alpha"), ("sub/b.txt", b"beta")]);
        unpack_tar_to_dir(tar, dst.clone()).await.unwrap();

        assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(std::fs::read(dst.join("sub/b.txt")).unwrap(), b"beta");
        let _ = std::fs::remove_dir_all(&dst);
    }

    // Traversal on extraction is covered by `safe_join_rejects_escapes`, which
    // tests the function that implements it. An end-to-end version is not
    // possible through this API: the `tar` crate refuses to *write* an archive
    // containing `..`, so the malicious input cannot be constructed here.
}
