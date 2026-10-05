//! Disk monitor: polls Docker usage through the rate-limited cache,
//! attributes by namespace/workspace/class, and raises a threshold alert
//! naming the largest contributors.

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::context::Ctx;

pub async fn run(ctx: Arc<Ctx>, cancel: CancellationToken) {
    let mut tick = super::jittered_interval(Duration::from_secs(300));
    let mut alerted = false;
    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            _ = tick.tick() => {}
        }
        let usage = match ctx.disk.get().await {
            Ok(u) => u,
            Err(e) => {
                tracing::debug!(error = %e, "disk usage poll failed");
                continue;
            }
        };
        let Some(disk_total) = total_disk_bytes(&ctx.state_dir) else {
            continue;
        };
        let percent = (usage.total_bytes as f64 / disk_total as f64) * 100.0;
        let over = percent >= f64::from(ctx.disk_threshold_percent);
        if over && !alerted {
            alerted = true;
            let top: Vec<String> = usage
                .volumes
                .iter()
                .take(3)
                .map(|v| format!("{} ({} MiB)", v.volume, v.bytes / (1024 * 1024)))
                .collect();
            ctx.event(
                "warn",
                None,
                None,
                "disk",
                &format!(
                    "envmux volumes use {:.1}% of disk (threshold {}%); largest: {}",
                    percent,
                    ctx.disk_threshold_percent,
                    top.join(", ")
                ),
            )
            .await;
        } else if !over {
            alerted = false;
        }
    }
}

/// Total size of the disk backing the state dir (a proxy for the Docker data
/// disk on single-disk dev machines). `None` disables alerting rather than
/// lying.
fn total_disk_bytes(state_dir: &std::path::Path) -> Option<u64> {
    fs4::total_space(state_dir).ok()
}
