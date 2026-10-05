//! Namespace bootstrap: network, mirror, shadow origin, image, shared
//! services, and the base container — everything that exists once per
//! project.

use std::sync::Arc;

use anyhow::{Context as _, bail};
use envmux_config::{FetchMode, ResolvedConfig, resolve_dir};
use envmux_core::{Labels, NamespaceName, Role, VolumeClass};
use envmux_docker::{ContainerSpec, NetworkSpec, VolumeMountSpec};
use envmux_git::{Mirror, ShadowRepo};
use envmux_secrets::{SecretKey, SecretValue};
use envmux_services::{Minio, Postgres, Redis, ServiceKind};
use tokio::sync::RwLock;

use crate::context::{Ctx, NamespaceCtx};

/// In-container mount points for the namespace git repositories.
pub const MIRROR_MOUNT: &str = "/mirror";
pub const SHADOW_MOUNT: &str = "/shadow";

/// Tell git in `container` that the given bind-mounted repositories are not a
/// stranger's, so it will read them despite the uid on them not being its own.
///
/// Two details, both learned the hard way and neither obvious:
///
/// - **System scope, not global.** `--global` writes the config of whichever
///   user runs it, and the user that runs the clone afterwards is not
///   necessarily that user — `[workspace] user` can make it anything. The
///   system file covers every user in the container, which is what a mount
///   belonging to the whole container deserves.
/// - **Not `git -c`.** Git only honours `safe.directory` from protected
///   configuration, and a value passed on the command line is not that. `-c`
///   is accepted in silence and changes nothing, which reads exactly like the
///   fix not being applied at all.
pub async fn mark_mounts_safe(ctx: &Ctx, container: &str, mounts: &[&str]) -> anyhow::Result<()> {
    let script = mounts
        .iter()
        .map(|mount| format!("git config --system --add safe.directory {mount}"))
        .collect::<Vec<_>>()
        .join(" && ");
    let out = ctx
        .docker
        .run_exec(
            container,
            vec!["sh".into(), "-c".into(), script],
            Some("root"),
            None,
            vec![],
            None,
        )
        .await?;
    if !out.success() {
        bail!(
            "could not mark the mounted repositories safe: {}",
            out.stderr.trim()
        );
    }
    Ok(())
}

/// Register (or re-adopt) a namespace from a host repository directory:
/// resolve config, set up network + mirror + shadow + image + services +
/// base container, and store the runtime context.
pub async fn register(
    ctx: &Arc<Ctx>,
    repo_dir: &std::path::Path,
) -> anyhow::Result<Arc<NamespaceCtx>> {
    // Strictly one registration at a time: IPC opens before boot rehydration,
    // so a client's register can arrive while rehydration is building the
    // same namespace. Serialized, the loser of the race takes the fast
    // adopt-existing path below instead of double-building.
    let _serialize = ctx.register_lock.lock().await;
    let resolved = resolve_dir(repo_dir).map_err(|e| anyhow::anyhow!("{e}"))?;

    let ns_name = match &resolved.config.meta.namespace {
        Some(ns) => ns.clone(),
        None => repo_dir
            .file_name()
            .map(|s| s.to_string_lossy().to_lowercase().replace([' ', '.'], "-"))
            .context("repository directory has no name")?,
    };
    let name = NamespaceName::new(ns_name).map_err(|e| anyhow::anyhow!("{e}"))?;

    if let Some(existing) = ctx.namespace(name.as_str()).await {
        // Re-registration refreshes the resolved config; everything else is
        // adopted as-is (workspaces are never upgraded in place).
        *existing.resolved.write().await = resolved;
        return Ok(existing);
    }

    let fetch_mode = match resolved.config.mirror.fetch {
        FetchMode::Periodic => "periodic",
        FetchMode::OnDemand => "on-demand",
    };

    // Two remotes with two jobs. The *origin* (declared, or detected from
    // the repository) is what workspaces push to and what the credential
    // shim allowlists. The *mirror source* is where workspace clones come
    // from — and in v2 that is the local repository itself: `envmux` runs in
    // a directory, and the branch you are on is the branch you mean, pushed
    // or not. Cloning from the forge instead silently hands workspaces a
    // stale default branch whenever local work has not been pushed.
    let remote = match &resolved.config.mirror.remote {
        Some(r) => r.clone(),
        None => ctx
            .git
            .run(repo_dir, &["remote", "get-url", "origin"])
            .await
            .map(|s| s.trim().to_owned())
            .unwrap_or_else(|_| repo_dir.display().to_string()),
    };
    // A declared [mirror] remote still overrides the source — it is an
    // explicit instruction to clone from somewhere else.
    let mirror_source = match &resolved.config.mirror.remote {
        Some(r) => r.clone(),
        None => repo_dir.display().to_string(),
    };

    ctx.db
        .upsert_namespace(
            name.as_str(),
            Some(&remote),
            &repo_dir.to_string_lossy(),
            fetch_mode,
        )
        .await?;

    // Network.
    let networks = ctx.docker.list_networks(Some(&name)).await?;
    let net_name = format!("envmux-{name}");
    if !networks
        .iter()
        .any(|n| n.name.as_deref() == Some(net_name.as_str()))
    {
        ctx.docker
            .create_network(NetworkSpec {
                name: net_name.clone(),
                labels: Labels::new(name.clone(), Role::Orchestrator),
            })
            .await?;
    }

    // Mirror + shadow on the host filesystem (bind-mounted into containers).
    let mirror = Mirror::new(ctx.mirror_dir(name.as_str()), ctx.git.clone());
    if !mirror.exists() {
        mirror
            .init(&mirror_source)
            .await
            .with_context(|| format!("initializing mirror from {mirror_source}"))?;
        ctx.db.touch_mirror_fetch(name.as_str()).await?;
    } else if let Ok(current) = mirror.remote_url().await
        && current != mirror_source
    {
        // A pre-existing mirror pointed elsewhere (the forge-sourced v1
        // layout): repoint and refetch so local branches become clonable.
        tracing::info!(
            from = current,
            to = mirror_source,
            "repointing mirror source"
        );
        ctx.git
            .run(
                &ctx.mirror_dir(name.as_str()),
                &["remote", "set-url", "origin", &mirror_source],
            )
            .await
            .map_err(|e| anyhow::anyhow!("repointing mirror: {e}"))?;
        mirror
            .fetch()
            .await
            .context("refetching repointed mirror")?;
        ctx.db.touch_mirror_fetch(name.as_str()).await?;
    }
    // The shadow lives in the project itself: `.envmux/git` is the shared
    // shadow remote every session of this repository pushes captures to. It
    // survives daemons, containers, and state-dir deletion — deleting the
    // project folder is the one act that should take the shadow with it.
    let project_dir = repo_dir.join(envmux_core::PROJECT_DIR);
    std::fs::create_dir_all(&project_dir).context("creating .envmux")?;
    // Self-defence against git even when onboarding never ran here (a repo
    // registered via `envmux up`, or one onboarded before this existed).
    let ignore_marker = project_dir.join(".gitignore");
    if !ignore_marker.exists() {
        let _ = std::fs::write(&ignore_marker, "*\n");
    }
    let shadow_dir = project_dir.join("git");
    migrate_legacy_shadow(&ctx.shadow_dir(name.as_str()), &shadow_dir);
    let shadow = ShadowRepo::new(shadow_dir, ctx.git.clone());
    if shadow.exists() {
        // The workspace user writes this repository through a bind mount and
        // is not the host user; a shadow created before that was true has to
        // be relaxed, or the first capture from a non-root workspace fails.
        shadow
            .ensure_shared()
            .await
            .context("relaxing shadow origin permissions")?;
    } else {
        shadow.init().await.context("initializing shadow origin")?;
    }

    // Image: pulled by reference, or built from the declared Dockerfile via
    // the docker CLI.
    let image = ensure_image(ctx, &name, &resolved, repo_dir).await?;

    let ns = Arc::new(NamespaceCtx {
        name: name.clone(),
        repo_dir: repo_dir.to_path_buf(),
        resolved: RwLock::new(resolved),
        mirror,
        shadow,
        origin_remote: remote.clone(),
        mirror_lock: tokio::sync::Mutex::new(()),
        shadow_lock: tokio::sync::Mutex::new(()),
        image,
    });

    start_services(ctx, &ns).await?;
    start_base_container(ctx, &ns).await?;

    ctx.namespaces
        .write()
        .await
        .insert(name.to_string(), Arc::clone(&ns));
    ctx.event(
        "info",
        Some(name.as_str()),
        None,
        "namespace",
        "namespace registered",
    )
    .await;
    Ok(ns)
}

/// Ensure the namespace image is present locally: pull the declared
/// reference, or build the declared Dockerfile by invoking `docker build`.
///
/// envmux orchestrates the build rather than implementing it. The CLI already
/// applies `.dockerignore`, streams the context incrementally, and uses
/// BuildKit's cache; reimplementing any of that against the API's `/build`
/// endpoint would be strictly worse.
/// Carry a pre-move shadow into the project, once, best-effort.
///
/// Earlier v2 builds kept the shadow under the state dir. Losing capture
/// history to a layout change would be exactly the kind of quiet data loss
/// the shadow exists to prevent, so an old repo is renamed into place when
/// no new one exists yet. Failure is logged, not fatal: a fresh shadow is
/// always a valid (if empty) fallback.
fn migrate_legacy_shadow(old: &std::path::Path, new: &std::path::Path) {
    if !old.exists() || new.exists() {
        return;
    }
    if let Some(parent) = new.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::rename(old, new) {
        Ok(()) => {
            tracing::info!(from = %old.display(), to = %new.display(), "moved shadow into the project");
        }
        Err(e) => {
            tracing::warn!(from = %old.display(), to = %new.display(), error = %e,
                "could not migrate legacy shadow; starting fresh");
        }
    }
}

async fn ensure_image(
    ctx: &Ctx,
    ns: &NamespaceName,
    resolved: &ResolvedConfig,
    repo_dir: &std::path::Path,
) -> anyhow::Result<String> {
    if let Some(reference) = &resolved.config.image.reference {
        if !ctx.docker.image_exists(reference).await? {
            ctx.event(
                "info",
                Some(ns.as_str()),
                None,
                "image",
                &format!("pulling {reference}"),
            )
            .await;
            ctx.docker.pull_image(reference).await?;
        }
        return Ok(reference.clone());
    }

    let dockerfile = resolved
        .config
        .image
        .dockerfile
        .as_deref()
        .expect("validation guarantees one image source");
    // Tagged by config hash: a workspace is a product of the config it was
    // created from, so a changed Dockerfile declaration is a different image.
    let tag = resolved.hash.image_tag(ns.as_str());
    if ctx.docker.image_exists(&tag).await? {
        return Ok(tag);
    }

    let cli = envmux_docker::cli_version().await?;
    ctx.event(
        "info",
        Some(ns.as_str()),
        None,
        "image",
        &format!("building {tag} with docker {cli}"),
    )
    .await;

    let request = envmux_docker::BuildRequest {
        tag: tag.clone(),
        dockerfile: envmux_docker::resolve_dockerfile(repo_dir, dockerfile),
        context: repo_dir.join(resolved.config.image.context.as_deref().unwrap_or(".")),
        build_args: resolved.config.image.args.clone(),
    };
    envmux_docker::build_image(&request, |line| {
        // Build output is progress, not an audit trail: it goes to the log,
        // while the `events` ledger keeps the start/finish record.
        tracing::debug!(target: "envmux::build", tag = %tag, "{line}");
    })
    .await?;

    ctx.event(
        "info",
        Some(ns.as_str()),
        None,
        "image",
        &format!("built {tag}"),
    )
    .await;
    Ok(tag)
}

/// Start declared services (idempotent) with canonical ports, DNS aliases,
/// data volumes, and loopback-published admin ports.
async fn start_services(ctx: &Ctx, ns: &NamespaceCtx) -> anyhow::Result<()> {
    let resolved = ns.resolved.read().await;
    for (svc_name, svc) in &resolved.config.services {
        let container_name = ns.service_container_name(svc_name);
        if ctx.docker.inspect_container(&container_name).await.is_ok() {
            ctx.docker.start_container(&container_name).await.ok();
            continue;
        }

        let kind = match svc.kind {
            envmux_config::ServiceKindName::Postgres => "postgres",
            envmux_config::ServiceKindName::Minio => "minio",
            envmux_config::ServiceKindName::Redis => "redis",
        };
        let (default_image, default_tag) =
            envmux_services::default_image(kind).expect("closed set");
        let image = match (&svc.image, &svc.version) {
            (Some(i), Some(v)) => format!("{i}:{v}"),
            (Some(i), None) => i.clone(),
            (None, Some(v)) => format!("{default_image}:{v}"),
            (None, None) => format!("{default_image}:{default_tag}"),
        };
        if !ctx.docker.image_exists(&image).await? {
            ctx.docker.pull_image(&image).await?;
        }
        let port = envmux_services::canonical_port(kind).expect("closed set");

        // Admin credentials: from the helper chain, minted on first use.
        let admin = admin_password(ctx, &ns.name, svc_name)?;

        let mut env = vec![];
        let mut cmd = None;
        match kind {
            "postgres" => {
                env.push(format!("POSTGRES_PASSWORD={admin}"));
                env.push("POSTGRES_USER=envmux_admin".to_owned());
            }
            "redis" => {
                cmd = Some(vec![
                    "redis-server".to_owned(),
                    "--requirepass".to_owned(),
                    admin.clone(),
                ]);
            }
            "minio" => {
                env.push("MINIO_ROOT_USER=envmux_admin".to_owned());
                env.push(format!("MINIO_ROOT_PASSWORD={admin}"));
                cmd = Some(vec!["server".to_owned(), "/data".to_owned()]);
            }
            _ => unreachable!("closed set"),
        }
        for (k, v) in &svc.config {
            env.push(format!("{k}={v}"));
        }

        let data_volume = svc
            .data_volume
            .clone()
            .unwrap_or_else(|| format!("envmux-{}-{}-data", ns.name, svc_name));
        ctx.docker
            .create_volume(envmux_docker::VolumeSpec {
                name: data_volume.clone(),
                labels: Labels::new(ns.name.clone(), Role::Service).class(VolumeClass::ServiceData),
            })
            .await?;

        let data_mount = match kind {
            "postgres" => "/var/lib/postgresql/data",
            "redis" => "/data",
            "minio" => "/data",
            _ => unreachable!(),
        };

        let health = svc.health.as_ref().map(|h| bollard::models::HealthConfig {
            test: Some(vec!["CMD-SHELL".to_owned(), h.cmd.clone()]),
            #[allow(clippy::cast_possible_wrap)]
            interval: Some(h.interval.as_secs() as i64 * 1_000_000_000),
            #[allow(clippy::cast_possible_wrap)]
            retries: Some(i64::from(h.retries)),
            ..Default::default()
        });

        let mut spec = ContainerSpec::new(
            container_name.clone(),
            image,
            Labels::new(ns.name.clone(), Role::Service),
        );
        spec.env = env;
        spec.cmd = cmd;
        spec.network = Some(ns.network_name());
        // Stable DNS alias: workspaces reach the service by its declared name.
        spec.network_aliases = vec![svc_name.clone()];
        spec.mounts = vec![VolumeMountSpec::volume(data_volume, data_mount, false)];
        spec.health = health;
        spec.loopback_ports = vec![port];

        ctx.docker.create_container(spec).await?;
        ctx.docker.start_container(&container_name).await?;
        ctx.event(
            "info",
            Some(ns.name.as_str()),
            None,
            "service",
            &format!("{svc_name} started"),
        )
        .await;
    }
    Ok(())
}

/// Get-or-mint the admin password for a service, via the helper chain.
pub fn admin_password(ctx: &Ctx, ns: &NamespaceName, svc: &str) -> anyhow::Result<String> {
    let key = SecretKey::new(ns.clone(), format!("svc-{svc}-admin"));
    match ctx.secrets.get(&key) {
        Ok(v) => Ok(String::from_utf8_lossy(v.as_bytes()).into_owned()),
        Err(envmux_secrets::SecretError::NotFound { .. }) => {
            let minted = envmux_secrets::mint_token();
            ctx.secrets
                .store(&key, &SecretValue(minted.clone().into_bytes()))
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            Ok(minted)
        }
        Err(e) => Err(anyhow::anyhow!("{e}")),
    }
}

/// Build the `ServiceKind` admin handle for a declared service.
pub async fn service_kind(
    ctx: &Ctx,
    ns: &NamespaceCtx,
    svc_name: &str,
) -> anyhow::Result<ServiceKind> {
    let resolved = ns.resolved.read().await;
    let svc = resolved
        .config
        .services
        .get(svc_name)
        .with_context(|| format!("unknown service {svc_name:?}"))?;
    let container = ns.service_container_name(svc_name);
    let admin = admin_password(ctx, &ns.name, svc_name)?;
    let kind = match svc.kind {
        envmux_config::ServiceKindName::Postgres => {
            let port = ctx
                .docker
                .published_port(&container, 5432)
                .await?
                .context("postgres admin port not published")?;
            ServiceKind::Postgres(Postgres {
                admin_url: format!("postgres://envmux_admin:{admin}@127.0.0.1:{port}/postgres"),
                service_host: svc_name.to_owned(),
                service_name: svc_name.to_owned(),
            })
        }
        envmux_config::ServiceKindName::Redis => {
            let port = ctx
                .docker
                .published_port(&container, 6379)
                .await?
                .context("redis admin port not published")?;
            ServiceKind::Redis(Redis {
                admin_url: format!("redis://:{admin}@127.0.0.1:{port}"),
                service_host: svc_name.to_owned(),
                service_name: svc_name.to_owned(),
            })
        }
        envmux_config::ServiceKindName::Minio => ServiceKind::Minio(Minio {
            docker: ctx.docker.clone(),
            container,
            admin_user: "envmux_admin".to_owned(),
            admin_password: admin,
            service_host: svc_name.to_owned(),
            service_name: svc_name.to_owned(),
        }),
    };
    Ok(kind)
}

/// The base container: always present, running the namespace image, holding a
/// checkout cloned from the mirror at the standard path, and the target for
/// light verification.
async fn start_base_container(ctx: &Ctx, ns: &NamespaceCtx) -> anyhow::Result<()> {
    let name = ns.base_container_name();
    let resolved = ns.resolved.read().await;
    let workdir = resolved.config.workspace.workdir.clone();
    let hash = resolved.hash.clone();
    drop(resolved);

    if ctx.docker.inspect_container(&name).await.is_err() {
        let mut spec = ContainerSpec::new(
            name.clone(),
            ns.image.clone(),
            Labels::new(ns.name.clone(), Role::Base).config_hash(hash),
        );
        spec.network = Some(ns.network_name());
        spec.init_idle = true;
        spec.mounts = vec![VolumeMountSpec::bind(
            ns.mirror.dir.display().to_string(),
            MIRROR_MOUNT,
            true,
        )];
        ctx.docker.create_container(spec).await?;
    }
    ctx.docker.start_container(&name).await?;

    verify_base(ctx, ns, &name, &workdir).await?;
    Ok(())
}

/// Light verification: tmux ≥ 3.2 present, git present, the mirror resolves,
/// and a checkout exists at the standard path. Because it is the same image,
/// a base container that works is meaningful evidence that workspaces will.
async fn verify_base(
    ctx: &Ctx,
    ns: &NamespaceCtx,
    container: &str,
    workdir: &str,
) -> anyhow::Result<()> {
    let tmux = ctx
        .docker
        .run_exec(
            container,
            vec!["tmux".into(), "-V".into()],
            None,
            None,
            vec![],
            None,
        )
        .await?;
    if !tmux.success() {
        bail!(
            "image for namespace {} has no tmux; tmux >= {}.{} is a hard requirement for \
             anything envmux shells into",
            ns.name,
            envmux_git::MIN_TMUX_VERSION.0,
            envmux_git::MIN_TMUX_VERSION.1
        );
    }
    let version = tmux.stdout.trim().trim_start_matches("tmux ").to_owned();
    let numeric: String = version
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = numeric.split('.');
    let major: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    if (major, minor) < envmux_git::MIN_TMUX_VERSION {
        bail!("image tmux {version} is older than required 3.2");
    }

    let git = ctx
        .docker
        .run_exec(
            container,
            vec!["git".into(), "--version".into()],
            None,
            None,
            vec![],
            None,
        )
        .await?;
    if !git.success() {
        bail!("image for namespace {} has no git", ns.name);
    }

    // Standardized git position: clone from the mirror if absent.
    //
    // The mirror is a host directory bind-mounted in, so it is owned by the
    // host user while git in the container is somebody else. Git refuses to
    // touch a repository owned by a stranger, which is right in general and
    // wrong for a mount envmux created and attached on purpose.
    let check = ctx
        .docker
        .run_exec(
            container,
            vec!["sh".into(), "-c".into(), format!("test -d {workdir}/.git")],
            None,
            None,
            vec![],
            None,
        )
        .await?;
    if !check.success() {
        mark_mounts_safe(ctx, container, &[MIRROR_MOUNT]).await?;
        let clone = ctx
            .docker
            .run_exec(
                container,
                vec![
                    "sh".into(),
                    "-c".into(),
                    format!("git clone {MIRROR_MOUNT} {workdir}"),
                ],
                None,
                None,
                vec![],
                None,
            )
            .await?;
        if !clone.success() {
            bail!("base checkout failed: {}", clone.stderr.trim());
        }
    }
    ctx.event(
        "info",
        Some(ns.name.as_str()),
        None,
        "base",
        "base container verified",
    )
    .await;
    Ok(())
}
