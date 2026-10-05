//! The control-mode client: commands written as lines, replies matched to
//! commands in send order by the begin/end framing, notifications fanned out
//! to subscribers.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use thiserror::Error;
use tokio::io::{AsyncBufReadExt as _, AsyncRead, AsyncWrite, AsyncWriteExt as _, BufReader};
use tokio::sync::{broadcast, oneshot};

use crate::protocol::{ControlEvent, Parser, Reply};
use crate::{RUN_DIR, SESSION, TERMINAL_WINDOW};

#[derive(Debug, Error)]
pub enum TmuxError {
    #[error("tmux stream closed")]
    Closed,
    #[error("tmux command failed: {0}")]
    Command(String),
    #[error("tmux io: {0}")]
    Io(#[from] std::io::Error),
    #[error("unexpected tmux output: {0}")]
    Parse(String),
}

/// A window as reported by `list-windows`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub name: String,
    pub dead: bool,
    /// `pane_dead_status` where tmux reports it — advisory only; the task
    /// engine reads real exit codes from `.exit` files.
    pub dead_status: Option<i32>,
}

type PendingQueue = Arc<Mutex<VecDeque<oneshot::Sender<Reply>>>>;

/// A live control-mode session over any byte stream (a Docker exec stream in
/// production, a duplex pipe in tests).
pub struct TmuxClient {
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Unpin + Send>>,
    pending: PendingQueue,
    events: broadcast::Sender<ControlEvent>,
    reader_task: tokio::task::JoinHandle<()>,
}

impl Drop for TmuxClient {
    fn drop(&mut self) {
        self.reader_task.abort();
    }
}

impl TmuxClient {
    /// Split a bidirectional stream and start the read loop.
    pub fn new<S>(stream: S) -> Self
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (read, write) = tokio::io::split(stream);
        let pending: PendingQueue = Arc::new(Mutex::new(VecDeque::new()));
        let (events_tx, _) = broadcast::channel(1024);

        let reader_pending = Arc::clone(&pending);
        let reader_events = events_tx.clone();
        let reader_task = tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            let mut parser = Parser::new();
            // tmux emits one spontaneous empty reply pair on control-mode
            // attach; routing it to a command waiter would desync the queue.
            let mut initial_swallowed = false;
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(event) = parser.feed_line(&line) {
                    if let ControlEvent::Reply(reply) = event {
                        if !initial_swallowed {
                            initial_swallowed = true;
                            continue;
                        }
                        let waiter = reader_pending.lock().expect("pending lock").pop_front();
                        if let Some(tx) = waiter {
                            let _ = tx.send(reply);
                        }
                    } else {
                        let _ = reader_events.send(event);
                    }
                }
            }
            // Stream ended: fail all waiters by dropping their senders.
            reader_pending.lock().expect("pending lock").clear();
        });

        Self {
            writer: tokio::sync::Mutex::new(Box::new(write)),
            pending,
            events: events_tx,
            reader_task,
        }
    }

    /// Subscribe to notifications (`%output`, window events, `%exit`, …).
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<ControlEvent> {
        self.events.subscribe()
    }

    /// Send one command line and await its framed reply.
    pub async fn command(&self, cmd: &str) -> Result<String, TmuxError> {
        let (tx, rx) = oneshot::channel();
        {
            let mut writer = self.writer.lock().await;
            self.pending.lock().expect("pending lock").push_back(tx);
            writer.write_all(cmd.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await?;
        }
        let reply = rx.await.map_err(|_| TmuxError::Closed)?;
        if reply.error {
            Err(TmuxError::Command(reply.body))
        } else {
            Ok(reply.body)
        }
    }

    // -- task-engine surface -------------------------------------------------

    /// Create a detached window running a wrapped task command, with
    /// `remain-on-exit` so scrollback survives for debugging.
    pub async fn new_task_window(&self, task: &str, wrapped_cmd: &str) -> Result<(), TmuxError> {
        self.command(&format!(
            "new-window -d -t {SESSION}: -n {task} {}",
            crate::wrap::sh_quote(wrapped_cmd)
        ))
        .await?;
        self.command(&format!(
            "set-option -w -t {SESSION}:{task} remain-on-exit on"
        ))
        .await?;
        Ok(())
    }

    /// Kill a task window (restart path re-creates it).
    pub async fn kill_window(&self, task: &str) -> Result<(), TmuxError> {
        self.command(&format!("kill-window -t {SESSION}:{task}"))
            .await?;
        Ok(())
    }

    /// List windows with dead state.
    pub async fn list_windows(&self) -> Result<Vec<WindowInfo>, TmuxError> {
        let body = self
            .command(&format!(
                "list-windows -t {SESSION}: -F '#{{window_name}}\t#{{pane_dead}}\t#{{pane_dead_status}}'"
            ))
            .await?;
        let mut windows = Vec::new();
        for line in body.lines().filter(|l| !l.trim().is_empty()) {
            let line = line.trim_matches('\'');
            let mut parts = line.split('\t');
            let name = parts.next().unwrap_or_default().to_owned();
            let dead = parts.next() == Some("1");
            let dead_status = parts.next().and_then(|s| s.parse().ok());
            windows.push(WindowInfo {
                name,
                dead,
                dead_status,
            });
        }
        Ok(windows)
    }
}

/// The exec command line the daemon uses to open the control stream.
///
/// `initial_command` runs in the session's first window — the one an attach
/// lands in — so `[workspace] terminal = "claude"` drops the user straight
/// into the agent. It only takes effect when this call *creates* the session
/// (`-A` attaches silently when one exists), which is exactly right: the
/// terminal choice is a provision-time property, not a per-attach one. tmux
/// hands a single trailing argument to the default shell, so a full command
/// line works unquoted.
///
/// The window is named [`TERMINAL_WINDOW`] so a later attach can tell "the
/// terminal is still there" from "its program exited" — see [`attach_cmd`].
#[must_use]
pub fn control_attach_cmd(initial_command: Option<&str>) -> Vec<String> {
    let mut cmd: Vec<String> = vec![
        "tmux".into(),
        "-CC".into(),
        "-u".into(),
        "new-session".into(),
        "-A".into(),
        "-D".into(),
        "-s".into(),
        SESSION.into(),
        "-n".into(),
        TERMINAL_WINDOW.into(),
    ];
    if let Some(initial) = initial_command {
        cmd.push(initial.into());
    }
    cmd
}

/// The exec command line for a plain client attach (session broker).
///
/// A read-write attach re-establishes what it needs before attaching: the
/// session, and — when no task was asked for — the interactive
/// [`TERMINAL_WINDOW`] running `terminal`. Both can legitimately be gone,
/// because exiting the terminal's program closes its window, and tmux
/// destroys a session whose last window closed. Reattaching is then the
/// natural thing to do, so it has to work: `exit` should hand back a fresh
/// shell rather than a dead socket. Nothing here touches a workspace whose
/// session and window are still up.
///
/// A named task is never invented — that window belongs to the task engine or
/// to an ad-hoc session, and a shell wearing its name would be a lie. The
/// attach selects it if it is there and lands in the session either way.
///
/// A read-only attach creates nothing at all: watching a workspace must not
/// bring its terminal back to life. It attaches to what exists, or fails.
#[must_use]
pub fn attach_cmd(task: Option<&str>, read_only: bool, terminal: Option<&str>) -> Vec<String> {
    if read_only {
        let mut cmd = vec![
            "tmux".to_owned(),
            "attach".to_owned(),
            "-r".to_owned(),
            "-t".to_owned(),
            SESSION.to_owned(),
        ];
        if let Some(task) = task {
            cmd.extend([
                ";".to_owned(),
                "select-window".to_owned(),
                "-t".to_owned(),
                format!("{SESSION}:{task}"),
            ]);
        }
        return cmd;
    }

    // tmux runs a trailing shell-command argument through the default shell,
    // so the configured terminal rides as one quoted word — the same deal
    // `control_attach_cmd` makes, and the same command in the same window.
    let run = terminal
        .map(|t| format!(" {}", crate::wrap::sh_quote(t)))
        .unwrap_or_default();
    let mut script = format!(
        "tmux has-session -t {SESSION} 2>/dev/null || \
         tmux new-session -d -s {SESSION} -n {TERMINAL_WINDOW}{run}\n"
    );
    match task {
        Some(task) => script.push_str(&format!(
            "tmux select-window -t {SESSION}:{task} 2>/dev/null || :\n"
        )),
        None => script.push_str(&format!(
            "tmux select-window -t {SESSION}:{TERMINAL_WINDOW} 2>/dev/null || \
             tmux new-window -t {SESSION}: -n {TERMINAL_WINDOW}{run}\n"
        )),
    }
    // exec, so the exec'd process the daemon is streaming *is* the tmux
    // client: no shell left in the middle to swallow its exit.
    script.push_str(&format!("exec tmux attach -t {SESSION}\n"));
    vec!["sh".to_owned(), "-c".to_owned(), script]
}

/// Command ensuring the run dir for exit files exists (run once per
/// workspace before the first task window).
///
/// Created as root but left writable by everyone, `/tmp`-style: the tasks that
/// write `<task>.exit` into it run as `[workspace] user`, which the default
/// image makes a non-root account. A root-owned 0755 directory here reads as
/// every task failing to report an exit code at all.
#[must_use]
pub fn ensure_run_dir_cmd() -> Vec<String> {
    vec![
        "sh".into(),
        "-c".into(),
        format!("mkdir -p {RUN_DIR} && chmod 1777 {RUN_DIR}"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive the client against a scripted fake tmux over a duplex pipe.
    #[tokio::test]
    async fn command_reply_matching_and_events() {
        let (client_side, mut server_side) = tokio::io::duplex(4096);
        let client = TmuxClient::new(client_side);
        let mut events = client.subscribe();

        let server = tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
            let (read, mut write) = tokio::io::split(&mut server_side);
            let mut lines = BufReader::new(read).lines();

            // The attach guard reply (swallowed by the client) and an
            // unsolicited notification before any command.
            write
                .write_all(b"\x1bP1000p%begin 1 0 1\n%end 1 0 1\n%session-changed $0 envmux\n")
                .await
                .unwrap();

            // First command → ok reply; second → error reply.
            let first = lines.next_line().await.unwrap().unwrap();
            assert!(first.contains("list-windows"));
            write
                .write_all(b"%begin 1 1 1\n0: dev* (1 panes)\n%end 1 1 1\n")
                .await
                .unwrap();

            let second = lines.next_line().await.unwrap().unwrap();
            assert!(second.contains("kill-window"));
            write
                .write_all(b"%begin 1 2 1\ncan't find window\n%error 1 2 1\n")
                .await
                .unwrap();
        });

        let body = client.command("list-windows -t envmux:").await.unwrap();
        assert_eq!(body, "0: dev* (1 panes)");

        let err = client
            .command("kill-window -t envmux:zzz")
            .await
            .unwrap_err();
        assert!(matches!(err, TmuxError::Command(m) if m.contains("can't find window")));

        let ev = events.recv().await.unwrap();
        assert_eq!(
            ev,
            ControlEvent::SessionChanged {
                session: "$0".into(),
                name: "envmux".into()
            }
        );

        server.await.unwrap();
    }

    #[test]
    fn attach_cmds_shape() {
        assert_eq!(
            control_attach_cmd(None),
            vec![
                "tmux",
                "-CC",
                "-u",
                "new-session",
                "-A",
                "-D",
                "-s",
                "envmux",
                "-n",
                "terminal"
            ]
        );
        // A configured terminal rides as ONE trailing argument — tmux gives
        // it to the default shell, so a full command line stays intact.
        let with_terminal = control_attach_cmd(Some("claude --continue"));
        assert_eq!(with_terminal.last().unwrap(), "claude --continue");
        assert_eq!(with_terminal.len(), control_attach_cmd(None).len() + 1);
        let ro = attach_cmd(Some("dev"), true, None);
        assert!(ro.contains(&"-r".to_owned()));
        assert!(ro.last().unwrap().ends_with(":dev"));
        let rw = attach_cmd(None, false, None);
        assert!(!rw.contains(&"-r".to_owned()));
    }

    /// The read-write attach is the reconnect path: a session and a terminal
    /// window that exited a moment ago must both come back.
    #[test]
    fn a_read_write_attach_recreates_what_exiting_destroyed() {
        let cmd = attach_cmd(None, false, Some("claude --continue"));
        assert_eq!(cmd[0], "sh");
        assert_eq!(cmd[1], "-c");
        let script = &cmd[2];
        // Session first: exiting the last window takes the session with it.
        assert!(script.contains("has-session -t envmux"), "{script}");
        assert!(
            script.contains("new-session -d -s envmux -n terminal 'claude --continue'"),
            "{script}"
        );
        // Then the window, with the same command, only if it is missing.
        assert!(
            script.contains("select-window -t envmux:terminal 2>/dev/null || "),
            "{script}"
        );
        assert!(
            script.contains("new-window -t envmux: -n terminal 'claude --continue'"),
            "{script}"
        );
        assert!(script.trim_end().ends_with("exec tmux attach -t envmux"));
        // No terminal configured means the image's own shell, not an empty
        // argument that tmux would try to run.
        let plain = attach_cmd(None, false, None);
        assert!(
            plain[2].contains("new-window -t envmux: -n terminal\n"),
            "{}",
            plain[2]
        );
    }

    /// A task's window is selected, never created: the task engine owns it.
    #[test]
    fn attaching_to_a_task_never_invents_its_window() {
        let script = attach_cmd(Some("dev"), false, None).remove(2);
        assert!(
            script.contains("select-window -t envmux:dev 2>/dev/null || :"),
            "{script}"
        );
        assert!(!script.contains("new-window -t envmux: -n dev"), "{script}");
        // The session itself is still ensured — without one there is nothing
        // to select in.
        assert!(script.contains("has-session -t envmux"), "{script}");
    }

    /// Read-only attach is a spectator: it must not create a session, a
    /// window, or a shell.
    #[test]
    fn read_only_attach_creates_nothing() {
        for task in [None, Some("dev")] {
            let cmd = attach_cmd(task, true, Some("claude"));
            assert_eq!(cmd[0], "tmux");
            let joined = cmd.join(" ");
            assert!(!joined.contains("new-session"), "{joined}");
            assert!(!joined.contains("new-window"), "{joined}");
            assert!(!joined.contains("claude"), "{joined}");
        }
    }
}
