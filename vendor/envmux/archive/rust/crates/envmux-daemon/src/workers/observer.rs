//! Observer: scheduled, lock-free collection of branch, commit, dirtiness,
//! and activity per workspace, fanned out with a bounded concurrency limit so
//! a dozen monorepo workspaces don't stampede. Skips non-Ready/Degraded
//! states. Consumers display observation age, never imply liveness.

use std::sync::Arc;
use std::time::Duration;

use envmux_git::scripts;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::context::{Ctx, NamespaceCtx};
use crate::state::{ObservationRow, WorkspaceRow};

const CONCURRENCY: usize = 4;

pub async fn run(ctx: Arc<Ctx>, cancel: CancellationToken) {
    let mut tick = super::jittered_interval(Duration::from_secs(30));
    let mut last_run: std::collections::HashMap<String, std::time::Instant> =
        std::collections::HashMap::new();
    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            _ = tick.tick() => {}
        }
        let namespaces: Vec<_> = ctx.namespaces.read().await.values().cloned().collect();
        for ns in namespaces {
            let interval = ns.resolved.read().await.config.observe.interval.as_std();
            let due = last_run
                .get(ns.name.as_str())
                .is_none_or(|at| at.elapsed() >= interval);
            if !due {
                continue;
            }
            last_run.insert(ns.name.to_string(), std::time::Instant::now());

            let Ok(workspaces) = ctx.db.list_workspaces(Some(ns.name.as_str())).await else {
                continue;
            };
            let mut joinset = JoinSet::new();
            let mut pending: Vec<WorkspaceRow> = workspaces
                .into_iter()
                .filter(|w| w.state.observable())
                .collect();
            let mut inflight = 0usize;
            loop {
                while inflight < CONCURRENCY {
                    let Some(row) = pending.pop() else { break };
                    let ctx2 = Arc::clone(&ctx);
                    let ns2 = Arc::clone(&ns);
                    joinset.spawn(async move {
                        if let Err(e) = observe_one(&ctx2, &ns2, &row).await {
                            tracing::debug!(workspace = %row.name, error = %e, "observation failed");
                        }
                    });
                    inflight += 1;
                }
                if joinset.join_next().await.is_none() {
                    break;
                }
                inflight -= 1;
            }
        }
    }
}

async fn observe_one(ctx: &Ctx, ns: &NamespaceCtx, row: &WorkspaceRow) -> anyhow::Result<()> {
    let container = ns.workspace_container_name(&row.name);
    let resolved = ns.resolved.read().await;
    let workdir = resolved.config.workspace.workdir.clone();
    let depth = match resolved.config.observe.depth {
        envmux_config::ObserveDepth::Full => "full",
        envmux_config::ObserveDepth::Cheap => "cheap",
    };
    let cap = resolved.config.observe.status_cap;
    drop(resolved);

    let out = ctx
        .docker
        .run_exec(
            &container,
            vec!["sh".into(), "-c".into(), scripts::OBSERVE_SCRIPT.to_owned()],
            None,
            None,
            vec![
                format!("ENVMUX_WORKDIR={workdir}"),
                format!("ENVMUX_DEPTH={depth}"),
                format!("ENVMUX_CAP={cap}"),
            ],
            None,
        )
        .await?;
    let data = scripts::parse_observation_output(&out.stdout);
    let tasks = ctx.task_status.get(&row.id);
    ctx.db
        .upsert_observation(&ObservationRow {
            workspace_id: row.id.clone(),
            observed_at: jiff::Timestamp::now().to_string(),
            branch: data.branch,
            head: data.head,
            dirty: data.dirty,
            dirty_files: data.dirty_files.map(i64::from),
            truncated: data.truncated,
            ahead: data.ahead.map(i64::from),
            behind: data.behind.map(i64::from),
            flagged_state: data.flagged,
            tasks_json: serde_json::to_string(&tasks).unwrap_or_else(|_| "[]".into()),
            last_attach_at: None, // preserved by the upsert's COALESCE
        })
        .await?;
    Ok(())
}
