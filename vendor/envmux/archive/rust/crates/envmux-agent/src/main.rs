//! The in-container envmux agent.
//!
//! Two entry points, one small job — letting git inside a workspace use the
//! credentials of the human outside it, without those credentials ever being
//! stored in the container:
//!
//! - `envmux-agent serve` is started by the daemon over `docker exec` with
//!   its stdio attached. It listens on a unix socket inside the container and
//!   relays each request as one length-prefixed frame over stdout, then
//!   relays the daemon's framed reply back. The exec stream is the transport
//!   because it is the one channel that exists on every platform without
//!   bind-mounted sockets or published ports.
//! - `envmux-agent credential <get|store|erase>` is what git invokes (it is
//!   installed as the container's credential helper). It speaks the standard
//!   git-credential key=value protocol on its own stdio and forwards it
//!   through the socket.
//!
//! The daemon answers only `get`, and only for hosts it has allowlisted;
//! `store` and `erase` are acknowledged and dropped — the host's credential
//! manager already owns the credential. A missing socket or an empty reply
//! makes git fall through to whatever the image would have done anyway, so
//! the shim can only ever add capability.

/// Where the serve half listens and the credential half connects.
#[cfg_attr(not(unix), allow(dead_code))]
const SOCKET_PATH: &str = "/run/envmux/agent.sock";

fn main() {
    let mut args = std::env::args().skip(1);
    let code = match args.next().as_deref() {
        Some("serve") => serve(),
        Some("credential") => credential(args.next().as_deref()),
        _ => {
            eprintln!("usage: envmux-agent serve | envmux-agent credential <get|store|erase>");
            2
        }
    };
    std::process::exit(code);
}

// ---------------------------------------------------------------------------
// Framing: 4-byte big-endian length + UTF-8 payload. The payload's first line
// is the action; the rest is the git-credential key=value block. The daemon
// side mirrors this in `envmux-daemon/src/agent_bridge.rs` — change both.

#[cfg_attr(not(unix), allow(dead_code))]
fn write_frame(mut w: impl std::io::Write, payload: &[u8]) -> std::io::Result<()> {
    let len = u32::try_from(payload.len())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "frame too large"))?;
    w.write_all(&len.to_be_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

#[cfg_attr(not(unix), allow(dead_code))]
fn read_frame(mut r: impl std::io::Read) -> std::io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len) as usize;
    // A credential block is a few hundred bytes; a megabyte is already wrong.
    if len > 1 << 20 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok(payload)
}

// ---------------------------------------------------------------------------
// serve: unix socket -> stdio bridge (PID stays alive for the exec stream)

#[cfg(unix)]
fn serve() -> i32 {
    use std::os::unix::fs::PermissionsExt as _;

    let sock_dir = std::path::Path::new(SOCKET_PATH)
        .parent()
        .expect("socket path has a parent");
    if let Err(e) = std::fs::create_dir_all(sock_dir) {
        eprintln!("envmux-agent: creating {}: {e}", sock_dir.display());
        return 1;
    }
    // A previous agent's socket would make bind fail; the exec that started
    // us is the only live server by construction, so take the name over.
    let _ = std::fs::remove_file(SOCKET_PATH);
    let listener = match std::os::unix::net::UnixListener::bind(SOCKET_PATH) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("envmux-agent: binding {SOCKET_PATH}: {e}");
            return 1;
        }
    };
    // Any user inside the container may ask; the daemon decides what to
    // answer. Workspaces are single-human by design.
    let _ = std::fs::set_permissions(SOCKET_PATH, std::fs::Permissions::from_mode(0o666));

    // One request at a time: stdio is a single duplex channel, and
    // credential fills are rare, short, and never concurrent in practice.
    for conn in listener.incoming() {
        let Ok(mut conn) = conn else { continue };
        let request = match read_frame(&mut conn) {
            Ok(r) => r,
            Err(_) => continue,
        };
        // Relay to the daemon over our exec stdio and wait for its verdict.
        if write_frame(std::io::stdout().lock(), &request).is_err() {
            // stdout gone = the daemon hung up = this workspace is dying.
            return 0;
        }
        let reply = match read_frame(std::io::stdin().lock()) {
            Ok(r) => r,
            Err(_) => return 0,
        };
        let _ = write_frame(&mut conn, &reply);
    }
    0
}

#[cfg(not(unix))]
fn serve() -> i32 {
    eprintln!("envmux-agent serve only runs inside a Linux container");
    1
}

// ---------------------------------------------------------------------------
// credential: the helper git invokes

#[cfg(unix)]
fn credential(action: Option<&str>) -> i32 {
    use std::io::Read as _;
    use std::io::Write as _;

    let Some(action @ ("get" | "store" | "erase")) = action else {
        eprintln!("usage: envmux-agent credential <get|store|erase>");
        return 2;
    };

    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return 1;
    }

    // No socket means no bridge (agent not running, or a plain container).
    // Saying nothing lets git fall through to the image's own helpers.
    let Ok(mut sock) = std::os::unix::net::UnixStream::connect(SOCKET_PATH) else {
        return 0;
    };
    let payload = format!("{action}\n{input}");
    if write_frame(&mut sock, payload.as_bytes()).is_err() {
        return 0;
    }
    let Ok(reply) = read_frame(&mut sock) else {
        return 0;
    };
    let _ = std::io::stdout().lock().write_all(&reply);
    0
}

#[cfg(not(unix))]
fn credential(_action: Option<&str>) -> i32 {
    eprintln!("envmux-agent credential only runs inside a Linux container");
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, b"get\nhost=github.com\n").expect("write");
        let payload = read_frame(buffer.as_slice()).expect("read");
        assert_eq!(payload, b"get\nhost=github.com\n");
    }

    #[test]
    fn an_absurd_length_is_rejected_before_allocation() {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&u32::MAX.to_be_bytes());
        assert!(read_frame(buffer.as_slice()).is_err());
    }

    #[test]
    fn an_empty_frame_is_valid() {
        // The daemon's "no answer" is an empty payload, and git treats no
        // output as no credential — both directions must carry it.
        let mut buffer = Vec::new();
        write_frame(&mut buffer, b"").expect("write");
        assert_eq!(read_frame(buffer.as_slice()).expect("read"), b"");
    }
}
