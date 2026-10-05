//! The envmux daemon: one instance per machine, managing every namespace.
//! Boot order: state dir → tracing → database + migrations → Docker
//! → reconciliation → workers → API (local IPC).
//!
//! This is a library so the daemon and the CLI can be **one executable**. They
//! are two halves of one thing: a CLI that cannot talk to a daemon of a
//! different build is a support problem, and "keep these two files together"
//! is a rule every installer, bundle, and package then has to honour. Shipping
//! one binary removes both. [`run`] is the whole entry point; the caller
//! supplies the runtime, because the daemon needs a multi-threaded one while
//! the CLI is happiest current-thread.

mod agent_bridge;
mod api;
mod context;
mod namespace;
mod naming;
mod reconcile;
mod router;
mod state;
mod tasks_engine;
mod workers;
mod workspace;

use std::sync::Arc;

use anyhow::Context as _;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::context::Ctx;

/// Daemon options, flattened into the CLI's `daemon` subcommand.
#[derive(clap::Args, Debug, Default)]
pub struct DaemonArgs {
    /// State directory to own. The v2 CLI passes the project's own
    /// `.envmux/state` so each folder gets its own daemon and IPC endpoint;
    /// unset falls back to the machine-wide resolution.
    #[arg(long)]
    pub state_dir: Option<std::path::PathBuf>,
    /// Seconds without any client before the daemon closes its containers and
    /// exits. The dead-man switch that makes the daemon ephemeral: long
    /// enough to survive a TUI restart, short enough that a closed terminal
    /// actually means shutdown.
    #[arg(long, default_value_t = 60)]
    pub grace_secs: u64,
    /// Disk alert threshold as percent of the state-dir disk.
    #[arg(long, default_value_t = 80)]
    pub disk_threshold: u8,
    /// Register a namespace from this repository directory at boot.
    #[arg(long)]
    pub register: Vec<std::path::PathBuf>,
}

fn init_tracing(state_dir: &std::path::Path) -> tracing_appender::non_blocking::WorkerGuard {
    let file_appender =
        tracing_appender::rolling::daily(state_dir.join("logs"), "envmux-daemon.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);
    use tracing_subscriber::layer::SubscriberExt as _;
    use tracing_subscriber::util::SubscriberInitExt as _;
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let stderr_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);
    let file_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_writer(file_writer);
    tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .with(file_layer)
        .init();
    guard
}

fn ensure_ipc_token(state_dir: &std::path::Path) -> anyhow::Result<String> {
    let path = state_dir.join("ipc.token");
    if path.exists() {
        return Ok(std::fs::read_to_string(path)?.trim().to_owned());
    }
    let token = envmux_secrets::mint_token();
    std::fs::write(&path, &token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(token)
}

/// Run the daemon until it is asked to stop.
///
/// # Errors
/// Returns an error if a component fails or exits unexpectedly.
pub async fn run(args: DaemonArgs) -> anyhow::Result<()> {
    let (state_dir, mode) = match &args.state_dir {
        Some(dir) => (dir.clone(), envmux_core::StateDirKind::Explicit),
        None => envmux_core::state_dir_with_kind(),
    };
    std::fs::create_dir_all(&state_dir).context("creating state dir")?;
    let ipc_token = ensure_ipc_token(&state_dir).context("initializing IPC credential")?;
    let _log_guard = init_tracing(&state_dir);
    // Say which directory and why. With a portable copy and an installed one on
    // the same machine, "where did my workspaces go" is the obvious failure,
    // and the answer is exactly this line.
    tracing::info!(
        state_dir = %state_dir.display(),
        mode = mode.as_str(),
        "envmux daemon starting"
    );
    // The log file lives inside the state dir, so a portable daemon's first
    // line is invisible to anyone watching the installed copy's logs. Say it on
    // stderr too — this is the run people are most likely to be debugging.
    if matches!(mode, envmux_core::StateDirKind::Portable) {
        eprintln!("portable mode: state in {}", state_dir.display());
    }

    // Substrate checks: host git version is a hard requirement.
    let git = envmux_git::GitRunner::new();
    let git_version = git.verify_version().await.context("host git check")?;
    tracing::info!(git = git_version, "host git ok");

    let db = state::Db::open(&state_dir.join("envmux.db"))
        .await
        .context("opening state database")?;

    let docker = envmux_docker::DockerHandle::connect().context("connecting to Docker")?;
    docker
        .ping()
        .await
        .context("Docker daemon is not reachable over the local socket")?;

    let secrets = Arc::new(envmux_secrets::Chain::default_chain(&state_dir));
    let (events_tx, _) = tokio::sync::broadcast::channel(1024);

    let ctx: Arc<Ctx> = Arc::new(Ctx {
        db,
        docker: docker.clone(),
        secrets,
        git,
        state_dir: state_dir.clone(),
        namespaces: tokio::sync::RwLock::new(std::collections::HashMap::new()),
        disk: envmux_docker::DiskUsageCache::new(docker, std::time::Duration::from_secs(60)),
        disk_threshold_percent: args.disk_threshold,
        task_status: Arc::new(tasks_engine::dashmap_lite::StatusMap::default()),
        events_tx,
        ipc_token,
        activity: Arc::new(workers::idle::Activity::default()),
        register_lock: tokio::sync::Mutex::new(()),
        shutdown: CancellationToken::new(),
        router_port: std::sync::OnceLock::new(),
    });

    // Serve IPC before anything slow. Rehydration below can include pulling
    // or building images — minutes — and a CLI that spawned this daemon polls
    // /v1/health with finite patience; a daemon that answers "booting" late
    // is indistinguishable from one that never came up. Requests that need a
    // namespace serialize against rehydration on the registration lock.
    let cancel = ctx.shutdown.clone();
    let mut components: JoinSet<&'static str> = JoinSet::new();
    {
        let ipc_router = api::ipc_router(Arc::clone(&ctx));
        let (r, d, t) = (ipc_router, state_dir.clone(), cancel.clone());
        components.spawn(async move {
            if let Err(e) = api::ipc::serve(r, d, t).await {
                tracing::error!(error = %e, "IPC server failed");
            }
            "ipc"
        });
    }

    // Rehydrate every persisted namespace before reconciliation and workers
    // start. A missing/moved repository is reported without preventing other
    // namespaces (and the daemon itself) from recovering.
    for (name, _, repo_dir, ..) in ctx.db.list_namespaces().await? {
        let Some(repo_dir) = repo_dir else {
            tracing::warn!(
                namespace = name,
                "namespace predates repo-path persistence; run envmux up once"
            );
            continue;
        };
        if let Err(e) = namespace::register(&ctx, std::path::Path::new(&repo_dir)).await {
            tracing::error!(namespace = name, repo = repo_dir, error = %e, "namespace rehydration failed");
        }
    }

    // Optional boot-time namespace registration.
    for repo in &args.register {
        if let Err(e) = namespace::register(&ctx, repo).await {
            tracing::error!(repo = %repo.display(), error = %e, "namespace registration failed");
        }
    }

    // Boot reconciliation after namespace contexts have been restored.
    reconcile::run(&ctx).await.context("boot reconciliation")?;

    // Boot is over; the grace clock starts NOW. Without this, a long
    // rehydration (an image build) eats the whole grace period before any
    // client could possibly have connected, and the dead-man switch kills a
    // daemon that only just became reachable.
    ctx.activity.mark_active();

    // Components: one JoinSet; a component exiting is a bug.
    {
        let (c, t) = (Arc::clone(&ctx), cancel.clone());
        components.spawn(async move {
            workers::reaper::run(c, t).await;
            "reaper"
        });
        let (c, t) = (Arc::clone(&ctx), cancel.clone());
        components.spawn(async move {
            workers::capture::run(c, t).await;
            "capture"
        });
        let (c, t) = (Arc::clone(&ctx), cancel.clone());
        components.spawn(async move {
            workers::observer::run(c, t).await;
            "observer"
        });
        let (c, t) = (Arc::clone(&ctx), cancel.clone());
        components.spawn(async move {
            workers::mirror_sync::run(c, t).await;
            "mirror-sync"
        });
        let (c, t) = (Arc::clone(&ctx), cancel.clone());
        components.spawn(async move {
            workers::disk::run(c, t).await;
            "disk-monitor"
        });
        // The in-session router: serves `[routes]`/`[routing]` over loopback.
        // It runs even when no namespace declares routes yet — namespaces
        // register later, and resolution is per-request.
        let (c, t) = (Arc::clone(&ctx), cancel.clone());
        components.spawn(async move {
            router::run(c, t).await;
            "router"
        });
        // The dead-man switch: this worker cancelling the token is the normal
        // way a v2 daemon ends, so its exit is a requested shutdown, not a
        // component failure.
        let (c, t) = (Arc::clone(&ctx), cancel.clone());
        let grace = std::time::Duration::from_secs(args.grace_secs.max(1));
        components.spawn(async move {
            workers::idle::run(c, grace, t).await;
            "idle-watch"
        });
    }

    ctx.event("info", None, None, "daemon", "daemon started")
        .await;

    // Supervision: a requested cancellation is graceful; an unsolicited component
    // exit still brings the daemon down and is reported as a failure.
    let component_failure = tokio::select! {
        () = cancel.cancelled() => None,
        joined = components.join_next() => {
            if cancel.is_cancelled() {
                None
            } else {
                let message = match joined {
                    Some(Ok(name)) => {
                        tracing::error!(component = name, "component exited unexpectedly");
                        format!("daemon component {name} exited unexpectedly")
                    }
                    Some(Err(e)) => {
                        tracing::error!(error = %e, "component panicked");
                        format!("daemon component panicked: {e}")
                    }
                    None => "all daemon components exited unexpectedly".to_owned(),
                };
                Some(message)
            }
        }
        Ok(()) = tokio::signal::ctrl_c() => {
            tracing::info!("shutdown signal; draining");
            None
        }
    };

    cancel.cancel();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while components.join_next().await.is_some() {}
    })
    .await;
    ctx.event("info", None, None, "daemon", "daemon stopped")
        .await;
    if let Some(message) = component_failure {
        anyhow::bail!(message);
    }
    Ok(())
}
