//! Workspace lifecycle: creation (clone → provision → secrets → task graph)
//! and the idempotent reap sequence (final capture → deprovision → destroy).

use std::sync::Arc;

use anyhow::{Context as _, bail};
use envmux_api_types::CreateWorkspaceRequest;
use envmux_core::{Labels, ReapStep, Role, VolumeClass, WorkspaceState};
use envmux_docker::{ContainerSpec, VolumeMountSpec};
use envmux_git::scripts;
use uuid::Uuid;

use crate::context::{Ctx, NamespaceCtx};
use crate::namespace::{MIRROR_MOUNT, SHADOW_MOUNT, service_kind};
use crate::state::{CaptureRow, SliceRow, WorkspaceRow, new_workspace_row};

/// Secrets land here as files, mode 0400 — never as environment variables.
pub const SECRETS_DIR: &str = "/run/envmux/secrets";

/// Create (or reuse) a workspace. Returns the row and whether it was reused.
pub async fn create(
    ctx: &Arc<Ctx>,
    ns: &Arc<NamespaceCtx>,
    req: &CreateWorkspaceRequest,
) -> anyhow::Result<(WorkspaceRow, bool)> {
    let resolved = ns.resolved.read().await.clone();
    let cfg = &resolved.config;

    // Reuse: naming a workspace that still exists reuses it.
    if let Some(name) = &req.name {
        if let Some(existing) = ctx.db.find_workspace(ns.name.as_str(), name).await? {
            if existing.state.reapable() {
                return Ok((existing, true));
            }
        }
    }

    let live = ctx.db.count_live_workspaces(ns.name.as_str()).await?;
    if live >= i64::from(cfg.lease.max_workspaces) {
        bail!(
            "namespace {} is at its max of {} concurrent workspaces",
            ns.name,
            cfg.lease.max_workspaces
        );
    }

    let branch = req.branch.clone().unwrap_or_else(|| "main".to_owned());

    // On-demand fetch when the requested ref is unknown to the mirror.
    if !ns.mirror.has_ref(&branch).await? {
        let _guard = ns.mirror_lock.lock().await;
        ns.mirror.fetch().await.context("on-demand mirror fetch")?;
        ctx.db.touch_mirror_fetch(ns.name.as_str()).await?;
        if !ns.mirror.has_ref(&branch).await? {
            bail!("branch {branch:?} does not exist on the mirror after fetch");
        }
    }

    // Name: requested, or generated per strategy, retried on collision.
    let name = match &req.name {
        Some(n) => {
            envmux_core::WorkspaceName::new(n.clone()).map_err(|e| anyhow::anyhow!("{e}"))?
        }
        None => loop {
            let candidate = crate::naming::generate(cfg.workspace.naming, &branch);
            if ctx
                .db
                .find_workspace(ns.name.as_str(), candidate.as_str())
                .await?
                .is_none()
            {
                break candidate;
            }
        },
    };

    // The row freezes the resolved TOML and its hash: a workspace is a
    // product of the file it was created from, never upgraded in place.
    #[allow(clippy::cast_possible_wrap)]
    let row = new_workspace_row(
        ns.name.as_str(),
        name.as_str(),
        &branch,
        resolved.hash.as_str(),
        &resolved.text,
        cfg.lease.initial.as_secs() as i64,
    );
    ctx.db.insert_workspace(&row).await?;
    ctx.event(
        "info",
        Some(ns.name.as_str()),
        Some(name.as_str()),
        "workspace",
        "creating",
    )
    .await;

    match provision(ctx, ns, &row, &resolved).await {
        Ok(container_id) => {
            ctx.db
                .set_workspace_container(&row.id, &container_id)
                .await?;
            // The task graph runs to Ready in the background; creation
            // returns as soon as the workspace is provisioned.
            let ctx2 = Arc::clone(ctx);
            let ns2 = Arc::clone(ns);
            let row2 = ctx
                .db
                .get_workspace(&row.id)
                .await?
                .context("row vanished")?;
            // The graph outlives the create request that started it, and an
            // unattended daemon must not grace-out under a workspace it is
            // still building. The guard is handed to run_graph, which drops
            // it at Ready — NOT held for the graph's whole life, because
            // after Ready the graph becomes the long-running supervision
            // loop, and a supervision loop that counts as a client would
            // make the daemon immortal. (The TUI's polling hides all of
            // this; a bare `envmux create` does not.)
            let busy = ctx.activity.client();
            tokio::spawn(async move {
                if let Err(e) =
                    crate::tasks_engine::run_graph(&ctx2, &ns2, &row2, &resolved.config, busy).await
                {
                    tracing::warn!(workspace = %row2.name, error = %e, "task graph failed");
                    ctx2.event(
                        "warn",
                        Some(row2.namespace.as_str()),
                        Some(row2.name.as_str()),
                        "tasks",
                        &format!("task graph failed: {e}"),
                    )
                    .await;
                }
            });
            let row = ctx
                .db
                .get_workspace(&row.id)
                .await?
                .context("row vanished")?;
            Ok((row, false))
        }
        Err(e) => {
            // Roll back best-effort and record the failure.
            ctx.event(
                "error",
                Some(ns.name.as_str()),
                Some(name.as_str()),
                "workspace",
                &format!("creation failed: {e}"),
            )
            .await;
            let _ = reap_now(ctx, ns, &row.id).await;
            Err(e)
        }
    }
}

/// Provisioning: volume, container, clone, slices, secrets. Returns the
/// container id.
async fn provision(
    ctx: &Arc<Ctx>,
    ns: &Arc<NamespaceCtx>,
    row: &WorkspaceRow,
    resolved: &envmux_config::ResolvedConfig,
) -> anyhow::Result<String> {
    let cfg = &resolved.config;
    let ws_name =
        envmux_core::WorkspaceName::new(row.name.clone()).map_err(|e| anyhow::anyhow!("{e}"))?;

    // Source volume.
    let src_volume = ns.source_volume_name(&row.name);
    ctx.docker
        .create_volume(envmux_docker::VolumeSpec {
            name: src_volume.clone(),
            labels: Labels::new(ns.name.clone(), Role::Workspace)
                .workspace(ws_name.clone())
                .class(VolumeClass::Source),
        })
        .await?;

    // Container: one per workspace; all tasks are tmux windows inside it.
    let container_name = ns.workspace_container_name(&row.name);
    let mut spec = ContainerSpec::new(
        container_name.clone(),
        ns.image.clone(),
        Labels::new(ns.name.clone(), Role::Workspace)
            .workspace(ws_name.clone())
            .config_hash(
                row.config_hash
                    .parse()
                    .map_err(|e| anyhow::anyhow!("{e}"))?,
            ),
    );
    spec.network = Some(ns.network_name());
    spec.network_aliases = vec![row.name.clone()];
    spec.init_idle = true;
    spec.user = cfg.workspace.user.clone();
    #[allow(clippy::cast_possible_truncation)]
    {
        spec.nano_cpus = cfg.workspace.cpus.map(|c| (c * 1e9) as i64);
    }
    // Absent, or an explicit 0, means no limit: the workspace gets whatever
    // the host will give it.
    spec.memory_bytes = cfg
        .workspace
        .memory
        .filter(|m| !m.is_zero())
        .map(envmux_config::ByteSize::as_i64);
    spec.mounts = vec![
        VolumeMountSpec::volume(&src_volume, cfg.workspace.workdir.clone(), false),
        VolumeMountSpec::bind(ns.mirror.dir.display().to_string(), MIRROR_MOUNT, true),
        VolumeMountSpec::bind(ns.shadow.dir.display().to_string(), SHADOW_MOUNT, false),
    ];
    if cfg.workspace.dangerously_mount_docker_socket {
        #[cfg(unix)]
        spec.mounts.push(VolumeMountSpec::bind(
            "/var/run/docker.sock",
            "/var/run/docker.sock",
            false,
        ));
        #[cfg(windows)]
        anyhow::bail!(
            "workspace.dangerously_mount_docker_socket is supported only by a native Linux Docker host"
        );
    }
    spec.privileged = cfg.workspace.dangerously_enable_dind;
    // Publish every `[routes]` container port to 127.0.0.1 with an ephemeral
    // host port — the same mechanism service admin endpoints use — so the
    // in-session router can reach the workspace's routes.
    let mut route_ports: Vec<u16> = cfg.routes.values().copied().collect();
    route_ports.sort_unstable();
    route_ports.dedup();
    spec.loopback_ports = route_ports;
    // Named cache/tools/sync volumes. Copy-on-start volumes are seeded from
    // the stable namespace volume using a temporary read-only mount in the
    // workspace itself; this works on Docker Desktop as well as native Linux.
    let mut copy_seeds = Vec::new();
    for (vol_name, decl) in &cfg.volumes.named {
        if decl.mode == envmux_config::VolumeMode::Off {
            continue;
        }
        let class = match decl.class {
            envmux_config::VolumeClassName::Cache => VolumeClass::Cache,
            envmux_config::VolumeClassName::Tools => VolumeClass::Tools,
            envmux_config::VolumeClassName::Sync => VolumeClass::Sync,
        };
        let physical = match decl.mode {
            // Shared: one namespace-scoped volume for every workspace.
            envmux_config::VolumeMode::Shared => format!("envmux-{}-{vol_name}", ns.name),
            // Copy-on-start: per-workspace copy that diverges harmlessly and
            // is reaped with the workspace.
            envmux_config::VolumeMode::CopyOnStart => {
                let seed = format!("envmux-{}-{vol_name}", ns.name);
                ctx.docker
                    .create_volume(envmux_docker::VolumeSpec {
                        name: seed.clone(),
                        labels: Labels::new(ns.name.clone(), Role::Workspace).class(class),
                    })
                    .await?;
                let seed_path = format!("/run/envmux/copy-seed/{vol_name}");
                copy_seeds.push((seed_path.clone(), decl.path.clone()));
                spec.mounts
                    .push(VolumeMountSpec::volume(seed, seed_path, true));
                format!("envmux-{}-{vol_name}-{}", ns.name, row.name)
            }
            envmux_config::VolumeMode::Off => unreachable!(),
        };
        let mut labels = Labels::new(ns.name.clone(), Role::Workspace).class(class);
        if decl.mode == envmux_config::VolumeMode::CopyOnStart {
            labels = labels.workspace(ws_name.clone());
        }
        ctx.docker
            .create_volume(envmux_docker::VolumeSpec {
                name: physical.clone(),
                labels,
            })
            .await?;
        let read_only = decl.class == envmux_config::VolumeClassName::Tools;
        spec.mounts.push(VolumeMountSpec::volume(
            physical,
            decl.path.clone(),
            read_only,
        ));
    }

    let container_id = ctx.docker.create_container(spec).await?;
    ctx.docker.start_container(&container_name).await?;

    for (seed, target) in copy_seeds {
        let out = ctx
            .docker
            .run_exec(
                &container_name,
                vec![
                    "sh".into(),
                    "-c".into(),
                    "cp -a -- \"$ENVMUX_SEED/.\" \"$ENVMUX_TARGET/\"".into(),
                ],
                Some("root"),
                None,
                vec![
                    format!("ENVMUX_SEED={seed}"),
                    format!("ENVMUX_TARGET={target}"),
                ],
                None,
            )
            .await?;
        if !out.success() {
            bail!(
                "copy-on-start seed failed for {target}: {}",
                out.stderr.trim()
            );
        }
    }

    // The mirror and the shadow origin are host directories bind-mounted in,
    // so they are owned by the host user while git in here is somebody else.
    // Marked once, before anything reaches for them, so the clone, the shadow
    // push, and the user's own git inside the workspace all agree about it.
    crate::namespace::mark_mounts_safe(ctx, &container_name, &[MIRROR_MOUNT, SHADOW_MOUNT]).await?;

    // Clone from the mirror with shared objects (or full, per config).
    let strategy = match cfg.volumes.clone {
        envmux_config::CloneStrategy::Shared => "shared",
        envmux_config::CloneStrategy::Full => "full",
    };
    // The real remote, not the mirror's clone source: the source is a host
    // path in v2, and an origin pointing at it would be unreachable (and
    // meaningless) from inside the container.
    let remote = ns.origin_remote.clone();
    let clone_params = scripts::CloneParams {
        strategy,
        mirror_path: MIRROR_MOUNT.to_owned(),
        branch: row.branch_requested.clone(),
        workdir: cfg.workspace.workdir.clone(),
        remote_url: remote,
    };
    let out = ctx
        .docker
        .run_exec(
            &container_name,
            vec!["sh".into(), "-c".into(), scripts::CLONE_SCRIPT.to_owned()],
            None,
            None,
            clone_params.to_env(),
            None,
        )
        .await?;
    if !out.success() {
        bail!("workspace clone failed: {}", out.stderr.trim());
    }

    // The credential shim: install the in-container agent and start its
    // bridge to the host's credential manager. Best-effort by design — a
    // workspace without it is merely a workspace where `git push` asks the
    // image for credentials, exactly as before.
    crate::agent_bridge::start(ctx, ns, &container_name, ws_name.as_str()).await;

    // Run dir for task exit files.
    ctx.docker
        .run_exec(
            &container_name,
            envmux_tmux::client::ensure_run_dir_cmd(),
            Some("root"),
            None,
            vec![],
            None,
        )
        .await?;

    // Provision slices and deliver scoped credentials as secret files.
    for (svc_name, svc) in &cfg.services {
        if !svc.provision {
            continue;
        }
        let kind = service_kind(ctx, ns, svc_name).await?;
        let ws_ref = envmux_services::WorkspaceRef {
            name: ws_name.clone(),
        };
        let health_deadline = tokio::time::Instant::now() + svc.provision_timeout.as_std();
        loop {
            if matches!(kind.health().await, Ok(envmux_services::Health::Healthy)) {
                break;
            }
            if tokio::time::Instant::now() >= health_deadline {
                bail!(
                    "service {svc_name} did not become healthy within {}",
                    svc.provision_timeout
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        let provisioned =
            tokio::time::timeout(svc.provision_timeout.as_std(), kind.provision(&ws_ref))
                .await
                .map_err(|_| {
                    anyhow::anyhow!(
                        "provisioning slice of {svc_name} timed out after {}",
                        svc.provision_timeout
                    )
                });
        match provisioned.and_then(|r| r.map_err(|e| anyhow::anyhow!(e))) {
            Ok(creds) => {
                ctx.db
                    .insert_slice(&SliceRow {
                        id: Uuid::now_v7().to_string(),
                        workspace_id: row.id.clone(),
                        service: svc_name.clone(),
                        slice_key: creds.slice_key.to_string(),
                        state: "provisioned".to_owned(),
                        created_at: jiff::Timestamp::now().to_string(),
                        deprovisioned_at: None,
                        last_error: None,
                    })
                    .await?;
                let files: Vec<(String, Vec<u8>, u32)> = creds
                    .files
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone().into_bytes(), 0o400))
                    .collect();
                let dir = format!("{SECRETS_DIR}/{svc_name}");
                ctx.docker.write_files(&container_name, &dir, files).await?;
                // The tar arrives owned by root at mode 0400, and the tasks
                // that read it run as `[workspace] user` — non-root in the
                // default image. Hand the directory to whoever those tasks
                // are, keeping 0400: readable by its owner and nobody else,
                // which is the property that mattered in the first place.
                give_to_workspace_user(ctx, &container_name, &dir).await?;
            }
            Err(e) => {
                ctx.db
                    .insert_slice(&SliceRow {
                        id: Uuid::now_v7().to_string(),
                        workspace_id: row.id.clone(),
                        service: svc_name.clone(),
                        slice_key: envmux_services::slice_ident(&ws_name),
                        state: "failed".to_owned(),
                        created_at: jiff::Timestamp::now().to_string(),
                        deprovisioned_at: None,
                        last_error: Some(e.to_string()),
                    })
                    .await?;
                bail!("provisioning slice of {svc_name}: {e}");
            }
        }
    }

    // User-declared secrets from the helper chain, same delivery path as
    // daemon-minted ones — a task never distinguishes the two.
    for (secret_name, decl) in &cfg.secrets {
        let key = envmux_secrets::SecretKey::new(ns.name.clone(), secret_name.clone());
        let secrets = Arc::clone(&ctx.secrets);
        let value = tokio::task::spawn_blocking(move || secrets.get(&key)).await??;
        let dest = decl
            .mount
            .clone()
            .unwrap_or_else(|| format!("{SECRETS_DIR}/{secret_name}"));
        let (dir, file) = match dest.rsplit_once('/') {
            Some((d, f)) if !d.is_empty() => (d.to_owned(), f.to_owned()),
            _ => (SECRETS_DIR.to_owned(), dest),
        };
        let path = format!("{dir}/{file}");
        ctx.docker
            .write_files(
                &container_name,
                &dir,
                vec![(file, value.as_bytes().to_vec(), 0o400)],
            )
            .await?;
        // The file, not its directory: `mount` can name any path, and handing
        // a system directory to the workspace user because a secret was
        // mounted inside it would be a far larger change than was asked for.
        give_to_workspace_user(ctx, &container_name, &path).await?;
    }

    Ok(container_id)
}

/// Give `path` and everything under it to whoever the workspace's processes
/// are, leaving modes alone.
///
/// The daemon cannot name that user from configuration: `[workspace] user`
/// may be absent, in which case it is whatever the image's own `USER` says —
/// non-root in the images envmux ships. So it asks the container, by running
/// `id` in an exec with no user override, which is precisely the identity
/// tasks run under.
async fn give_to_workspace_user(ctx: &Ctx, container: &str, path: &str) -> anyhow::Result<()> {
    let who = ctx
        .docker
        .run_exec(
            container,
            vec![
                "sh".into(),
                "-c".into(),
                "printf '%s:%s' \"$(id -u)\" \"$(id -g)\"".into(),
            ],
            None,
            None,
            vec![],
            None,
        )
        .await?;
    if !who.success() {
        bail!(
            "could not identify the workspace user: {}",
            who.stderr.trim()
        );
    }
    let owner = who.stdout.trim().to_owned();
    let out = ctx
        .docker
        .run_exec(
            container,
            vec!["chown".into(), "-R".into(), owner.clone(), path.to_owned()],
            Some("root"),
            None,
            vec![],
            None,
        )
        .await?;
    if !out.success() {
        bail!("could not give {path} to {owner}: {}", out.stderr.trim());
    }
    Ok(())
}

/// One capture, shared by the capture worker and the reaper's final capture.
pub async fn capture_workspace(
    ctx: &Ctx,
    ns: &NamespaceCtx,
    row: &WorkspaceRow,
) -> anyhow::Result<CaptureRow> {
    let container = ns.workspace_container_name(&row.name);
    let resolved = ns.resolved.read().await;
    let workdir = resolved.config.workspace.workdir.clone();
    drop(resolved);

    let ts = jiff::Timestamp::now();
    let ts_safe = scripts::ref_safe_timestamp(&ts);
    let _guard = ns.shadow_lock.lock().await;
    let prev = ns.shadow.tip(&row.name).await.unwrap_or(None);
    let env = vec![
        format!("ENVMUX_WORKDIR={workdir}"),
        format!("ENVMUX_SHADOW={SHADOW_MOUNT}"),
        format!("ENVMUX_WS={}", row.name),
        format!("ENVMUX_TS={ts}"),
        format!("ENVMUX_TS_SAFE={ts_safe}"),
        format!("ENVMUX_PREV={}", prev.unwrap_or_default()),
    ];
    let out = ctx
        .docker
        .run_exec(
            &container,
            vec!["sh".into(), "-c".into(), scripts::CAPTURE_SCRIPT.to_owned()],
            None,
            None,
            env,
            None,
        )
        .await?;
    if !out.success() {
        bail!(
            "capture script exited {}: {}",
            out.exit_code,
            out.stderr.trim()
        );
    }
    let outcome = scripts::parse_capture_output(&out.stdout).map_err(|e| anyhow::anyhow!("{e}"))?;
    let capture = CaptureRow {
        id: Uuid::now_v7().to_string(),
        workspace_id: row.id.clone(),
        captured_at: ts.to_string(),
        branch: outcome.branch.clone(),
        shadow_ref: outcome.snap_ref.clone(),
        commit_oid: outcome.commit.clone(),
        torn: outcome.torn,
        flagged_state: outcome.flagged.clone(),
    };
    ctx.db.insert_capture(&capture).await?;
    Ok(capture)
}

/// The idempotent reap sequence, resumable at the persisted step:
/// capture → deprovision → destroy → Reaped.
pub async fn reap_now(
    ctx: &Arc<Ctx>,
    ns: &Arc<NamespaceCtx>,
    workspace_id: &str,
) -> anyhow::Result<()> {
    let row = ctx
        .db
        .get_workspace(workspace_id)
        .await?
        .context("workspace not found")?;
    if row.state == WorkspaceState::Reaped {
        return Ok(());
    }
    if row.state != WorkspaceState::Reaping {
        ctx.db
            .transition_workspace(&row.id, WorkspaceState::Reaping)
            .await?;
    }
    let start_step = row.reap_step.unwrap_or(ReapStep::Capture);

    let mut step = Some(start_step);
    while let Some(current) = step {
        ctx.db.set_reap_step(&row.id, current).await?;
        match current {
            ReapStep::Capture => {
                // Final capture closes the scheduled-interval blast radius;
                // failure is logged and the reap continues.
                if let Err(e) = capture_workspace(ctx, ns, &row).await {
                    ctx.event(
                        "warn",
                        Some(row.namespace.as_str()),
                        Some(row.name.as_str()),
                        "reaper",
                        &format!("final capture failed: {e}"),
                    )
                    .await;
                }
            }
            ReapStep::Deprovision => {
                // The daemon — not a task inside a dying container — performs
                // deprovisioning; failures are recorded against the service.
                for slice in ctx.db.list_slices(Some(&row.id)).await? {
                    if slice.state != "provisioned" {
                        continue;
                    }
                    let timeout = ns
                        .resolved
                        .read()
                        .await
                        .config
                        .services
                        .get(&slice.service)
                        .map_or(std::time::Duration::from_secs(120), |s| {
                            s.provision_timeout.as_std()
                        });
                    let outcome = match service_kind(ctx, ns, &slice.service).await {
                        Ok(kind) => {
                            let key = envmux_core::SliceKey::new(slice.slice_key.clone())
                                .map_err(|e| anyhow::anyhow!("{e}"));
                            match key {
                                Ok(key) => {
                                    match tokio::time::timeout(timeout, kind.deprovision(&key))
                                        .await
                                    {
                                        Ok(result) => result.map_err(|e| e.to_string()),
                                        Err(_) => {
                                            Err(format!("deprovision timed out after {timeout:?}"))
                                        }
                                    }
                                }
                                Err(e) => Err(e.to_string()),
                            }
                        }
                        Err(e) => Err(e.to_string()),
                    };
                    match outcome {
                        Ok(()) => {
                            ctx.db
                                .set_slice_state(&slice.id, "deprovisioned", None)
                                .await?;
                        }
                        Err(e) => {
                            ctx.db
                                .set_slice_state(&slice.id, "failed", Some(&e))
                                .await?;
                            ctx.event(
                                "warn",
                                Some(row.namespace.as_str()),
                                Some(row.name.as_str()),
                                "provisioner",
                                &format!("deprovision {} failed: {e}", slice.service),
                            )
                            .await;
                        }
                    }
                }
            }
            ReapStep::Destroy => {
                let container = ns.workspace_container_name(&row.name);
                ctx.docker.stop_container(&container, 10).await.ok();
                ctx.docker.remove_container(&container).await?;
                // Per-workspace volumes: source + copy-on-start copies.
                for vol in ctx.docker.list_volumes(Some(&ns.name)).await? {
                    let is_ours = vol
                        .labels
                        .get(envmux_core::labels::LABEL_WORKSPACE)
                        .is_some_and(|w| w == &row.name);
                    if is_ours {
                        ctx.docker.remove_volume(&vol.name).await.ok();
                    }
                }
            }
        }
        step = current.next();
    }

    ctx.db
        .transition_workspace(&row.id, WorkspaceState::Reaped)
        .await?;
    ctx.task_status.remove(&row.id);
    ctx.event(
        "info",
        Some(row.namespace.as_str()),
        Some(row.name.as_str()),
        "reaper",
        "reaped",
    )
    .await;
    Ok(())
}
