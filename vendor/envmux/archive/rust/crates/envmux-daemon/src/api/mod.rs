//! The API, served over always-on local IPC (Unix socket / Windows named
//! pipe, filesystem ACLs as auth).

pub mod ipc;
pub mod routes;
pub mod ws;

use axum::Router;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::{get, post};

use crate::context::SharedCtx;

pub fn router(ctx: SharedCtx) -> Router {
    Router::new()
        .route("/v1/health", get(routes::health))
        .route(
            "/v1/namespaces",
            get(routes::list_namespaces).post(routes::register_namespace),
        )
        .route("/v1/namespaces/{ns}", get(routes::get_namespace))
        .route(
            "/v1/namespaces/{ns}/mirror/fetch",
            post(routes::mirror_fetch),
        )
        .route(
            "/v1/namespaces/{ns}/workspaces",
            get(routes::list_workspaces).post(routes::create_workspace),
        )
        .route(
            "/v1/namespaces/{ns}/workspaces:from-capture",
            post(routes::from_capture),
        )
        .route(
            "/v1/workspaces/{id}",
            get(routes::get_workspace).delete(routes::reap_workspace),
        )
        .route("/v1/workspaces/{id}/lease", post(routes::lease))
        .route("/v1/workspaces/{id}/pin", post(routes::pin))
        .route("/v1/workspaces/{id}/unpin", post(routes::unpin))
        .route("/v1/workspaces/{id}/observation", get(routes::observation))
        .route("/v1/workspaces/{id}/tasks", get(routes::task_graph))
        .route(
            "/v1/workspaces/{id}/files",
            get(routes::download_files).put(routes::upload_files),
        )
        .route("/v1/workspaces/{id}/files/list", get(routes::list_files))
        .route(
            "/v1/workspaces/{id}/captures",
            get(routes::list_captures).post(routes::capture_now),
        )
        .route("/v1/workspaces/{id}/run", post(routes::run_command))
        .route("/v1/services/{ns}", get(routes::list_services))
        .route("/v1/services/{ns}/{svc}/slices", get(routes::list_slices))
        .route("/v1/config/{ns}", get(routes::config_info))
        .route("/v1/disk", get(routes::disk))
        .route("/v1/events", get(routes::events))
        .route("/v1/reap", post(routes::reap_sweep))
        .route("/v1/shutdown", post(routes::shutdown))
        .route("/v1/workspaces/{id}/attach", get(ws::attach))
        .route("/v1/events/stream", get(ws::events_stream))
        .with_state(ctx)
}

pub fn ipc_router(ctx: SharedCtx) -> Router {
    router(ctx.clone()).layer(axum::middleware::from_fn_with_state(ctx, ipc_auth))
}

async fn ipc_auth(
    axum::extract::State(ctx): axum::extract::State<SharedCtx>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let authorized = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token.as_bytes() == ctx.ipc_token.as_bytes());
    if authorized {
        // Count the request as a live client for its whole duration, so a
        // long provisioning call cannot look like an idle daemon to the
        // dead-man switch.
        let _client = ctx.activity.client();
        Ok(next.run(request).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tower::ServiceExt as _;

    use super::*;

    async fn context() -> SharedCtx {
        let docker = envmux_docker::DockerHandle::connect().unwrap();
        let state_dir =
            std::env::temp_dir().join(format!("envmux-api-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&state_dir).unwrap();
        let (events_tx, _) = tokio::sync::broadcast::channel(16);
        Arc::new(crate::context::Ctx {
            db: crate::state::Db::open_memory().await.unwrap(),
            docker: docker.clone(),
            secrets: Arc::new(envmux_secrets::Chain::new(vec![Box::new(
                envmux_secrets::FileProvider::new(state_dir.join("secrets.toml")),
            )])),
            git: envmux_git::GitRunner::new(),
            state_dir,
            namespaces: tokio::sync::RwLock::new(std::collections::HashMap::new()),
            disk: envmux_docker::DiskUsageCache::new(docker, std::time::Duration::from_secs(60)),
            disk_threshold_percent: 80,
            task_status: Arc::new(crate::tasks_engine::dashmap_lite::StatusMap::default()),
            events_tx,
            ipc_token: "test-capability".into(),
            activity: Arc::new(crate::workers::idle::Activity::default()),
            register_lock: tokio::sync::Mutex::new(()),
            shutdown: tokio_util::sync::CancellationToken::new(),
            router_port: std::sync::OnceLock::new(),
        })
    }

    #[tokio::test]
    async fn ipc_rejects_missing_capability() {
        let response = ipc_router(context().await)
            .oneshot(
                Request::builder()
                    .uri("/v1/health")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn ipc_accepts_matching_capability() {
        let response = ipc_router(context().await)
            .oneshot(
                Request::builder()
                    .uri("/v1/health")
                    .header("authorization", "Bearer test-capability")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
