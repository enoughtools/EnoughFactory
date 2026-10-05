//! Capture worker: scheduled shadow snapshots per namespace, fanned out per
//! workspace, serialized against shadow maintenance by the per-namespace
//! lock. Also owns shadow maintenance (ref pruning + gc) on its own cadence.

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::context::Ctx;

pub async fn run(ctx: Arc<Ctx>, cancel: CancellationToken) {
    let mut capture_tick = super::jittered_interval(Duration::from_secs(60));
    let mut last_maintenance: std::collections::HashMap<String, std::time::Instant> =
        std::collections::HashMap::new();
    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            _ = capture_tick.tick() => {}
        }
        let namespaces: Vec<_> = ctx.namespaces.read().await.values().cloned().collect();
        for ns in namespaces {
            let resolved = ns.resolved.read().await;
            let interval = resolved.config.capture.interval.as_std();
            let retention = resolved.config.capture.retention;
            let maintenance = resolved.config.capture.maintenance.as_std();
            drop(resolved);

            // Capture on the namespace's own cadence (worker ticks faster
            // and skips namespaces whose interval hasn't elapsed).
            let due = {
                let workspaces = ctx
                    .db
                    .list_workspaces(Some(ns.name.as_str()))
                    .await
                    .unwrap_or_default();
                let now = jiff::Timestamp::now();
                let mut due = Vec::new();
                for row in workspaces {
                    if !row.state.observable() {
                        continue;
                    }
                    let last = ctx
                        .db
                        .list_captures(Some(&row.id), None)
                        .await
                        .ok()
                        .and_then(|c| c.first().map(|c| c.captured_at.clone()));
                    let elapsed = match last.and_then(|l| l.parse::<jiff::Timestamp>().ok()) {
                        Some(at) => now.as_second() - at.as_second(),
                        None => i64::MAX,
                    };
                    #[allow(clippy::cast_possible_wrap)]
                    if elapsed >= interval.as_secs() as i64 {
                        due.push(row);
                    }
                }
                due
            };
            for row in due {
                match crate::workspace::capture_workspace(&ctx, &ns, &row).await {
                    Ok(capture) if capture.torn => {
                        ctx.event(
                            "warn",
                            Some(row.namespace.as_str()),
                            Some(row.name.as_str()),
                            "capture",
                            "snapshot flagged torn (tree was moving)",
                        )
                        .await;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        tracing::warn!(workspace = %row.name, error = %e, "capture failed");
                    }
                }
            }

            // Shadow maintenance: explicit and daemon-owned, serialized
            // against capture by the same per-namespace lock.
            let due_maintenance = last_maintenance
                .get(ns.name.as_str())
                .is_none_or(|at| at.elapsed() >= maintenance);
            if due_maintenance {
                last_maintenance.insert(ns.name.to_string(), std::time::Instant::now());
                let _guard = ns.shadow_lock.lock().await;
                #[allow(clippy::cast_possible_wrap)]
                let cutoff = jiff::Timestamp::now()
                    .checked_sub(jiff::Span::new().seconds(retention.as_secs() as i64))
                    .unwrap_or_else(|_| jiff::Timestamp::now());
                match ns.shadow.prune_refs(cutoff).await {
                    Ok(pruned) if pruned > 0 => {
                        ctx.event(
                            "info",
                            Some(ns.name.as_str()),
                            None,
                            "shadow",
                            &format!("pruned {pruned} snapshot refs past retention"),
                        )
                        .await;
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!(error = %e, "shadow ref prune failed"),
                }
                if let Err(e) = ns.shadow.gc("2.weeks.ago").await {
                    tracing::warn!(error = %e, "shadow gc failed");
                }
                // Mirror maintenance rides the same schedule: repack keeping
                // existing packs; prune only when no live clone shares.
                if let Err(e) = ns.mirror.repack_keep().await {
                    tracing::warn!(error = %e, "mirror repack failed");
                }
                let live = ctx
                    .db
                    .count_live_workspaces(ns.name.as_str())
                    .await
                    .unwrap_or(i64::MAX);
                #[allow(clippy::cast_sign_loss)]
                let live = usize::try_from(live.max(0)).unwrap_or(usize::MAX);
                if let Err(e) = ns.mirror.prune_if_safe(live).await {
                    tracing::warn!(error = %e, "mirror prune failed");
                }
            }
        }
    }
}
