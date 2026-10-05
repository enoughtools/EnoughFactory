//! `${...}` interpolation for env values and task exports. Covers host
//! environment (`${host.VAR}`), workspace identity (`${workspace.name}`,
//! `${workspace.namespace}`, `${workspace.branch}`, `${workspace.workdir}`),
//! and service/task exports (`${export.NAME.KEY}` — task exports and
//! provisioned-slice credential *paths* land in the same map).

use std::collections::BTreeMap;

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum InterpolationError {
    #[error("unterminated ${{ in {0:?}")]
    Unterminated(String),
    #[error("unknown interpolation {0:?}")]
    Unknown(String),
}

/// Values available to interpolation at workspace creation.
#[derive(Debug, Clone, Default)]
pub struct InterpolationContext {
    /// Host environment as visible to the daemon.
    pub host: BTreeMap<String, String>,
    /// `workspace.*` identity values.
    pub workspace: BTreeMap<String, String>,
    /// `export.<name>.<key>` values: task exports and slice credential paths.
    pub exports: BTreeMap<String, BTreeMap<String, String>>,
}

impl InterpolationContext {
    fn lookup(&self, path: &str) -> Option<String> {
        let (head, rest) = path.split_once('.')?;
        match head {
            "host" => self.host.get(rest).cloned(),
            "workspace" => self.workspace.get(rest).cloned(),
            "export" => {
                let (name, key) = rest.split_once('.')?;
                self.exports.get(name)?.get(key).cloned()
            }
            _ => None,
        }
    }
}

/// Interpolate `${...}` references. `$$` escapes a literal `$`.
pub fn interpolate(input: &str, ctx: &InterpolationContext) -> Result<String, InterpolationError> {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.char_indices().peekable();
    while let Some((_, c)) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some((_, '$')) => {
                chars.next();
                out.push('$');
            }
            Some((_, '{')) => {
                chars.next();
                let mut path = String::new();
                let mut closed = false;
                for (_, c) in chars.by_ref() {
                    if c == '}' {
                        closed = true;
                        break;
                    }
                    path.push(c);
                }
                if !closed {
                    return Err(InterpolationError::Unterminated(input.to_owned()));
                }
                let value = ctx
                    .lookup(&path)
                    .ok_or_else(|| InterpolationError::Unknown(path.clone()))?;
                out.push_str(&value);
            }
            _ => out.push('$'),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> InterpolationContext {
        let mut c = InterpolationContext::default();
        c.host.insert("HOME".into(), "/home/dev".into());
        c.workspace.insert("name".into(), "wobbly-otter".into());
        c.workspace.insert("namespace".into(), "acme".into());
        c.exports
            .entry("db".into())
            .or_default()
            .insert("DATABASE_URL_FILE".into(), "/run/envmux/secrets/db".into());
        c
    }

    #[test]
    fn interpolates_all_sources() {
        let out = interpolate(
            "ws=${workspace.name} ns=${workspace.namespace} h=${host.HOME} db=${export.db.DATABASE_URL_FILE}",
            &ctx(),
        )
        .unwrap();
        assert_eq!(
            out,
            "ws=wobbly-otter ns=acme h=/home/dev db=/run/envmux/secrets/db"
        );
    }

    #[test]
    fn escapes_and_literals() {
        assert_eq!(interpolate("a$$b", &ctx()).unwrap(), "a$b");
        assert_eq!(interpolate("plain $5", &ctx()).unwrap(), "plain $5");
    }

    #[test]
    fn unknown_and_unterminated_error() {
        assert_eq!(
            interpolate("${nope.x}", &ctx()).unwrap_err(),
            InterpolationError::Unknown("nope.x".into())
        );
        assert!(matches!(
            interpolate("${workspace.name", &ctx()).unwrap_err(),
            InterpolationError::Unterminated(_)
        ));
    }
}
