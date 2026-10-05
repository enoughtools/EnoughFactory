//! Disk usage via `system_df`, cached with a minimum refresh interval —
//! full disk accounting can take seconds on a large installation, so polling
//! is rate-limited here rather than trusted to every caller.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use envmux_core::labels as l;
use tokio::sync::Mutex;

use crate::{DockerError, DockerHandle};

/// One envmux-labelled volume's attributed usage.
#[derive(Debug, Clone)]
pub struct VolumeUsage {
    pub volume: String,
    pub bytes: u64,
    pub namespace: Option<String>,
    pub workspace: Option<String>,
    pub class: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DiskUsage {
    pub polled_at: jiff::Timestamp,
    /// Total bytes across all envmux volumes.
    pub total_bytes: u64,
    pub volumes: Vec<VolumeUsage>,
}

/// Cached `system_df` reader.
#[derive(Clone)]
pub struct DiskUsageCache {
    docker: DockerHandle,
    min_refresh: Duration,
    state: Arc<Mutex<Option<(Instant, DiskUsage)>>>,
}

impl DiskUsageCache {
    #[must_use]
    pub fn new(docker: DockerHandle, min_refresh: Duration) -> Self {
        Self {
            docker,
            min_refresh,
            state: Arc::new(Mutex::new(None)),
        }
    }

    /// Current usage, refreshed at most once per `min_refresh`.
    pub async fn get(&self) -> Result<DiskUsage, DockerError> {
        let mut state = self.state.lock().await;
        if let Some((at, cached)) = state.as_ref()
            && at.elapsed() < self.min_refresh
        {
            return Ok(cached.clone());
        }
        let fresh = self.poll().await?;
        *state = Some((Instant::now(), fresh.clone()));
        Ok(fresh)
    }

    async fn poll(&self) -> Result<DiskUsage, DockerError> {
        let df = self.docker.raw().df().await?;
        let mut volumes = Vec::new();
        let mut total = 0u64;
        for vol in df.volumes.unwrap_or_default() {
            let labels: HashMap<String, String> = vol.labels.clone();
            // Only envmux-labelled volumes are attributed; the daemon never
            // accounts for the world.
            if labels.get(l::LABEL_SCHEMA).map(String::as_str) != Some(l::LABEL_SCHEMA_VERSION) {
                continue;
            }
            #[allow(clippy::cast_sign_loss)] // Docker reports -1 for unknown, mapped to 0
            let bytes = vol
                .usage_data
                .as_ref()
                .map_or(0, |u| if u.size < 0 { 0 } else { u.size as u64 });
            total += bytes;
            volumes.push(VolumeUsage {
                volume: vol.name.clone(),
                bytes,
                namespace: labels.get(l::LABEL_NAMESPACE).cloned(),
                workspace: labels.get(l::LABEL_WORKSPACE).cloned(),
                class: labels.get(l::LABEL_CLASS).cloned(),
            });
        }
        volumes.sort_by_key(|v| std::cmp::Reverse(v.bytes));
        Ok(DiskUsage {
            polled_at: jiff::Timestamp::now(),
            total_bytes: total,
            volumes,
        })
    }
}
