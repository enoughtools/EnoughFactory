//! The reaper: a scheduled sweep against stamped death dates. Nothing is
//! computed from elapsed time at sweep — a machine that slept for a weekend
//! wakes with the same death dates it went to sleep with.

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::context::Ctx;

pub async fn run(ctx: Arc<Ctx>, cancel: CancellationToken) {
    let mut interval = super::jittered_interval(Duration::from_secs(60));
    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            _ = interval.tick() => {}
        }
        if let Err(e) = sweep(&ctx).await {
            tracing::warn!(error = %e, "reaper sweep failed");
        }
    }
}

pub async fn sweep(ctx: &Arc<Ctx>) -> anyhow::Result<()> {
    // Resume anything stuck mid-reap first (crash recovery), then fresh
    // victims past their stamp.
    let mut victims = ctx.db.workspaces_reaping().await?;
    victims.extend(ctx.db.workspaces_past_death().await?);
    for row in victims {
        let Some(ns) = ctx.namespace(&row.namespace).await else {
            tracing::warn!(workspace = %row.name, namespace = %row.namespace,
                "cannot reap: namespace not registered this boot");
            continue;
        };
        if let Err(e) = crate::workspace::reap_now(ctx, &ns, &row.id).await {
            tracing::warn!(workspace = %row.name, error = %e, "reap failed");
        }
    }
    Ok(())
}
