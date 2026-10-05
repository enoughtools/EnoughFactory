//! Platform credential store provider via the `keyring` crate: Keychain on
//! macOS, Credential Manager on Windows, Secret Service on Linux.

use base64::Engine as _;

use crate::{Provider, SecretError, SecretKey, SecretValue};

pub struct KeyringProvider;

fn entry(key: &SecretKey) -> Result<keyring::Entry, SecretError> {
    keyring::Entry::new(&format!("envmux/{}", key.namespace), &key.name).map_err(|e| {
        SecretError::Provider {
            provider: "keyring".into(),
            message: e.to_string(),
        }
    })
}

impl Provider for KeyringProvider {
    fn name(&self) -> &str {
        "keyring"
    }

    fn get(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretError> {
        match entry(key)?.get_password() {
            // Values are stored base64ed so binary key material survives
            // stores that only take strings.
            Ok(encoded) => base64::engine::general_purpose::STANDARD
                .decode(&encoded)
                .map(|bytes| Some(SecretValue(bytes)))
                .map_err(|e| SecretError::Provider {
                    provider: "keyring".into(),
                    message: format!("stored value is not valid base64: {e}"),
                }),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError::Provider {
                provider: "keyring".into(),
                message: e.to_string(),
            }),
        }
    }

    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretError> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
        entry(key)?
            .set_password(&encoded)
            .map_err(|e| SecretError::Provider {
                provider: "keyring".into(),
                message: e.to_string(),
            })
    }

    fn erase(&self, key: &SecretKey) -> Result<(), SecretError> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError::Provider {
                provider: "keyring".into(),
                message: e.to_string(),
            }),
        }
    }
}
