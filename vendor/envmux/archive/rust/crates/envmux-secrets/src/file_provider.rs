//! Plain-text file fallback for environments with no platform store:
//! a TOML file under the state dir, created 0600 on Unix. Every store through
//! the chain into this provider logs a warning.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine as _;

use crate::{Provider, SecretError, SecretKey, SecretValue};

pub struct FileProvider {
    path: PathBuf,
    // Serialize read-modify-write cycles within this process.
    lock: Mutex<()>,
}

type Store = BTreeMap<String, BTreeMap<String, String>>;

impl FileProvider {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn load(&self) -> Result<Store, SecretError> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => toml::from_str(&text).map_err(|e| SecretError::Provider {
                provider: "file".into(),
                message: format!("corrupt secrets file {}: {e}", self.path.display()),
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::new()),
            Err(e) => Err(SecretError::Provider {
                provider: "file".into(),
                message: format!("reading {}: {e}", self.path.display()),
            }),
        }
    }

    fn save(&self, store: &Store) -> Result<(), SecretError> {
        let text = toml::to_string(store).map_err(|e| SecretError::Provider {
            provider: "file".into(),
            message: e.to_string(),
        })?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| SecretError::Provider {
                provider: "file".into(),
                message: format!("creating {}: {e}", parent.display()),
            })?;
        }
        std::fs::write(&self.path, &text).map_err(|e| SecretError::Provider {
            provider: "file".into(),
            message: format!("writing {}: {e}", self.path.display()),
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

impl Provider for FileProvider {
    fn name(&self) -> &str {
        "file"
    }

    fn get(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretError> {
        let _guard = self.lock.lock().expect("secrets file lock poisoned");
        let store = self.load()?;
        let Some(encoded) = store
            .get(key.namespace.as_str())
            .and_then(|ns| ns.get(&key.name))
        else {
            return Ok(None);
        };
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map(|b| Some(SecretValue(b)))
            .map_err(|e| SecretError::Provider {
                provider: "file".into(),
                message: format!("stored value is not valid base64: {e}"),
            })
    }

    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretError> {
        let _guard = self.lock.lock().expect("secrets file lock poisoned");
        let mut store = self.load()?;
        store.entry(key.namespace.to_string()).or_default().insert(
            key.name.clone(),
            base64::engine::general_purpose::STANDARD.encode(value.as_bytes()),
        );
        self.save(&store)
    }

    fn erase(&self, key: &SecretKey) -> Result<(), SecretError> {
        let _guard = self.lock.lock().expect("secrets file lock poisoned");
        let mut store = self.load()?;
        if let Some(ns) = store.get_mut(key.namespace.as_str()) {
            ns.remove(&key.name);
            if ns.is_empty() {
                store.remove(key.namespace.as_str());
            }
        }
        self.save(&store)
    }
}
