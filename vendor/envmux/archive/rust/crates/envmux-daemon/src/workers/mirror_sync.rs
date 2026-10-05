//! Mirror sync: periodic fetch per namespace (when configured periodic),
//! serialized per namespace by the mirror lock.

use std::sync::Arc;
use std::time::Duration;

use envmux_config::FetchMode;
use tokio_util::sync::CancellationToken;

use crate::context::Ctx;

pub async fn run(ctx: Arc<Ctx>, cancel: CancellationToken) {
    let mut tick = super::jittered_interval(Duration::from_secs(60));
    let mut last_fetch: std::collections::HashMap<String, std::time::Instant> =
        std::collections::HashMap::new();
    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            _ = tick.tick() => {}
        }
        let namespaces: Vec<_> = ctx.namespaces.read().await.values().cloned().collect();
        for ns in namespaces {
            let resolved = ns.resolved.read().await;
            if resolved.config.mirror.fetch != FetchMode::Periodic {
                continue;
            }
            let interval = resolved.config.mirror.interval.as_std();
            drop(resolved);
            let due = last_fetch
                .get(ns.name.as_str())
                .is_none_or(|at| at.elapsed() >= interval);
            if !due {
                continue;
            }
            last_fetch.insert(ns.name.to_string(), std::time::Instant::now());
            let _guard = ns.mirror_lock.lock().await;
            match ns.mirror.fetch().await {
                Ok(()) => {
                    let _ = ctx.db.touch_mirror_fetch(ns.name.as_str()).await;
                }
                Err(e) => {
                    tracing::warn!(namespace = %ns.name, error = %e, "mirror fetch failed");
                }
            }
        }
    }
}
