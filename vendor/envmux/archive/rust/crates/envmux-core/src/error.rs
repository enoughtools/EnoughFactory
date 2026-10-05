use thiserror::Error;

/// Errors arising from domain-type construction and lifecycle transitions.
#[derive(Debug, Error)]
pub enum CoreError {
    #[error("invalid {kind} name {value:?}: {reason}")]
    InvalidName {
        kind: &'static str,
        value: String,
        reason: &'static str,
    },

    #[error("invalid config hash {0:?}: expected 64 lowercase hex characters")]
    InvalidConfigHash(String),

    #[error(transparent)]
    InvalidTransition(#[from] crate::state::InvalidTransition),
}
