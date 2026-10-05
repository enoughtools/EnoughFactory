//! The task engine: compiles `[tasks.*]` into a dependency graph, creates
//! tmux windows in topological order, evaluates readiness/completion checks,
//! and supervises restarts. A workspace is `Ready` when the graph is
//! satisfied; breaching a restart policy makes it `Degraded`.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use anyhow::{Context as _, bail};
use dashmap_lite::StatusMap;
use envmux_api_types::{TaskState, TaskStatus};
use envmux_config::{Check, Config, RestartPolicy};
use envmux_core::WorkspaceState;
use envmux_tmux::wrap::{exit_file, wrap_task_command};
use petgraph::graph::DiGraph;

use crate::context::{Ctx, NamespaceCtx};
use crate::state::WorkspaceRow;
use crate::workspace::SECRETS_DIR;

/// Minimal shared map: workspace id → task statuses. Engine writes, observer
/// and API read.
pub mod dashmap_lite {
    use std::collections::HashMap;
    use std::sync::{Mutex, MutexGuard};

    #[derive(Default)]
    pub struct StatusMap(Mutex<HashMap<String, Vec<super::TaskStatus>>>);

    impl StatusMap {
        fn lock(&self) -> MutexGuard<'_, HashMap<String, Vec<super::TaskStatus>>> {
            self.0.lock().expect("status map lock poisoned")
        }

        pub fn set(&self, ws: &str, statuses: Vec<super::TaskStatus>) {
            self.lock().insert(ws.to_owned(), statuses);
        }

        pub fn update(&self, ws: &str, task: &str, f: impl FnOnce(&mut super::TaskStatus)) {
            if let Some(list) = self.lock().get_mut(ws) {
                if let Some(t) = list.iter_mut().find(|t| t.name == task) {
                    f(t);
                }
            }
        }

        #[must_use]
        pub fn get(&self, ws: &str) -> Vec<super::TaskStatus> {
            self.lock().get(ws).cloned().unwrap_or_default()
        }

        pub fn remove(&self, ws: &str) {
            self.lock().remove(ws);
        }
    }
}

pub type TaskStatusMap = Arc<StatusMap>;

/// Run the full graph for a freshly provisioned workspace, then mark it
/// Ready. Long-running task supervision continues in the background.
pub async fn run_graph(
    ctx: &Arc<Ctx>,
    ns: &Arc<NamespaceCtx>,
    row: &WorkspaceRow,
    cfg: &Config,
    // Counts the build phase as daemon activity so an unattended daemon
    // cannot grace-out under a workspace it is still building. Dropped at
    // Ready: the supervision loop that follows must NOT count, or a single
    // long-running task would keep the daemon alive forever.
    building: crate::workers::idle::ClientGuard,
) -> anyhow::Result<()> {
    let container = ns.workspace_container_name(&row.name);

    ctx.task_status.set(
        &row.id,
        cfg.tasks
            .keys()
            .map(|name| TaskStatus {
                name: name.clone(),
                state: TaskState::Waiting,
                exit_code: None,
                restarts: 0,
            })
            .collect(),
    );

    // External dependencies first: every required service must be healthy.
    for task in cfg.tasks.values() {
        for svc in &task.requires {
            wait_service_healthy(ctx, ns, svc).await?;
        }
    }

    // Topological order (config validation already rejected cycles).
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
    let order = petgraph::algo::toposort(&graph, None)
        .map_err(|_| anyhow::anyhow!("cyclic task graph escaped validation"))?;

    // Open the control-mode stream (creates the session on first use, with
    // the configured terminal in the first window — the one attach lands in).
    // tmux -CC requires its client fd to be a tty, so the exec allocates one.
    let stream = ctx
        .docker
        .exec_stream(
            &container,
            envmux_tmux::client::control_attach_cmd(cfg.workspace.terminal_command()),
            None,
            None,
            true,
        )
        .await?;
    let tmux = envmux_tmux::TmuxClient::new(stream);

    for node in order {
        let task_name = graph[node].to_owned();
        let task = &cfg.tasks[&task_name];
        start_task(ctx, ns, row, &container, &tmux, &task_name, task, cfg).await?;
        if task.long_running {
            wait_check(ctx, &container, &task_name, task, false).await?;
            ctx.task_status
                .update(&row.id, &task_name, |t| t.state = TaskState::Ready);
        } else {
            let code = wait_exit(ctx, &container, &task_name, task).await?;
            ctx.task_status.update(&row.id, &task_name, |t| {
                t.exit_code = Some(code);
                t.state = if code == 0 {
                    TaskState::Exited
                } else {
                    TaskState::Failed
                };
            });
            if code != 0 {
                match &task.restart {
                    RestartPolicy::Never => {
                        bail!(
                            "one-shot task {task_name:?} exited {code}. Its last output:\n{}",
                            pane_tail(ctx, &container, &task_name).await
                        );
                    }
                    RestartPolicy::OnFailure { max, backoff } => {
                        let mut attempts = 0;
                        loop {
                            attempts += 1;
                            if attempts > *max {
                                ctx.db
                                    .transition_workspace(&row.id, WorkspaceState::Ready)
                                    .await
                                    .ok();
                                ctx.db
                                    .transition_workspace(&row.id, WorkspaceState::Degraded)
                                    .await
                                    .ok();
                                bail!(
                                    "task {task_name:?} breached its restart policy. \
                                     Its last output:\n{}",
                                    pane_tail(ctx, &container, &task_name).await
                                );
                            }
                            tokio::time::sleep(backoff.as_std()).await;
                            tmux.kill_window(&task_name).await.ok();
                            start_task(ctx, ns, row, &container, &tmux, &task_name, task, cfg)
                                .await?;
                            ctx.task_status
                                .update(&row.id, &task_name, |t| t.restarts = attempts);
                            let code = wait_exit(ctx, &container, &task_name, task).await?;
                            if code == 0 {
                                ctx.task_status.update(&row.id, &task_name, |t| {
                                    t.exit_code = Some(0);
                                    t.state = TaskState::Exited;
                                });
                                break;
                            }
                        }
                    }
                    RestartPolicy::Always { .. } => unreachable!("validation rejects this"),
                }
            }
        }
    }

    ctx.db
        .transition_workspace(&row.id, WorkspaceState::Ready)
        .await?;
    ctx.event(
        "info",
        Some(row.namespace.as_str()),
        Some(row.name.as_str()),
        "tasks",
        "workspace ready",
    )
    .await;
    // Built. From here the grace clock answers to real clients again.
    drop(building);

    // Long-running supervision: poll windows; restart per policy; breach →
    // Degraded (visible in observation, does not stop siblings).
    let long_running: BTreeMap<String, _> = cfg
        .tasks
        .iter()
        .filter(|(_, t)| t.long_running)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if !long_running.is_empty() {
        supervise(ctx, ns, row, &container, tmux, long_running, cfg.clone()).await;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn start_task(
    ctx: &Ctx,
    ns: &NamespaceCtx,
    row: &WorkspaceRow,
    container: &str,
    tmux: &envmux_tmux::TmuxClient,
    name: &str,
    task: &envmux_config::Task,
    cfg: &Config,
) -> anyhow::Result<()> {
    let cwd = task
        .cwd
        .clone()
        .unwrap_or_else(|| cfg.workspace.workdir.clone());

    // Interpolation context: host env, workspace identity, and exports —
    // task exports plus slice credential *paths*.
    let mut ictx = envmux_config::InterpolationContext {
        host: std::env::vars().collect(),
        ..Default::default()
    };
    ictx.workspace.insert("name".into(), row.name.clone());
    ictx.workspace
        .insert("namespace".into(), row.namespace.clone());
    ictx.workspace
        .insert("branch".into(), row.branch_requested.clone());
    ictx.workspace
        .insert("workdir".into(), cfg.workspace.workdir.clone());
    for (svc_name, svc) in &cfg.services {
        if svc.provision {
            let files = ctx.db.list_slices(Some(&row.id)).await.unwrap_or_default();
            let _ = files;
            ictx.exports
                .entry(svc_name.clone())
                .or_default()
                .insert("SECRETS_DIR".into(), format!("{SECRETS_DIR}/{svc_name}"));
        }
    }
    for (other_name, other) in &cfg.tasks {
        let entry = ictx.exports.entry(other_name.clone()).or_default();
        for (k, v) in &other.exports {
            entry.insert(k.clone(), v.clone());
        }
    }
    let _ = ns;

    let mut env_pairs: Vec<(String, String)> = Vec::new();
    for (k, v) in &cfg.env {
        env_pairs.push((k.clone(), envmux_config::interpolate(v, &ictx)?));
    }
    for (k, v) in &task.exports {
        env_pairs.push((k.clone(), envmux_config::interpolate(v, &ictx)?));
    }
    let command = envmux_config::interpolate(&task.command, &ictx)?;

    // Clear any stale exit file, then create the window.
    ctx.docker
        .run_exec(
            container,
            vec!["rm".into(), "-f".into(), exit_file(name)],
            None,
            None,
            vec![],
            None,
        )
        .await?;
    let wrapped = wrap_task_command(name, &command, &cwd, &env_pairs);
    tmux.new_task_window(name, &wrapped)
        .await
        .with_context(|| format!("creating tmux window for task {name:?}"))?;
    ctx.task_status
        .update(&row.id, name, |t| t.state = TaskState::Running);
    Ok(())
}

/// Wait for a one-shot task's exit file (the real exit code, not
/// `pane_dead_status`).
async fn wait_exit(
    ctx: &Ctx,
    container: &str,
    name: &str,
    task: &envmux_config::Task,
) -> anyhow::Result<i32> {
    let timeout = match &task.check {
        Some(
            Check::Exec { timeout, .. } | Check::Http { timeout, .. } | Check::Port { timeout, .. },
        ) => timeout.as_std(),
        None => std::time::Duration::from_secs(600),
    };
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let out = ctx
            .docker
            .run_exec(
                container,
                vec!["cat".into(), exit_file(name)],
                None,
                None,
                vec![],
                None,
            )
            .await?;
        if out.success() {
            return out
                .stdout
                .trim()
                .parse()
                .with_context(|| format!("unparseable exit file for {name:?}"));
        }
        if tokio::time::Instant::now() >= deadline {
            bail!("task {name:?} did not exit within {timeout:?}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// Wait until a task's check passes (readiness for long-running tasks).
/// `completed_ok` selects completion semantics for one-shot deps.
/// The task window's last non-empty lines, for failure messages.
///
/// The tmux window outlives its command, so a dead task's output is still
/// capturable — but a rolled-back workspace's is not, which is exactly why
/// every failure path quotes it *now* rather than leaving the reader to exec
/// into a container that is about to be reaped.
async fn pane_tail(ctx: &Ctx, container: &str, name: &str) -> String {
    let pane = ctx
        .docker
        .run_exec(
            container,
            vec![
                "tmux".into(),
                "capture-pane".into(),
                "-p".into(),
                "-t".into(),
                format!("envmux:{name}"),
            ],
            None,
            None,
            vec![],
            None,
        )
        .await
        .map(|out| out.stdout)
        .unwrap_or_default();
    let tail: Vec<&str> = pane
        .lines()
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(10)
        .collect();
    tail.into_iter().rev().collect::<Vec<_>>().join("\n")
}

async fn wait_check(
    ctx: &Ctx,
    container: &str,
    name: &str,
    task: &envmux_config::Task,
    _completed_ok: bool,
) -> anyhow::Result<()> {
    let Some(check) = &task.check else {
        return Ok(());
    };
    let (interval, timeout) = match check {
        Check::Exec {
            interval, timeout, ..
        }
        | Check::Http {
            interval, timeout, ..
        }
        | Check::Port {
            interval, timeout, ..
        } => (interval.as_std(), timeout.as_std()),
    };
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        // A long-running task whose command has already exited will never
        // pass its check; its wrapper wrote an exit file the moment it died.
        // Waiting out the timeout buries the real error under fifteen silent
        // minutes and a rollback — fail now, quoting the task's own output.
        if task.long_running {
            let exited = ctx
                .docker
                .run_exec(
                    container,
                    vec![
                        "sh".into(),
                        "-c".into(),
                        format!("cat {} 2>/dev/null", exit_file(name)),
                    ],
                    None,
                    None,
                    vec![],
                    None,
                )
                .await?;
            if exited.success() {
                let code = exited.stdout.trim().to_owned();
                bail!(
                    "long-running task {name:?} exited (code {code}) before its \
                     check ever passed. Its last output:\n{}",
                    pane_tail(ctx, container, name).await
                );
            }
        }
        let script = match check {
            Check::Exec { cmd, .. } => cmd.clone(),
            // Http/port checks run in-container against localhost: the
            // workspace is its own network namespace, so localhost is the
            // right vantage point and needs no orchestrator round-trip.
            Check::Http { port, path, .. } => format!(
                "wget -q -O /dev/null http://127.0.0.1:{port}{path} 2>/dev/null || curl -fsS -o /dev/null http://127.0.0.1:{port}{path}"
            ),
            Check::Port { port, .. } => {
                format!("(exec 3<>/dev/tcp/127.0.0.1/{port}) 2>/dev/null || nc -z 127.0.0.1 {port}")
            }
        };
        let out = ctx
            .docker
            .run_exec(
                container,
                vec!["sh".into(), "-c".into(), script],
                None,
                None,
                vec![],
                None,
            )
            .await?;
        if out.success() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            bail!("check for task {name:?} did not pass within {timeout:?}");
        }
        tokio::time::sleep(interval).await;
    }
}

async fn wait_service_healthy(ctx: &Ctx, ns: &NamespaceCtx, svc: &str) -> anyhow::Result<()> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        let kind = crate::namespace::service_kind(ctx, ns, svc).await?;
        if matches!(kind.health().await, Ok(envmux_services::Health::Healthy)) {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            bail!("service {svc:?} did not become healthy within 120s");
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// Background supervision of long-running tasks via window polling.
async fn supervise(
    ctx: &Arc<Ctx>,
    ns: &Arc<NamespaceCtx>,
    row: &WorkspaceRow,
    container: &str,
    tmux: envmux_tmux::TmuxClient,
    tasks: BTreeMap<String, envmux_config::Task>,
    cfg: Config,
) {
    let mut restarts: HashMap<String, u32> = HashMap::new();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let Ok(current) = ctx.db.get_workspace(&row.id).await else {
            break;
        };
        let Some(current) = current else { break };
        if !current.state.reapable() {
            break; // reaping or gone; supervision ends
        }
        let Ok(windows) = tmux.list_windows().await else {
            break;
        };
        for (name, task) in &tasks {
            let dead = windows.iter().any(|w| w.name == *name && w.dead)
                || !windows.iter().any(|w| w.name == *name);
            if !dead {
                continue;
            }
            let exit_code = read_exit_code(ctx, container, name).await;
            ctx.task_status.update(&row.id, name, |t| {
                t.exit_code = exit_code;
                t.state = TaskState::Failed;
            });
            let (max, backoff) = match &task.restart {
                RestartPolicy::Never => {
                    // A dead never-restart long-running task degrades the
                    // workspace but stops nothing else.
                    let _ = ctx
                        .db
                        .transition_workspace(&row.id, WorkspaceState::Degraded)
                        .await;
                    continue;
                }
                RestartPolicy::OnFailure { max, backoff } => (*max, backoff.as_std()),
                RestartPolicy::Always { backoff } => (u32::MAX, backoff.as_std()),
            };
            let count = restarts.entry(name.clone()).or_insert(0);
            *count += 1;
            if *count > max {
                let _ = ctx
                    .db
                    .transition_workspace(&row.id, WorkspaceState::Degraded)
                    .await;
                continue;
            }
            tokio::time::sleep(backoff).await;
            tmux.kill_window(name).await.ok();
            if start_task(ctx, ns, row, container, &tmux, name, task, &cfg)
                .await
                .is_ok()
            {
                let n = *count;
                ctx.task_status.update(&row.id, name, |t| {
                    t.restarts = n;
                    t.state = TaskState::Running;
                });
                // Recovered task graph: Degraded → Ready if it was degraded.
                if let Ok(Some(w)) = ctx.db.get_workspace(&row.id).await {
                    if w.state == WorkspaceState::Degraded {
                        let _ = ctx
                            .db
                            .transition_workspace(&row.id, WorkspaceState::Ready)
                            .await;
                    }
                }
            }
        }
    }
}

async fn read_exit_code(ctx: &Ctx, container: &str, name: &str) -> Option<i32> {
    let out = ctx
        .docker
        .run_exec(
            container,
            vec!["cat".into(), exit_file(name)],
            None,
            None,
            vec![],
            None,
        )
        .await
        .ok()?;
    if out.success() {
        out.stdout.trim().parse().ok()
    } else {
        None
    }
}
