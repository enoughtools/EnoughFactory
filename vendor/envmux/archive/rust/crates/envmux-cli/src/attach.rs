//! Terminal attach: raw mode via crossterm, spliced to the daemon's attach
//! WebSocket. Binary frames are raw PTY bytes; text frames carry control
//! JSON (resize) and server events. Detaching kills nothing.
//!
//! An attach outlives the thing it is attached to. Exiting the terminal's
//! program closes its tmux window, and closing the session's last window ends
//! the session — so the stream drops for reasons that have nothing to do with
//! the user wanting to leave. Reporting a dead socket at someone who typed
//! `exit` is no answer, so this reconnects instead, and the daemon
//! re-establishes a terminal for it to land in.

use std::time::{Duration, Instant};

use anyhow::{Context as _, bail};
use crossterm::terminal;
use envmux_api_types::AttachEvent;
use futures_util::{SinkExt as _, StreamExt as _};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio_tungstenite::tungstenite::Message;

use crate::client;

/// A connection that dies this fast was never a terminal someone exited; it
/// is a terminal that cannot come up.
const SETTLED: Duration = Duration::from_secs(2);

/// How many of those in a row to absorb before believing them. Reconnecting
/// forever would replace a clear error with a silent spin.
const GIVE_UP_AFTER: u32 = 3;

struct RawGuard;

impl RawGuard {
    fn enable() -> anyhow::Result<Self> {
        terminal::enable_raw_mode().context("enabling raw mode")?;
        Ok(Self)
    }
}

impl Drop for RawGuard {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
    }
}

/// How one connection ended.
enum Ended {
    /// The user left something that is still running, or our own stdin
    /// closed. Either way there is nobody to reconnect for.
    Detached,
    /// Nothing on the other end any more, with the reason to say out loud.
    Lost(String),
}

/// Counts reconnects that failed to stay up, so a workspace that cannot hold a
/// terminal fails loudly instead of spinning.
#[derive(Default)]
struct Backstop {
    consecutive: u32,
}

impl Backstop {
    /// Record a connection that lasted `alive`; false means stop trying.
    fn survived(&mut self, alive: Duration) -> bool {
        if alive >= SETTLED {
            self.consecutive = 0;
            return true;
        }
        self.consecutive += 1;
        self.consecutive < GIVE_UP_AFTER
    }
}

pub async fn attach(workspace_id: &str, task: Option<&str>, read_only: bool) -> anyhow::Result<()> {
    // Raw mode spans the reconnects, not each connection: dropping back to
    // cooked mode between them would flicker the terminal and let the
    // notice below be echoed by the local line discipline.
    let _raw = RawGuard::enable()?;
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut backstop = Backstop::default();

    loop {
        let opened = Instant::now();
        let ended = session(workspace_id, task, read_only, &mut stdin, &mut stdout).await?;
        let reason = match ended {
            Ended::Detached => return Ok(()),
            Ended::Lost(reason) => reason,
        };
        // A read-only client watches a terminal it does not own. Reconnecting
        // would ask the daemon to recreate one, which is exactly the side
        // effect this mode exists to avoid.
        if read_only {
            note(&mut stdout, &format!("{reason} — the session is over")).await;
            return Ok(());
        }
        if !backstop.survived(opened.elapsed()) {
            bail!("reconnected {GIVE_UP_AFTER} times and the terminal never stayed up ({reason})");
        }
        note(&mut stdout, &format!("{reason} — reconnecting…")).await;
    }
}

/// One connection, from handshake to whatever ended it.
async fn session(
    workspace_id: &str,
    task: Option<&str>,
    read_only: bool,
    stdin: &mut tokio::io::Stdin,
    stdout: &mut tokio::io::Stdout,
) -> anyhow::Result<Ended> {
    let mode = if read_only { "ro" } else { "rw" };
    let mut path = format!("/v1/workspaces/{workspace_id}/attach?mode={mode}");
    if let Some(task) = task {
        path.push_str(&format!("&task={task}"));
    }
    let ws = client::websocket(&path).await?;
    let (mut tx, mut rx) = ws.split();

    // Fresh exec, fresh pty: every connection states its own size.
    if let Ok((cols, rows)) = terminal::size() {
        let control = envmux_api_types::AttachControl::Resize { cols, rows };
        tx.send(Message::Text(serde_json::to_string(&control)?.into()))
            .await?;
    }

    let to_remote = async {
        let mut buf = [0u8; 4096];
        loop {
            let n = stdin.read(&mut buf).await?;
            if n == 0 {
                return anyhow::Ok(Ended::Detached);
            }
            tx.send(Message::Binary(buf[..n].to_vec().into())).await?;
        }
    };
    let to_local = async {
        // The daemon names the reason before it closes. Without one, a stream
        // that simply stopped is still a terminal that is not there.
        let mut ended = Ended::Lost("the connection dropped".to_owned());
        while let Some(msg) = rx.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    stdout.write_all(&data).await?;
                    stdout.flush().await?;
                }
                // Task and window notices are for display, not for how this
                // connection ended; only the two endings speak to that.
                Ok(Message::Text(text)) => match serde_json::from_str::<AttachEvent>(&text) {
                    Ok(AttachEvent::Detached) => ended = Ended::Detached,
                    Ok(AttachEvent::TerminalExited) => {
                        ended = Ended::Lost("the terminal exited".to_owned());
                    }
                    Ok(_) | Err(_) => {}
                },
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(e) => {
                    ended = Ended::Lost(format!("the connection dropped: {e}"));
                    break;
                }
            }
        }
        anyhow::Ok(ended)
    };

    tokio::select! {
        r = to_remote => r,
        r = to_local => r,
    }
}

/// One line of envmux's own voice on a terminal that belongs to tmux.
///
/// Raw mode means a bare `\n` steps down a line without returning the cursor
/// to column one, so the carriage returns are the message, not decoration.
async fn note(stdout: &mut tokio::io::Stdout, message: &str) {
    let _ = stdout
        .write_all(format!("\r\n[envmux] {message}\r\n").as_bytes())
        .await;
    let _ = stdout.flush().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A terminal someone exited, reconnected, and exited again is a normal
    /// afternoon — only immediate failures in a row mean give up.
    #[test]
    fn the_backstop_counts_only_connections_that_never_settled() {
        let mut backstop = Backstop::default();
        for _ in 0..10 {
            assert!(backstop.survived(Duration::from_secs(600)));
        }
        // Two instant deaths are absorbed; the third is believed.
        assert!(backstop.survived(Duration::ZERO));
        assert!(backstop.survived(Duration::from_millis(30)));
        assert!(!backstop.survived(Duration::from_millis(30)));
    }

    /// One connection that stayed up clears the count: a long session
    /// followed by a quick exit is not a failing workspace.
    #[test]
    fn a_settled_connection_resets_the_backstop() {
        let mut backstop = Backstop::default();
        assert!(backstop.survived(Duration::ZERO));
        assert!(backstop.survived(Duration::ZERO));
        assert!(backstop.survived(SETTLED));
        assert!(backstop.survived(Duration::ZERO));
        assert!(backstop.survived(Duration::ZERO));
        assert!(!backstop.survived(Duration::ZERO));
    }
}
