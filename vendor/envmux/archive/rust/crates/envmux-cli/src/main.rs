//! The envmux CLI — the complete interface. Exit codes: 0 ok, 1 error,
//! 2 usage (clap), 3 not-found, 4 daemon-unreachable.

mod attach;
mod client;
mod editor;
mod image;
mod install;
mod onboard;
mod output;
mod prune;
mod tui;

use std::path::PathBuf;

use anyhow::{Context as _, bail};
use clap::{CommandFactory as _, Parser, Subcommand};
use envmux_api_types as dto;

/// Where this invocation's daemon keeps its state.
///
/// v2 scopes envmux to the project: inside a repository (or an onboarded
/// directory) state lives in the project's own `.envmux/state`, which gives
/// every folder its own daemon and IPC endpoint. `$ENVMUX_STATE_DIR` still
/// wins as an explicit instruction, and outside any project the machine-wide
/// resolution applies so `envmux install` keeps working from a download dir.
pub fn state_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        if let Ok(dir) = std::env::var("ENVMUX_STATE_DIR")
            && !dir.trim().is_empty()
        {
            return PathBuf::from(dir);
        }
        std::env::current_dir()
            .map_err(anyhow::Error::from)
            .and_then(|cwd| repo_root(&cwd))
            .map_or_else(
                |_| envmux_core::state_dir(),
                |root| envmux_core::project_state_dir(&root),
            )
    })
    .clone()
}

use output::Format;

/// Marker context for exit code 4.
#[derive(Debug)]
pub struct DaemonUnreachable;

impl std::fmt::Display for DaemonUnreachable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Name the directory. Every project has its own daemon in v2, so a
        // running daemon and an unreachable one are the same sentence unless
        // it says which state directory it looked in.
        write!(
            f,
            "no daemon for this project (run `envmux` to start a session)\n  looked in: {}",
            state_dir().display(),
        )
    }
}

impl std::error::Error for DaemonUnreachable {}

#[derive(Parser)]
#[command(
    name = "envmux",
    version,
    about = "isolated, disposable dev environments"
)]
struct Cli {
    /// Absent means the TUI on a terminal, and `--help` when redirected.
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(clap::Args)]
struct FormatArgs {
    /// Stable tab-separated columns for scripting.
    #[arg(long)]
    porcelain: bool,
    /// One JSON object per line.
    #[arg(long)]
    json: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Start (or adopt) the daemon and register the namespace from cwd.
    Up,
    /// Daemon and namespace status.
    Status(FormatArgs),
    /// Gracefully stop the daemon; managed resources keep running.
    Down,
    /// Create a workspace (contextual from cwd, or explicit).
    Create {
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        branch: Option<String>,
        #[arg(long)]
        name: Option<String>,
        /// Wait until the task graph is satisfied.
        #[arg(long)]
        wait: bool,
    },
    /// List workspaces by observed state.
    Ls {
        #[arg(long)]
        branch: Option<String>,
        /// Only workspaces with uncommitted changes.
        #[arg(long)]
        dirty: bool,
        #[command(flatten)]
        format: FormatArgs,
    },
    /// Attach to a workspace's tmux session (or a named task window).
    Attach {
        workspace: String,
        #[arg(long)]
        task: Option<String>,
        /// Read-only: watch without keeping the workspace alive.
        #[arg(long)]
        ro: bool,
    },
    /// Open a workspace in VS Code, attached to its container.
    ///
    /// Launches your local VS Code with a folder URI that attaches it into
    /// the workspace container — VS Code installs its server over `docker
    /// exec` and opens the workspace folder inside. Hands off immediately;
    /// the attach happens in the VS Code window. Configure with the
    /// `[editor]` section (best kept in .envmux.local.toml).
    Code {
        /// Workspace name or id; absent opens the first live workspace.
        workspace: Option<String>,
    },
    /// Run a one-off command in a workspace.
    Run {
        workspace: String,
        #[arg(last = true, required = true)]
        cmd: Vec<String>,
    },
    /// Extend, shorten, set, pin, or unpin a lease.
    Lease {
        workspace: String,
        #[arg(long)]
        extend: Option<String>,
        #[arg(long)]
        until: Option<String>,
        #[arg(long)]
        pin: bool,
        #[arg(long)]
        unpin: bool,
    },
    /// Copy files in or out: `envmux cp ws:path local` or `envmux cp local ws:path`.
    Cp { src: String, dst: String },
    /// List shadow snapshots for a workspace or across a branch.
    Snapshots {
        workspace: Option<String>,
        #[arg(long)]
        branch: Option<String>,
        /// Create a fresh workspace from this snapshot id.
        #[arg(long)]
        from: Option<String>,
        #[command(flatten)]
        format: FormatArgs,
    },
    /// Capture a workspace's shadow snapshot now.
    Capture { workspace: String },
    /// Mirror operations.
    Mirror {
        #[command(subcommand)]
        cmd: MirrorCmd,
    },
    /// Build or pull the project's image in the foreground.
    ///
    /// The daemon does this too, invisibly, on first registration. Doing it
    /// here first puts the docker CLI's own progress on your terminal, and
    /// tags exactly what the daemon will look for — so the session that
    /// follows skips straight past the build.
    Image {
        #[command(subcommand)]
        cmd: ImageCmd,
    },
    /// Configuration inspection and local-override management.
    Config {
        #[command(subcommand)]
        cmd: ConfigCmd,
    },
    /// Service health.
    Services(FormatArgs),
    /// Provisioned slices, with orphan reporting.
    Slices {
        #[arg(long)]
        orphans: bool,
        #[command(flatten)]
        format: FormatArgs,
    },
    /// Run the reaper sweep now.
    Reap {
        #[arg(long)]
        dry_run: bool,
    },
    /// Remove leftover envmux containers, volumes, and networks from Docker.
    ///
    /// Talks to Docker directly — no daemon needed — and touches only objects
    /// carrying the envmux label schema. By default removes stopped envmux
    /// containers, then envmux volumes no surviving container mounts, then
    /// idle `envmux-*` networks. Running containers are left alone.
    Prune {
        /// Also stop and remove RUNNING envmux containers.
        #[arg(long)]
        all: bool,
        /// Print what would be removed and change nothing.
        #[arg(long)]
        dry_run: bool,
        /// Skip the confirmation prompt (required off a terminal).
        #[arg(long, short = 'f')]
        force: bool,
    },
    /// Disk use attributed by namespace, workspace, and volume class.
    Disk(FormatArgs),
    /// Copy this executable somewhere permanent and put it on PATH.
    ///
    /// The second step, once you have decided to keep it: everything works
    /// from wherever the archive was unpacked, and this is what survives
    /// deleting the download. Per-user, no elevation, no service unit — the
    /// daemon starts on demand.
    Install {
        /// Install here instead of the per-user default.
        #[arg(long)]
        dir: Option<PathBuf>,
        /// Copy the files but leave PATH alone.
        #[arg(long)]
        no_path: bool,
    },
    /// Start (or rejoin) a session in this directory.
    ///
    /// `envmux` with no arguments does this already on a terminal: onboard
    /// the directory if it has no config, fork the folder's daemon if none is
    /// running, make sure a workspace exists, and open the session TUI.
    Session {
        /// Answer yes to the onboarding prompt.
        #[arg(long)]
        yes: bool,
    },
    /// Manage this folder's namespace: workspaces, captures, events.
    ///
    /// The same view `/manage` opens from inside a session.
    Manage,
    /// Generate shell completions.
    Completions { shell: clap_complete::Shell },
    /// Run the daemon in the foreground.
    ///
    /// The daemon and the CLI are one executable. `envmux up` starts this for
    /// you in the background and is what you normally want; run it directly to
    /// keep it in the foreground, to see its logs on stderr, or from a
    /// service unit.
    Daemon(envmux_daemon::DaemonArgs),
}

#[derive(Subcommand)]
enum MirrorCmd {
    /// Trigger a mirror fetch now.
    Fetch,
}

#[derive(Subcommand)]
enum ImageCmd {
    /// Build (or pull) the image if it is not already present.
    Build {
        /// Rebuild or re-pull even when the image exists.
        #[arg(long)]
        force: bool,
    },
    /// Print the exact image reference or tag the daemon will use.
    Tag,
}

#[derive(Subcommand)]
enum ConfigCmd {
    /// Show the active file, its hash, and drift state.
    Show {
        #[arg(long)]
        hash: bool,
    },
    /// Copy .envmux.toml to .envmux.local.toml with drift detection.
    CreateLocal,
    /// Write a commented starter .envmux.toml.
    Generate,
    /// Print the prompt for having an agent write .envmux.toml, or run it.
    ///
    /// The declaration is meant to be generated: something that reads the
    /// repository and infers its services, tasks, and ports will do better
    /// than a template. envmux ships the instructions and pipes them to
    /// whichever agent you already use.
    ///
    ///   envmux config prompt                  # print it; pipe it anywhere
    ///   envmux config prompt --agent claude   # run it through an agent
    ///   envmux config prompt --list-agents
    Prompt {
        /// Agent to run: a known name (claude, codex, opencode, gemini) or any
        /// command, which receives the prompt on stdin.
        #[arg(long)]
        agent: Option<String>,
        /// List the agent names envmux knows how to invoke.
        #[arg(long)]
        list_agents: bool,
    },
}

fn namespace_from_cwd() -> anyhow::Result<String> {
    let cwd = std::env::current_dir()?;
    let root = repo_root(&cwd)?;
    let resolved = envmux_config::resolve_dir(&root).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(match resolved.config.meta.namespace {
        Some(ns) => ns,
        None => root
            .file_name()
            .map(|s| s.to_string_lossy().to_lowercase().replace([' ', '.'], "-"))
            .context("repository directory has no name")?,
    })
}

fn repo_root(from: &std::path::Path) -> anyhow::Result<PathBuf> {
    let mut dir = from.to_path_buf();
    loop {
        if dir.join(".git").exists() || dir.join(envmux_config::CONFIG_FILE).exists() {
            return Ok(dir);
        }
        if !dir.pop() {
            bail!(
                "not inside a repository (no .git or {} found)",
                envmux_config::CONFIG_FILE
            );
        }
    }
}

async fn resolve_workspace_id(
    namespace: &str,
    name_or_id: &str,
) -> anyhow::Result<dto::WorkspaceSummary> {
    // Try by listing the namespace and matching name first, then id.
    let resp = client::get(&format!("/v1/namespaces/{namespace}/workspaces")).await?;
    if resp.status == 200 {
        let list: Vec<dto::WorkspaceSummary> = resp.json()?;
        if let Some(ws) = list
            .iter()
            .find(|w| w.name == name_or_id || w.id == name_or_id)
        {
            return Ok(ws.clone());
        }
    }
    let resp = client::get(&format!("/v1/workspaces/{name_or_id}")).await?;
    if resp.status == 200 {
        return resp.json();
    }
    Err(anyhow::anyhow!(NotFound(format!(
        "workspace {name_or_id:?}"
    ))))
}

/// Marker context for exit code 3.
#[derive(Debug)]
pub struct NotFound(String);

impl std::fmt::Display for NotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} not found", self.0)
    }
}

impl std::error::Error for NotFound {}

/// Run the daemon on a multi-threaded runtime.
///
/// The CLI is current-thread — it makes one request and exits — but the daemon
/// supervises workers, Docker streams, and tmux control connections, and needs
/// real parallelism.
fn run_daemon(args: envmux_daemon::DaemonArgs) -> ! {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    match runtime.block_on(envmux_daemon::run(args)) {
        Ok(()) => std::process::exit(0),
        Err(e) => {
            eprintln!("error: {e:#}");
            std::process::exit(1);
        }
    }
}

/// What a bare `envmux` should do.
///
/// A terminal gets the TUI; anything else gets help, exactly as before. The
/// test is a real TTY check rather than a guess about who is calling, because
/// a script that suddenly receives an alternate-screen UI instead of its usual
/// output is a genuinely bad day.
fn bare_invocation() -> Command {
    use std::io::IsTerminal as _;
    if std::io::stdout().is_terminal() && std::io::stdin().is_terminal() {
        Command::Session { yes: false }
    } else {
        Cli::command().print_help().ok();
        println!();
        std::process::exit(2);
    }
}

fn main() {
    let cli = Cli::parse();
    let command = cli.command.unwrap_or_else(bare_invocation);
    if let Command::Daemon(args) = command {
        run_daemon(args);
    }

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let result = runtime.block_on(run(command));
    match result {
        Ok(()) => {}
        Err(e) => {
            eprintln!("error: {e:#}");
            let code = if e.chain().any(|c| c.is::<DaemonUnreachable>()) {
                4
            } else if e.chain().any(|c| c.is::<NotFound>()) || e.is::<NotFound>() {
                3
            } else {
                1
            };
            std::process::exit(code);
        }
    }
}

#[allow(clippy::too_many_lines)]
async fn run(command: Command) -> anyhow::Result<()> {
    match command {
        // Handled in `main` before the runtime is built: the daemon needs a
        // multi-threaded one, and this function is already inside the
        // current-thread runtime the CLI uses.
        Command::Daemon(_) => unreachable!("dispatched before the CLI runtime starts"),
        Command::Session { yes } => session(yes).await,
        Command::Manage => manage().await,
        Command::Install { dir, no_path } => install_here(dir, !no_path),
        Command::Up => up().await,
        Command::Status(format) => status(Format::from_flags(format.porcelain, format.json)).await,
        Command::Down => {
            let resp = client::post("/v1/shutdown", serde_json::json!({})).await?;
            if resp.status != 202 {
                bail!("{}", resp.error_message());
            }
            println!("daemon stopping; workspaces captured and containers closed");
            Ok(())
        }
        Command::Create {
            repo,
            branch,
            name,
            wait,
        } => {
            let ns = namespace_from_cwd()?;
            let resp = client::post(
                &format!("/v1/namespaces/{ns}/workspaces"),
                serde_json::json!({ "repo": repo, "branch": branch, "name": name, "overrides": null }),
            )
            .await?;
            if resp.status != 200 {
                bail!("{}", resp.error_message());
            }
            let created: dto::CreateWorkspaceResponse = resp.json()?;
            let id = created.workspace.id.clone();
            println!(
                "{} {}",
                if created.reused { "reused" } else { "created" },
                created.workspace.name
            );
            if wait {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    let ws: dto::WorkspaceSummary =
                        client::get(&format!("/v1/workspaces/{id}")).await?.json()?;
                    match ws.state {
                        dto::WorkspaceState::Ready => {
                            println!("ready");
                            break;
                        }
                        dto::WorkspaceState::Degraded => {
                            bail!("workspace degraded while starting");
                        }
                        _ => {}
                    }
                }
            }
            Ok(())
        }
        Command::Ls {
            branch,
            dirty,
            format,
        } => {
            let ns = namespace_from_cwd()?;
            let resp = client::get(&format!("/v1/namespaces/{ns}/workspaces")).await?;
            if resp.status != 200 {
                bail!("{}", resp.error_message());
            }
            let mut rows: Vec<dto::WorkspaceSummary> = resp.json()?;
            if let Some(branch) = branch {
                rows.retain(|w| {
                    w.observation.as_ref().and_then(|o| o.branch.as_deref())
                        == Some(branch.as_str())
                });
            }
            if dirty {
                rows.retain(|w| w.observation.as_ref().is_some_and(|o| o.dirty));
            }
            output::workspaces(&rows, Format::from_flags(format.porcelain, format.json));
            Ok(())
        }
        Command::Attach {
            workspace,
            task,
            ro,
        } => {
            let ns = namespace_from_cwd()?;
            let ws = resolve_workspace_id(&ns, &workspace).await?;
            attach::attach(&ws.id, task.as_deref(), ro).await
        }
        Command::Code { workspace } => code_cmd(workspace).await,
        Command::Run { workspace, cmd } => {
            let ns = namespace_from_cwd()?;
            let ws = resolve_workspace_id(&ns, &workspace).await?;
            let resp = client::post(
                &format!("/v1/workspaces/{}/run", ws.id),
                serde_json::json!({ "cmd": cmd }),
            )
            .await?;
            if resp.status != 200 {
                bail!("{}", resp.error_message());
            }
            let out: serde_json::Value = resp.json()?;
            print!("{}", out["stdout"].as_str().unwrap_or_default());
            eprint!("{}", out["stderr"].as_str().unwrap_or_default());
            let code = out["exit_code"].as_i64().unwrap_or(1);
            if code != 0 {
                std::process::exit(i32::try_from(code).unwrap_or(1));
            }
            Ok(())
        }
        Command::Lease {
            workspace,
            extend,
            until,
            pin,
            unpin,
        } => {
            let ns = namespace_from_cwd()?;
            let ws = resolve_workspace_id(&ns, &workspace).await?;
            let resp = if pin {
                client::post(
                    &format!("/v1/workspaces/{}/pin", ws.id),
                    serde_json::json!({}),
                )
                .await?
            } else if unpin {
                client::post(
                    &format!("/v1/workspaces/{}/unpin", ws.id),
                    serde_json::json!({}),
                )
                .await?
            } else if let Some(by) = extend {
                client::post(
                    &format!("/v1/workspaces/{}/lease", ws.id),
                    serde_json::json!({ "op": "extend", "by": by }),
                )
                .await?
            } else if let Some(at) = until {
                client::post(
                    &format!("/v1/workspaces/{}/lease", ws.id),
                    serde_json::json!({ "op": "until", "at": at }),
                )
                .await?
            } else {
                bail!("one of --extend, --until, --pin, --unpin is required");
            };
            if resp.status != 200 {
                bail!("{}", resp.error_message());
            }
            let lease: dto::LeaseResponse = resp.json()?;
            match (&lease.death_date, lease.pinned) {
                (_, true) => println!("pinned"),
                (Some(d), _) => println!("dies {d} ({})", output::until(d)),
                (None, false) => println!("no death date"),
            }
            Ok(())
        }
        Command::Cp { src, dst } => cp(&src, &dst).await,
        Command::Snapshots {
            workspace,
            branch,
            from,
            format,
        } => {
            let ns = namespace_from_cwd()?;
            if let Some(capture_id) = from {
                let resp = client::post(
                    &format!("/v1/namespaces/{ns}/workspaces:from-capture"),
                    serde_json::json!({ "capture_id": capture_id, "name": null }),
                )
                .await?;
                if resp.status != 200 {
                    bail!("{}", resp.error_message());
                }
                let created: dto::CreateWorkspaceResponse = resp.json()?;
                println!("created {} from snapshot", created.workspace.name);
                return Ok(());
            }
            let path = match (&workspace, &branch) {
                (Some(ws), _) => {
                    let ws = resolve_workspace_id(&ns, ws).await?;
                    format!("/v1/workspaces/{}/captures", ws.id)
                }
                (None, Some(b)) => format!("/v1/workspaces/-/captures?branch={b}"),
                (None, None) => bail!("name a workspace or pass --branch"),
            };
            let resp = client::get(&path).await?;
            if resp.status != 200 {
                bail!("{}", resp.error_message());
            }
            let snaps: Vec<dto::CaptureSummary> = resp.json()?;
            let format = Format::from_flags(format.porcelain, format.json);
            for s in &snaps {
                match format {
                    Format::Json => println!("{}", serde_json::to_string(s)?),
                    _ => println!(
                        "{}\t{}\t{}\t{}{}\t{}",
                        s.id,
                        s.workspace_name,
                        s.captured_at,
                        if s.torn { "torn" } else { "clean" },
                        s.flagged_state
                            .as_deref()
                            .map(|f| format!("+{f}"))
                            .unwrap_or_default(),
                        &s.commit_oid[..s.commit_oid.len().min(10)],
                    ),
                }
            }
            Ok(())
        }
        Command::Capture { workspace } => {
            let ns = namespace_from_cwd()?;
            let ws = resolve_workspace_id(&ns, &workspace).await?;
            let resp = client::post(
                &format!("/v1/workspaces/{}/captures", ws.id),
                serde_json::json!({}),
            )
            .await?;
            if resp.status != 200 {
                bail!("{}", resp.error_message());
            }
            let c: dto::CaptureSummary = resp.json()?;
            println!(
                "captured {} ({}{})",
                &c.commit_oid[..c.commit_oid.len().min(10)],
                if c.torn { "torn" } else { "clean" },
                c.flagged_state
                    .as_deref()
                    .map(|f| format!(", {f}"))
                    .unwrap_or_default(),
            );
            Ok(())
        }
        Command::Mirror {
            cmd: MirrorCmd::Fetch,
        } => {
            let ns = namespace_from_cwd()?;
            let resp = client::post(
                &format!("/v1/namespaces/{ns}/mirror/fetch"),
                serde_json::json!({}),
            )
            .await?;
            if resp.status != 200 {
                bail!("{}", resp.error_message());
            }
            let r: dto::MirrorFetchResponse = resp.json()?;
            println!("fetched at {}", r.fetched_at);
            Ok(())
        }
        Command::Image { cmd } => match cmd {
            ImageCmd::Build { force } => image::build(force).await,
            ImageCmd::Tag => image::print_tag(),
        },
        Command::Config { cmd } => config_cmd(cmd).await,
        Command::Services(format) => {
            let ns = namespace_from_cwd()?;
            let resp = client::get(&format!("/v1/services/{ns}")).await?;
            if resp.status != 200 {
                bail!("{}", resp.error_message());
            }
            let services: Vec<dto::ServiceSummary> = resp.json()?;
            let format = Format::from_flags(format.porcelain, format.json);
            for s in &services {
                match format {
                    Format::Json => println!("{}", serde_json::to_string(s)?),
                    _ => println!(
                        "{}\t{}\t{}",
                        s.name,
                        s.kind,
                        match s.healthy {
                            Some(true) => "healthy",
                            Some(false) => "unhealthy",
                            None => "unknown",
                        }
                    ),
                }
            }
            Ok(())
        }
        Command::Slices { orphans, format } => {
            let ns = namespace_from_cwd()?;
            let services: Vec<dto::ServiceSummary> =
                client::get(&format!("/v1/services/{ns}")).await?.json()?;
            let format = Format::from_flags(format.porcelain, format.json);
            for svc in &services {
                let resp = client::get(&format!("/v1/services/{ns}/{}/slices", svc.name)).await?;
                if resp.status != 200 {
                    continue;
                }
                let mut slices: Vec<dto::SliceSummary> = resp.json()?;
                if orphans {
                    slices.retain(|s| s.orphan);
                }
                for s in &slices {
                    match format {
                        Format::Json => println!("{}", serde_json::to_string(s)?),
                        _ => println!(
                            "{}\t{}\t{}\t{}",
                            s.service,
                            s.slice_key,
                            if s.orphan { "ORPHAN" } else { s.state.as_str() },
                            s.workspace_name.as_deref().unwrap_or("-"),
                        ),
                    }
                }
            }
            Ok(())
        }
        Command::Reap { dry_run } => {
            if dry_run {
                let ns = namespace_from_cwd()?;
                let rows: Vec<dto::WorkspaceSummary> =
                    client::get(&format!("/v1/namespaces/{ns}/workspaces"))
                        .await?
                        .json()?;
                let now = jiff::Timestamp::now().to_string();
                for w in rows {
                    if let Some(d) = &w.death_date {
                        if *d < now
                            && matches!(
                                w.state,
                                dto::WorkspaceState::Provisioning
                                    | dto::WorkspaceState::Ready
                                    | dto::WorkspaceState::Degraded
                            )
                        {
                            println!("would reap {}", w.name);
                        }
                    }
                }
                return Ok(());
            }
            let resp = client::post("/v1/reap", serde_json::json!({})).await?;
            if resp.status >= 300 {
                bail!("{}", resp.error_message());
            }
            println!("reaper sweep complete");
            Ok(())
        }
        Command::Prune {
            all,
            dry_run,
            force,
        } => prune::run(all, dry_run, force).await,
        Command::Disk(format) => {
            let resp = client::get("/v1/disk").await?;
            if resp.status != 200 {
                bail!("{}", resp.error_message());
            }
            let report: dto::DiskReport = resp.json()?;
            let format = Format::from_flags(format.porcelain, format.json);
            if format == Format::Json {
                println!("{}", serde_json::to_string(&report)?);
                return Ok(());
            }
            println!(
                "total {} MiB across {} envmux volumes (threshold {}%)",
                report.total_bytes / (1024 * 1024),
                report.items.len(),
                report.threshold_percent
            );
            for item in report.items.iter().take(20) {
                println!(
                    "{}\t{}\t{}\t{} MiB",
                    item.namespace.as_deref().unwrap_or("-"),
                    item.class.as_deref().unwrap_or("-"),
                    item.volume,
                    item.bytes / (1024 * 1024),
                );
            }
            Ok(())
        }
        Command::Completions { shell } => {
            clap_complete::generate(shell, &mut Cli::command(), "envmux", &mut std::io::stdout());
            Ok(())
        }
    }
}

/// Start a daemon for this state directory and wait for its IPC surface.
///
/// A no-op when one is already answering, so it is safe to call on any path
/// that needs a daemon — `envmux up`, and the TUI when it finds none.
pub async fn spawn_daemon() -> anyhow::Result<()> {
    if client::get("/v1/health").await.is_ok() {
        return Ok(());
    }
    // Same executable, different entry point — nothing to locate and no way
    // for the two halves to be different builds.
    let exe = std::env::current_exe().context("locating the envmux executable")?;
    // Create the state dir before the race starts: on Windows the pipe name
    // is a digest of the *canonicalized* state dir, and canonicalize only
    // works once the directory exists — both sides must resolve it the same.
    let dir = state_dir();
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating state dir {}", dir.display()))?;
    // Boot errors must land somewhere readable: a daemon with a nulled
    // stderr that dies during boot produces exactly the "did not come up"
    // message with no cause anywhere near it.
    let boot_log = dir.join("daemon-boot.stderr");
    let stderr_file =
        std::fs::File::create(&boot_log).context("creating daemon boot stderr file")?;
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("daemon").arg("--state-dir").arg(&dir);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::from(stderr_file));
    // Disowned, not supervised: the daemon must outlive this process and any
    // terminal it came from. Its own idle grace is what ends it.
    #[cfg(windows)]
    {
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().context("spawning daemon")?;
    // Wait for the IPC surface. The daemon serves it before anything slow,
    // so this resolves in well under a second — the generous ceiling exists
    // for cold machines, and a child that DIED gets reported immediately
    // with its own words rather than a timeout.
    for _ in 0..300 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Ok(Some(status)) = child.try_wait() {
            let tail = std::fs::read_to_string(&boot_log).unwrap_or_default();
            let tail = tail.lines().rev().take(6).collect::<Vec<_>>();
            let tail: Vec<_> = tail.into_iter().rev().collect();
            bail!(
                "daemon exited during boot ({status})\n{}\n  full log: {}",
                tail.join("\n"),
                boot_log.display()
            );
        }
        if client::get("/v1/health").await.is_ok() {
            return Ok(());
        }
    }
    client::get("/v1/health")
        .await
        .map(|_| ())
        .with_context(|| {
            format!(
                "daemon did not come up within 60s; its boot log is {}",
                boot_log.display()
            )
        })
}

fn install_here(dir: Option<PathBuf>, update_path: bool) -> anyhow::Result<()> {
    let plan = install::plan(dir)?;
    if plan.already_installed {
        println!("already installed at {}", plan.destination.display());
        return Ok(());
    }

    let report = install::run(&plan, update_path)?;
    println!("installed {}", plan.destination.display());

    if report.path_updated {
        println!("added to your user PATH — open a new terminal for it to take");
    } else if !plan.on_path {
        // Never edit a shell profile on someone's behalf: guessing which shell
        // and which file, and getting it wrong, edits a file they own.
        println!("\n{} is not on PATH. Add it with:", plan.dir.display());
        println!("  {}", install::path_hint(&plan.dir));
    }

    // The one thing people are surprised by: a portable copy keeps its state
    // beside itself, and the installed copy will not find it.
    if plan.portable_source {
        println!(
            "\nNote: this copy is running in portable mode, so its workspaces live in\n\
             its own state directory. The installed copy starts empty and uses the\n\
             platform data directory. Point at the old one with $ENVMUX_STATE_DIR if\n\
             you want to keep using it."
        );
    }

    println!("\nNext: cd into a repository and run `envmux`.");
    Ok(())
}

/// The whole v2 product in one function: onboard, fork the folder's daemon,
/// make sure a workspace exists, and hand over to the session TUI.
async fn session(assume_yes: bool) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    // Inside a repository the session belongs to its root; a bare directory
    // becomes a project by being onboarded.
    let root = repo_root(&cwd).unwrap_or(cwd);
    // `--yes` still means "do not ask": it takes the recommended preset and
    // goes, for the scripted case. Without it the TUI's setup screen asks,
    // and asks better than a `[Y/n]` on a cooked terminal could — it can show
    // the file it is about to write.
    if assume_yes && tui::setup_needed(&root) {
        let written = tui::write_recommended_config(&root)?;
        println!("onboarded: wrote {}", written.display());
    }

    // Everything that used to happen here — fork a daemon, register the
    // namespace (which on a first run pulls or builds an image), create a
    // workspace — now happens inside the TUI, on a task, with a checklist
    // reporting it. This function's job is to decide which folder the session
    // is for and get out of the way, so the landing page is on screen in
    // milliseconds rather than after several silent minutes.
    //
    // `[workspace] terminal = "manage"` means the session lands in the
    // management view rather than pointed at a workspace attach.
    let manage = envmux_config::resolve_dir(&root)
        .map(|resolved| resolved.config.workspace.terminal_is_manage())
        .unwrap_or(false);
    tui::run(tui::Launch {
        root,
        namespace: None,
        manage,
    })
    .await
}

/// `envmux manage`: straight to the management view for this folder.
async fn manage() -> anyhow::Result<()> {
    let root = repo_root(&std::env::current_dir()?)?;
    tui::run(tui::Launch {
        root,
        namespace: None,
        manage: true,
    })
    .await
}

/// The branch the host checkout is on — None when detached or not a repo.
pub fn host_branch(root: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (!name.is_empty() && name != "HEAD").then_some(name)
}

// `ensure_namespace` used to live here: fork the daemon, print
// "preparing namespace…", then block for however long an image pull takes
// before the UI existed. It is now `tui::boot`, which does the same calls on a
// task while the landing page reports each one.

async fn up() -> anyhow::Result<()> {
    // Adopt a running daemon, or spawn one as a supervised child.
    let was_running = client::get("/v1/health").await.is_ok();
    spawn_daemon().await?;
    println!(
        "{}",
        if was_running {
            "daemon running"
        } else {
            "daemon started"
        }
    );

    let root = repo_root(&std::env::current_dir()?)?;
    let resp = client::post(
        "/v1/namespaces",
        serde_json::json!({ "repo_dir": root.display().to_string() }),
    )
    .await?;
    if resp.status != 200 {
        bail!("{}", resp.error_message());
    }
    let ns: dto::NamespaceSummary = resp.json()?;
    println!(
        "namespace {} ready ({} services, {} live workspaces)",
        ns.name,
        ns.services.len(),
        ns.workspaces
    );
    Ok(())
}

async fn status(format: Format) -> anyhow::Result<()> {
    let resp = client::get("/v1/namespaces").await?;
    if resp.status != 200 {
        bail!("{}", resp.error_message());
    }
    let namespaces: Vec<dto::NamespaceSummary> = resp.json()?;
    for ns in &namespaces {
        match format {
            Format::Json => println!("{}", serde_json::to_string(ns)?),
            _ => {
                println!(
                    "{}\tworkspaces={}\tmirror_fetch={}\tservices={}",
                    ns.name,
                    ns.workspaces,
                    ns.mirror_last_fetch
                        .as_deref()
                        .map(output::age)
                        .unwrap_or_else(|| "never".into()),
                    ns.services
                        .iter()
                        .map(|s| {
                            format!(
                                "{}:{}",
                                s.name,
                                match s.healthy {
                                    Some(true) => "ok",
                                    Some(false) => "down",
                                    None => "?",
                                }
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(","),
                );
            }
        }
    }
    Ok(())
}

async fn config_cmd(cmd: ConfigCmd) -> anyhow::Result<()> {
    let root = repo_root(&std::env::current_dir()?)?;
    match cmd {
        ConfigCmd::Show { hash } => {
            let resolved = match envmux_config::resolve_dir(&root) {
                Ok(r) => r,
                Err(e) => {
                    // Config errors are miette diagnostics — the config file
                    // is the primary human touchpoint.
                    eprintln!("{:?}", miette::Report::new(e));
                    std::process::exit(1);
                }
            };
            if hash {
                println!("{}", resolved.hash);
                return Ok(());
            }
            println!("active: {}", resolved.path.display());
            println!("hash:   {}", resolved.hash);
            // Which daemon this CLI will talk to, and why. A portable copy and
            // an installed one on the same machine are otherwise
            // indistinguishable until commands quietly address the wrong one.
            let (dir, mode) = envmux_core::state_dir_with_kind();
            println!("state:  {} ({})", dir.display(), mode.as_str());
            match resolved.drift {
                envmux_config::DriftState::NotApplicable => {}
                envmux_config::DriftState::Untracked => {
                    println!("drift:  local override without recorded base (untracked)");
                }
                envmux_config::DriftState::Clean => println!("drift:  base unchanged"),
                envmux_config::DriftState::BaseMoved { .. } => {
                    println!(
                        "drift:  BASE HAS MOVED — your local copy is a diff away from finding out how"
                    );
                }
                envmux_config::DriftState::BaseMissing => {
                    println!("drift:  committed base no longer exists");
                }
            }
            Ok(())
        }
        ConfigCmd::CreateLocal => {
            envmux_config::create_local_config(&root).map_err(|e| anyhow::anyhow!("{e}"))?;
            println!(
                "wrote {} (whole-file override; drift detection on)",
                envmux_config::LOCAL_CONFIG_FILE
            );
            Ok(())
        }
        ConfigCmd::Generate => {
            let path = root.join(envmux_config::CONFIG_FILE);
            if path.exists() {
                bail!("{} already exists", path.display());
            }
            std::fs::write(&path, envmux_config::generate_starter(None))?;
            println!("wrote {}", path.display());
            Ok(())
        }
        ConfigCmd::Prompt { agent, list_agents } => {
            if list_agents {
                println!("agents envmux knows how to invoke:");
                for (name, argv) in envmux_config::KNOWN_AGENTS {
                    println!("  {name:-10} {}", argv.join(" "));
                }
                println!("\nAny other command works too — it receives the prompt on stdin:");
                println!("  envmux config prompt --agent 'uvx my-agent --yes'");
                return Ok(());
            }

            let Some(agent) = agent else {
                // No agent: print it. Piping to something else is a first-class
                // use, not a fallback.
                print!("{}", envmux_config::AUTHORING_PROMPT);
                return Ok(());
            };

            let argv = envmux_config::agent_command(&agent);
            let Some((program, args)) = argv.split_first() else {
                bail!("empty agent command");
            };

            // Run in the repository root: the agent is being asked to read this
            // repository and write a file into it.
            let mut child = tokio::process::Command::new(program)
                .args(args)
                .current_dir(&root)
                .stdin(std::process::Stdio::piped())
                .spawn()
                .with_context(|| {
                    format!(
                        "running {program:?}. Install it, or pass a different \
                         --agent; `envmux config prompt` alone prints the \
                         instructions for any tool."
                    )
                })?;

            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt as _;
                stdin
                    .write_all(envmux_config::AUTHORING_PROMPT.as_bytes())
                    .await
                    .context("sending the prompt to the agent")?;
                stdin.shutdown().await.ok();
            }

            let status = child.wait().await.context("waiting for the agent")?;
            if !status.success() {
                bail!("{program} exited with {status}");
            }
            println!("\nCheck the result with: envmux config show");
            Ok(())
        }
    }
}

/// `envmux code [workspace]`: hand the workspace to local VS Code.
///
/// The default workspace is resolved the way an attach would pick one: the
/// first live (ready or degraded — a failed task is exactly the thing you
/// open an editor on) workspace of the cwd namespace. Everything after that
/// is `editor::open`: preconditions, folder resolution, discovery, launch.
async fn code_cmd(workspace: Option<String>) -> anyhow::Result<()> {
    let ns = namespace_from_cwd()?;
    let root = repo_root(&std::env::current_dir()?)?;
    // namespace_from_cwd already resolved this file once, so failures here
    // would have surfaced there; resolving again keeps the two independent.
    let resolved = envmux_config::resolve_dir(&root).map_err(|e| anyhow::anyhow!("{e}"))?;

    let ws = match workspace {
        Some(name) => resolve_workspace_id(&ns, &name).await?,
        None => {
            let resp = client::get(&format!("/v1/namespaces/{ns}/workspaces")).await?;
            if resp.status != 200 {
                bail!("{}", resp.error_message());
            }
            let list: Vec<dto::WorkspaceSummary> = resp.json()?;
            list.into_iter()
                .find(|w| matches!(w.state.to_string().as_str(), "ready" | "degraded"))
                .ok_or(editor::EditorError::NoContainerSelected)?
        }
    };

    let opened = editor::open(editor::OpenSpec {
        namespace: &ns,
        workspace: &ws.name,
        editor: &resolved.config.editor,
        configured_workdir: Some(&resolved.config.workspace.workdir),
    })
    .await?;

    println!(
        "VS Code launched ({}) — the attach happens in its window",
        opened.editor.display()
    );
    println!("(first time: VS Code will offer to install the Dev Containers extension)");
    if let Some(hint) = opened.hint {
        println!("note: {hint}");
    }
    Ok(())
}

async fn cp(src: &str, dst: &str) -> anyhow::Result<()> {
    let ns = namespace_from_cwd()?;
    let parse = |s: &str| -> Option<(String, String)> {
        // ws:path — but not a Windows drive letter like C:\...
        let (ws, path) = s.split_once(':')?;
        if ws.len() == 1 {
            return None;
        }
        Some((ws.to_owned(), path.to_owned()))
    };
    match (parse(src), parse(dst)) {
        (Some((ws, remote)), None) => {
            let ws = resolve_workspace_id(&ns, &ws).await?;
            let resp =
                client::get(&format!("/v1/workspaces/{}/files?path={remote}", ws.id)).await?;
            if resp.status != 200 {
                bail!("{}", resp.error_message());
            }
            // The body is a tar of the requested path; unpack to dst.
            let dest = PathBuf::from(dst);
            std::fs::create_dir_all(&dest)?;
            let mut archive = tar::Archive::new(resp.body.as_ref());
            archive.unpack(&dest)?;
            println!("copied {remote} -> {}", dest.display());
            Ok(())
        }
        (None, Some((ws, remote))) => {
            let ws = resolve_workspace_id(&ns, &ws).await?;
            let src_path = PathBuf::from(src);
            let mut builder = tar::Builder::new(Vec::new());
            if src_path.is_dir() {
                builder.append_dir_all(".", &src_path)?;
            } else {
                let name = src_path
                    .file_name()
                    .context("source has no file name")?
                    .to_string_lossy()
                    .into_owned();
                let mut f = std::fs::File::open(&src_path)?;
                builder.append_file(name, &mut f)?;
            }
            let data = builder.into_inner()?;
            let resp = client::put_bytes(
                &format!("/v1/workspaces/{}/files?path={remote}", ws.id),
                bytes::Bytes::from(data),
            )
            .await?;
            if resp.status >= 300 {
                bail!("{}", resp.error_message());
            }
            println!("copied {src} -> {ws}:{remote}", ws = ws.name);
            Ok(())
        }
        _ => bail!("exactly one side must be <workspace>:<path>"),
    }
}
