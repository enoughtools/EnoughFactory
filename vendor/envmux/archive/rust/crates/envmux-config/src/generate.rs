//! `toml_edit`-based generation: the commented starter file and
//! `create local config` (copy + recorded base hash for drift detection).

use std::path::Path;

use envmux_core::ConfigHash;

use crate::resolve::BASE_HASH_PREFIX;
use crate::{CONFIG_FILE, ConfigError, LOCAL_CONFIG_FILE};

/// Generate a starter `.envmux.toml`: enough live configuration that the
/// first workspace is genuinely usable — image, non-root user, agent state
/// that survives the workspace — plus worked, commented examples of the
/// sections only the repository can fill in.
///
/// It is deliberately a seed rather than a guess: nothing that could fail a
/// workspace on first `envmux up` is left switched on, and the header points
/// at `envmux config prompt`, which hands an agent the repository and the
/// authoring rules so it can finish the balance.
#[must_use]
pub fn generate_starter(namespace: Option<&str>) -> String {
    let ns_line = match namespace {
        Some(ns) => format!("namespace = \"{ns}\""),
        None => {
            "# namespace = \"my-project\"   # absent: implied from the repository name".to_owned()
        }
    };
    format!(
        r#"# envmux configuration. Committed; reviewed like code.
# A workspace is built from exactly one file, once, at creation.
# To change a running workspace: commit, let capture preserve the work, re-create.
#
# This is a seed, not a survey of your project: what every workspace needs is
# live, and everything only your repository can answer is a commented example
# below. Fill in the balance by hand, or hand the repository to an agent:
#
#     envmux config prompt --agent claude   # also: codex, opencode, gemini
#     envmux config show                    # parse and validate what you wrote

[meta]
schema = 2
{ns_line}

[image]
# One image backs every workspace; tmux >= 3.2 required. Pin a digest or tag —
# a workspace is a product of the config it was created from.
reference = "ghcr.io/strigops-io/envmux-default:0.1.0"
# ...or build from a Dockerfile in this repository instead:
# dockerfile = "Dockerfile.envmux"

[workspace]
# The default image runs as the non-root account `user`, home /home/user. Say
# so here rather than leave it implied: the volume paths below are paths in
# that home, and an image with a different account needs both changed.
user = "user"
workdir = "/work"
# What a session drops you into: "shell" (default), "manage" for the
# management view, or any command the image can run — an agent, say. The
# agent-state volumes below are what make `terminal = "claude"` arrive
# already signed in.
# terminal = "claude"

# Agent credentials and state.
#
# These are envmux named volumes, not host directories. `class = "sync"` is
# persistent and shared by every workspace in the namespace: sign an agent in
# once, in any workspace, and every workspace created afterwards starts signed
# in. `class = "cache"` is the same mechanism for what you would not mind
# losing. Nothing is copied from your machine — the first sign-in happens
# inside a workspace, and credentials are shared namespace-wide, so give work
# that must not see them its own namespace.
[volumes.named.claude]
class = "sync"
path = "/home/user/.claude"

[volumes.named.codex]
class = "sync"
path = "/home/user/.codex"

[volumes.named.opencode]
class = "sync"
path = "/home/user/.config/opencode"

[volumes.named.npm]
class = "cache"
path = "/home/user/.npm"

# One cache volume per toolchain the repository actually uses. Uncomment the
# ones that apply; a cache for a language this project does not build is an
# empty Docker volume per namespace and nothing else.
#
# Rust — the default image keeps CARGO_HOME in /usr/local, not a home:
# [volumes.named.cargo-registry]
# class = "cache"
# path = "/usr/local/cargo/registry"
#
# [volumes.named.cargo-git]
# class = "cache"
# path = "/usr/local/cargo/git"
#
# Python:
# [volumes.named.pip]
# class = "cache"
# path = "/home/user/.cache/pip"
#
# .NET:
# [volumes.named.nuget]
# class = "cache"
# path = "/home/user/.nuget/packages"
#
# Go — the module cache and the build cache are separate, and the build cache
# is the one that makes a second compile fast:
# [volumes.named.go-mod]
# class = "cache"
# path = "/home/user/go/pkg/mod"
#
# [volumes.named.go-build]
# class = "cache"
# path = "/home/user/.cache/go-build"

# Environment exported to every task, and to the shell you attach to.
[env]
# Claude Code keeps `.claude.json` beside $HOME, not inside ~/.claude, so one
# volume only covers the whole of its state once this points it there.
CLAUDE_CONFIG_DIR = "/home/user/.claude"
# RUST_LOG = "debug"

# Tasks are named tmux windows with a dependency graph. They are the whole
# execution mechanism — there is no separate job runner — and they start with
# the workspace, so running one means creating or attaching to a workspace:
#
#     envmux create --wait                  # create; wait for the graph
#     envmux attach <workspace> --task dev  # open that task's window
#     envmux run <workspace> -- npm test    # one-off command beside the tasks
#
# A one-shot task is expected to exit, and a non-zero exit fails the whole
# workspace. A long-running one is not: mark it `long_running` and give it a
# readiness `check`, or `--wait` cannot tell when the workspace is ready.
# Ordering is declared — `after` for tasks, `requires` for services — never
# left to luck.
#
# [tasks.install]
# command = "npm ci"
#
# [tasks.dev]
# command = "npm run dev"
# after = ["install"]
# long_running = true
# check = {{ kind = "http", port = 8080, path = "/health", timeout = "90s" }}
# restart = {{ policy = "on-failure", max = 3, backoff = "3s" }}

# Shared containers, one per namespace. envmux gives each workspace its own
# slice (a database and role, a bucket, a key prefix) and drops scoped
# credentials in /run/envmux/secrets/<name>/. Tasks name them in `requires`.
# [services.db]
# kind = "postgres"        # postgres | minio | redis
# version = "16"

# Ports served by the in-session router at https://<ns>_<ws>_<name>.<domain>/
# Names become part of the hostname: lowercase letters, digits, hyphens.
# [routes]
# web = 8080

# [routing]
# port = 8443              # router loopback port; absent = default, with fallback
# domain = "dev.example"   # absent = platform default (needs wildcard DNS to 127.0.0.1)

# How long a workspace lives before the reaper takes it. A read-write attach
# extends the lease; a busy agent or a running server does not.
# [lease]
# initial = "7d"
# attach_extension = "24h"
# max_workspaces = 8
"#
    )
}

/// Copy the committed file to `.envmux.local.toml`, recording the base hash
/// so the CLI can flag when the base moves. Returns the local file text.
pub fn create_local_config(dir: &Path) -> Result<String, ConfigError> {
    let committed = dir.join(CONFIG_FILE);
    let base = std::fs::read_to_string(&committed).map_err(|source| ConfigError::Io {
        path: committed.display().to_string(),
        source,
    })?;
    // Parse through toml_edit so we fail early on a broken base while
    // preserving its comments and layout verbatim in the copy.
    let doc: toml_edit::DocumentMut =
        base.parse()
            .map_err(|e: toml_edit::TomlError| ConfigError::Parse {
                message: e.to_string(),
                src: miette::NamedSource::new(CONFIG_FILE, base.clone()),
                span: e.span().map(|r| miette::SourceSpan::from(r.start..r.end)),
            })?;
    let hash = ConfigHash::of_bytes(base.as_bytes());
    let text = format!(
        "{BASE_HASH_PREFIX}{hash}\n# Local whole-file override: while this file exists, it IS the\n# configuration; {CONFIG_FILE} is not layered underneath it.\n{doc}",
    );
    let local = dir.join(LOCAL_CONFIG_FILE);
    std::fs::write(&local, &text).map_err(|source| ConfigError::Io {
        path: local.display().to_string(),
        source,
    })?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starter_parses_and_validates() {
        let text = generate_starter(Some("acme"));
        let cfg: crate::Config = toml::from_str(&text).unwrap();
        crate::validate(CONFIG_FILE, &text, &cfg).unwrap();
        assert_eq!(cfg.meta.schema, 2);
        assert_eq!(cfg.meta.namespace.as_deref(), Some("acme"));
        assert!(cfg.image.reference.is_some());
    }

    #[test]
    fn nothing_live_in_the_starter_can_fail_a_first_workspace() {
        // The live half is only what every workspace needs regardless of the
        // repository. Anything whose right value depends on the project —
        // tasks, services, routes, routing — stays a commented example,
        // because a guessed one-shot task that exits non-zero fails the whole
        // workspace on the very first `envmux up`.
        let text = generate_starter(None);
        let cfg: crate::Config = toml::from_str(&text).unwrap();
        crate::validate(CONFIG_FILE, &text, &cfg).unwrap();
        assert!(cfg.tasks.is_empty());
        assert!(cfg.services.is_empty());
        assert!(cfg.routes.is_empty());
        assert_eq!(cfg.routing, crate::Routing::default());
        assert_eq!(cfg.lease, crate::Lease::default());
        for section in ["[tasks.", "[services.", "[routes]", "[routing]", "[lease]"] {
            assert!(
                text.contains(&format!("# {section}")),
                "the starter should show {section} as a commented example"
            );
        }
    }

    #[test]
    fn the_starter_shows_how_a_task_is_actually_run() {
        // Tasks are the one section people meet without a mental model for
        // it: they are tmux windows that start with the workspace, so there
        // is no `envmux task run`. The commented example carries the commands
        // that do exist, or the reader invents one that does not.
        let text = generate_starter(None);
        assert!(text.contains("envmux create --wait"));
        assert!(text.contains("envmux attach <workspace> --task dev"));
        assert!(text.contains("envmux run <workspace> --"));
        assert!(text.contains("# [tasks.dev]"));
        assert!(text.contains("# long_running = true"));
    }

    #[test]
    fn agent_state_is_live_and_lands_in_the_default_image_home() {
        // The point of the seed: a workspace where the agents are signed in.
        // That needs sync volumes on the *image's* home, so these paths and
        // `[workspace] user` are one decision — assert them together, since a
        // volume under the wrong home silently authenticates nothing.
        let text = generate_starter(None);
        let cfg: crate::Config = toml::from_str(&text).unwrap();
        assert_eq!(cfg.workspace.user.as_deref(), Some("user"));
        for agent in ["claude", "codex", "opencode"] {
            let vol = cfg
                .volumes
                .named
                .get(agent)
                .unwrap_or_else(|| panic!("{agent} state should be a named volume"));
            assert_eq!(vol.class, crate::VolumeClassName::Sync, "{agent}");
            assert!(vol.path.starts_with("/home/user/"), "{agent}: {}", vol.path);
        }
        // Claude Code keeps `.claude.json` next to $HOME rather than inside
        // ~/.claude, so without this the volume preserves credentials and
        // loses onboarding state — and every workspace re-onboards.
        assert_eq!(
            cfg.env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            Some("/home/user/.claude")
        );
    }

    #[test]
    fn starter_without_namespace_parses() {
        let text = generate_starter(None);
        let cfg: crate::Config = toml::from_str(&text).unwrap();
        assert_eq!(cfg.meta.namespace, None);
    }

    #[test]
    fn repository_examples_parse_and_validate() {
        for (name, text) in [
            (".envmux.toml", include_str!("../../../.envmux.toml")),
            (
                "envmux.codex.example.toml",
                include_str!("../../../examples/envmux.codex.example.toml"),
            ),
            (
                "envmux.dotnet-node.example.toml",
                include_str!("../../../examples/envmux.dotnet-node.example.toml"),
            ),
            (
                "envmux.rust-node.example.toml",
                include_str!("../../../examples/envmux.rust-node.example.toml"),
            ),
        ] {
            let cfg: crate::Config = toml::from_str(text).unwrap();
            crate::validate(name, text, &cfg).unwrap();
        }
    }
}
