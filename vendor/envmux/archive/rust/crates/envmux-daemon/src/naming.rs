//! Workspace naming: fully random petnames by default, branch-derived with a
//! random suffix when configured, or a caller-requested name. The name is the
//! workspace's identity — not the branch.

use envmux_config::NamingStrategy;
use envmux_core::WorkspaceName;

/// Sanitize an arbitrary branch name into name-safe characters.
fn sanitize(s: &str) -> String {
    let mut out: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    let out = out.trim_matches('-').to_owned();
    // Leave room for the random suffix.
    out.chars().take(40).collect()
}

/// Generate a candidate name; the caller retries on collision.
#[must_use]
pub fn generate(strategy: NamingStrategy, branch: &str) -> WorkspaceName {
    let name = match strategy {
        NamingStrategy::Random => petname::petname(2, "-").unwrap_or_else(|| "workspace".into()),
        NamingStrategy::Branch => {
            let stem = sanitize(branch);
            let suffix = petname::petname(1, "-").unwrap_or_else(|| "x".into());
            if stem.is_empty() {
                suffix
            } else {
                format!("{stem}-{suffix}")
            }
        }
    };
    WorkspaceName::new(name).unwrap_or_else(|_| {
        // Petnames are name-safe by construction; this is a last resort.
        WorkspaceName::new(format!("ws-{}", uuid::Uuid::now_v7().simple()))
            .expect("uuid name valid")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_names_are_valid_and_vary() {
        let a = generate(NamingStrategy::Random, "main");
        let b = generate(NamingStrategy::Random, "main");
        // Petname collisions across two draws are vanishingly unlikely; if
        // this ever flakes the generator is broken enough to care.
        assert_ne!(a, b);
    }

    #[test]
    fn branch_names_sanitize() {
        let n = generate(NamingStrategy::Branch, "feature/ABC_123!!weird");
        assert!(n.as_str().starts_with("feature-abc-123-weird-"));
    }

    #[test]
    fn empty_branch_still_names() {
        let n = generate(NamingStrategy::Branch, "///");
        assert!(!n.as_str().is_empty());
    }
}
