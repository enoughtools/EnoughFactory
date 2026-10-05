//! Prebuilt starting points for `.envmux.toml`.
//!
//! Onboarding used to be a yes/no question that wrote one commented seed. That
//! is a fine answer for someone who already knows the format and a poor one
//! for everybody else: the file it writes runs nothing, serves nothing, and
//! leaves the reader to work out which of nine commented sections applies to
//! them.
//!
//! A preset is the other half of that — a small, complete configuration for a
//! recognisable kind of project, with the install and dev commands filled in
//! and the ports that [`crate::detect`] found already routed. It is chosen
//! from a list, previewed in full before anything is written, and is ordinary
//! TOML afterwards: there is no preset recorded anywhere, nothing that
//! re-generates, and nothing that resents being edited.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use crate::detect::{Detected, PackageManager, Stack};

/// The catalogue's entries. Not open for extension by config — a preset is a
/// starting point that ships with the tool, and one you can name is one you
/// can pick deterministically from a list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresetId {
    /// A shell and the agent state volumes. No tasks, no routes, nothing that
    /// can fail — the answer for a repository nobody has decided about yet.
    Minimal,
    Node,
    Next,
    Vite,
    Rust,
    Python,
    Go,
    Dotnet,
}

/// One catalogue entry, as the picker shows it.
pub struct Preset {
    pub id: PresetId,
    /// Lowercase, always: it is a name in a list, not a headline.
    pub label: &'static str,
    /// One line, on the row under the label.
    pub summary: &'static str,
}

/// Every preset, in the order the picker lists them.
///
/// Fixed order rather than sorted-by-relevance: the recommended one is marked
/// and pre-selected, but the list underneath it stays where it was last time
/// so the muscle memory of picking `rust` from the middle keeps working.
#[must_use]
pub fn catalogue() -> &'static [Preset] {
    &[
        Preset {
            id: PresetId::Minimal,
            label: "minimal",
            summary: "a shell, and agents that arrive signed in — nothing that can fail",
        },
        Preset {
            id: PresetId::Node,
            label: "node",
            summary: "install and dev script, package-manager cache",
        },
        Preset {
            id: PresetId::Next,
            label: "next.js",
            summary: "install, next dev, and the dev server routed",
        },
        Preset {
            id: PresetId::Vite,
            label: "vite",
            summary: "install, vite dev bound to 0.0.0.0, and it routed",
        },
        Preset {
            id: PresetId::Rust,
            label: "rust",
            summary: "cargo fetch, registry and git caches",
        },
        Preset {
            id: PresetId::Python,
            label: "python",
            summary: "dependency install, pip cache, django dev server when there is one",
        },
        Preset {
            id: PresetId::Go,
            label: "go",
            summary: "go mod download, module and build caches",
        },
        Preset {
            id: PresetId::Dotnet,
            label: ".net",
            summary: "dotnet restore, nuget cache",
        },
    ]
}

/// Which preset the catalogue should open on for this repository.
///
/// Falls back to [`PresetId::Minimal`], which is the honest answer when
/// nothing was recognised: the alternative is offering a Node config to a
/// repository with no `package.json` in it.
#[must_use]
pub fn recommended(detected: &Detected) -> PresetId {
    match detected.primary() {
        Some(Stack::Next) => PresetId::Next,
        Some(Stack::Vite) => PresetId::Vite,
        Some(Stack::Node) => PresetId::Node,
        Some(Stack::Rust) => PresetId::Rust,
        Some(Stack::Python) => PresetId::Python,
        Some(Stack::Go) => PresetId::Go,
        Some(Stack::Dotnet) => PresetId::Dotnet,
        None => PresetId::Minimal,
    }
}

/// Where the workspace image comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageSource {
    /// The pinned default image.
    Reference(String),
    /// The repository builds its own, and already says how.
    Dockerfile(String),
}

/// A named volume the plan will declare.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedVolume {
    pub name: String,
    /// `cache` or `sync`, spelled as it appears in the file.
    pub class: &'static str,
    pub path: String,
}

/// A task the plan will declare.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedTask {
    pub name: String,
    pub command: String,
    pub after: Vec<String>,
    pub long_running: bool,
    /// Port to health-check, for a long-running task that serves one.
    pub check_port: Option<u16>,
}

/// The complete, resolved intention: exactly what will be written, in a shape
/// the picker can also summarise on screen.
///
/// The plan exists as data rather than as a string so the onboarding view can
/// show "3 tasks · 1 route · 2 caches" beside the preview without parsing the
/// TOML it is about to write.
#[derive(Debug, Clone)]
pub struct Plan {
    pub preset: PresetId,
    pub namespace: Option<String>,
    pub image: ImageSource,
    pub volumes: Vec<PlannedVolume>,
    pub tasks: Vec<PlannedTask>,
    pub routes: BTreeMap<String, u16>,
    /// What detection contributed, for display: one line each, already
    /// phrased for a human.
    pub notes: Vec<String>,
}

/// The image every preset starts from when the repository does not build one.
pub const DEFAULT_IMAGE: &str = "ghcr.io/strigops-io/envmux-default:0.1.0";

/// The agent state volumes. Live in every preset, because a workspace where
/// the agent is already signed in is most of the point of one.
fn agent_volumes() -> Vec<PlannedVolume> {
    [
        ("claude", "/home/user/.claude"),
        ("codex", "/home/user/.codex"),
        ("opencode", "/home/user/.config/opencode"),
    ]
    .into_iter()
    .map(|(name, path)| PlannedVolume {
        name: name.to_owned(),
        class: "sync",
        path: path.to_owned(),
    })
    .collect()
}

fn cache(name: &str, path: &str) -> PlannedVolume {
    PlannedVolume {
        name: name.to_owned(),
        class: "cache",
        path: path.to_owned(),
    }
}

impl Plan {
    /// Resolve a preset against what detection found.
    ///
    /// Detection only ever *fills in* a preset — it never changes which one
    /// you picked. Choosing `rust` on a repository that also has a
    /// `package.json` gives you the Rust preset, because you said so.
    #[must_use]
    pub fn new(preset: PresetId, detected: &Detected, namespace: Option<&str>) -> Self {
        let mut plan = Self {
            preset,
            namespace: namespace.map(ToOwned::to_owned),
            image: detected.dockerfile.clone().map_or_else(
                || ImageSource::Reference(DEFAULT_IMAGE.to_owned()),
                ImageSource::Dockerfile,
            ),
            volumes: agent_volumes(),
            tasks: Vec::new(),
            routes: BTreeMap::new(),
            notes: Vec::new(),
        };

        if let ImageSource::Dockerfile(file) = &plan.image {
            plan.notes.push(format!(
                "building the image from {file}, which this repository already has"
            ));
        }

        // Routes come from detection regardless of preset: a port the
        // repository declares is a fact about the repository, not about the
        // stack somebody picked for it. Minimal is the exception — it exists
        // to declare nothing.
        if preset != PresetId::Minimal {
            for hint in &detected.ports {
                plan.routes.insert(hint.name.clone(), hint.port);
                plan.notes.push(format!(
                    "route {} → {} (from {})",
                    hint.name, hint.port, hint.source
                ));
            }
        }

        match preset {
            PresetId::Minimal => {}
            PresetId::Node | PresetId::Next | PresetId::Vite => plan.plan_node(preset, detected),
            PresetId::Rust => plan.plan_rust(),
            PresetId::Python => plan.plan_python(detected),
            PresetId::Go => plan.plan_go(),
            PresetId::Dotnet => plan.plan_dotnet(),
        }
        plan
    }

    /// The primary route's port, if there is one — what a dev task should be
    /// health-checked on.
    fn primary_port(&self) -> Option<u16> {
        self.routes
            .get("web")
            .copied()
            .or_else(|| self.routes.values().copied().next())
    }

    fn plan_node(&mut self, preset: PresetId, detected: &Detected) {
        let manager = detected.package_manager.unwrap_or(PackageManager::Npm);
        let (cache_name, cache_path) = manager.cache();
        self.volumes.push(cache(cache_name, cache_path));
        self.notes
            .push(format!("{} is the package manager here", manager.label()));

        self.tasks.push(PlannedTask {
            name: "install".to_owned(),
            command: manager.install().to_owned(),
            after: Vec::new(),
            long_running: false,
            check_port: None,
        });

        // The script to run, in the order a project is likely to mean it.
        // `dev` when it exists, because that is what a workspace is for.
        let script = ["dev", "start", "serve"]
            .into_iter()
            .find(|name| detected.scripts.contains_key(*name));
        let Some(script) = script else {
            self.notes.push(
                "no dev/start script in package.json — only the install task is declared"
                    .to_owned(),
            );
            return;
        };

        let mut command = manager.run(script);
        // Vite binds loopback unless told otherwise, and a dev server on
        // 127.0.0.1 inside a container is reachable from nothing at all — not
        // the router, not the browser. This is the single most common way a
        // routed workspace comes up "working" and serves nobody.
        if preset == PresetId::Vite {
            command.push_str(match detected.package_manager {
                // npm and yarn need the `--` to stop eating the flag.
                Some(PackageManager::Pnpm | PackageManager::Bun) => " --host 0.0.0.0",
                _ => " -- --host 0.0.0.0",
            });
            self.notes
                .push("vite is bound to 0.0.0.0 so the route can reach it".to_owned());
        }

        self.tasks.push(PlannedTask {
            name: "dev".to_owned(),
            command,
            after: vec!["install".to_owned()],
            long_running: true,
            check_port: self.primary_port(),
        });
    }

    fn plan_rust(&mut self) {
        // CARGO_HOME lives in /usr/local in the default image, not in a home
        // directory — a cache volume on ~/.cargo would silently cache nothing.
        self.volumes
            .push(cache("cargo-registry", "/usr/local/cargo/registry"));
        self.volumes
            .push(cache("cargo-git", "/usr/local/cargo/git"));
        // Fetch, not build: `cargo build` on a fresh workspace is minutes of
        // waiting before the first prompt, and `cargo run` on a library crate
        // is a non-zero exit that fails the whole workspace.
        self.tasks.push(PlannedTask {
            name: "fetch".to_owned(),
            command: "cargo fetch".to_owned(),
            after: Vec::new(),
            long_running: false,
            check_port: None,
        });
    }

    fn plan_python(&mut self, detected: &Detected) {
        self.volumes.push(cache("pip", "/home/user/.cache/pip"));

        // Whichever dependency file is actually committed decides the command.
        // There is no safe default when none of them is: `pip install -r
        // requirements.txt` against a repository with no requirements.txt is a
        // one-shot non-zero exit, and that fails the whole workspace.
        let install = [
            ("uv.lock", "uv sync --frozen"),
            ("poetry.lock", "poetry install"),
            ("Pipfile.lock", "pipenv sync"),
            ("requirements.txt", "pip install -r requirements.txt"),
            ("pyproject.toml", "pip install -e ."),
        ]
        .into_iter()
        .find(|(marker, _)| detected.has(marker));

        match install {
            Some((marker, command)) => {
                self.notes
                    .push(format!("{marker} decides the install command"));
                self.tasks.push(PlannedTask {
                    name: "install".to_owned(),
                    command: command.to_owned(),
                    after: Vec::new(),
                    long_running: false,
                    check_port: None,
                });
            }
            None => self
                .notes
                .push("no dependency file found — no install task declared".to_owned()),
        }

        // Django is the one Python layout whose dev command is knowable from a
        // filename. `0.0.0.0` rather than the default loopback bind, for the
        // same reason Vite gets `--host`: a server on 127.0.0.1 inside a
        // container is reachable from nothing.
        if detected.has("manage.py") {
            let port = self.primary_port().unwrap_or(8000);
            self.routes.entry("web".to_owned()).or_insert(port);
            self.tasks.push(PlannedTask {
                name: "dev".to_owned(),
                command: format!("python manage.py runserver 0.0.0.0:{port}"),
                after: self.tasks.iter().map(|t| t.name.clone()).collect(),
                long_running: true,
                check_port: Some(port),
            });
            self.notes
                .push("manage.py is here, so the django dev server is the dev task".to_owned());
        }
    }

    fn plan_go(&mut self) {
        self.volumes.push(cache("go-mod", "/home/user/go/pkg/mod"));
        // The build cache is the one that makes the second compile fast.
        self.volumes
            .push(cache("go-build", "/home/user/.cache/go-build"));
        self.tasks.push(PlannedTask {
            name: "deps".to_owned(),
            command: "go mod download".to_owned(),
            after: Vec::new(),
            long_running: false,
            check_port: None,
        });
    }

    fn plan_dotnet(&mut self) {
        self.volumes
            .push(cache("nuget", "/home/user/.nuget/packages"));
        self.tasks.push(PlannedTask {
            name: "restore".to_owned(),
            command: "dotnet restore".to_owned(),
            after: Vec::new(),
            long_running: false,
            check_port: None,
        });
    }

    /// The file, exactly as it will be written.
    #[must_use]
    pub fn render(&self) -> String {
        if self.preset == PresetId::Minimal {
            return crate::generate_starter(self.namespace.as_deref());
        }

        let mut out = String::new();
        out.push_str(
            "# envmux configuration. Committed; reviewed like code.\n\
             # A workspace is built from exactly one file, once, at creation.\n\
             # To change a running workspace: commit, let capture preserve the work, re-create.\n\
             #\n\
             # Written by `envmux` onboarding from what this repository looks like.\n\
             # It is ordinary TOML now — edit it freely, nothing regenerates it.\n\
             #\n\
             #     envmux config show                    # parse and validate what you wrote\n\
             #     envmux config prompt --agent claude   # hand the rest to an agent\n\n",
        );

        out.push_str("[meta]\nschema = 2\n");
        match &self.namespace {
            Some(ns) => {
                let _ = writeln!(out, "namespace = \"{ns}\"");
            }
            None => out.push_str(
                "# namespace = \"my-project\"   # absent: implied from the repository name\n",
            ),
        }

        out.push_str("\n[image]\n");
        match &self.image {
            ImageSource::Reference(reference) => {
                out.push_str(
                    "# One image backs every workspace; tmux >= 3.2 required. Pin a digest or\n\
                     # tag — a workspace is a product of the config it was created from.\n",
                );
                let _ = writeln!(out, "reference = \"{reference}\"");
            }
            ImageSource::Dockerfile(file) => {
                out.push_str("# This repository builds its own image, so envmux uses it.\n");
                let _ = writeln!(out, "dockerfile = \"{file}\"");
            }
        }

        out.push_str(
            "\n[workspace]\n\
             # The default image runs as the non-root account `user`, home /home/user — the\n\
             # volume paths below are paths in that home.\n\
             user = \"user\"\n\
             workdir = \"/work\"\n\
             # What a session drops you into: \"shell\" (default), \"manage\", or any command\n\
             # the image can run. `terminal = \"claude\"` arrives signed in, via the volumes\n\
             # below.\n\
             # terminal = \"claude\"\n",
        );

        out.push_str(
            "\n# Agent credentials and state. `class = \"sync\"` is persistent and shared by\n\
             # every workspace in the namespace: sign in once, in any workspace, and every\n\
             # workspace created afterwards starts signed in. Nothing is copied from your\n\
             # machine. Credentials are namespace-wide, so give work that must not see them\n\
             # its own namespace.\n",
        );
        for volume in &self.volumes {
            let _ = writeln!(
                out,
                "\n[volumes.named.{}]\nclass = \"{}\"\npath = \"{}\"",
                volume.name, volume.class, volume.path
            );
        }

        out.push_str(
            "\n# Environment exported to every task, and to the shell you attach to.\n\
             [env]\n\
             # Claude Code keeps `.claude.json` beside $HOME rather than inside ~/.claude, so\n\
             # one volume only covers the whole of its state once this points it there.\n\
             CLAUDE_CONFIG_DIR = \"/home/user/.claude\"\n",
        );

        if self.tasks.is_empty() {
            out.push_str(
                "\n# Tasks are named tmux windows with a dependency graph — they start with\n\
                 # the workspace, so there is no separate job runner.\n\
                 # [tasks.dev]\n\
                 # command = \"npm run dev\"\n\
                 # long_running = true\n",
            );
        } else {
            out.push_str(
                "\n# Tasks are named tmux windows with a dependency graph. They start with the\n\
                 # workspace, so running one means creating or attaching to a workspace:\n\
                 #\n\
                 #     envmux create --wait                  # create; wait for the graph\n\
                 #     envmux attach <workspace> --task dev  # open that task's window\n\
                 #\n\
                 # A one-shot task is expected to exit, and a non-zero exit fails the whole\n\
                 # workspace. A long-running one is not.\n",
            );
            for task in &self.tasks {
                let _ = writeln!(out, "\n[tasks.{}]", task.name);
                let _ = writeln!(out, "command = {}", toml_string(&task.command));
                if !task.after.is_empty() {
                    let list: Vec<String> = task.after.iter().map(|a| toml_string(a)).collect();
                    let _ = writeln!(out, "after = [{}]", list.join(", "));
                }
                if task.long_running {
                    out.push_str("long_running = true\n");
                }
                if let Some(port) = task.check_port {
                    let _ = writeln!(
                        out,
                        "check = {{ kind = \"http\", port = {port}, path = \"/\", timeout = \"90s\" }}"
                    );
                }
            }
        }

        out.push_str(
            "\n# Ports served by the in-session router at\n\
             # https://<ns>_<ws>_<name>.<domain>/ — names become part of the hostname, so\n\
             # they are lowercase letters, digits and hyphens.\n",
        );
        if self.routes.is_empty() {
            out.push_str("# [routes]\n# web = 8080\n");
        } else {
            out.push_str("[routes]\n");
            for (name, port) in &self.routes {
                let _ = writeln!(out, "{name} = {port}");
            }
        }

        out.push_str(
            "\n# Shared containers, one per namespace, with a per-workspace slice and scoped\n\
             # credentials in /run/envmux/secrets/<name>/. Tasks name them in `requires`.\n\
             # [services.db]\n\
             # kind = \"postgres\"        # postgres | minio | redis\n\
             # version = \"16\"\n\
             \n\
             # How long a workspace lives before the reaper takes it. A read-write attach\n\
             # extends the lease; a busy agent or a running server does not.\n\
             # [lease]\n\
             # initial = \"7d\"\n\
             # attach_extension = \"24h\"\n",
        );

        out
    }
}

/// A TOML basic string with the two characters that would break it escaped.
///
/// Commands come from a package manager's script names and from detection, so
/// a quote or a backslash in one is unlikely — and "unlikely" is exactly the
/// input that produces a config file nobody can parse and nobody expected to
/// have to.
fn toml_string(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detect::PortHint;

    fn detected_node(manager: PackageManager, script: &str, port: Option<u16>) -> Detected {
        let mut detected = Detected {
            package_manager: Some(manager),
            ..Detected::default()
        };
        detected
            .scripts
            .insert(script.to_owned(), "whatever".to_owned());
        if let Some(port) = port {
            detected.ports.push(PortHint {
                name: "web".to_owned(),
                port,
                source: "test".to_owned(),
            });
        }
        detected
    }

    /// Every preset must produce a file that parses and validates. This is the
    /// whole contract: onboarding writes it unattended and the next thing that
    /// happens is a workspace being built from it.
    #[test]
    fn every_preset_renders_a_valid_config() {
        let detected = detected_node(PackageManager::Pnpm, "dev", Some(3000));
        for preset in catalogue() {
            let plan = Plan::new(preset.id, &detected, Some("acme"));
            let text = plan.render();
            let cfg: crate::Config = toml::from_str(&text)
                .unwrap_or_else(|e| panic!("{} did not parse: {e}", preset.label));
            crate::validate(crate::CONFIG_FILE, &text, &cfg)
                .unwrap_or_else(|e| panic!("{} did not validate: {e}", preset.label));
            assert_eq!(cfg.meta.schema, 2);
            assert_eq!(cfg.meta.namespace.as_deref(), Some("acme"));
        }
    }

    /// And with nothing detected at all, which is the case for a repository
    /// somebody picked a preset for by hand.
    #[test]
    fn every_preset_renders_a_valid_config_from_nothing() {
        let detected = Detected::default();
        for preset in catalogue() {
            let plan = Plan::new(preset.id, &detected, None);
            let text = plan.render();
            let cfg: crate::Config = toml::from_str(&text)
                .unwrap_or_else(|e| panic!("{} did not parse: {e}", preset.label));
            crate::validate(crate::CONFIG_FILE, &text, &cfg)
                .unwrap_or_else(|e| panic!("{} did not validate: {e}", preset.label));
            assert!(cfg.meta.namespace.is_none());
        }
    }

    #[test]
    fn the_minimal_preset_declares_nothing_that_can_fail() {
        // It is the answer for a repository nobody has decided about, and its
        // only promise is that `envmux` comes up.
        let detected = detected_node(PackageManager::Npm, "dev", Some(3000));
        let plan = Plan::new(PresetId::Minimal, &detected, None);
        let cfg: crate::Config = toml::from_str(&plan.render()).unwrap();
        assert!(cfg.tasks.is_empty());
        assert!(cfg.routes.is_empty());
        assert!(plan.routes.is_empty());
    }

    #[test]
    fn a_detected_port_becomes_a_route_and_the_dev_check() {
        let detected = detected_node(PackageManager::Npm, "dev", Some(4321));
        let plan = Plan::new(PresetId::Vite, &detected, None);
        assert_eq!(plan.routes.get("web"), Some(&4321));
        let dev = plan
            .tasks
            .iter()
            .find(|t| t.name == "dev")
            .expect("a dev task");
        assert_eq!(dev.check_port, Some(4321));

        let cfg: crate::Config = toml::from_str(&plan.render()).unwrap();
        assert_eq!(cfg.routes.get("web"), Some(&4321));
        assert!(matches!(
            cfg.tasks["dev"].check,
            Some(crate::Check::Http { port: 4321, .. })
        ));
    }

    /// The bug this catches is invisible until someone opens the route: a Vite
    /// server on 127.0.0.1 inside a container serves nobody, and the workspace
    /// otherwise looks perfectly healthy.
    #[test]
    fn vite_is_bound_where_the_router_can_reach_it() {
        for (manager, expected) in [
            (PackageManager::Npm, "npm run dev -- --host 0.0.0.0"),
            (PackageManager::Pnpm, "pnpm dev --host 0.0.0.0"),
            (PackageManager::Yarn, "yarn dev -- --host 0.0.0.0"),
            (PackageManager::Bun, "bun run dev --host 0.0.0.0"),
        ] {
            let detected = detected_node(manager, "dev", Some(5173));
            let plan = Plan::new(PresetId::Vite, &detected, None);
            let dev = plan.tasks.iter().find(|t| t.name == "dev").unwrap();
            assert_eq!(dev.command, expected, "{}", manager.label());
        }
    }

    #[test]
    fn the_lockfile_decides_the_install_command_and_the_cache() {
        let detected = detected_node(PackageManager::Pnpm, "dev", None);
        let plan = Plan::new(PresetId::Node, &detected, None);
        let install = plan.tasks.iter().find(|t| t.name == "install").unwrap();
        assert_eq!(install.command, "pnpm install --frozen-lockfile");
        assert!(plan.volumes.iter().any(|v| v.name == "pnpm-store"));
        // And the dev task waits for it rather than racing it.
        let dev = plan.tasks.iter().find(|t| t.name == "dev").unwrap();
        assert_eq!(dev.after, vec!["install".to_owned()]);
    }

    #[test]
    fn a_node_project_with_no_dev_script_gets_no_dev_task() {
        // Inventing `npm run dev` for a package that has no such script is a
        // task that exits non-zero, and a one-shot non-zero exit fails the
        // whole workspace on the very first `envmux`.
        let mut detected = Detected {
            package_manager: Some(PackageManager::Npm),
            ..Detected::default()
        };
        detected
            .scripts
            .insert("test".to_owned(), "jest".to_owned());
        let plan = Plan::new(PresetId::Node, &detected, None);
        assert_eq!(plan.tasks.len(), 1);
        assert_eq!(plan.tasks[0].name, "install");
        assert!(plan.notes.iter().any(|n| n.contains("no dev/start script")));
    }

    #[test]
    fn a_repository_that_builds_its_own_image_keeps_it() {
        let detected = Detected {
            dockerfile: Some("Dockerfile".to_owned()),
            ..Detected::default()
        };
        let plan = Plan::new(PresetId::Go, &detected, None);
        assert_eq!(plan.image, ImageSource::Dockerfile("Dockerfile".to_owned()));
        let cfg: crate::Config = toml::from_str(&plan.render()).unwrap();
        assert_eq!(cfg.image.dockerfile.as_deref(), Some("Dockerfile"));
        // And never both — the two are mutually exclusive and validation says so.
        assert!(cfg.image.reference.is_none());
    }

    #[test]
    fn picking_a_preset_overrides_what_was_detected() {
        // Detection fills a preset in; it never changes which one you chose.
        let detected = detected_node(PackageManager::Npm, "dev", Some(3000));
        let plan = Plan::new(PresetId::Rust, &detected, None);
        assert!(plan.tasks.iter().any(|t| t.command == "cargo fetch"));
        assert!(!plan.tasks.iter().any(|t| t.command.contains("npm")));
        // The detected port is still a fact about the repository, so it is
        // still routed.
        assert_eq!(plan.routes.get("web"), Some(&3000));
    }

    #[test]
    fn every_stack_preset_is_recommended_by_its_own_stack() {
        for (stack, expected) in [
            (Stack::Next, PresetId::Next),
            (Stack::Vite, PresetId::Vite),
            (Stack::Node, PresetId::Node),
            (Stack::Rust, PresetId::Rust),
            (Stack::Python, PresetId::Python),
            (Stack::Go, PresetId::Go),
            (Stack::Dotnet, PresetId::Dotnet),
        ] {
            let detected = Detected {
                stacks: vec![stack],
                ..Detected::default()
            };
            assert_eq!(recommended(&detected), expected, "{}", stack.label());
        }
        assert_eq!(recommended(&Detected::default()), PresetId::Minimal);
    }

    #[test]
    fn rendering_is_deterministic() {
        let detected = detected_node(PackageManager::Yarn, "dev", Some(3000));
        let plan = Plan::new(PresetId::Node, &detected, Some("acme"));
        let first = plan.render();
        for _ in 0..5 {
            assert_eq!(
                Plan::new(PresetId::Node, &detected, Some("acme")).render(),
                first
            );
        }
    }

    #[test]
    fn a_command_with_a_quote_in_it_still_produces_parseable_toml() {
        assert_eq!(toml_string(r#"echo "hi""#), r#""echo \"hi\"""#);
        assert_eq!(toml_string(r"C:\path"), r#""C:\\path""#);
    }
}
