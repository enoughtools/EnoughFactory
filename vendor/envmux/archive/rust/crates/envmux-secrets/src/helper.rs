//! External helper subprocess protocol, modeled on git credential helpers.
//!
//! A helper is an executable `envmux-secret-<name>` on PATH. The daemon
//! invokes it with `get`, `store`, or `erase` as the sole argument, writes
//! `key=value\n` pairs on stdin (`name=<secret name>`, `namespace=<ns>`, and
//! for `store` a `value=<base64>` line), then reads the same format on
//! stdout. For `get`, a `value=<base64>` line is the hit; nonzero exit or
//! empty output means not found and the chain continues.

use std::io::Write as _;
use std::process::{Command, Stdio};

use base64::Engine as _;

use crate::{Provider, SecretError, SecretKey, SecretValue};

pub struct HelperProvider {
    /// Helper suffix: `envmux-secret-<suffix>`.
    suffix: String,
}

impl HelperProvider {
    #[must_use]
    pub fn new(suffix: impl Into<String>) -> Self {
        Self {
            suffix: suffix.into(),
        }
    }

    fn executable(&self) -> String {
        format!("envmux-secret-{}", self.suffix)
    }

    fn invoke(
        &self,
        op: &str,
        key: &SecretKey,
        value: Option<&SecretValue>,
    ) -> Result<Option<String>, SecretError> {
        let exe = self.executable();
        let mut child = Command::new(&exe)
            .arg(op)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|source| SecretError::Helper {
                helper: exe.clone(),
                source,
            })?;

        {
            let stdin = child.stdin.as_mut().expect("piped stdin");
            let mut input = format!("name={}\nnamespace={}\n", key.name, key.namespace);
            if let Some(v) = value {
                input.push_str(&format!(
                    "value={}\n",
                    base64::engine::general_purpose::STANDARD.encode(v.as_bytes())
                ));
            }
            stdin
                .write_all(input.as_bytes())
                .map_err(|source| SecretError::Helper {
                    helper: exe.clone(),
                    source,
                })?;
        }

        let out = child
            .wait_with_output()
            .map_err(|source| SecretError::Helper {
                helper: exe.clone(),
                source,
            })?;
        if !out.status.success() {
            return Ok(None);
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        Ok(stdout
            .lines()
            .find_map(|l| l.strip_prefix("value="))
            .map(str::to_owned))
    }
}

impl Provider for HelperProvider {
    fn name(&self) -> &str {
        &self.suffix
    }

    fn get(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretError> {
        let Some(encoded) = self.invoke("get", key, None)? else {
            return Ok(None);
        };
        base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map(|b| Some(SecretValue(b)))
            .map_err(|e| SecretError::Provider {
                provider: self.executable(),
                message: format!("helper returned invalid base64: {e}"),
            })
    }

    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretError> {
        self.invoke("store", key, Some(value)).map(|_| ())
    }

    fn erase(&self, key: &SecretKey) -> Result<(), SecretError> {
        self.invoke("erase", key, None).map(|_| ())
    }
}
