//! The authoring prompt, embedded in the binary.
//!
//! CONCEPT §13: the declaration "is expected to be generated, not
//! hand-written", by something that reads the repository and infers services
//! and tasks. Shipping the prompt inside envmux rather than in documentation
//! means it is always the version that matches this build's schema, and it
//! works with whatever agent the reader already uses — envmux pipes it in and
//! stays out of the way.

/// Instructions for an agent writing `.envmux.toml` for a repository.
pub const AUTHORING_PROMPT: &str = include_str!("../prompts/authoring.md");

/// Agents envmux knows how to invoke, and the argv to run one with the prompt
/// on stdin.
///
/// A short list of the common CLIs, not a plugin system: anything else is
/// reachable by passing its command directly.
pub const KNOWN_AGENTS: &[(&str, &[&str])] = &[
    ("claude", &["claude", "-p"]),
    ("codex", &["codex", "exec"]),
    ("opencode", &["opencode", "run"]),
    ("gemini", &["gemini", "-p"]),
];

/// Resolve an agent name to its argv, or treat the input as a command.
///
/// `claude` resolves to the known invocation; `my-agent --flag` is split and
/// run as given, so an unlisted tool needs no change here.
#[must_use]
pub fn agent_command(agent: &str) -> Vec<String> {
    let trimmed = agent.trim();
    for (name, argv) in KNOWN_AGENTS {
        if trimmed.eq_ignore_ascii_case(name) {
            return argv.iter().map(|s| (*s).to_owned()).collect();
        }
    }
    trimmed.split_whitespace().map(str::to_owned).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_is_embedded_and_covers_the_schema() {
        assert!(AUTHORING_PROMPT.len() > 1000);
        // The things an agent gets wrong without being told.
        for needle in [
            "tmux",
            "long_running",
            "requires",
            "after",
            "/run/envmux/secrets",
            "schema = 2",
        ] {
            assert!(
                AUTHORING_PROMPT.contains(needle),
                "the prompt should mention {needle:?}"
            );
        }
    }

    #[test]
    fn known_agents_resolve_to_their_invocation() {
        assert_eq!(agent_command("claude"), vec!["claude", "-p"]);
        assert_eq!(agent_command("CLAUDE"), vec!["claude", "-p"]);
        assert_eq!(agent_command("codex"), vec!["codex", "exec"]);
    }

    #[test]
    fn an_unknown_agent_is_taken_as_a_command() {
        assert_eq!(agent_command("my-agent"), vec!["my-agent"]);
        assert_eq!(
            agent_command("uvx some-agent --yes"),
            vec!["uvx", "some-agent", "--yes"]
        );
    }
}
