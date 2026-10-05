//! Secrets: a helper-based lookup chain modeled on git credential helpers.
//!
//! A helper is tried in configured order; the first hit wins. Built-in
//! providers: `keyring` (platform credential store) and `file` (0600 TOML
//! fallback under the state dir, with a logged warning). External helpers are
//! executables named `envmux-secret-<name>` speaking the documented
//! `key=value` stdin/stdout protocol.
//!
//! The same chain holds mTLS client key material, service admin credentials,
//! user-declared secrets, and daemon-minted slice credentials. All providers
//! are blocking; async callers wrap the chain in `spawn_blocking`.

mod file_provider;
mod helper;
mod keyring_provider;

use std::path::Path;

pub use file_provider::FileProvider;
pub use helper::HelperProvider;
pub use keyring_provider::KeyringProvider;

use envmux_core::NamespaceName;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("secret {name:?} not found in any provider")]
    NotFound { name: String },
    #[error("provider {provider}: {message}")]
    Provider { provider: String, message: String },
    #[error("helper {helper}: {source}")]
    Helper {
        helper: String,
        #[source]
        source: std::io::Error,
    },
}

/// A secret's identity: namespaced by project so two projects on one machine
/// cannot read each other's material.
#[derive(Debug, Clone)]
pub struct SecretKey {
    pub namespace: NamespaceName,
    pub name: String,
}

impl SecretKey {
    #[must_use]
    pub fn new(namespace: NamespaceName, name: impl Into<String>) -> Self {
        Self {
            namespace,
            name: name.into(),
        }
    }
}

/// A secret value. Deliberately opaque in Debug output.
#[derive(Clone)]
pub struct SecretValue(pub Vec<u8>);

impl SecretValue {
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretValue(<redacted>)")
    }
}

/// A provider in the chain. Implementations are blocking.
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;
    /// `Ok(None)` = not found, chain continues.
    fn get(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretError>;
    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretError>;
    fn erase(&self, key: &SecretKey) -> Result<(), SecretError>;
}

/// The ordered provider chain.
pub struct Chain {
    providers: Vec<Box<dyn Provider>>,
}

impl Chain {
    #[must_use]
    pub fn new(providers: Vec<Box<dyn Provider>>) -> Self {
        Self { providers }
    }

    /// The default chain: platform keyring, then the file fallback.
    #[must_use]
    pub fn default_chain(state_dir: &Path) -> Self {
        Self::new(vec![
            Box::new(KeyringProvider),
            Box::new(FileProvider::new(state_dir.join("secrets.toml"))),
        ])
    }

    /// Try each provider in order; first hit wins.
    pub fn get(&self, key: &SecretKey) -> Result<SecretValue, SecretError> {
        for p in &self.providers {
            match p.get(key) {
                Ok(Some(v)) => return Ok(v),
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(provider = p.name(), name = %key.name, error = %e,
                        "secret provider errored; trying next");
                }
            }
        }
        Err(SecretError::NotFound {
            name: key.name.clone(),
        })
    }

    /// Store in the first provider that accepts the write.
    pub fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretError> {
        let mut last: Option<SecretError> = None;
        for p in &self.providers {
            match p.store(key, value) {
                Ok(()) => {
                    if p.name() == "file" {
                        tracing::warn!(name = %key.name,
                            "secret stored in plain-text file fallback; no platform store was available");
                    }
                    return Ok(());
                }
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or(SecretError::NotFound {
            name: key.name.clone(),
        }))
    }

    /// Erase from every provider (best-effort; a secret must not survive in a
    /// lower-priority provider).
    pub fn erase(&self, key: &SecretKey) -> Result<(), SecretError> {
        for p in &self.providers {
            let _ = p.erase(key);
        }
        Ok(())
    }
}

/// Mint a credential token: 32 OS-random bytes, base64url without padding.
#[must_use]
pub fn mint_token() -> String {
    use base64::Engine as _;
    use rand::RngCore as _;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(name: &str) -> SecretKey {
        SecretKey::new("testns".parse().unwrap(), name)
    }

    #[test]
    fn minted_tokens_are_unique_and_url_safe() {
        let a = mint_token();
        let b = mint_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 43); // 32 bytes base64url unpadded
        assert!(
            a.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }

    #[test]
    fn file_fallback_round_trips_through_chain() {
        let dir = std::env::temp_dir().join(format!("envmux-secrets-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Chain with only the file provider so tests never touch the real
        // platform credential store.
        let chain = Chain::new(vec![Box::new(FileProvider::new(dir.join("secrets.toml")))]);

        let k = key("db-admin");
        assert!(matches!(chain.get(&k), Err(SecretError::NotFound { .. })));
        chain.store(&k, &SecretValue(b"hunter2".to_vec())).unwrap();
        assert_eq!(chain.get(&k).unwrap().as_bytes(), b"hunter2");
        chain.erase(&k).unwrap();
        assert!(matches!(chain.get(&k), Err(SecretError::NotFound { .. })));
    }
}
