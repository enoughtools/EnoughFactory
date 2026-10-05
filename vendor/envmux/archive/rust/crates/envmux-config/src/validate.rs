//! Semantic validation beyond what serde enforces: name validity, image
//! exclusivity, task-graph shape (cycles rejected here, not at run time),
//! dependency references, and route/port sanity.

use std::collections::HashMap;

use petgraph::graph::DiGraph;

use crate::{Check, Config, ConfigError};

/// Parse and validate configuration text that is not a file on disk yet.
///
/// The same two steps [`crate::resolve_dir`] does after reading, exposed for
/// text that is about to become a file — a generated preset being checked
/// before it is offered, a fragment in a test. `file_name` is only what
/// diagnostics will call it.
pub fn parse(file_name: &str, text: &str) -> Result<Config, ConfigError> {
    let config: Config =
        toml::from_str(text).map_err(|e| ConfigError::from_toml(file_name, text, &e))?;
    validate(file_name, text, &config)?;
    Ok(config)
}

/// Validate a parsed config against the source it came from (the source text
/// is used only to point diagnostics at the offending key).
pub fn validate(file_name: &str, text: &str, cfg: &Config) -> Result<(), ConfigError> {
    let invalid = |needle: &str, msg: String, help: Option<String>| {
        ConfigError::invalid(file_name, text, needle, msg, help)
    };

    // Schema 2 is current; 1 is accepted and parses with no behavior change,
    // so files written before the trim keep working.
    if !matches!(cfg.meta.schema, 1 | 2) {
        return Err(invalid(
            "schema",
            format!("unsupported schema version {}", cfg.meta.schema),
            Some("this envmux understands schema = 1 or schema = 2".into()),
        ));
    }

    if let Some(ns) = &cfg.meta.namespace {
        envmux_core::NamespaceName::new(ns.clone())
            .map_err(|e| invalid(ns, e.to_string(), None))?;
    }

    match (&cfg.image.dockerfile, &cfg.image.reference) {
        (None, None) => {
            return Err(invalid(
                "[image]",
                "image must declare either `dockerfile` or `reference`".into(),
                None,
            ));
        }
        (Some(_), Some(_)) => {
            return Err(invalid(
                "[image]",
                "image declares both `dockerfile` and `reference`; pick one".into(),
                None,
            ));
        }
        _ => {}
    }
    if cfg.image.dockerfile.is_none() && (!cfg.image.args.is_empty() || cfg.image.context.is_some())
    {
        return Err(invalid(
            "[image]",
            "image `context`/`args` only apply when building from a `dockerfile`".into(),
            None,
        ));
    }

    if !matches!(cfg.workspace.egress, crate::EgressPolicy::Unrestricted) {
        return Err(invalid(
            "egress",
            "restricted workspace egress is not supported yet".into(),
            Some(
                "remove workspace.egress or use mode = \"unrestricted\"; envmux refuses to silently run an unenforced policy"
                    .into(),
            ),
        ));
    }

    if let Some(terminal) = &cfg.workspace.terminal
        && terminal.trim().is_empty()
    {
        return Err(invalid(
            "terminal",
            "workspace.terminal is empty".into(),
            Some(
                "use \"shell\" (default), \"manage\", or a command the image can run — \
                 \"claude\", \"codex\", or any command line"
                    .into(),
            ),
        ));
    }

    if cfg.workspace.dangerously_mount_docker_socket && cfg.workspace.dangerously_enable_dind {
        return Err(invalid(
            "dangerously_mount_docker_socket",
            "the host Docker socket and privileged Docker-in-Docker modes are mutually exclusive"
                .into(),
            Some("enable exactly one dangerous Docker mode".into()),
        ));
    }

    for name in cfg.services.keys() {
        envmux_core::ServiceName::new(name.clone())
            .map_err(|e| invalid(name, e.to_string(), None))?;
    }
    for name in cfg.volumes.named.keys() {
        envmux_core::VolumeName::new(name.clone())
            .map_err(|e| invalid(name, e.to_string(), None))?;
    }
    for (name, task) in &cfg.tasks {
        envmux_core::TaskName::new(name.clone()).map_err(|e| invalid(name, e.to_string(), None))?;
        for dep in &task.after {
            if !cfg.tasks.contains_key(dep) {
                return Err(invalid(
                    dep,
                    format!("task {name:?} depends on unknown task {dep:?}"),
                    None,
                ));
            }
        }
        for svc in &task.requires {
            if !cfg.services.contains_key(svc) {
                return Err(invalid(
                    svc,
                    format!("task {name:?} requires unknown service {svc:?}"),
                    None,
                ));
            }
        }
        if task.long_running && matches!(task.check, Some(Check::Exec { .. }) | None) {
            // Fine: long-running tasks may have no readiness check at all.
        }
        if !task.long_running && matches!(task.restart, crate::RestartPolicy::Always { .. }) {
            return Err(invalid(
                name,
                format!("one-shot task {name:?} cannot use restart policy \"always\""),
                Some("mark it long_running = true or drop the restart policy".into()),
            ));
        }
    }

    // Cycle detection: a cyclic graph is a rejected config.
    let mut graph = DiGraph::<&str, ()>::new();
    let mut nodes = HashMap::new();
    for name in cfg.tasks.keys() {
        nodes.insert(name.as_str(), graph.add_node(name.as_str()));
    }
    for (name, task) in &cfg.tasks {
        for dep in &task.after {
            graph.add_edge(nodes[dep.as_str()], nodes[name.as_str()], ());
        }
    }
    if let Err(cycle) = petgraph::algo::toposort(&graph, None) {
        let member = graph[cycle.node_id()];
        return Err(invalid(
            member,
            format!("task dependency cycle involving {member:?}"),
            None,
        ));
    }

    for (name, port) in &cfg.routes {
        if !is_hostname_label(name) {
            return Err(invalid(
                name,
                format!("route name {name:?} is not a valid hostname label"),
                Some(
                    "route names appear in the routed host, so they must be lowercase \
                     letters, digits, and hyphens; `_` is the delimiter between host \
                     fields and cannot appear inside a name"
                        .into(),
                ),
            ));
        }
        if *port == 0 {
            return Err(invalid(
                name,
                format!("route {name:?} declares port 0"),
                None,
            ));
        }
    }

    if cfg.routing.port == Some(0) {
        return Err(invalid(
            "port",
            "routing.port cannot be 0".into(),
            Some("omit it to let the router pick its default (with fallback)".into()),
        ));
    }

    if let Some(path) = &cfg.editor.path {
        // A host path, so platform rules apply — but a leading slash is also
        // accepted on Windows since the file may be shared across machines.
        if !(std::path::Path::new(path).is_absolute() || path.starts_with('/')) {
            return Err(invalid(
                path,
                format!("editor path {path:?} is not absolute"),
                Some(
                    "point [editor] path at the editor executable itself; a relative \
                     path depends on where envmux happens to be run from"
                        .into(),
                ),
            ));
        }
    }
    if !cfg.editor.default_folder.starts_with('/') {
        return Err(invalid(
            &cfg.editor.default_folder,
            format!(
                "editor default_folder {:?} is not an absolute container path",
                cfg.editor.default_folder
            ),
            Some(
                "container-side folders are absolute and use forward slashes, e.g. \"/work\""
                    .into(),
            ),
        ));
    }
    for (workspace, folder) in &cfg.editor.folders {
        if !folder.starts_with('/') {
            return Err(invalid(
                folder,
                format!(
                    "editor folder for workspace {workspace:?} is not an absolute container path"
                ),
                Some(
                    "container-side folders are absolute and use forward slashes, e.g. \"/work\""
                        .into(),
                ),
            ));
        }
    }

    Ok(())
}

/// Whether a route name can stand as (part of) a hostname label: lowercase
/// alphanumeric and hyphens, no leading/trailing hyphen. Notably no `_`,
/// which is the delimiter between the fields of the routed host.
fn is_hostname_label(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(src: &str) -> Result<(), ConfigError> {
        let cfg: Config = toml::from_str(src).unwrap();
        validate(".envmux.toml", src, &cfg)
    }

    #[test]
    fn the_minimal_v2_file_validates() {
        // The contract of the v2 trim: schema plus an image source is a
        // complete, valid configuration. Everything else has a default.
        let src = "[meta]\nschema = 2\n\n[image]\nreference = \"ghcr.io/acme/dev:2026.08\"\n";
        let cfg: Config = toml::from_str(src).unwrap();
        validate(".envmux.toml", src, &cfg).unwrap();

        let src = "[meta]\nschema = 2\n\n[image]\ndockerfile = \"Dockerfile.envmux\"\n";
        let cfg: Config = toml::from_str(src).unwrap();
        validate(".envmux.toml", src, &cfg).unwrap();
    }

    #[test]
    fn schema_one_and_two_are_accepted_others_name_both() {
        assert!(check("[meta]\nschema = 1\n[image]\nreference='x'\n").is_ok());
        assert!(check("[meta]\nschema = 2\n[image]\nreference='x'\n").is_ok());
        let err = check("[meta]\nschema = 3\n[image]\nreference='x'\n").unwrap_err();
        let rendered = format!("{err:?}");
        assert!(
            rendered.contains("unsupported schema version 3"),
            "{rendered}"
        );
        assert!(rendered.contains("schema = 1 or schema = 2"), "{rendered}");
    }

    #[test]
    fn route_names_must_be_hostname_labels() {
        assert!(check("[image]\nreference='x'\n[routes]\nweb-2 = 8080\n").is_ok());
        // `_` is the host-field delimiter; a name containing it would split
        // the host into the wrong fields.
        assert!(check("[image]\nreference='x'\n[routes]\nmy_app = 8080\n").is_err());
        assert!(check("[image]\nreference='x'\n[routes]\n\"Editor\" = 3000\n").is_err());
        assert!(check("[image]\nreference='x'\n[routes]\n\"-web\" = 8080\n").is_err());
        assert!(check("[image]\nreference='x'\n[routes]\nweb = 0\n").is_err());
    }

    #[test]
    fn routing_port_zero_is_rejected() {
        assert!(check("[image]\nreference='x'\n[routing]\nport = 8443\n").is_ok());
        assert!(check("[image]\nreference='x'\n[routing]\nport = 0\n").is_err());
    }

    #[test]
    fn image_exclusivity() {
        assert!(check("[image]\nreference='x'\n").is_ok());
        assert!(check("[image]\ndockerfile='Dockerfile'\n").is_ok());
        let err = check("[image]\nreference='x'\ndockerfile='D'\n").unwrap_err();
        assert!(err.to_string().contains("pick one"), "{err}");
        assert!(check("[meta]\n[image]\n").is_err());
    }

    #[test]
    fn build_only_fields_require_a_dockerfile() {
        // `context`/`args` are meaningless when pulling, and silently ignoring
        // them would hide a mistaken config.
        let err = check("[image]\nreference='x'\ncontext='.'\n").unwrap_err();
        assert!(err.to_string().contains("only apply"), "{err}");
        let err = check("[image]\nreference='x'\n[image.args]\nA='1'\n").unwrap_err();
        assert!(err.to_string().contains("only apply"), "{err}");
    }

    #[test]
    fn task_cycles_rejected() {
        let err = check(
            r#"
            [image]
            reference = "x"
            [tasks.a]
            command = "true"
            after = ["b"]
            [tasks.b]
            command = "true"
            after = ["a"]
            "#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("cycle"), "{err}");
    }

    #[test]
    fn unknown_deps_rejected() {
        assert!(
            check("[image]\nreference='x'\n[tasks.a]\ncommand='true'\nafter=['nope']\n").is_err()
        );
        assert!(
            check("[image]\nreference='x'\n[tasks.a]\ncommand='true'\nrequires=['nodb']\n")
                .is_err()
        );
    }

    #[test]
    fn valid_graph_accepted() {
        assert!(
            check(
                r#"
            [image]
            reference = "x"
            [services.db]
            kind = "postgres"
            [tasks.migrate]
            command = "migrate"
            requires = ["db"]
            [tasks.seed]
            command = "seed"
            after = ["migrate"]
            "#,
            )
            .is_ok()
        );
    }

    #[test]
    fn one_shot_always_restart_rejected() {
        assert!(
            check(
                r#"
            [image]
            reference = "x"
            [tasks.a]
            command = "true"
            restart = { policy = "always" }
            "#,
            )
            .is_err()
        );
    }

    #[test]
    fn editor_paths_and_folders_must_be_absolute() {
        // Fine: absolute path (either spelling), absolute folders.
        assert!(check("[image]\nreference='x'\n[editor]\npath='/usr/local/bin/code'\n").is_ok());
        assert!(
            check("[image]\nreference='x'\n[editor]\ndefault_folder='/srv'\n[editor.folders]\nws='/work/api'\n")
                .is_ok()
        );

        // A relative editor path depends on the cwd; rejected with help.
        let err = check("[image]\nreference='x'\n[editor]\npath='code'\n").unwrap_err();
        assert!(err.to_string().contains("not absolute"), "{err}");

        // Container-side folders must be absolute POSIX paths.
        let err = check("[image]\nreference='x'\n[editor]\ndefault_folder='work'\n").unwrap_err();
        assert!(err.to_string().contains("default_folder"), "{err}");
        let err = check("[image]\nreference='x'\n[editor.folders]\notter='work'\n").unwrap_err();
        assert!(err.to_string().contains("otter"), "{err}");
    }

    #[test]
    fn restricted_egress_fails_closed() {
        let src = r#"
            [image]
            reference = "example.invalid/image"
            [workspace.egress]
            mode = "allowlist"
            hosts = ["example.com"]
        "#;
        let err = check(src).unwrap_err();
        assert!(err.to_string().contains("restricted workspace egress"));
    }

    #[test]
    fn dangerous_docker_modes_are_mutually_exclusive() {
        let src = r#"
            [image]
            reference = "example.invalid/image"
            [workspace]
            dangerously_mount_docker_socket = true
            dangerously_enable_dind = true
        "#;
        let err = check(src).unwrap_err();
        assert!(err.to_string().contains("mutually exclusive"));
    }
}
