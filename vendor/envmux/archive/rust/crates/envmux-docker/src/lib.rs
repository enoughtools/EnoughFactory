//! A thin, typed layer over `bollard`.
//!
//! Invariants enforced here rather than by convention:
//! - every create call goes through a builder that injects the envmux label
//!   set — this crate cannot construct an unlabelled object;
//! - every list call is a filtered query on `dev.envmux.*` labels — the
//!   daemon never lists the world;
//! - file transfer uses the archive endpoints with path-traversal defense on
//!   extraction, tar packed/unpacked in `spawn_blocking`;
//! - `system_df` is cached with a minimum refresh interval because full disk
//!   accounting is slow on large installations.

pub mod archive;
pub mod build;
pub mod client;
pub mod exec;
pub mod usage;

pub use archive::{TarEntrySummary, unpack_tar_to_dir};
pub use build::{
    BuildRequest, build_argv, build_image, buildkit_available, cli_version, resolve_dockerfile,
};
pub use client::{
    ContainerSpec, DockerClient, DockerHandle, NetworkSpec, VolumeMountSpec, VolumeSpec,
};
pub use exec::{ExecOutput, ExecStream};
pub use usage::{DiskUsage, DiskUsageCache, VolumeUsage};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum DockerError {
    #[error("docker api: {0}")]
    Api(#[from] bollard::errors::Error),
    #[error("exec {context}: {message}")]
    Exec { context: String, message: String },
    #[error("archive: {0}")]
    Archive(String),
    #[error("tar entry {path:?} escapes the extraction root")]
    PathTraversal { path: String },
    #[error("object not found: {0}")]
    NotFound(String),
    #[error("build: {0}")]
    Build(String),
}

impl DockerError {
    /// Whether the underlying API error is a 404 (safe to ignore for
    /// idempotent destroy steps).
    #[must_use]
    pub fn is_not_found(&self) -> bool {
        match self {
            Self::NotFound(_) => true,
            Self::Api(bollard::errors::Error::DockerResponseServerError {
                status_code, ..
            }) => *status_code == 404,
            _ => false,
        }
    }
}
