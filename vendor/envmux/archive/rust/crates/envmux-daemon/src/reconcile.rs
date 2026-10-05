//! Boot reconciliation (before the API opens): list by label, join against
//! SQLite. Adopt matches; labelled-but-unrecorded → flag orphan (event,
//! never auto-delete); recorded-but-gone → Lost. Observations need no stale
//! flag — staleness is derived from `observed_at` by every consumer.

use std::collections::HashSet;
use std::sync::Arc;

use envmux_core::{Role, WorkspaceState, labels as l};

use crate::context::Ctx;

pub async fn run(ctx: &Arc<Ctx>) -> anyhow::Result<()> {
    let containers = ctx.docker.list_containers(None).await?;

    let mut seen: HashSet<(String, String)> = HashSet::new(); // (namespace, workspace)
    for c in &containers {
        let Some(labels) = &c.labels else { continue };
        let Some(parsed) = envmux_core::Labels::from_map(labels) else {
            continue;
        };
        if parsed.role != Role::Workspace {
            continue;
        }
        let Some(ws) = parsed.workspace else { continue };
        let key = (parsed.namespace.to_string(), ws.to_string());
        let recorded = ctx
            .db
            .find_workspace(&key.0, &key.1)
            .await?
            .filter(|row| row.state != WorkspaceState::Reaped);
        if recorded.is_some() {
            seen.insert(key);
        } else {
            // Labelled container envmux does not recognise: orphan. Reported,
            // never auto-deleted.
            ctx.event(
                "warn",
                Some(&key.0),
                Some(&key.1),
                "reconcile",
                &format!(
                    "orphan container {} carries envmux labels but has no live record",
                    c.id.as_deref().unwrap_or("?")
                ),
            )
            .await;
        }
    }

    // Recorded workspaces whose containers vanished outside envmux → Lost.
    for row in ctx.db.list_workspaces(None).await? {
        if !row.state.reapable() {
            continue;
        }
        if !seen.contains(&(row.namespace.clone(), row.name.clone())) {
            ctx.db
                .transition_workspace(&row.id, WorkspaceState::Lost)
                .await
                .ok();
            ctx.event(
                "warn",
                Some(&row.namespace),
                Some(&row.name),
                "reconcile",
                "workspace container vanished outside envmux; marked lost",
            )
            .await;
        }
    }

    // Label constants referenced so schema drift breaks loudly here.
    let _ = (l::LABEL_SCHEMA, l::LABEL_NAMESPACE);
    Ok(())
}
