//! Local IPC transport, always on, no TLS: a Unix domain socket (0600) on
//! Unix, a named pipe on Windows. Filesystem/pipe ACLs are the auth.

use axum::Router;
use hyper_util::rt::TokioIo;
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
pub async fn serve(
    router: Router,
    state_dir: std::path::PathBuf,
    cancel: CancellationToken,
) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    let sock = state_dir.join("daemon.sock");
    let _ = std::fs::remove_file(&sock);
    let listener = tokio::net::UnixListener::bind(&sock)?;
    std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))?;
    tracing::info!(socket = %sock.display(), "IPC listening");
    loop {
        tokio::select! {
            () = cancel.cancelled() => return Ok(()),
            accepted = listener.accept() => {
                let (stream, _addr) = accepted?;
                spawn_connection(router.clone(), stream, cancel.clone());
            }
        }
    }
}

#[cfg(windows)]
pub async fn serve(
    router: Router,
    state_dir: std::path::PathBuf,
    cancel: CancellationToken,
) -> anyhow::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    // Derived from the state directory, so a portable daemon and an installed
    // one get distinct pipes — the scoping a Unix socket gets for free by
    // living in the directory it belongs to.
    let pipe_name = envmux_core::ipc_endpoint(&state_dir);
    tracing::info!(pipe = pipe_name, "IPC listening");
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)
        .map_err(|e| {
            // `first_pipe_instance` is deliberate: it turns "another daemon
            // already owns this state directory" into a clear refusal instead
            // of two daemons interleaving accepts on one pipe.
            anyhow::anyhow!(
                "creating IPC pipe {pipe_name}: {e}\n\
                 another envmux daemon may already be running for {}",
                state_dir.display()
            )
        })?;
    loop {
        tokio::select! {
            () = cancel.cancelled() => return Ok(()),
            connected = server.connect() => {
                if let Err(e) = connected {
                    // A client can vanish between opening the pipe and the
                    // accept completing (a poll loop giving up, a killed
                    // process). That is that client's business — the daemon
                    // must keep listening, not die with it.
                    tracing::debug!(error = %e, "IPC accept failed; continuing");
                }
                // Stand up the next instance BEFORE anything else: from the
                // moment a client connects, this instance no longer listens,
                // and a second client connecting into that window gets
                // ERROR_FILE_NOT_FOUND — "no daemon" — from a daemon that is
                // entirely alive. The gap cannot be closed completely from
                // the server side (the client retries error 2 briefly for
                // the same reason), but it can be made microscopic.
                let next = ServerOptions::new().create(&pipe_name).map_err(|e| {
                    tracing::error!(error = %e, "could not create the next pipe instance");
                    e
                })?;
                let stream = std::mem::replace(&mut server, next);
                tracing::trace!("IPC connection accepted; next instance listening");
                spawn_connection(router.clone(), stream, cancel.clone());
            }
        }
    }
}

pub fn spawn_connection<S>(router: Router, stream: S, cancel: CancellationToken)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let service = hyper_util::service::TowerToHyperService::new(router);
        let io = TokioIo::new(stream);
        let builder =
            hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
        let conn = builder.serve_connection_with_upgrades(io, service);
        tokio::select! {
            () = cancel.cancelled() => {}
            result = conn => {
                if let Err(e) = result {
                    tracing::debug!(error = %e, "IPC connection ended");
                }
            }
        }
    });
}
