//! JSON route handlers. DTOs come from `envmux-api-types`; errors are a
//! uniform `ApiError` body with a meaningful status.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use envmux_api_types as dto;
use serde::Deserialize;

use crate::context::{Ctx, NamespaceCtx, SharedCtx};
use crate::state::WorkspaceRow;

pub struct ApiError(pub StatusCode, pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = dto::ApiError {
            code: self.0.canonical_reason().unwrap_or("error").to_owned(),
            message: self.1,
        };
        (self.0, Json(body)).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = %e, error_chain = %format_args!("{e:#}"), "API operation failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal server error; consult daemon logs".into(),
        )
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => Self(StatusCode::NOT_FOUND, "not found".into()),
            other => {
                tracing::error!(error = %other, "database operation failed");
                Self(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal database error; consult daemon logs".into(),
                )
            }
        }
    }
}

type ApiResult<T> = Result<T, ApiError>;

fn not_found(what: &str) -> ApiError {
    ApiError(StatusCode::NOT_FOUND, format!("{what} not found"))
}

fn internal<E>(error: E) -> ApiError
where
    E: std::error::Error + Send + Sync + 'static,
{
    ApiError::from(anyhow::Error::new(error))
}

async fn ns_of(ctx: &Ctx, name: &str) -> ApiResult<Arc<NamespaceCtx>> {
    ctx.namespace(name)
        .await
        .ok_or_else(|| not_found("namespace"))
}

async fn workspace_of(ctx: &Ctx, id: &str) -> ApiResult<(WorkspaceRow, Arc<NamespaceCtx>)> {
    let row = ctx
        .db
        .get_workspace(id)
        .await?
        .ok_or_else(|| not_found("workspace"))?;
    let ns = ns_of(ctx, &row.namespace).await?;
    Ok((row, ns))
}

async fn summarize(ctx: &Ctx, ns: &NamespaceCtx, row: &WorkspaceRow) -> dto::WorkspaceSummary {
    let observation = ctx
        .db
        .get_observation(&row.id)
        .await
        .ok()
        .flatten()
        .map(|o| {
            let last_capture = None; // filled below
            let mut obs = dto::Observation {
                observed_at: o.observed_at,
                branch: o.branch,
                head: o.head,
                dirty: o.dirty,
                dirty_files: o.dirty_files.and_then(|v| u32::try_from(v).ok()),
                truncated: o.truncated,
                ahead: o.ahead.and_then(|v| u32::try_from(v).ok()),
                behind: o.behind.and_then(|v| u32::try_from(v).ok()),
                tasks: serde_json::from_str(&o.tasks_json).unwrap_or_default(),
                last_attach_at: o.last_attach_at,
                last_capture_at: last_capture,
                flagged_state: o.flagged_state,
            };
            obs.tasks = if obs.tasks.is_empty() {
                serde_json::from_str("[]").unwrap_or_default()
            } else {
                obs.tasks
            };
            obs
        });
    let mut summary = dto::WorkspaceSummary {
        id: row.id.clone(),
        namespace: row.namespace.clone(),
        name: row.name.clone(),
        state: row.state,
        branch_requested: row.branch_requested.clone(),
        config_hash: row.config_hash.clone(),
        config_current: {
            let resolved = ns.resolved.read().await;
            resolved.hash.as_str() == row.config_hash
        },
        created_at: row.created_at.clone(),
        death_date: row.death_date.clone(),
        container_id: row.container_id.clone(),
        observation,
        routes: {
            let resolved = ns.resolved.read().await;
            // Real URLs: the port the in-session router actually bound, or
            // the configured/default listen port if it has not bound yet.
            let port = ctx
                .router_port
                .get()
                .copied()
                .or(resolved.config.routing.port)
                .unwrap_or(crate::router::DEFAULT_PORT);
            resolved
                .config
                .routes
                .keys()
                .map(|name| {
                    (
                        name.clone(),
                        format!(
                            "http://{}:{port}/",
                            resolved
                                .config
                                .routing
                                .host_for(&row.namespace, &row.name, name)
                        ),
                    )
                })
                .collect()
        },
    };
    if let Ok(captures) = ctx.db.list_captures(Some(&row.id), None).await {
        if let (Some(obs), Some(first)) = (summary.observation.as_mut(), captures.first()) {
            obs.last_capture_at = Some(first.captured_at.clone());
        }
    }
    summary
}

// -- health / namespaces ----------------------------------------------------

pub async fn health() -> &'static str {
    "ok"
}

#[derive(Deserialize)]
pub struct RegisterNamespace {
    pub repo_dir: String,
}

pub async fn register_namespace(
    State(ctx): State<SharedCtx>,
    Json(req): Json<RegisterNamespace>,
) -> ApiResult<Json<dto::NamespaceSummary>> {
    let ns = crate::namespace::register(&ctx, std::path::Path::new(&req.repo_dir))
        .await
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, format!("{e:#}")))?;
    namespace_summary(&ctx, ns.name.as_str()).await.map(Json)
}

async fn namespace_summary(ctx: &Ctx, name: &str) -> ApiResult<dto::NamespaceSummary> {
    let rows = ctx.db.list_namespaces().await?;
    let (ns_name, repo_remote, _repo_dir, created_at, mirror_last_fetch, fetch_mode) = rows
        .into_iter()
        .find(|r| r.0 == name)
        .ok_or_else(|| not_found("namespace"))?;
    let workspaces = ctx.db.count_live_workspaces(&ns_name).await?;
    let services = service_summaries(ctx, &ns_name).await;
    Ok(dto::NamespaceSummary {
        name: ns_name,
        repo_remote,
        created_at,
        mirror_last_fetch,
        mirror_fetch_mode: fetch_mode,
        workspaces: u32::try_from(workspaces).unwrap_or(0),
        services,
    })
}

async fn service_summaries(ctx: &Ctx, ns_name: &str) -> Vec<dto::ServiceSummary> {
    let Some(ns) = ctx.namespace(ns_name).await else {
        return Vec::new();
    };
    let resolved = ns.resolved.read().await;
    let mut out = Vec::new();
    for (name, svc) in &resolved.config.services {
        let container = ns.service_container_name(name);
        let healthy = match crate::namespace::service_kind(ctx, &ns, name).await {
            Ok(kind) => kind
                .health()
                .await
                .ok()
                .map(|h| h == envmux_services::Health::Healthy),
            Err(_) => None,
        };
        let container_id = ctx
            .docker
            .inspect_container(&container)
            .await
            .ok()
            .and_then(|i| i.id);
        out.push(dto::ServiceSummary {
            name: name.clone(),
            kind: format!("{:?}", svc.kind).to_lowercase(),
            image: svc.image.clone().unwrap_or_default(),
            healthy,
            container_id,
        });
    }
    out
}

pub async fn list_namespaces(
    State(ctx): State<SharedCtx>,
) -> ApiResult<Json<Vec<dto::NamespaceSummary>>> {
    let mut out = Vec::new();
    for (name, ..) in ctx.db.list_namespaces().await? {
        out.push(namespace_summary(&ctx, &name).await?);
    }
    Ok(Json(out))
}

pub async fn get_namespace(
    State(ctx): State<SharedCtx>,
    Path(ns): Path<String>,
) -> ApiResult<Json<dto::NamespaceSummary>> {
    namespace_summary(&ctx, &ns).await.map(Json)
}

pub async fn mirror_fetch(
    State(ctx): State<SharedCtx>,
    Path(ns): Path<String>,
) -> ApiResult<Json<dto::MirrorFetchResponse>> {
    let nsctx = ns_of(&ctx, &ns).await?;
    let _guard = nsctx.mirror_lock.lock().await;
    nsctx
        .mirror
        .fetch()
        .await
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let fetched_at = ctx.db.touch_mirror_fetch(&ns).await?;
    Ok(Json(dto::MirrorFetchResponse { fetched_at }))
}

// -- workspaces -------------------------------------------------------------

pub async fn list_workspaces(
    State(ctx): State<SharedCtx>,
    Path(ns): Path<String>,
) -> ApiResult<Json<Vec<dto::WorkspaceSummary>>> {
    let nsctx = ns_of(&ctx, &ns).await?;
    let rows = ctx.db.list_workspaces(Some(&ns)).await?;
    let mut out = Vec::new();
    for row in rows {
        out.push(summarize(&ctx, &nsctx, &row).await);
    }
    Ok(Json(out))
}

pub async fn create_workspace(
    State(ctx): State<SharedCtx>,
    Path(ns): Path<String>,
    Json(req): Json<dto::CreateWorkspaceRequest>,
) -> ApiResult<Json<dto::CreateWorkspaceResponse>> {
    let nsctx = ns_of(&ctx, &ns).await?;
    let (row, reused) = crate::workspace::create(&ctx, &nsctx, &req)
        .await
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, format!("{e:#}")))?;
    Ok(Json(dto::CreateWorkspaceResponse {
        workspace: summarize(&ctx, &nsctx, &row).await,
        reused,
    }))
}

pub async fn get_workspace(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
) -> ApiResult<Json<dto::WorkspaceSummary>> {
    let (row, ns) = workspace_of(&ctx, &id).await?;
    Ok(Json(summarize(&ctx, &ns, &row).await))
}

pub async fn reap_workspace(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let (row, ns) = workspace_of(&ctx, &id).await?;
    crate::workspace::reap_now(&ctx, &ns, &row.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn lease(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
    Json(req): Json<dto::LeaseRequest>,
) -> ApiResult<Json<dto::LeaseResponse>> {
    let (row, _ns) = workspace_of(&ctx, &id).await?;
    let death = match req {
        dto::LeaseRequest::Extend { by } => {
            let dur: envmux_config::HumanDuration = by
                .parse()
                .map_err(|e: String| ApiError(StatusCode::BAD_REQUEST, e))?;
            #[allow(clippy::cast_possible_wrap)]
            let new = jiff::Timestamp::now()
                .checked_add(jiff::Span::new().seconds(dur.as_secs() as i64))
                .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?
                .to_string();
            ctx.db.set_death_date(&row.id, Some(&new)).await?;
            Some(new)
        }
        dto::LeaseRequest::Until { at } => {
            at.parse::<jiff::Timestamp>()
                .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
            ctx.db.set_death_date(&row.id, Some(&at)).await?;
            Some(at)
        }
    };
    Ok(Json(dto::LeaseResponse {
        death_date: death,
        pinned: false,
    }))
}

pub async fn pin(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
) -> ApiResult<Json<dto::LeaseResponse>> {
    let (row, _) = workspace_of(&ctx, &id).await?;
    ctx.db.set_death_date(&row.id, None).await?;
    Ok(Json(dto::LeaseResponse {
        death_date: None,
        pinned: true,
    }))
}

pub async fn unpin(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
) -> ApiResult<Json<dto::LeaseResponse>> {
    let (row, ns) = workspace_of(&ctx, &id).await?;
    let initial = ns.resolved.read().await.config.lease.initial;
    #[allow(clippy::cast_possible_wrap)]
    let new = jiff::Timestamp::now()
        .checked_add(jiff::Span::new().seconds(initial.as_secs() as i64))
        .map_err(internal)?
        .to_string();
    ctx.db.set_death_date(&row.id, Some(&new)).await?;
    Ok(Json(dto::LeaseResponse {
        death_date: Some(new),
        pinned: false,
    }))
}

pub async fn observation(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
) -> ApiResult<Json<Option<dto::Observation>>> {
    let (row, ns) = workspace_of(&ctx, &id).await?;
    Ok(Json(summarize(&ctx, &ns, &row).await.observation))
}

// -- captures ---------------------------------------------------------------

/// The workspace's declared task graph, joined with live engine status.
///
/// Parsed from the workspace's frozen `config_toml`, not the file on disk:
/// a workspace is a product of the config it was created from and is never
/// upgraded in place, so this reports what it is actually running.
pub async fn task_graph(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
) -> ApiResult<Json<dto::TaskGraph>> {
    let (row, ns) = workspace_of(&ctx, &id).await?;
    let config: envmux_config::Config = toml::from_str(&row.config_toml).map_err(|e| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("frozen config for workspace {id} does not parse: {e}"),
        )
    })?;

    let live = ctx.task_status.get(&row.id);
    let tasks = config
        .tasks
        .iter()
        .map(|(name, task)| dto::TaskNode {
            name: name.clone(),
            command: task.command.clone(),
            cwd: task.cwd.clone(),
            after: task.after.clone(),
            requires: task.requires.clone(),
            long_running: task.long_running,
            restart: render_restart(&task.restart),
            check: task.check.as_ref().map(render_check),
            exports: task.exports.clone(),
            status: live.iter().find(|s| s.name == *name).cloned(),
        })
        .collect();

    Ok(Json(dto::TaskGraph {
        workspace_id: row.id.clone(),
        workspace_name: row.name.clone(),
        config_hash: row.config_hash.clone(),
        config_current: {
            let resolved = ns.resolved.read().await;
            resolved.hash.as_str() == row.config_hash
        },
        tasks,
    }))
}

fn render_restart(policy: &envmux_config::RestartPolicy) -> String {
    use envmux_config::RestartPolicy as R;
    match policy {
        R::Never => "never".to_owned(),
        R::OnFailure { max, backoff } => format!("on-failure max={max} backoff={backoff}"),
        R::Always { backoff } => format!("always backoff={backoff}"),
    }
}

fn render_check(check: &envmux_config::Check) -> String {
    use envmux_config::Check as C;
    match check {
        C::Exec {
            cmd,
            interval,
            timeout,
        } => format!("exec `{cmd}` every {interval}, timeout {timeout}"),
        C::Http {
            port,
            path,
            interval,
            timeout,
        } => format!("http :{port}{path} every {interval}, timeout {timeout}"),
        C::Port {
            port,
            interval,
            timeout,
        } => format!("port :{port} every {interval}, timeout {timeout}"),
    }
}

#[derive(Deserialize)]
pub struct CaptureQuery {
    pub branch: Option<String>,
}

pub async fn list_captures(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
    Query(q): Query<CaptureQuery>,
) -> ApiResult<Json<Vec<dto::CaptureSummary>>> {
    // `id` may be a workspace id, or "-" with ?branch= for branch grouping.
    let rows = if id == "-" {
        ctx.db.list_captures(None, q.branch.as_deref()).await?
    } else {
        ctx.db.list_captures(Some(&id), None).await?
    };
    let mut out = Vec::new();
    for c in rows {
        let ws_name = ctx
            .db
            .get_workspace(&c.workspace_id)
            .await?
            .map(|w| w.name)
            .unwrap_or_default();
        out.push(dto::CaptureSummary {
            id: c.id,
            workspace_id: c.workspace_id,
            workspace_name: ws_name,
            branch: c.branch,
            captured_at: c.captured_at,
            shadow_ref: c.shadow_ref,
            commit_oid: c.commit_oid,
            torn: c.torn,
            flagged_state: c.flagged_state,
        });
    }
    Ok(Json(out))
}

pub async fn capture_now(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
) -> ApiResult<Json<dto::CaptureSummary>> {
    let (row, ns) = workspace_of(&ctx, &id).await?;
    let c = crate::workspace::capture_workspace(&ctx, &ns, &row).await?;
    Ok(Json(dto::CaptureSummary {
        id: c.id,
        workspace_id: c.workspace_id,
        workspace_name: row.name,
        branch: c.branch,
        captured_at: c.captured_at,
        shadow_ref: c.shadow_ref,
        commit_oid: c.commit_oid,
        torn: c.torn,
        flagged_state: c.flagged_state,
    }))
}

/// Start a fresh workspace from a captured point: create on the same branch,
/// then reset the tree to the snapshot commit fetched from the shadow.
pub async fn from_capture(
    State(ctx): State<SharedCtx>,
    Path(ns): Path<String>,
    Json(req): Json<dto::FromCaptureRequest>,
) -> ApiResult<Json<dto::CreateWorkspaceResponse>> {
    let nsctx = ns_of(&ctx, &ns).await?;
    let capture = ctx
        .db
        .get_capture(&req.capture_id)
        .await?
        .ok_or_else(|| not_found("capture"))?;
    let origin = ctx
        .db
        .get_workspace(&capture.workspace_id)
        .await?
        .ok_or_else(|| not_found("capture's workspace"))?;

    let create_req = dto::CreateWorkspaceRequest {
        repo: None,
        branch: capture
            .branch
            .clone()
            .or(Some(origin.branch_requested.clone())),
        name: req.name.clone(),
        overrides: None,
    };
    let (row, reused) = crate::workspace::create(&ctx, &nsctx, &create_req)
        .await
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, format!("{e:#}")))?;

    // Fetch the snapshot commit from the shadow mount and lay it into the
    // tree (keeping the branch position: mixed reset, files only).
    let container = nsctx.workspace_container_name(&row.name);
    let workdir = nsctx.resolved.read().await.config.workspace.workdir.clone();
    let script = format!(
        "cd {workdir} && git fetch {shadow} {oid} && git restore --source {oid} --worktree -- . ",
        shadow = crate::namespace::SHADOW_MOUNT,
        oid = capture.commit_oid,
    );
    let out = ctx
        .docker
        .run_exec(
            &container,
            vec!["sh".into(), "-c".into(), script],
            None,
            None,
            vec![],
            None,
        )
        .await
        .map_err(internal)?;
    if !out.success() {
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("restoring snapshot into workspace: {}", out.stderr.trim()),
        ));
    }

    Ok(Json(dto::CreateWorkspaceResponse {
        workspace: summarize(&ctx, &nsctx, &row).await,
        reused,
    }))
}

// -- run / files ------------------------------------------------------------

#[derive(Deserialize)]
pub struct RunRequest {
    pub cmd: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct RunResponse {
    pub exit_code: i64,
    pub stdout: String,
    pub stderr: String,
}

pub async fn run_command(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
    Json(req): Json<RunRequest>,
) -> ApiResult<Json<RunResponse>> {
    let (row, ns) = workspace_of(&ctx, &id).await?;
    let container = ns.workspace_container_name(&row.name);
    let workdir = ns.resolved.read().await.config.workspace.workdir.clone();
    let out = ctx
        .docker
        .run_exec(&container, req.cmd, None, Some(&workdir), vec![], None)
        .await
        .map_err(internal)?;
    Ok(Json(RunResponse {
        exit_code: out.exit_code,
        stdout: out.stdout,
        stderr: out.stderr,
    }))
}

#[derive(Deserialize)]
pub struct FileQuery {
    pub path: String,
}

pub async fn download_files(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
    Query(q): Query<FileQuery>,
) -> ApiResult<Response> {
    let (row, ns) = workspace_of(&ctx, &id).await?;
    let container = ns.workspace_container_name(&row.name);
    let bytes = ctx
        .docker
        .download_tar(&container, &q.path)
        .await
        .map_err(|e| ApiError(StatusCode::NOT_FOUND, e.to_string()))?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/x-tar")],
        bytes,
    )
        .into_response())
}

pub async fn upload_files(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
    Query(q): Query<FileQuery>,
    body: axum::body::Bytes,
) -> ApiResult<StatusCode> {
    let (row, ns) = workspace_of(&ctx, &id).await?;
    let container = ns.workspace_container_name(&row.name);
    ctx.docker
        .upload_tar(&container, &q.path, body)
        .await
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_files(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
    Query(q): Query<FileQuery>,
) -> ApiResult<Json<Vec<dto::FileEntry>>> {
    let (row, ns) = workspace_of(&ctx, &id).await?;
    let container = ns.workspace_container_name(&row.name);
    let entries = ctx
        .docker
        .list_tar(&container, &q.path)
        .await
        .map_err(|e| ApiError(StatusCode::NOT_FOUND, e.to_string()))?;
    Ok(Json(
        entries
            .into_iter()
            .map(|e| dto::FileEntry {
                name: e
                    .path
                    .trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .unwrap_or(&e.path)
                    .to_owned(),
                path: e.path,
                size: e.size,
                is_dir: e.is_dir,
                modified: e.mtime.and_then(|m| {
                    i64::try_from(m)
                        .ok()
                        .and_then(|s| jiff::Timestamp::from_second(s).ok())
                        .map(|t| t.to_string())
                }),
            })
            .collect(),
    ))
}

// -- services / slices / config / disk / events -----------------------------

pub async fn list_services(
    State(ctx): State<SharedCtx>,
    Path(ns): Path<String>,
) -> ApiResult<Json<Vec<dto::ServiceSummary>>> {
    ns_of(&ctx, &ns).await?;
    Ok(Json(service_summaries(&ctx, &ns).await))
}

pub async fn list_slices(
    State(ctx): State<SharedCtx>,
    Path((ns, svc)): Path<(String, String)>,
) -> ApiResult<Json<Vec<dto::SliceSummary>>> {
    let nsctx = ns_of(&ctx, &ns).await?;
    let mut out = Vec::new();
    let rows = ctx.db.list_slices(None).await?;
    let mut recorded_keys = std::collections::HashSet::new();
    for s in rows.into_iter().filter(|s| s.service == svc) {
        let ws = ctx.db.get_workspace(&s.workspace_id).await?;
        if ws.as_ref().map(|w| w.namespace.as_str()) != Some(ns.as_str()) {
            continue;
        }
        recorded_keys.insert(s.slice_key.clone());
        out.push(dto::SliceSummary {
            id: s.id,
            workspace_id: Some(s.workspace_id),
            workspace_name: ws.map(|w| w.name),
            service: s.service,
            slice_key: s.slice_key,
            state: s.state,
            created_at: s.created_at,
            last_error: s.last_error,
            orphan: false,
        });
    }
    // Orphan audit: server-side slices with no live workspace behind them.
    if let Ok(kind) = crate::namespace::service_kind(&ctx, &nsctx, &svc).await {
        if let Ok(server_side) = kind.audit().await {
            for key in server_side {
                if !recorded_keys.contains(key.as_str()) {
                    out.push(dto::SliceSummary {
                        id: String::new(),
                        workspace_id: None,
                        workspace_name: None,
                        service: svc.clone(),
                        slice_key: key.to_string(),
                        state: "unknown".to_owned(),
                        created_at: String::new(),
                        last_error: None,
                        orphan: true,
                    });
                }
            }
        }
    }
    Ok(Json(out))
}

pub async fn config_info(
    State(ctx): State<SharedCtx>,
    Path(ns): Path<String>,
) -> ApiResult<Json<dto::ConfigInfo>> {
    let nsctx = ns_of(&ctx, &ns).await?;
    // Re-resolve so drift state is current, not boot-time.
    let resolved = envmux_config::resolve_dir(&nsctx.repo_dir).map_err(internal)?;
    let drift = match &resolved.drift {
        envmux_config::DriftState::NotApplicable => dto::DriftInfo::NotApplicable,
        envmux_config::DriftState::Untracked => dto::DriftInfo::Untracked,
        envmux_config::DriftState::Clean => dto::DriftInfo::Clean,
        envmux_config::DriftState::BaseMoved { recorded, current } => dto::DriftInfo::BaseMoved {
            recorded: recorded.to_string(),
            current: current.to_string(),
        },
        envmux_config::DriftState::BaseMissing => dto::DriftInfo::BaseMissing,
    };
    let info = dto::ConfigInfo {
        active_file: resolved.active.file_name().to_owned(),
        path: resolved.path.display().to_string(),
        hash: resolved.hash.to_string(),
        drift,
    };
    *nsctx.resolved.write().await = resolved;
    Ok(Json(info))
}

pub async fn disk(State(ctx): State<SharedCtx>) -> ApiResult<Json<dto::DiskReport>> {
    let usage = ctx
        .disk
        .get()
        .await
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e.to_string()))?;
    Ok(Json(dto::DiskReport {
        polled_at: usage.polled_at.to_string(),
        total_bytes: usage.total_bytes,
        threshold_percent: ctx.disk_threshold_percent,
        alert: false,
        items: usage
            .volumes
            .into_iter()
            .map(|v| dto::DiskItem {
                namespace: v.namespace,
                workspace: v.workspace,
                class: v.class,
                volume: v.volume,
                bytes: v.bytes,
            })
            .collect(),
    }))
}

#[derive(Deserialize)]
pub struct EventsQuery {
    #[serde(default)]
    pub since: i64,
}

pub async fn events(
    State(ctx): State<SharedCtx>,
    Query(q): Query<EventsQuery>,
) -> ApiResult<Json<Vec<dto::EventRecord>>> {
    let rows = ctx.db.list_events(q.since, 500).await?;
    Ok(Json(
        rows.into_iter()
            .map(
                |(id, at, level, namespace, workspace, component, message)| dto::EventRecord {
                    id,
                    at,
                    level,
                    namespace,
                    workspace,
                    component,
                    message,
                },
            )
            .collect(),
    ))
}

// -- reap -------------------------------------------------------------------

pub async fn reap_sweep(State(ctx): State<SharedCtx>) -> ApiResult<StatusCode> {
    crate::workers::reaper::sweep(&ctx).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn shutdown(State(ctx): State<SharedCtx>) -> StatusCode {
    tokio::spawn(async move {
        // Let the HTTP 202 response flush before listeners begin draining.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        // v2 semantics: stopping the daemon stops its world. The daemon is
        // the session; there is no resident thing for containers to belong
        // to once it exits.
        crate::workers::idle::shutdown_world(&ctx).await;
        ctx.shutdown.cancel();
    });
    StatusCode::ACCEPTED
}

#[cfg(test)]
mod tests {
    use envmux_config::{Check, RestartPolicy};

    use super::*;

    fn secs(n: u64) -> envmux_config::HumanDuration {
        envmux_config::HumanDuration::from_secs(n)
    }

    #[test]
    fn restart_policies_render_for_display() {
        assert_eq!(render_restart(&RestartPolicy::Never), "never");
        assert_eq!(
            render_restart(&RestartPolicy::OnFailure {
                max: 3,
                backoff: secs(5),
            }),
            "on-failure max=3 backoff=5s"
        );
        assert_eq!(
            render_restart(&RestartPolicy::Always { backoff: secs(90) }),
            "always backoff=1m 30s"
        );
    }

    #[test]
    fn checks_render_with_their_discriminating_detail() {
        // Clients show these verbatim, so each variant must render the
        // field that distinguishes it — the command, or the port and path.
        assert_eq!(
            render_check(&Check::Exec {
                cmd: "docker info".into(),
                interval: secs(2),
                timeout: secs(120),
            }),
            "exec `docker info` every 2s, timeout 2m"
        );
        assert_eq!(
            render_check(&Check::Http {
                port: 7700,
                path: "/v1/health".into(),
                interval: secs(3),
                timeout: secs(900),
            }),
            "http :7700/v1/health every 3s, timeout 15m"
        );
        assert_eq!(
            render_check(&Check::Port {
                port: 5432,
                interval: secs(1),
                timeout: secs(30),
            }),
            "port :5432 every 1s, timeout 30s"
        );
    }
}
