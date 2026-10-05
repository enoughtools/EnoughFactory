//! The `.envmux.toml` model: parsing, validation, hashing, provenance, and
//! `toml_edit`-based generation.
//!
//! Local override is whole-file: if `.envmux.local.toml` exists, it *is* the
//! configuration. Drift detection is opt-in via a recorded base hash embedded
//! in the local file when it is created by `create local config`.

pub mod bytes;
pub mod detect;
pub mod duration;
pub mod error;
pub mod generate;
pub mod interpolate;
pub mod model;
pub mod preset;
pub mod prompt;
pub mod resolve;
pub mod validate;

pub use bytes::ByteSize;
pub use detect::{Detected, PackageManager, PortHint, Stack, detect};
pub use duration::HumanDuration;
pub use error::ConfigError;
pub use generate::{create_local_config, generate_starter};
pub use interpolate::{InterpolationContext, interpolate};
pub use model::*;
pub use preset::{Plan, Preset, PresetId, catalogue, recommended};
pub use prompt::{AUTHORING_PROMPT, KNOWN_AGENTS, agent_command};
pub use resolve::{ActiveFile, DriftState, ResolvedConfig, resolve_dir};
pub use validate::{parse, validate};

/// Committed configuration file name.
pub const CONFIG_FILE: &str = ".envmux.toml";
/// Uncommitted whole-file override.
pub const LOCAL_CONFIG_FILE: &str = ".envmux.local.toml";
