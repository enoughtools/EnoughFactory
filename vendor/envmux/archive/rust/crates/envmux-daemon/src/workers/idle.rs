//! The dead-man switch that makes the v2 daemon ephemeral.
//!
//! The daemon is forked and disowned by `envmux`, so nothing supervises it.
//! Instead it supervises itself: every IPC request and every live attach
//! counts as a client, and once the last client has been gone for the grace
//! period, the daemon reaps its workspaces, stops the namespace's containers,
//! and exits. Closing the last envmux instance *is* the shutdown command —
//! it just takes `grace` to land, so a TUI restart or an `envmux manage`
//! from a second terminal reattaches to a world still running.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::context::Ctx;

/// Client liveness, updated by the IPC layer.
///
/// `attached` counts in-flight requests and open attach streams, so a long
/// `docker build` inside one POST cannot be mistaken for an idle daemon.
/// `last` is the instant the count last touched zero territory — the grace
/// clock starts there, not at the request's start.
pub struct Activity {
    last: std::sync::Mutex<Instant>,
    attached: AtomicUsize,
}

impl Default for Activity {
    fn default() -> Self {
        Self {
            // Boot counts as activity: a daemon nobody ever connects to
            // should still die after one grace period, not immediately.
            last: std::sync::Mutex::new(Instant::now()),
            attached: AtomicUsize::new(0),
        }
    }
}

impl Activity {
    fn touch(&self) {
        *self.last.lock().expect("activity clock") = Instant::now();
    }

    /// Count a client for as long as the returned guard lives.
    pub fn client(self: &Arc<Self>) -> ClientGuard {
        self.attached.fetch_add(1, Ordering::SeqCst);
        self.touch();
        ClientGuard(Arc::clone(self))
    }

    /// Restart the grace clock without holding a client. Boot calls this
    /// once rehydration finishes: time spent becoming reachable must not
    /// count against the grace period.
    pub fn mark_active(&self) {
        self.touch();
    }

    /// How long the daemon has been without any client. Zero while one is
    /// connected.
    pub fn idle_for(&self) -> Duration {
        if self.attached.load(Ordering::SeqCst) > 0 {
            return Duration::ZERO;
        }
        self.last.lock().expect("activity clock").elapsed()
    }
}

/// Decrements the client count and restarts the grace clock on drop.
pub struct ClientGuard(Arc<Activity>);

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.0.touch();
        self.0.attached.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Watch for the grace period to elapse, then take everything down.
pub async fn run(ctx: Arc<Ctx>, grace: Duration, cancel: CancellationToken) {
    let mut interval = super::jittered_interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            _ = interval.tick() => {}
        }
        let idle = ctx.activity.idle_for();
        if idle < grace {
            continue;
        }
        tracing::info!(
            idle_secs = idle.as_secs(),
            grace_secs = grace.as_secs(),
            "no clients within grace; closing containers and exiting"
        );
        shutdown_world(&ctx).await;
        cancel.cancel();
        return;
    }
}

/// Reap every live workspace, then stop the namespace's own containers.
///
/// Reaping first matters: it is the path that still captures a final shadow
/// snapshot and deprovisions service slices, so work done in a container that
/// is about to die has already been pushed to the shadow remote by the time
/// the container goes. Also the explicit-shutdown path (`envmux down`).
pub(crate) async fn shutdown_world(ctx: &Arc<Ctx>) {
    let namespaces: Vec<_> = ctx.namespaces.read().await.values().cloned().collect();
    for ns in namespaces {
        let workspaces = match ctx.db.list_workspaces(Some(ns.name.as_str())).await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(namespace = %ns.name, error = %e, "listing workspaces for shutdown");
                continue;
            }
        };
        for row in workspaces {
            if matches!(
                row.state,
                envmux_core::WorkspaceState::Reaped | envmux_core::WorkspaceState::Lost
            ) {
                continue;
            }
            if let Err(e) = crate::workspace::reap_now(ctx, &ns, &row.id).await {
                tracing::warn!(workspace = row.name, error = %e, "reap during shutdown failed");
            }
        }

        // The namespace's own containers: base, then services. Stopped, not
        // removed — the next session's register adopts them by name, and
        // `envmux prune` sweeps the ones no session ever comes back for.
        let mut names = vec![ns.base_container_name()];
        {
            let resolved = ns.resolved.read().await;
            names.extend(
                resolved
                    .config
                    .services
                    .keys()
                    .map(|svc| ns.service_container_name(svc)),
            );
        }
        for name in names {
            if let Err(e) = ctx.docker.stop_container(&name, 10).await {
                tracing::debug!(container = name, error = %e, "stop during shutdown (absent?)");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_client_pins_idle_at_zero() {
        let activity = Arc::new(Activity::default());
        let guard = activity.client();
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(activity.idle_for(), Duration::ZERO);
        drop(guard);
        // The clock starts when the last client leaves, not when it arrived.
        assert!(activity.idle_for() < Duration::from_millis(500));
    }

    #[test]
    fn overlapping_clients_only_release_with_the_last_one() {
        let activity = Arc::new(Activity::default());
        let first = activity.client();
        let second = activity.client();
        drop(first);
        assert_eq!(activity.idle_for(), Duration::ZERO, "one client remains");
        drop(second);
        std::thread::sleep(Duration::from_millis(10));
        assert!(activity.idle_for() > Duration::ZERO);
    }
}
