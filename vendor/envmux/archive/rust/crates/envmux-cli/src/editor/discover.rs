//! Finding a VS Code-family editor to launch.
//!
//! Order: the config's `[editor] path`, then `$VSCODE_BIN`, then the PATH
//! names (`code`, `code-insiders`, `codium`, `cursor`, `windsurf` — stable
//! deliberately before insiders), then the platform's well-known install
//! locations. The result is cached for the process lifetime: discovery walks
//! the filesystem, and nothing it looks at changes underneath one process.
//!
//! The core is pure and takes its environment — PATH entries, env vars, an
//! existence probe — as inputs, so the tests are tables rather than fixtures.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::EditorError;

/// A found editor, plus any caveat worth telling the user about.
#[derive(Debug, Clone)]
pub struct Discovered {
    pub path: PathBuf,
    /// Codium may lack the Dev Containers extension; flatpak VS Code cannot
    /// reach the host docker socket. Neither blocks the launch — VS Code owns
    /// the attach — but both are worth a sentence.
    pub hint: Option<String>,
}

/// Everything discovery consults, injected so tests can fabricate a machine.
pub struct DiscoveryInputs<'a> {
    /// `[editor] path` from the resolved config. Explicit configuration is
    /// authoritative: when set and missing, discovery fails rather than
    /// quietly launching a different editor.
    pub config_path: Option<PathBuf>,
    /// `$VSCODE_BIN`. Also explicit, also authoritative.
    pub vscode_bin: Option<PathBuf>,
    /// The entries of PATH, already split.
    pub path_dirs: Vec<PathBuf>,
    /// Executable-name extensions to try per PATH entry (Windows: `.cmd`,
    /// `.exe`, `.bat`; elsewhere empty, meaning the bare name).
    pub extensions: Vec<String>,
    /// Platform well-known install locations, in preference order.
    pub well_knowns: Vec<PathBuf>,
    /// Whether a candidate exists (and, where the platform can say, is a
    /// file). The seam that makes the rest of this module a pure function.
    pub exists: &'a dyn Fn(&Path) -> bool,
}

/// The editor names probed on PATH, stable before insiders.
const PATH_NAMES: &[&str] = &["code", "code-insiders", "codium", "cursor", "windsurf"];

/// Discover with the real environment, caching for the process lifetime.
pub fn discover(config_path: Option<&Path>) -> Result<Discovered, EditorError> {
    static CACHE: OnceLock<Result<Discovered, Vec<String>>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let exists = |p: &Path| p.is_file();
            let inputs = DiscoveryInputs {
                config_path: config_path.map(Path::to_path_buf),
                vscode_bin: std::env::var_os("VSCODE_BIN").map(PathBuf::from),
                path_dirs: std::env::var_os("PATH")
                    .map(|p| std::env::split_paths(&p).collect())
                    .unwrap_or_default(),
                extensions: platform_extensions(),
                well_knowns: platform_well_knowns(),
                exists: &exists,
            };
            discover_with(&inputs).map_err(|e| match e {
                EditorError::EditorNotFound { tried } => tried,
                // discover_with only fails with EditorNotFound.
                other => vec![other.to_string()],
            })
        })
        .clone()
        .map_err(|tried| EditorError::EditorNotFound { tried })
}

/// The pure core: walk the order, return the first hit.
pub fn discover_with(inputs: &DiscoveryInputs<'_>) -> Result<Discovered, EditorError> {
    let mut tried = Vec::new();

    // 1. Explicit config. Set-but-missing is an error, not a fallthrough:
    //    someone who named an editor does not want a different one.
    if let Some(path) = &inputs.config_path {
        if (inputs.exists)(path) {
            return Ok(found(path.clone()));
        }
        return Err(EditorError::EditorNotFound {
            tried: vec![format!(
                "{} ([editor] path — set but not found)",
                path.display()
            )],
        });
    }

    // 2. $VSCODE_BIN, equally explicit, equally authoritative.
    if let Some(path) = &inputs.vscode_bin {
        if (inputs.exists)(path) {
            return Ok(found(path.clone()));
        }
        return Err(EditorError::EditorNotFound {
            tried: vec![format!(
                "{} ($VSCODE_BIN — set but not found)",
                path.display()
            )],
        });
    }

    // 3. PATH, by name then by directory — so `code` anywhere on PATH beats
    //    `code-insiders` everywhere.
    for name in PATH_NAMES {
        for dir in &inputs.path_dirs {
            for candidate in candidates(dir, name, &inputs.extensions) {
                if (inputs.exists)(&candidate) {
                    return Ok(found(candidate));
                }
            }
        }
        tried.push(format!("{name} (on PATH)"));
    }

    // 4. Platform well-knowns.
    for candidate in &inputs.well_knowns {
        if (inputs.exists)(candidate) {
            return Ok(found(candidate.clone()));
        }
        tried.push(candidate.display().to_string());
    }

    Err(EditorError::EditorNotFound { tried })
}

/// The file names a PATH entry may spell an editor as.
fn candidates(dir: &Path, name: &str, extensions: &[String]) -> Vec<PathBuf> {
    if extensions.is_empty() {
        return vec![dir.join(name)];
    }
    extensions
        .iter()
        .map(|ext| dir.join(format!("{name}{ext}")))
        .collect()
}

fn found(path: PathBuf) -> Discovered {
    let hint = hint_for(&path);
    Discovered { path, hint }
}

/// The caveats worth attaching to a particular install.
fn hint_for(path: &Path) -> Option<String> {
    let text = path.to_string_lossy().to_lowercase();
    if text.contains("flatpak") {
        return Some(
            "this is a flatpak VS Code, which usually cannot reach the host docker \
             socket — the attach may fail inside its sandbox"
                .to_owned(),
        );
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if stem.starts_with("codium") {
        return Some(
            "VSCodium's marketplace may not carry the Dev Containers extension the \
             attach depends on"
                .to_owned(),
        );
    }
    None
}

/// Executable extensions per platform: Windows editors ship `code.cmd`.
fn platform_extensions() -> Vec<String> {
    if cfg!(windows) {
        vec![".cmd".to_owned(), ".exe".to_owned(), ".bat".to_owned()]
    } else {
        Vec::new()
    }
}

/// Where installers put editors when PATH does not say.
fn platform_well_knowns() -> Vec<PathBuf> {
    let mut list = Vec::new();
    if cfg!(target_os = "macos") {
        let apps = ["/Applications".to_owned()]
            .into_iter()
            .chain(dirs::home_dir().map(|h| h.join("Applications").display().to_string()));
        for base in apps {
            for bundle in [
                "Visual Studio Code.app",
                "Visual Studio Code - Insiders.app",
            ] {
                list.push(PathBuf::from(format!(
                    "{base}/{bundle}/Contents/Resources/app/bin/code"
                )));
            }
        }
    } else if cfg!(windows) {
        for base in [
            std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Programs")),
            std::env::var_os("ProgramFiles").map(PathBuf::from),
        ]
        .into_iter()
        .flatten()
        {
            list.push(base.join(r"Microsoft VS Code\bin\code.cmd"));
        }
    } else {
        list.push(PathBuf::from("/usr/share/code/bin/code"));
        list.push(PathBuf::from("/snap/bin/code"));
        list.push(PathBuf::from(
            "/var/lib/flatpak/exports/bin/com.visualstudio.code",
        ));
        if let Some(home) = dirs::home_dir() {
            list.push(home.join(".local/share/flatpak/exports/bin/com.visualstudio.code"));
        }
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fabricated machine: these files exist, nothing else does.
    fn machine<'a>(files: &'a [&'a str]) -> impl Fn(&Path) -> bool + 'a {
        move |p: &Path| files.iter().any(|f| Path::new(f) == p)
    }

    fn inputs<'a>(
        config: Option<&str>,
        vscode_bin: Option<&str>,
        path_dirs: &[&str],
        exists: &'a dyn Fn(&Path) -> bool,
    ) -> DiscoveryInputs<'a> {
        DiscoveryInputs {
            config_path: config.map(PathBuf::from),
            vscode_bin: vscode_bin.map(PathBuf::from),
            path_dirs: path_dirs.iter().map(PathBuf::from).collect(),
            extensions: Vec::new(),
            well_knowns: vec![PathBuf::from("/usr/share/code/bin/code")],
            exists,
        }
    }

    #[test]
    fn the_order_is_config_env_path_then_well_knowns() {
        // Everything is present; config wins.
        let exists = machine(&[
            "/opt/mine/editor",
            "/opt/env/editor",
            "/bin/code",
            "/usr/share/code/bin/code",
        ]);
        let all = inputs(
            Some("/opt/mine/editor"),
            Some("/opt/env/editor"),
            &["/bin"],
            &exists,
        );
        assert_eq!(
            discover_with(&all).unwrap().path,
            PathBuf::from("/opt/mine/editor")
        );

        // No config: the env var wins.
        let env = inputs(None, Some("/opt/env/editor"), &["/bin"], &exists);
        assert_eq!(
            discover_with(&env).unwrap().path,
            PathBuf::from("/opt/env/editor")
        );

        // Neither: PATH.
        let path = inputs(None, None, &["/bin"], &exists);
        assert_eq!(
            discover_with(&path).unwrap().path,
            PathBuf::from("/bin/code")
        );

        // Empty PATH: the well-knowns.
        let wk = inputs(None, None, &[], &exists);
        assert_eq!(
            discover_with(&wk).unwrap().path,
            PathBuf::from("/usr/share/code/bin/code")
        );
    }

    #[test]
    fn stable_beats_insiders_across_the_whole_path() {
        // code-insiders sits in an earlier PATH entry than code; stable still
        // wins because the search is name-major.
        let exists = machine(&["/early/code-insiders", "/late/code"]);
        let inputs = inputs(None, None, &["/early", "/late"], &exists);
        assert_eq!(
            discover_with(&inputs).unwrap().path,
            PathBuf::from("/late/code")
        );
    }

    #[test]
    fn an_explicitly_configured_editor_that_is_missing_is_an_error() {
        // Not a fallthrough: launching a different editor than the one that
        // was named would be a silent surprise.
        let exists = machine(&["/bin/code"]);
        let cfg = inputs(Some("/opt/gone"), None, &["/bin"], &exists);
        let Err(EditorError::EditorNotFound { tried }) = discover_with(&cfg) else {
            panic!("a missing configured editor should not fall through");
        };
        assert!(tried[0].contains("/opt/gone") && tried[0].contains("[editor] path"));

        // Same contract for $VSCODE_BIN.
        let env = inputs(None, Some("/opt/gone"), &["/bin"], &exists);
        let Err(EditorError::EditorNotFound { tried }) = discover_with(&env) else {
            panic!("a missing $VSCODE_BIN should not fall through");
        };
        assert!(tried[0].contains("$VSCODE_BIN"));
    }

    #[test]
    fn nothing_found_lists_everything_tried() {
        let exists = machine(&[]);
        let inputs = inputs(None, None, &["/bin"], &exists);
        let Err(EditorError::EditorNotFound { tried }) = discover_with(&inputs) else {
            panic!("an empty machine should find nothing");
        };
        // All five PATH names, plus the well-known.
        assert_eq!(tried.len(), PATH_NAMES.len() + 1);
        assert!(tried.iter().any(|t| t.contains("windsurf")));
    }

    #[test]
    fn windows_extensions_probe_cmd_first() {
        let exists = machine(&[r"C:\bin\code.cmd"]);
        let inputs = DiscoveryInputs {
            config_path: None,
            vscode_bin: None,
            path_dirs: vec![PathBuf::from(r"C:\bin")],
            extensions: vec![".cmd".to_owned(), ".exe".to_owned()],
            well_knowns: Vec::new(),
            exists: &exists,
        };
        assert_eq!(
            discover_with(&inputs).unwrap().path,
            PathBuf::from(r"C:\bin\code.cmd")
        );
    }

    #[test]
    fn codium_and_flatpak_come_with_a_warning_attached() {
        let exists = machine(&["/bin/codium"]);
        let codium = inputs(None, None, &["/bin"], &exists);
        let hint = discover_with(&codium).unwrap().hint.expect("a codium hint");
        assert!(hint.contains("Dev Containers"), "{hint}");

        let flatpak = "/var/lib/flatpak/exports/bin/com.visualstudio.code";
        let files = [flatpak];
        let exists = machine(&files);
        let mut sandboxed = inputs(None, None, &[], &exists);
        sandboxed.well_knowns = vec![PathBuf::from(flatpak)];
        let hint = discover_with(&sandboxed)
            .unwrap()
            .hint
            .expect("a flatpak hint");
        assert!(hint.contains("docker socket"), "{hint}");
    }
}
