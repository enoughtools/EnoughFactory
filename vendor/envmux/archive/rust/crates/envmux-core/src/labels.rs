//! The label schema applied to every container, volume, and network envmux
//! creates. Label keys are constants; nothing formats a label string ad hoc.

use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::{ConfigHash, NamespaceName, WorkspaceName};

pub const LABEL_NAMESPACE: &str = "dev.envmux.namespace";
pub const LABEL_WORKSPACE: &str = "dev.envmux.workspace";
pub const LABEL_ROLE: &str = "dev.envmux.role";
pub const LABEL_CLASS: &str = "dev.envmux.class";
pub const LABEL_CREATED_AT: &str = "dev.envmux.created-at";
pub const LABEL_CONFIG_HASH: &str = "dev.envmux.config-hash";
pub const LABEL_SCHEMA: &str = "dev.envmux.schema";

/// Current label schema version; guards future label migrations.
pub const LABEL_SCHEMA_VERSION: &str = "1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Base,
    Workspace,
    Service,
    Orchestrator,
}

impl Role {
    pub const ALL: [Role; 4] = [
        Self::Base,
        Self::Workspace,
        Self::Service,
        Self::Orchestrator,
    ];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Workspace => "workspace",
            Self::Service => "service",
            Self::Orchestrator => "orchestrator",
        }
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Role {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| format!("unknown role {s:?}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VolumeClass {
    Source,
    Cache,
    Tools,
    Sync,
    Shadow,
    Mirror,
    ServiceData,
}

impl VolumeClass {
    pub const ALL: [VolumeClass; 7] = [
        Self::Source,
        Self::Cache,
        Self::Tools,
        Self::Sync,
        Self::Shadow,
        Self::Mirror,
        Self::ServiceData,
    ];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Cache => "cache",
            Self::Tools => "tools",
            Self::Sync => "sync",
            Self::Shadow => "shadow",
            Self::Mirror => "mirror",
            Self::ServiceData => "service-data",
        }
    }
}

impl fmt::Display for VolumeClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for VolumeClass {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| format!("unknown volume class {s:?}"))
    }
}

/// The full label set for an object envmux creates. Constructed through the
/// builder methods so every object carries the schema version, namespace,
/// role, and creation timestamp.
#[derive(Debug, Clone)]
pub struct Labels {
    pub namespace: NamespaceName,
    pub workspace: Option<WorkspaceName>,
    pub role: Role,
    pub class: Option<VolumeClass>,
    pub created_at: jiff::Timestamp,
    pub config_hash: Option<ConfigHash>,
}

impl Labels {
    #[must_use]
    pub fn new(namespace: NamespaceName, role: Role) -> Self {
        Self {
            namespace,
            workspace: None,
            role,
            class: None,
            created_at: jiff::Timestamp::now(),
            config_hash: None,
        }
    }

    #[must_use]
    pub fn workspace(mut self, ws: WorkspaceName) -> Self {
        self.workspace = Some(ws);
        self
    }

    #[must_use]
    pub fn class(mut self, class: VolumeClass) -> Self {
        self.class = Some(class);
        self
    }

    #[must_use]
    pub fn config_hash(mut self, hash: ConfigHash) -> Self {
        self.config_hash = Some(hash);
        self
    }

    /// Render into the map bollard expects.
    #[must_use]
    pub fn to_map(&self) -> HashMap<String, String> {
        let mut m = HashMap::new();
        m.insert(LABEL_NAMESPACE.into(), self.namespace.to_string());
        if let Some(ws) = &self.workspace {
            m.insert(LABEL_WORKSPACE.into(), ws.to_string());
        }
        m.insert(LABEL_ROLE.into(), self.role.to_string());
        if let Some(class) = self.class {
            m.insert(LABEL_CLASS.into(), class.to_string());
        }
        m.insert(LABEL_CREATED_AT.into(), self.created_at.to_string());
        if let Some(h) = &self.config_hash {
            m.insert(LABEL_CONFIG_HASH.into(), h.to_string());
        }
        m.insert(LABEL_SCHEMA.into(), LABEL_SCHEMA_VERSION.into());
        m
    }

    /// Parse envmux labels back off a Docker object; `None` when the object
    /// does not carry the envmux schema.
    #[must_use]
    pub fn from_map(m: &HashMap<String, String>) -> Option<Self> {
        if m.get(LABEL_SCHEMA).map(String::as_str) != Some(LABEL_SCHEMA_VERSION) {
            return None;
        }
        Some(Self {
            namespace: m.get(LABEL_NAMESPACE)?.parse().ok()?,
            workspace: match m.get(LABEL_WORKSPACE) {
                Some(ws) => Some(ws.parse().ok()?),
                None => None,
            },
            role: m.get(LABEL_ROLE)?.parse().ok()?,
            class: match m.get(LABEL_CLASS) {
                Some(c) => Some(c.parse().ok()?),
                None => None,
            },
            created_at: m.get(LABEL_CREATED_AT)?.parse().ok()?,
            config_hash: match m.get(LABEL_CONFIG_HASH) {
                Some(h) => Some(h.parse().ok()?),
                None => None,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_round_trip() {
        let labels = Labels::new("myns".parse().unwrap(), Role::Workspace)
            .workspace("wobbly-otter".parse().unwrap())
            .class(VolumeClass::Source)
            .config_hash(ConfigHash::of_bytes(b"cfg"));
        let map = labels.to_map();
        assert_eq!(map.get(LABEL_SCHEMA).unwrap(), "1");
        let back = Labels::from_map(&map).unwrap();
        assert_eq!(back.namespace, labels.namespace);
        assert_eq!(back.workspace, labels.workspace);
        assert_eq!(back.role, labels.role);
        assert_eq!(back.class, labels.class);
        assert_eq!(back.config_hash, labels.config_hash);
    }

    #[test]
    fn foreign_objects_are_not_ours() {
        let mut m = HashMap::new();
        m.insert("com.docker.compose.project".to_string(), "x".to_string());
        assert!(Labels::from_map(&m).is_none());
    }
}
