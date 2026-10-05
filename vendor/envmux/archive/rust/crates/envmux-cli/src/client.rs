//! IPC HTTP client: a fresh connection per request over the Unix socket or
//! Windows named pipe, HTTP/1.1 via hyper's low-level handshake. WebSocket
//! attach runs over the same transport via an HTTP upgrade.

use anyhow::{Context as _, bail};
use bytes::Bytes;
use http_body_util::{BodyExt as _, Full};
use hyper::Request;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;

/// Exit code 4: daemon unreachable (stable and documented).
pub struct Unreachable(pub anyhow::Error);

#[cfg(unix)]
pub async fn connect() -> Result<tokio::net::UnixStream, Unreachable> {
    let sock = crate::state_dir().join("daemon.sock");
    tokio::net::UnixStream::connect(&sock)
        .await
        .map_err(|e| Unreachable(anyhow::anyhow!("connecting {}: {e}", sock.display())))
}

#[cfg(windows)]
pub async fn connect() -> Result<tokio::net::windows::named_pipe::NamedPipeClient, Unreachable> {
    use tokio::net::windows::named_pipe::ClientOptions;
    // Derived from the state directory, exactly as the daemon derives it: the
    // CLI must reach the daemon that owns the credentials it is about to
    // present, not merely some daemon on this machine.
    let pipe_name = envmux_core::ipc_endpoint(&crate::state_dir());
    // Two transient failures are worth retrying. 231 (pipe busy): every
    // instance has a client; the server is standing up another. 2 (not
    // found): the instant between a client connecting and the server
    // creating the next instance — the pipe "does not exist" although the
    // daemon is entirely alive. Error 2 is also the genuine no-daemon
    // answer, so it gets only a short retry budget before it is believed.
    let mut not_found_budget = 6;
    for _ in 0..20 {
        match ClientOptions::new().open(&pipe_name) {
            Ok(client) => return Ok(client),
            Err(e) if e.raw_os_error() == Some(231) => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(e) if e.raw_os_error() == Some(2) && not_found_budget > 0 => {
                not_found_budget -= 1;
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(e) => return Err(Unreachable(anyhow::anyhow!("opening {pipe_name}: {e}"))),
        }
    }
    Err(Unreachable(anyhow::anyhow!("{pipe_name} stayed busy")))
}

pub struct Response {
    pub status: u16,
    pub body: Bytes,
}

fn ipc_token() -> anyhow::Result<String> {
    std::fs::read_to_string(crate::state_dir().join("ipc.token"))
        .context("reading local IPC credential (is the daemon initialized?)")
        .map(|token| token.trim().to_owned())
}

impl Response {
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> anyhow::Result<T> {
        serde_json::from_slice(&self.body).with_context(|| {
            format!(
                "unexpected response body: {}",
                String::from_utf8_lossy(&self.body)
            )
        })
    }

    /// A message worth printing for a non-2xx response.
    ///
    /// The daemon's uniform `ApiError` body is preferred, then the raw body.
    /// Both can be empty — a rejected IPC credential is a bare 401 with no
    /// body — and `error:` on its own tells nobody anything, so the status
    /// gets the last word.
    pub fn error_message(&self) -> String {
        match serde_json::from_slice::<envmux_api_types::ApiError>(&self.body) {
            Ok(api) if !api.message.trim().is_empty() => return api.message,
            // A structured error with nothing in it is no more use than an
            // empty body, so fall through to the status rather than echoing
            // the JSON back at the reader.
            Ok(_) => {}
            Err(_) => {
                let body = String::from_utf8_lossy(&self.body);
                let body = body.trim();
                if !body.is_empty() {
                    return body.to_owned();
                }
            }
        }
        match self.status {
            401 => "unauthorized: the daemon rejected this client's credential. \
                    The CLI reads it from the state directory, so check that \
                    $ENVMUX_STATE_DIR matches the daemon's."
                .to_owned(),
            403 => "forbidden".to_owned(),
            404 => "not found".to_owned(),
            status => format!("the daemon returned HTTP {status} with no message"),
        }
    }
}

/// One request over a fresh IPC connection.
pub async fn request(
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> anyhow::Result<Response> {
    let stream = match connect().await {
        Ok(s) => s,
        Err(Unreachable(e)) => {
            // Exit code 4 is applied by main's error mapping.
            return Err(e.context(crate::DaemonUnreachable));
        }
    };
    let io = hyper_util::rt::TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await?;
    tokio::spawn(conn);

    let payload = match body {
        Some(v) => Bytes::from(serde_json::to_vec(&v)?),
        None => Bytes::new(),
    };
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "envmux")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {}", ipc_token()?))
        .body(Full::new(payload))?;
    let resp = sender.send_request(req).await?;
    let status = resp.status().as_u16();
    let body = resp.into_body().collect().await?.to_bytes();
    Ok(Response { status, body })
}

pub async fn get(path: &str) -> anyhow::Result<Response> {
    request("GET", path, None).await
}

pub async fn post(path: &str, body: serde_json::Value) -> anyhow::Result<Response> {
    request("POST", path, Some(body)).await
}

pub async fn delete(path: &str) -> anyhow::Result<Response> {
    request("DELETE", path, None).await
}

/// Upload raw bytes (tar) with PUT.
pub async fn put_bytes(path: &str, payload: Bytes) -> anyhow::Result<Response> {
    let stream = match connect().await {
        Ok(s) => s,
        Err(Unreachable(e)) => return Err(e.context(crate::DaemonUnreachable)),
    };
    let io = hyper_util::rt::TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await?;
    tokio::spawn(conn);
    let req = Request::builder()
        .method("PUT")
        .uri(path)
        .header("host", "envmux")
        .header("content-type", "application/x-tar")
        .header("authorization", format!("Bearer {}", ipc_token()?))
        .body(Full::new(payload))?;
    let resp = sender.send_request(req).await?;
    let status = resp.status().as_u16();
    let body = resp.into_body().collect().await?.to_bytes();
    Ok(Response { status, body })
}

/// Open a WebSocket over the IPC transport (HTTP upgrade on the same stream).
pub async fn websocket(
    path: &str,
) -> anyhow::Result<
    tokio_tungstenite::WebSocketStream<
        impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
    >,
> {
    let stream = match connect().await {
        Ok(s) => s,
        Err(Unreachable(e)) => return Err(e.context(crate::DaemonUnreachable)),
    };
    let mut request = format!("ws://envmux{path}").into_client_request()?;
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {}", ipc_token()?).parse()?);
    let (ws, resp) = tokio_tungstenite::client_async(request, stream)
        .await
        .context("websocket handshake")?;
    if resp.status().as_u16() != 101 {
        bail!("attach refused: HTTP {}", resp.status());
    }
    Ok(ws)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(status: u16, body: &str) -> Response {
        Response {
            status,
            body: Bytes::from(body.to_owned()),
        }
    }

    #[test]
    fn prefers_the_structured_error_body() {
        let r = response(
            400,
            r#"{"code":"Bad Request","message":"image must declare"}"#,
        );
        assert_eq!(r.error_message(), "image must declare");
    }

    #[test]
    fn falls_back_to_a_plain_body() {
        assert_eq!(response(500, "boom").error_message(), "boom");
    }

    #[test]
    fn an_empty_body_still_says_something_useful() {
        // Regression: a rejected IPC credential is a bare 401, and this used
        // to print `error:` with nothing after it.
        let message = response(401, "").error_message();
        assert!(message.contains("unauthorized"), "{message}");
        assert!(message.contains("ENVMUX_STATE_DIR"), "{message}");

        assert!(response(418, "").error_message().contains("418"));
        // An ApiError with an empty message is as useless as no body at all.
        let empty = response(401, r#"{"code":"Unauthorized","message":""}"#);
        assert!(empty.error_message().contains("unauthorized"));
    }
}
