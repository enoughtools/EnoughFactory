//! WebSocket surfaces: terminal attach (binary frames = raw PTY bytes, text
//! frames = control JSON) and the events stream. One WS per terminal.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::Response;
use envmux_api_types::{AttachControl, AttachMode};
use futures_util::{SinkExt as _, StreamExt as _};
use serde::Deserialize;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

use crate::context::SharedCtx;

#[derive(Deserialize)]
pub struct AttachQuery {
    pub task: Option<String>,
    #[serde(default = "default_mode")]
    pub mode: String,
}

fn default_mode() -> String {
    "rw".to_owned()
}

pub async fn attach(
    State(ctx): State<SharedCtx>,
    Path(id): Path<String>,
    Query(q): Query<AttachQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| async move {
        // The upgraded stream outlives the HTTP request the auth middleware
        // counted, so it holds its own client guard: an open terminal is
        // exactly what the dead-man switch must treat as a live session.
        let _client = ctx.activity.client();
        if let Err(e) = attach_session(ctx.clone(), id, q, socket).await {
            tracing::debug!(error = %e, "attach session ended with error");
        }
    })
}

async fn attach_session(
    ctx: SharedCtx,
    id: String,
    q: AttachQuery,
    socket: WebSocket,
) -> anyhow::Result<()> {
    let row = ctx
        .db
        .get_workspace(&id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("workspace not found"))?;
    let ns = ctx
        .namespace(&row.namespace)
        .await
        .ok_or_else(|| anyhow::anyhow!("namespace not registered"))?;
    let container = ns.workspace_container_name(&row.name);
    let read_only = q.mode == "ro";
    let (attach_extension, terminal) = {
        let resolved = ns.resolved.read().await;
        (
            resolved.config.lease.attach_extension,
            resolved
                .config
                .workspace
                .terminal_command()
                .map(str::to_owned),
        )
    };

    // The attach side effect: rw attach extends the lease (now + extension if
    // later). Read-only attach does not — watching an agent shouldn't keep
    // its world alive.
    if !read_only {
        #[allow(clippy::cast_possible_wrap)]
        ctx.db
            .extend_lease_on_attach(&row.id, attach_extension.as_secs() as i64)
            .await?;
        ctx.event(
            "info",
            Some(&row.namespace),
            Some(&row.name),
            "broker",
            "rw attach; lease extended",
        )
        .await;
    }

    // Fresh exec per client — attach never shares the control stream.
    let cmd = envmux_tmux::client::attach_cmd(q.task.as_deref(), read_only, terminal.as_deref());
    let exec = ctx
        .docker
        .exec_stream(&container, cmd, None, None, true)
        .await?;
    let exec_id = exec.exec_id.clone();
    let (mut exec_read, mut exec_write) = tokio::io::split(exec);
    let (mut ws_tx, mut ws_rx) = socket.split();

    let docker = ctx.docker.clone();
    // The post-mortem below runs once the stream is gone, so it holds its own
    // handles rather than borrowing anything the pumps are using.
    let post_mortem = ctx.clone();
    let probed = container.clone();
    let (namespace, workspace) = (row.namespace.clone(), row.name.clone());
    let pump_out = async {
        let mut buf = [0u8; 8192];
        loop {
            let n = exec_read.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            ws_tx
                .send(Message::Binary(buf[..n].to_vec().into()))
                .await?;
        }
        // The tmux client is gone, and the byte stream cannot say why: a user
        // who detached and a terminal that exited out from under them look
        // exactly the same from here. The difference decides whether the
        // client reconnects, so ask the workspace which it was.
        let event = if session_exists(&post_mortem.docker, &probed).await {
            envmux_api_types::AttachEvent::Detached
        } else {
            post_mortem
                .event(
                    "info",
                    Some(&namespace),
                    Some(&workspace),
                    "broker",
                    "the terminal exited and took its session; a reattach opens a fresh one",
                )
                .await;
            envmux_api_types::AttachEvent::TerminalExited
        };
        let _ = ws_tx
            .send(Message::Text(serde_json::to_string(&event)?.into()))
            .await;
        anyhow::Ok(())
    };
    let pump_in = async {
        while let Some(msg) = ws_rx.next().await {
            match msg? {
                // A read-only attach still receives keystrokes; they are read
                // and dropped rather than refused, so the viewer's terminal
                // behaves normally and only the write is withheld.
                Message::Binary(data) if !read_only => {
                    exec_write.write_all(&data).await?;
                }
                Message::Text(text) => {
                    if let Ok(ctrl) = serde_json::from_str::<AttachControl>(&text) {
                        match ctrl {
                            AttachControl::Resize { cols, rows } => {
                                docker.resize_exec(&exec_id, cols, rows).await.ok();
                            }
                            AttachControl::Mode {
                                mode: AttachMode::Ro | AttachMode::Rw,
                            } => {
                                // Mode switching requires reattach; ignored.
                            }
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        anyhow::Ok(())
    };

    tokio::select! {
        r = pump_out => r?,
        r = pump_in => r?,
    }
    Ok(())
}

/// Whether the workspace's tmux session is still standing.
///
/// This is the whole question behind "detached or gone?". A tmux client that
/// loses the window it was in moves to another one and stays attached, so a
/// client that has *exited* either left deliberately or had the session pulled
/// out from under it — which is what happens when the terminal's program was
/// the last thing in it. Deliberate exits leave the session behind; that is
/// the difference. An error reads as gone, the honest answer when the
/// container itself has stopped replying.
async fn session_exists(docker: &envmux_docker::DockerHandle, container: &str) -> bool {
    let out = docker
        .run_exec(
            container,
            vec![
                "tmux".to_owned(),
                "has-session".to_owned(),
                "-t".to_owned(),
                envmux_tmux::SESSION.to_owned(),
            ],
            None,
            None,
            vec![],
            None,
        )
        .await;
    matches!(out, Ok(out) if out.success())
}

pub async fn events_stream(State(ctx): State<SharedCtx>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |mut socket| async move {
        let _client = ctx.activity.client();
        let mut rx = ctx.events_tx.subscribe();
        while let Ok(event) = rx.recv().await {
            let Ok(text) = serde_json::to_string(&event) else {
                continue;
            };
            if socket.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    })
}
