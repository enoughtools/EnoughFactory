//! The service library: per-service slice provisioning implementations.
//!
//! v1 supports a closed set — Postgres, MinIO, Redis — so dispatch is an
//! enum, exhaustively matched, no trait objects. Each implementation knows
//! how to provision, deprovision, audit, and health-check per-workspace
//! slices of its shared service container. Slice keys derive from the
//! workspace *name* (branch is not unique), sanitized per backend.
//!
//! Admin credentials come from the secrets helper chain and never enter a
//! workspace; what leaves this crate is [`SliceCredentials`] — scoped
//! material delivered through the secrets mount.

mod minio;
mod postgres;
mod redis_svc;

use std::collections::BTreeMap;

pub use minio::Minio;
pub use postgres::Postgres;
pub use redis_svc::Redis;

use envmux_core::{SliceKey, WorkspaceName};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("postgres admin: {0}")]
    Postgres(#[from] sqlx::Error),
    #[error("redis admin: {0}")]
    Redis(#[from] redis::RedisError),
    #[error("minio admin (mc exec): {0}")]
    Minio(String),
    #[error("docker: {0}")]
    Docker(#[from] envmux_docker::DockerError),
    #[error("invalid slice key from workspace {0:?}")]
    BadKey(String),
}

/// Health as reported by the implementation's own probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    Healthy,
    Unhealthy,
}

/// Scoped credentials minted for one workspace's slice, delivered to the
/// workspace as files at the secrets path. Task env interpolation exposes the
/// *paths*, never the values.
#[derive(Debug, Clone)]
pub struct SliceCredentials {
    pub service: String,
    pub slice_key: SliceKey,
    /// `<file name> -> <contents>`; the daemon writes each to
    /// `/run/envmux/secrets/<service>/<file name>` (mode 0400).
    pub files: BTreeMap<String, String>,
}

/// A reference to the workspace a slice is being provisioned for.
#[derive(Debug, Clone)]
pub struct WorkspaceRef {
    pub name: WorkspaceName,
}

/// Sanitize a workspace name into an identifier for SQL/ACL contexts:
/// `-` becomes `_`, prefixed `ws_`.
#[must_use]
pub fn slice_ident(ws: &WorkspaceName) -> String {
    format!("ws_{}", ws.as_str().replace('-', "_"))
}

/// Sanitize a workspace name into a bucket name: `_` becomes `-`, prefixed
/// `ws-` (S3 bucket names cannot contain underscores).
#[must_use]
pub fn slice_bucket(ws: &WorkspaceName) -> String {
    format!("ws-{}", ws.as_str().replace('_', "-"))
}

/// The closed set of supported service kinds.
pub enum ServiceKind {
    Postgres(Postgres),
    Minio(Minio),
    Redis(Redis),
}

impl ServiceKind {
    #[must_use]
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::Postgres(_) => "postgres",
            Self::Minio(_) => "minio",
            Self::Redis(_) => "redis",
        }
    }

    /// Create the per-workspace slice and mint scoped credentials.
    pub async fn provision(&self, ws: &WorkspaceRef) -> Result<SliceCredentials, ServiceError> {
        match self {
            Self::Postgres(p) => p.provision(ws).await,
            Self::Minio(m) => m.provision(ws).await,
            Self::Redis(r) => r.provision(ws).await,
        }
    }

    /// Destroy the slice. Idempotent: tolerates already-gone.
    pub async fn deprovision(&self, slice: &SliceKey) -> Result<(), ServiceError> {
        match self {
            Self::Postgres(p) => p.deprovision(slice).await,
            Self::Minio(m) => m.deprovision(slice).await,
            Self::Redis(r) => r.deprovision(slice).await,
        }
    }

    /// Slices that exist server-side (for orphan reporting; never deletes).
    pub async fn audit(&self) -> Result<Vec<SliceKey>, ServiceError> {
        match self {
            Self::Postgres(p) => p.audit().await,
            Self::Minio(m) => m.audit().await,
            Self::Redis(r) => r.audit().await,
        }
    }

    pub async fn health(&self) -> Result<Health, ServiceError> {
        match self {
            Self::Postgres(p) => p.health().await,
            Self::Minio(m) => m.health().await,
            Self::Redis(r) => r.health().await,
        }
    }
}

/// Pinned default images per kind (referenced when the declaration names no
/// image). The MinIO image ships `mc`, which the implementation execs.
#[must_use]
pub fn default_image(kind: &str) -> Option<(&'static str, &'static str)> {
    match kind {
        "postgres" => Some(("postgres", "16-alpine")),
        "redis" => Some(("redis", "7-alpine")),
        "minio" => Some(("minio/minio", "RELEASE.2024-10-02T17-50-41Z")),
        _ => None,
    }
}

/// Canonical in-namespace port per kind (namespacing means every namespace
/// uses the same canonical ports internally).
#[must_use]
pub fn canonical_port(kind: &str) -> Option<u16> {
    match kind {
        "postgres" => Some(5432),
        "redis" => Some(6379),
        "minio" => Some(9000),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idents_sanitize_per_backend() {
        let ws: WorkspaceName = "wobbly-otter_2".parse().unwrap();
        assert_eq!(slice_ident(&ws), "ws_wobbly_otter_2");
        assert_eq!(slice_bucket(&ws), "ws-wobbly-otter-2");
    }

    #[test]
    fn defaults_cover_the_closed_set() {
        for kind in ["postgres", "redis", "minio"] {
            assert!(default_image(kind).is_some());
            assert!(canonical_port(kind).is_some());
        }
        assert!(default_image("mongodb").is_none());
    }
}
