//! Locating and resolving the active configuration file, its hash, its
//! provenance, and opt-in drift detection for local overrides.

use std::path::{Path, PathBuf};

use envmux_core::ConfigHash;

use crate::{CONFIG_FILE, Config, ConfigError, LOCAL_CONFIG_FILE, validate};

/// Which file is the configuration. Whole-file override: when the local file
/// exists, the committed file is not layered underneath it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveFile {
    Committed,
    Local,
}

impl ActiveFile {
    #[must_use]
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Committed => CONFIG_FILE,
            Self::Local => LOCAL_CONFIG_FILE,
        }
    }
}

/// Drift state for a local override created with drift detection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriftState {
    /// The active file is the committed file; drift does not apply.
    NotApplicable,
    /// Local file exists but records no base hash (created by hand).
    Untracked,
    /// Committed base still matches the recorded hash.
    Clean,
    /// The committed base has moved since the local copy was made.
    BaseMoved {
        recorded: ConfigHash,
        current: ConfigHash,
    },
    /// A base hash is recorded but the committed file no longer exists.
    BaseMissing,
}

/// Marker comment carrying the recorded base hash in a generated local file.
pub(crate) const BASE_HASH_PREFIX: &str = "# envmux:base-hash=";

/// The fully resolved configuration: parsed model, frozen source text, hash,
/// and provenance. This is what a workspace is built from, once, at launch.
#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub config: Config,
    /// The exact file text the config was parsed from (frozen at launch into
    /// the workspace row, so provenance is always printable).
    pub text: String,
    pub hash: ConfigHash,
    pub active: ActiveFile,
    pub path: PathBuf,
    pub drift: DriftState,
}

/// Resolve the configuration for a repository root directory.
pub fn resolve_dir(dir: &Path) -> Result<ResolvedConfig, ConfigError> {
    let local = dir.join(LOCAL_CONFIG_FILE);
    let committed = dir.join(CONFIG_FILE);
    let (path, active) = if local.exists() {
        (local, ActiveFile::Local)
    } else if committed.exists() {
        (committed.clone(), ActiveFile::Committed)
    } else {
        return Err(ConfigError::NotFound {
            dir: dir.display().to_string(),
        });
    };

    let text = std::fs::read_to_string(&path).map_err(|source| ConfigError::Io {
        path: path.display().to_string(),
        source,
    })?;
    let file_name = active.file_name();
    let config: Config =
        toml::from_str(&text).map_err(|e| ConfigError::from_toml(file_name, &text, &e))?;
    validate(file_name, &text, &config)?;

    let drift = match active {
        ActiveFile::Committed => DriftState::NotApplicable,
        ActiveFile::Local => drift_state(&text, &committed)?,
    };

    Ok(ResolvedConfig {
        config,
        hash: ConfigHash::of_bytes(text.as_bytes()),
        text,
        active,
        path,
        drift,
    })
}

fn drift_state(local_text: &str, committed: &Path) -> Result<DriftState, ConfigError> {
    let Some(recorded) = local_text
        .lines()
        .find_map(|l| l.strip_prefix(BASE_HASH_PREFIX))
        .map(str::trim)
        .and_then(|h| ConfigHash::new(h).ok())
    else {
        return Ok(DriftState::Untracked);
    };
    if !committed.exists() {
        return Ok(DriftState::BaseMissing);
    }
    let base = std::fs::read(committed).map_err(|source| ConfigError::Io {
        path: committed.display().to_string(),
        source,
    })?;
    let current = ConfigHash::of_bytes(&base);
    if current == recorded {
        Ok(DriftState::Clean)
    } else {
        Ok(DriftState::BaseMoved { recorded, current })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = "[image]\nreference = \"ghcr.io/envmux/default\"\n";

    fn tmpdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("envmux-config-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn committed_file_resolves() {
        let dir = tmpdir("committed");
        std::fs::write(dir.join(CONFIG_FILE), MINIMAL).unwrap();
        let r = resolve_dir(&dir).unwrap();
        assert_eq!(r.active, ActiveFile::Committed);
        assert_eq!(r.drift, DriftState::NotApplicable);
        assert_eq!(r.hash, ConfigHash::of_bytes(MINIMAL.as_bytes()));
    }

    #[test]
    fn local_file_wins_whole_file() {
        let dir = tmpdir("local-wins");
        std::fs::write(dir.join(CONFIG_FILE), MINIMAL).unwrap();
        // The local file omits everything from the committed one on purpose:
        // nothing may be layered underneath it.
        std::fs::write(
            dir.join(LOCAL_CONFIG_FILE),
            "[image]\nreference = \"localhost/dev:scratch\"\n",
        )
        .unwrap();
        let r = resolve_dir(&dir).unwrap();
        assert_eq!(r.active, ActiveFile::Local);
        assert_eq!(
            r.config.image.reference.as_deref(),
            Some("localhost/dev:scratch")
        );
        assert_eq!(r.drift, DriftState::Untracked);
    }

    #[test]
    fn drift_detection_flags_base_movement() {
        let dir = tmpdir("drift");
        std::fs::write(dir.join(CONFIG_FILE), MINIMAL).unwrap();
        let local = crate::create_local_config(&dir).unwrap();
        assert!(local.contains(BASE_HASH_PREFIX));
        assert_eq!(resolve_dir(&dir).unwrap().drift, DriftState::Clean);

        // Base moves → flagged. Nothing is merged on the user's behalf.
        std::fs::write(
            dir.join(CONFIG_FILE),
            format!("{MINIMAL}\n[env]\nX = \"1\"\n"),
        )
        .unwrap();
        assert!(matches!(
            resolve_dir(&dir).unwrap().drift,
            DriftState::BaseMoved { .. }
        ));
    }

    #[test]
    fn missing_config_is_a_clear_error() {
        let dir = tmpdir("missing");
        assert!(matches!(
            resolve_dir(&dir),
            Err(ConfigError::NotFound { .. })
        ));
    }
}
