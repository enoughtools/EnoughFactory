//! Config errors as `miette` diagnostics: span-carrying where the underlying
//! parser gives us spans, key-path labelled for semantic validation.

use miette::{Diagnostic, NamedSource, SourceSpan};
use thiserror::Error;

#[derive(Debug, Error, Diagnostic)]
pub enum ConfigError {
    #[error("failed to read {path}")]
    #[diagnostic(code(envmux::config::io))]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("no {committed} or {local} found in {dir}", committed = crate::CONFIG_FILE, local = crate::LOCAL_CONFIG_FILE)]
    #[diagnostic(
        code(envmux::config::missing),
        help("run `envmux config generate` to create a starter .envmux.toml")
    )]
    NotFound { dir: String },

    #[error("{message}")]
    #[diagnostic(code(envmux::config::parse))]
    Parse {
        message: String,
        #[source_code]
        src: NamedSource<String>,
        #[label("here")]
        span: Option<SourceSpan>,
    },

    #[error("{message}")]
    #[diagnostic(code(envmux::config::invalid))]
    Invalid {
        message: String,
        #[source_code]
        src: NamedSource<String>,
        #[label("declared here")]
        span: Option<SourceSpan>,
        #[help]
        help: Option<String>,
    },
}

impl ConfigError {
    /// Build a `Parse` diagnostic from a `toml` deserialization error,
    /// carrying its span into the miette label.
    pub fn from_toml(file_name: &str, text: &str, err: &toml::de::Error) -> Self {
        Self::Parse {
            message: err.message().to_owned(),
            src: NamedSource::new(file_name, text.to_owned()),
            span: err.span().map(|r| SourceSpan::from(r.start..r.end)),
        }
    }

    /// Build an `Invalid` diagnostic for a semantic error, best-effort
    /// locating `needle` (e.g. a key or section header) in the source text.
    pub fn invalid(
        file_name: &str,
        text: &str,
        needle: &str,
        message: impl Into<String>,
        help: Option<String>,
    ) -> Self {
        let span = text
            .find(needle)
            .map(|start| SourceSpan::from(start..start + needle.len()));
        Self::Invalid {
            message: message.into(),
            src: NamedSource::new(file_name, text.to_owned()),
            span,
            help,
        }
    }
}
