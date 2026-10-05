//! Open a workspace in local VS Code, attached into its container.
//!
//! The mechanism is VS Code's own: launched with an `attached-container`
//! folder URI, it installs its server into the container over `docker exec`
//! and opens the folder inside — envmux only builds the URI, checks the
//! preconditions, and hands off. The Dev Containers extension does the rest,
//! and VS Code prompts to install it itself when it is missing.
//!
//! Split by trust boundary: `uri` is pure and exhaustively tested because the
//! URI format is undocumented; `discover` finds an editor with an injectable
//! environment; `launch` owns the spawn semantics (no shell, ever — the URI
//! travels as a single argv element).

pub mod discover;
pub mod launch;
pub mod uri;

use thiserror::Error;

use envmux_docker::DockerHandle;

/// Every way an open can fail, each naming its next action. None of these is
/// "the attach failed" — that happens later, in VS Code's window.
#[derive(Debug, Error)]
pub enum EditorError {
    #[error("no workspace to open — create one first (`envmux create`, or /new in a session)")]
    NoContainerSelected,
    #[error(
        "{name} is {state}, not running — wait for provisioning to finish, or check `envmux ls`"
    )]
    ContainerNotRunning { name: String, state: String },
    #[error("{name} is not a Linux container — VS Code can only attach into Linux containers")]
    UnsupportedContainerOs { name: String },
    #[error("container name {0:?} is not a valid Docker name — refusing to build a URI from it")]
    InvalidContainerName(String),
    #[error(
        "no editor found (tried: {tried:?}). Install VS Code, or point [editor] path at one \
         in .envmux.local.toml"
    )]
    EditorNotFound { tried: Vec<String> },
    #[error("inspecting the workspace container: {0}")]
    Inspect(String),
    #[error("launching the editor: {0}")]
    Spawn(std::io::Error),
}

/// What the caller knows; everything else is inspected or discovered.
pub struct OpenSpec<'a> {
    pub namespace: &'a str,
    pub workspace: &'a str,
    /// The resolved `[editor]` section (or its defaults when no config
    /// resolves — the folder chain degrades gracefully).
    pub editor: &'a envmux_config::Editor,
    /// The resolved config's `workspace.workdir` — where envmux cloned the
    /// repository, which beats anything the image declares.
    pub configured_workdir: Option<&'a str>,
}

/// A successful hand-off.
pub struct Opened {
    /// The editor that was launched.
    pub editor: std::path::PathBuf,
    /// A caveat from discovery worth relaying (Codium, flatpak).
    pub hint: Option<String>,
    /// Handle for the late warning should the editor exit non-zero.
    pub launched: launch::Launched,
}

/// Check the preconditions, build the URI, launch. Non-blocking: a returned
/// `Opened` means the editor process started, nothing more.
pub async fn open(spec: OpenSpec<'_>) -> Result<Opened, EditorError> {
    let container = format!("envmux-{}-ws-{}", spec.namespace, spec.workspace);
    // P5 before anything touches Docker or a shell-adjacent interpreter.
    let container = uri::normalize_container_name(&container)?;

    // P2/P3 by inspection, which also yields the image's WorkingDir for the
    // folder chain.
    let docker = DockerHandle::connect().map_err(|e| EditorError::Inspect(e.to_string()))?;
    let inspect = docker.inspect_container(&container).await.map_err(|e| {
        if e.is_not_found() {
            EditorError::ContainerNotRunning {
                name: container.clone(),
                state: "gone".to_owned(),
            }
        } else {
            EditorError::Inspect(format!("{e} (is Docker running?)"))
        }
    })?;

    let state = inspect.state.as_ref();
    if !state.and_then(|s| s.running).unwrap_or(false) {
        return Err(EditorError::ContainerNotRunning {
            state: state
                .and_then(|s| s.status)
                .map_or_else(|| "unknown".to_owned(), |s| s.to_string()),
            name: container,
        });
    }
    if inspect
        .platform
        .as_deref()
        .is_some_and(|os| os.eq_ignore_ascii_case("windows"))
    {
        return Err(EditorError::UnsupportedContainerOs { name: container });
    }

    let image_workdir = inspect
        .config
        .as_ref()
        .and_then(|c| c.working_dir.clone())
        .filter(|w| w.starts_with('/'));
    let folder = resolve_folder(
        spec.editor,
        spec.workspace,
        spec.configured_workdir,
        image_workdir.as_deref(),
    );

    let discovered = discover::discover(spec.editor.path.as_deref().map(std::path::Path::new))?;
    let uri = uri::folder_uri(&container, &folder)?;
    let plan = launch::LaunchPlan {
        editor: discovered.path.clone(),
        uri,
        new_window: spec.editor.window == envmux_config::EditorWindow::New,
        // Presence propagated, value never logged.
        docker_host: std::env::var("DOCKER_HOST").ok(),
    };
    let launched = launch::launch(&plan)?;
    Ok(Opened {
        editor: discovered.path,
        hint: discovered.hint,
        launched,
    })
}

/// The folder to open, most specific first: the per-workspace override, the
/// config's workdir (where envmux cloned the repository — it beats any image
/// `WORKDIR`), the image's own absolute `WorkingDir`, the configured default,
/// and finally `/`.
fn resolve_folder(
    editor: &envmux_config::Editor,
    workspace: &str,
    configured_workdir: Option<&str>,
    image_workdir: Option<&str>,
) -> String {
    if let Some(folder) = editor.folders.get(workspace) {
        return folder.clone();
    }
    if let Some(workdir) = configured_workdir.filter(|w| w.starts_with('/')) {
        return workdir.to_owned();
    }
    if let Some(workdir) = image_workdir.filter(|w| w.starts_with('/')) {
        return workdir.to_owned();
    }
    if editor.default_folder.starts_with('/') {
        return editor.default_folder.clone();
    }
    "/".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor_with(folders: &[(&str, &str)], default_folder: &str) -> envmux_config::Editor {
        envmux_config::Editor {
            path: None,
            window: envmux_config::EditorWindow::Reuse,
            default_folder: default_folder.to_owned(),
            folders: folders
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        }
    }

    #[test]
    fn the_folder_chain_is_override_workdir_image_default_root() {
        let editor = editor_with(&[("otter", "/work/api")], "/fallback");

        // (1) The per-workspace override beats everything.
        assert_eq!(
            resolve_folder(&editor, "otter", Some("/work"), Some("/img")),
            "/work/api"
        );
        // (2) The config workdir is where envmux cloned the repo — it beats
        // the image's WORKDIR.
        assert_eq!(
            resolve_folder(&editor, "stoat", Some("/work"), Some("/img")),
            "/work"
        );
        // (3) The image WorkingDir, only when absolute.
        assert_eq!(resolve_folder(&editor, "stoat", None, Some("/img")), "/img");
        assert_eq!(
            resolve_folder(&editor, "stoat", None, Some("relative")),
            "/fallback"
        );
        // (4) The configured default, then root.
        assert_eq!(resolve_folder(&editor, "stoat", None, None), "/fallback");
        let bare = editor_with(&[], "relative-junk");
        assert_eq!(resolve_folder(&bare, "stoat", None, None), "/");
    }
}
