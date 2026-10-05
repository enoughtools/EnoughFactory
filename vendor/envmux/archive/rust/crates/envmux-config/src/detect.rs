//! What a repository looks like from the outside, so onboarding can offer a
//! sensible default instead of an empty form.
//!
//! Everything here reads a fixed set of well-known files and nothing else. No
//! recursive source grep, no heuristics that fire on one project in ten: a
//! suggestion that is wrong half the time is worse than no suggestion, because
//! the reader has to check it either way and now they also have to un-pick it.
//!
//! Detection is **deterministic** — the same tree always produces the same
//! answer, in the same order — because the onboarding screen shows the exact
//! file it is about to write, and a preview that shuffles between runs is a
//! preview nobody can review.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// A stack the repository appears to be built on.
///
/// Ordered most-specific-first where it matters: a Next.js repo is also a
/// Node repo, and the preset worth offering is the specific one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stack {
    Next,
    Vite,
    Node,
    Rust,
    Python,
    Go,
    Dotnet,
}

impl Stack {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Next => "next.js",
            Self::Vite => "vite",
            Self::Node => "node",
            Self::Rust => "rust",
            Self::Python => "python",
            Self::Go => "go",
            Self::Dotnet => ".net",
        }
    }
}

/// Which Node package manager the repository committed to, by lockfile.
///
/// The lockfile is the answer rather than a `packageManager` field because the
/// lockfile is what actually decides whether `npm ci` works.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

impl PackageManager {
    /// The reproducible-install command — the one that respects the lockfile.
    #[must_use]
    pub fn install(self) -> &'static str {
        match self {
            Self::Npm => "npm ci",
            Self::Pnpm => "pnpm install --frozen-lockfile",
            Self::Yarn => "yarn install --immutable",
            Self::Bun => "bun install --frozen-lockfile",
        }
    }

    /// How this manager spells "run the script called `name`".
    #[must_use]
    pub fn run(self, name: &str) -> String {
        match self {
            Self::Npm => format!("npm run {name}"),
            Self::Pnpm => format!("pnpm {name}"),
            Self::Yarn => format!("yarn {name}"),
            Self::Bun => format!("bun run {name}"),
        }
    }

    /// The cache directory worth keeping in a named volume.
    #[must_use]
    pub fn cache(self) -> (&'static str, &'static str) {
        match self {
            Self::Npm => ("npm", "/home/user/.npm"),
            Self::Pnpm => ("pnpm-store", "/home/user/.local/share/pnpm/store"),
            Self::Yarn => ("yarn", "/home/user/.yarn/berry/cache"),
            Self::Bun => ("bun", "/home/user/.bun/install/cache"),
        }
    }

    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
            Self::Yarn => "yarn",
            Self::Bun => "bun",
        }
    }
}

/// A port the repository looks like it serves on, and where that was read
/// from.
///
/// The source travels with the number because onboarding shows it. "8080" is
/// a guess someone has to verify from memory; "8080 — from Dockerfile EXPOSE"
/// is a guess they can confirm by looking at one line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortHint {
    /// Suggested route name: lowercase letters, digits and hyphens, because
    /// it becomes a hostname label.
    pub name: String,
    pub port: u16,
    /// Human-readable provenance, e.g. `package.json scripts.dev`.
    pub source: String,
}

/// Everything detection could establish about a repository.
#[derive(Debug, Clone, Default)]
pub struct Detected {
    /// Ranked most specific first; empty when nothing was recognised.
    pub stacks: Vec<Stack>,
    /// Deduplicated by port number, best-evidence source kept, ordered by
    /// the priority of the source that found them.
    pub ports: Vec<PortHint>,
    /// A Dockerfile in the root, if there is one — the image question
    /// answers itself when the repository already builds one.
    pub dockerfile: Option<String>,
    pub package_manager: Option<PackageManager>,
    /// Script names present in `package.json`, for picking a dev command.
    pub scripts: BTreeMap<String, String>,
    /// Which well-known marker files are in the root.
    ///
    /// Presets need more than "this is Python": whether to write `uv sync`,
    /// `poetry install` or `pip install -r requirements.txt` is decided by
    /// which lockfile is actually committed, and guessing wrong writes a task
    /// that exits non-zero and fails the first workspace.
    pub markers: BTreeSet<String>,
}

/// Marker files worth remembering, checked in the root only.
const MARKERS: &[&str] = &[
    "uv.lock",
    "poetry.lock",
    "Pipfile.lock",
    "requirements.txt",
    "pyproject.toml",
    "manage.py",
    "Cargo.lock",
    "go.sum",
    "Makefile",
    "justfile",
];

impl Detected {
    /// The stack a preset should be chosen for, if any.
    #[must_use]
    pub fn primary(&self) -> Option<Stack> {
        self.stacks.first().copied()
    }

    /// Whether a well-known marker file is present in the root.
    #[must_use]
    pub fn has(&self, marker: &str) -> bool {
        self.markers.contains(marker)
    }
}

/// Scan `root` — shallow, and only files whose meaning is unambiguous.
#[must_use]
pub fn detect(root: &Path) -> Detected {
    let mut found = Detected::default();
    let package = read(root, "package.json")
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());

    detect_stacks(root, package.as_ref(), &mut found);
    found.package_manager = detect_package_manager(root);
    if let Some(scripts) = package
        .as_ref()
        .and_then(|p| p.get("scripts"))
        .and_then(serde_json::Value::as_object)
    {
        for (name, value) in scripts {
            if let Some(command) = value.as_str() {
                found.scripts.insert(name.clone(), command.to_owned());
            }
        }
    }

    for candidate in ["Dockerfile", "Dockerfile.envmux", "Dockerfile.dev"] {
        if root.join(candidate).is_file() {
            found.dockerfile = Some(candidate.to_owned());
            break;
        }
    }

    for marker in MARKERS {
        if root.join(marker).is_file() {
            found.markers.insert((*marker).to_owned());
        }
    }

    found.ports = detect_ports(root, package.as_ref(), &found);
    found
}

fn read(root: &Path, name: &str) -> Option<String> {
    // Bounded on purpose: a "package.json" that is a gigabyte is not one, and
    // onboarding must not stall on a pathological tree.
    const MAX: u64 = 512 * 1024;
    let path = root.join(name);
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX => std::fs::read_to_string(&path).ok(),
        _ => None,
    }
}

fn detect_stacks(root: &Path, package: Option<&serde_json::Value>, found: &mut Detected) {
    if let Some(package) = package {
        // Node frameworks are read from the dependency lists rather than from
        // config filenames: `vite.config.ts` can be absent from a Vite app and
        // present in a repo that only uses Vite for its docs.
        let has = |name: &str| {
            ["dependencies", "devDependencies"]
                .iter()
                .filter_map(|section| package.get(*section))
                .filter_map(serde_json::Value::as_object)
                .any(|deps| deps.contains_key(name))
        };
        if has("next") {
            found.stacks.push(Stack::Next);
        } else if has("vite") || has("@sveltejs/kit") || has("astro") {
            found.stacks.push(Stack::Vite);
        }
        found.stacks.push(Stack::Node);
    }
    if root.join("Cargo.toml").is_file() {
        found.stacks.push(Stack::Rust);
    }
    if root.join("pyproject.toml").is_file()
        || root.join("requirements.txt").is_file()
        || root.join("manage.py").is_file()
    {
        found.stacks.push(Stack::Python);
    }
    if root.join("go.mod").is_file() {
        found.stacks.push(Stack::Go);
    }
    if has_dotnet_project(root) {
        found.stacks.push(Stack::Dotnet);
    }
}

/// .NET projects live in `src/Thing/Thing.csproj` at least as often as in the
/// root, so this looks one level down — and no further, because a deep walk
/// on a big tree is a stall the user cannot see the reason for.
fn has_dotnet_project(root: &Path) -> bool {
    fn is_project(path: &Path) -> bool {
        matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("csproj" | "fsproj" | "sln")
        )
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    let mut children = Vec::new();
    for entry in entries.flatten().take(500) {
        let path = entry.path();
        if is_project(&path) {
            return true;
        }
        if path.is_dir() {
            children.push(path);
        }
    }
    children.sort();
    children.iter().take(60).any(|dir| {
        std::fs::read_dir(dir).is_ok_and(|entries| {
            entries
                .flatten()
                .take(200)
                .any(|entry| is_project(&entry.path()))
        })
    })
}

fn detect_package_manager(root: &Path) -> Option<PackageManager> {
    // Checked in a fixed order so a repo carrying two lockfiles (which happens,
    // and is a mistake) always resolves the same way rather than by whichever
    // the filesystem listed first.
    for (lockfile, manager) in [
        ("pnpm-lock.yaml", PackageManager::Pnpm),
        ("bun.lockb", PackageManager::Bun),
        ("bun.lock", PackageManager::Bun),
        ("yarn.lock", PackageManager::Yarn),
        ("package-lock.json", PackageManager::Npm),
    ] {
        if root.join(lockfile).is_file() {
            return Some(manager);
        }
    }
    // A package.json with no lockfile is still a Node project; it just cannot
    // have a reproducible install.
    root.join("package.json")
        .is_file()
        .then_some(PackageManager::Npm)
}

// ---------------------------------------------------------------------------
// Ports

/// Find the ports this repository looks like it serves on.
///
/// Sources are consulted in descending order of how much they *mean*: a
/// committed compose file or an `EXPOSE` line is a statement, a script flag is
/// close to one, and a framework's default port is only an educated guess.
/// The first source to claim a port number wins, so the strongest available
/// evidence is what gets shown.
fn detect_ports(
    root: &Path,
    package: Option<&serde_json::Value>,
    found: &Detected,
) -> Vec<PortHint> {
    let mut hints: Vec<PortHint> = Vec::new();
    let push = |name: &str, port: u16, source: String, hints: &mut Vec<PortHint>| {
        // Ports below 1024 are almost always a container-side convention
        // (`EXPOSE 80`) rather than something a dev server binds, and the
        // router maps a name to a port rather than to a privileged one.
        if port < 1024 || hints.iter().any(|h| h.port == port) {
            return;
        }
        let name = unique_name(name, hints);
        hints.push(PortHint { name, port, source });
    };

    for file in [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yml",
        "docker-compose.yaml",
    ] {
        if let Some(text) = read(root, file) {
            for (service, port) in compose_ports(&text) {
                push(&service, port, format!("{file} · {service}"), &mut hints);
            }
        }
    }

    if let Some(text) = read(root, "Dockerfile") {
        for port in dockerfile_exposes(&text) {
            push("web", port, "Dockerfile · EXPOSE".to_owned(), &mut hints);
        }
    }

    if let Some(scripts) = package
        .and_then(|p| p.get("scripts"))
        .and_then(serde_json::Value::as_object)
    {
        // Fixed order rather than the map's: `dev` is the script a workspace
        // is for, and it should name the `web` route when several match.
        for name in ["dev", "start", "serve", "preview"] {
            if let Some(command) = scripts.get(name).and_then(serde_json::Value::as_str)
                && let Some(port) = port_in_command(command)
            {
                push(
                    "web",
                    port,
                    format!("package.json · scripts.{name}"),
                    &mut hints,
                );
            }
        }
    }

    if let Some(text) = read(root, "Properties/launchSettings.json")
        .or_else(|| read(root, "src/Properties/launchSettings.json"))
    {
        for port in launch_settings_ports(&text) {
            push("web", port, "launchSettings.json".to_owned(), &mut hints);
        }
    }

    for file in [".env", ".env.example", ".env.local", ".env.development"] {
        if let Some(text) = read(root, file) {
            for (key, port) in env_ports(&text) {
                push("web", port, format!("{file} · {key}"), &mut hints);
            }
        }
    }

    // Only when nothing more definite turned up: a framework default is the
    // weakest evidence there is, and repeating it over a real answer would be
    // actively misleading.
    if hints.is_empty()
        && let Some(stack) = found.primary()
        && let Some(port) = framework_default(stack, root)
    {
        push(
            "web",
            port,
            format!("{} default", stack.label()),
            &mut hints,
        );
    }

    hints
}

/// Keep route names unique — they become hostname labels, and two `web`s
/// would collide into one route.
fn unique_name(base: &str, hints: &[PortHint]) -> String {
    let base = sanitise_route_name(base);
    if !hints.iter().any(|h| h.name == base) {
        return base;
    }
    // Bounded rather than open-ended: the suffix only has to outrun the number
    // of routes a repository could plausibly declare, and an unbounded search
    // here would be a hang with no visible cause.
    (2..=99)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !hints.iter().any(|h| &h.name == candidate))
        .unwrap_or(base)
}

/// Route names are a single hostname label: lowercase letters, digits and
/// hyphens, never leading or trailing.
fn sanitise_route_name(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_owned();
    if trimmed.is_empty() {
        "web".to_owned()
    } else {
        trimmed
    }
}

/// Host ports out of a compose file's `ports:` lists, with the service that
/// declared them.
///
/// Line-oriented rather than a YAML parse, and deliberately so: this is a
/// hint the user confirms on screen against a preview of the file it will
/// write, not configuration being consumed. The cost of a missed port is a
/// route someone adds by hand; the cost of a YAML dependency is permanent.
fn compose_ports(text: &str) -> Vec<(String, u16)> {
    let mut out = Vec::new();
    let mut in_services = false;
    let mut service: Option<String> = None;
    let mut service_indent = 0;
    let mut in_ports = false;

    for raw in text.lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();

        if indent == 0 {
            in_services = trimmed.starts_with("services:");
            service = None;
            in_ports = false;
            continue;
        }
        if !in_services {
            continue;
        }
        // A new key at or above the service's own indentation ends both the
        // ports list and — when it is a sibling — the service itself.
        if let Some(name) = trimmed.strip_suffix(':')
            && !trimmed.starts_with('-')
            && (service.is_none() || indent <= service_indent)
        {
            service = Some(name.trim().to_owned());
            service_indent = indent;
            in_ports = false;
            continue;
        }
        if trimmed.starts_with("ports:") {
            in_ports = true;
            continue;
        }
        if in_ports && trimmed.starts_with('-') {
            let value = trimmed
                .trim_start_matches('-')
                .trim()
                .trim_matches(['"', '\'']);
            if let Some(port) = compose_host_port(value) {
                out.push((service.clone().unwrap_or_else(|| "web".to_owned()), port));
            }
            continue;
        }
        if in_ports && !trimmed.starts_with('-') {
            in_ports = false;
        }
    }
    out
}

/// The host side of a compose port mapping: `8080:80` is 8080, `3000` is
/// 3000, `127.0.0.1:8080:80` is still 8080.
fn compose_host_port(value: &str) -> Option<u16> {
    let value = value.split('/').next().unwrap_or(value);
    let parts: Vec<&str> = value.split(':').collect();
    let host = match parts.len() {
        1 => parts[0],
        2 => parts[0],
        3 => parts[1],
        _ => return None,
    };
    // Ranges (`8000-8010:8000-8010`) name no single port to route.
    host.trim().parse().ok()
}

fn dockerfile_exposes(text: &str) -> Vec<u16> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed
            .strip_prefix("EXPOSE ")
            .or_else(|| trimmed.strip_prefix("expose "))
        else {
            continue;
        };
        for token in rest.split_whitespace() {
            if let Ok(port) = token.split('/').next().unwrap_or(token).parse() {
                out.push(port);
            }
        }
    }
    out
}

/// A port named in a script command line: `--port 3000`, `--port=3000`,
/// `-p 3000`, or a `PORT=3000` prefix.
fn port_in_command(command: &str) -> Option<u16> {
    let tokens: Vec<&str> = command.split_whitespace().collect();
    for (index, token) in tokens.iter().enumerate() {
        if let Some(value) = token
            .strip_prefix("--port=")
            .or_else(|| token.strip_prefix("PORT="))
            .or_else(|| token.strip_prefix("-p="))
            && let Ok(port) = value.parse()
        {
            return Some(port);
        }
        if matches!(*token, "--port" | "-p")
            && let Some(next) = tokens.get(index + 1)
            && let Ok(port) = next.parse()
        {
            return Some(port);
        }
    }
    None
}

fn env_ports(text: &str) -> Vec<(String, u16)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim().trim_start_matches("export ").trim();
        if !key.ends_with("PORT") {
            continue;
        }
        let value = value.trim().trim_matches(['"', '\'']);
        if let Ok(port) = value.parse() {
            out.push((key.to_owned(), port));
        }
    }
    out
}

/// `applicationUrl` in a .NET launch profile, which is a semicolon-separated
/// list of URLs rather than a port.
fn launch_settings_ports(text: &str) -> Vec<u16> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(profiles) = json.get("profiles").and_then(serde_json::Value::as_object) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for profile in profiles.values() {
        let Some(urls) = profile
            .get("applicationUrl")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        for url in urls.split(';') {
            if let Some(port) = url.trim().rsplit(':').next().and_then(|p| p.parse().ok()) {
                out.push(port);
            }
        }
    }
    out
}

/// The port a framework serves on when nobody said otherwise.
fn framework_default(stack: Stack, root: &Path) -> Option<u16> {
    match stack {
        Stack::Next => Some(3000),
        Stack::Vite => Some(5173),
        // A bare Node project has no default worth guessing — `node index.js`
        // serves on whatever the source says, and this module does not read
        // source.
        Stack::Node | Stack::Rust | Stack::Go => None,
        Stack::Python => root.join("manage.py").is_file().then_some(8000),
        Stack::Dotnet => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("envmux-detect-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_next_repo_is_recognised_ahead_of_being_a_node_one() {
        let root = scratch("next");
        std::fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"next":"14"},"scripts":{"dev":"next dev"}}"#,
        )
        .unwrap();
        std::fs::write(root.join("package-lock.json"), "{}").unwrap();
        let found = detect(&root);
        assert_eq!(found.primary(), Some(Stack::Next));
        assert_eq!(found.package_manager, Some(PackageManager::Npm));
        // With nothing more definite around, the framework default stands in.
        assert_eq!(found.ports.first().map(|p| p.port), Some(3000));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_lockfile_decides_the_package_manager() {
        let root = scratch("pnpm");
        std::fs::write(root.join("package.json"), "{}").unwrap();
        std::fs::write(root.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(detect(&root).package_manager, Some(PackageManager::Pnpm));
        assert_eq!(
            PackageManager::Pnpm.install(),
            "pnpm install --frozen-lockfile"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_real_declaration_beats_a_framework_default() {
        // The whole ordering rule in one case: the repo is Next (default
        // 3000) but its own script says 4000, and the script is what runs.
        let root = scratch("explicit");
        std::fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"next":"14"},"scripts":{"dev":"next dev --port 4000"}}"#,
        )
        .unwrap();
        let found = detect(&root);
        assert_eq!(found.ports.len(), 1);
        assert_eq!(found.ports[0].port, 4000);
        assert!(found.ports[0].source.contains("scripts.dev"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn compose_ports_come_out_named_after_their_service() {
        let text = "
version: '3'
services:
  web:
    image: nginx
    ports:
      - \"8080:80\"
  api:
    ports:
      - '9000:9000/tcp'
    environment:
      - FOO=bar
  db:
    ports:
      - 5432:5432
";
        let ports = compose_ports(text);
        assert_eq!(
            ports,
            vec![
                ("web".to_owned(), 8080),
                ("api".to_owned(), 9000),
                ("db".to_owned(), 5432),
            ]
        );
    }

    #[test]
    fn a_ports_list_does_not_leak_into_the_next_key() {
        // `environment:` follows `ports:` at the same indentation in the
        // fixture above; a scanner that stayed in list mode would read
        // `- FOO=bar` as a port mapping.
        let text = "services:\n  api:\n    ports:\n      - 3000:3000\n    environment:\n      - PORT=9999\n";
        assert_eq!(compose_ports(text), vec![("api".to_owned(), 3000)]);
    }

    #[test]
    fn host_ports_are_read_from_every_mapping_shape() {
        assert_eq!(compose_host_port("3000"), Some(3000));
        assert_eq!(compose_host_port("8080:80"), Some(8080));
        assert_eq!(compose_host_port("127.0.0.1:8080:80"), Some(8080));
        assert_eq!(compose_host_port("9000:9000/udp"), Some(9000));
        // A range names no single port to route to.
        assert_eq!(compose_host_port("8000-8010:8000-8010"), None);
    }

    #[test]
    fn port_flags_are_read_in_every_spelling_that_appears_in_the_wild() {
        assert_eq!(port_in_command("next dev --port 4000"), Some(4000));
        assert_eq!(port_in_command("vite --port=5000"), Some(5000));
        assert_eq!(port_in_command("PORT=7000 node server.js"), Some(7000));
        assert_eq!(port_in_command("serve -p 8000"), Some(8000));
        assert_eq!(port_in_command("jest --watch"), None);
    }

    #[test]
    fn privileged_and_duplicate_ports_are_dropped() {
        // `EXPOSE 80` is a container-side convention, not something to route,
        // and the same number found twice is one route.
        let root = scratch("expose");
        std::fs::write(
            root.join("Dockerfile"),
            "FROM nginx\nEXPOSE 80 8080\nEXPOSE 8080\n",
        )
        .unwrap();
        let found = detect(&root);
        assert_eq!(found.ports.len(), 1);
        assert_eq!(found.ports[0].port, 8080);
        assert_eq!(found.dockerfile.as_deref(), Some("Dockerfile"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn two_services_on_different_ports_get_distinct_route_names() {
        let root = scratch("twoports");
        std::fs::write(
            root.join("compose.yaml"),
            "services:\n  web:\n    ports:\n      - 3000:3000\n  web:\n    ports:\n      - 4000:4000\n",
        )
        .unwrap();
        let found = detect(&root);
        let names: Vec<&str> = found.ports.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["web", "web-2"], "route names must not collide");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn route_names_are_always_a_legal_hostname_label() {
        assert_eq!(sanitise_route_name("My Service"), "my-service");
        assert_eq!(sanitise_route_name("api_v2"), "api-v2");
        assert_eq!(sanitise_route_name("--"), "web");
        assert_eq!(sanitise_route_name(""), "web");
    }

    #[test]
    fn env_files_only_offer_keys_that_are_actually_ports() {
        let text =
            "# comment\nPORT=3000\nexport APP_PORT=4000\nDATABASE_URL=postgres://x\nPORTAL=nope\n";
        assert_eq!(
            env_ports(text),
            vec![("PORT".to_owned(), 3000), ("APP_PORT".to_owned(), 4000)]
        );
    }

    #[test]
    fn dotnet_launch_profiles_give_up_their_ports() {
        let text = r#"{"profiles":{"http":{"applicationUrl":"http://localhost:5108;https://localhost:7226"}}}"#;
        assert_eq!(launch_settings_ports(text), vec![5108, 7226]);
    }

    #[test]
    fn an_unrecognisable_directory_detects_nothing_and_does_not_fail() {
        let root = scratch("empty");
        let found = detect(&root);
        assert!(found.stacks.is_empty());
        assert!(found.ports.is_empty());
        assert_eq!(found.primary(), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn detection_is_deterministic() {
        // Onboarding shows the file it is about to write; a preview that
        // reorders between runs is one nobody can review.
        let root = scratch("stable");
        std::fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"vite":"5"},"scripts":{"dev":"vite --port 5173","start":"node s.js"}}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("compose.yaml"),
            "services:\n  api:\n    ports:\n      - 9000:9000\n",
        )
        .unwrap();
        let first = detect(&root);
        for _ in 0..5 {
            let again = detect(&root);
            assert_eq!(first.stacks, again.stacks);
            assert_eq!(first.ports, again.ports);
        }
        // And the compose file, being the stronger statement, is listed first.
        assert_eq!(first.ports[0].port, 9000);
        let _ = std::fs::remove_dir_all(&root);
    }
}
