//! Validated newtypes for every name that identifies a domain object.
//!
//! Validation rule (shared): 1–63 characters, ASCII lowercase alphanumeric
//! plus `-` and `_`, must start with an alphanumeric. This keeps every name
//! Docker-safe (container names, volume names, DNS aliases) and SQL/ref-safe.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::CoreError;

fn validate(kind: &'static str, s: &str) -> Result<(), CoreError> {
    let err = |reason| CoreError::InvalidName {
        kind,
        value: s.to_owned(),
        reason,
    };
    if s.is_empty() {
        return Err(err("empty"));
    }
    if s.len() > 63 {
        return Err(err("longer than 63 characters"));
    }
    let mut chars = s.chars();
    let first = chars.next().unwrap_or('-');
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(err("must start with a lowercase letter or digit"));
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(err(
            "may only contain lowercase letters, digits, '-' and '_'",
        ));
    }
    Ok(())
}

macro_rules! name_newtype {
    ($(#[$doc:meta])* $name:ident, $kind:literal) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(s: impl Into<String>) -> Result<Self, CoreError> {
                let s = s.into();
                validate($kind, &s)?;
                Ok(Self(s))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = CoreError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::new(s)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                Self::new(s).map_err(serde::de::Error::custom)
            }
        }
    };
}

name_newtype!(
    /// One project's world: network, mirror, services, volumes, shadow origin,
    /// workspaces.
    NamespaceName,
    "namespace"
);
name_newtype!(
    /// A workspace's identity. Arbitrary; usually generated.
    WorkspaceName,
    "workspace"
);
name_newtype!(
    /// A shared service container within a namespace.
    ServiceName,
    "service"
);
name_newtype!(
    /// A named tmux window inside a workspace.
    TaskName,
    "task"
);
name_newtype!(
    /// A named Docker volume envmux manages.
    VolumeName,
    "volume"
);
name_newtype!(
    /// Identifies a per-workspace slice of a shared service (a database name,
    /// a bucket name, a key prefix), already sanitized per backend.
    SliceKey,
    "slice key"
);

/// Internal workspace id: UUID v7 so creation order sorts lexically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorkspaceId(pub uuid::Uuid);

impl WorkspaceId {
    #[must_use]
    pub fn generate() -> Self {
        Self(uuid::Uuid::now_v7())
    }
}

impl fmt::Display for WorkspaceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl FromStr for WorkspaceId {
    type Err = uuid::Error;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(uuid::Uuid::from_str(s)?))
    }
}

/// Blake3 hex digest of the resolved configuration a workspace was built from.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct ConfigHash(String);

impl ConfigHash {
    pub fn new(s: impl Into<String>) -> Result<Self, CoreError> {
        let s = s.into();
        if s.len() != 64
            || !s
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(CoreError::InvalidConfigHash(s));
        }
        Ok(Self(s))
    }

    /// Hash raw config bytes into a `ConfigHash`.
    #[must_use]
    pub fn of_bytes(bytes: &[u8]) -> Self {
        Self(blake3::hash(bytes).to_hex().to_string())
    }

    /// The image tag a Dockerfile-built namespace image carries.
    ///
    /// One function because two callers must agree exactly: the daemon tags
    /// what it builds with this, and `envmux image build` pre-builds the same
    /// tag in the foreground so registration finds it and skips the build. A
    /// drifted format silently doubles every build.
    #[must_use]
    pub fn image_tag(&self, namespace: &str) -> String {
        format!("envmux-{namespace}:{}", &self.0[..12])
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ConfigHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for ConfigHash {
    type Err = CoreError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::new(s)
    }
}

impl<'de> Deserialize<'de> for ConfigHash {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Self::new(s).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_names() {
        for ok in ["a", "abc", "a-b_c1", "0start", "x".repeat(63).as_str()] {
            assert!(NamespaceName::new(ok).is_ok(), "{ok:?} should be valid");
        }
    }

    #[test]
    fn rejects_invalid_names() {
        for bad in [
            "",
            "-lead",
            "_lead",
            "UPPER",
            "has space",
            "has.dot",
            "x".repeat(64).as_str(),
        ] {
            assert!(
                WorkspaceName::new(bad).is_err(),
                "{bad:?} should be invalid"
            );
        }
    }

    #[test]
    fn config_hash_of_bytes_round_trips() {
        let h = ConfigHash::of_bytes(b"hello");
        assert_eq!(h.as_str().len(), 64);
        assert_eq!(ConfigHash::new(h.as_str()).unwrap(), h);
        assert!(ConfigHash::new("abc").is_err());
        assert!(ConfigHash::new("G".repeat(64)).is_err());
    }

    #[test]
    fn workspace_id_sorts_by_creation() {
        let a = WorkspaceId::generate();
        let b = WorkspaceId::generate();
        assert!(a.to_string() <= b.to_string());
    }
}
