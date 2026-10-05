//! The daemon half of the in-container credential shim.
//!
//! A workspace container gets a copy of the `envmux-agent` binary and a
//! container-wide git credential helper pointing at it. The agent relays each
//! helper invocation over its exec stream — the one duplex channel that
//! exists on every platform without bind-mounted sockets or published ports —
//! and this module answers from the host side by invoking `git credential
//! fill`, which delegates to whatever credential manager the human already
//! uses (GCM, osxkeychain, libsecret).
//!
//! The guardrails, in order of importance:
//! - only `get` is answered; `store`/`erase` are acknowledged and dropped —
//!   the host manager already owns the credential, and a container must not
//!   be able to edit it;
//! - only hosts on the allowlist (derived from the namespace's remote) are
//!   filled — a process in the container cannot mine credentials for
//!   arbitrary hosts;
//! - the fill runs with prompts disabled, so an unknown host degrades to an
//!   empty reply instead of a daemon wedged on an invisible prompt;
//! - every fill, answered or refused, is an audit event.
//!
//! Framing matches `envmux-agent/src/main.rs`: 4-byte big-endian length +
//! UTF-8 payload, payload = action line + git-credential key=value block.
//! Change both together.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context as _;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio_util::sync::CancellationToken;

use crate::context::{Ctx, NamespaceCtx};

/// Where the agent lives inside the container.
pub const AGENT_PATH: &str = "/usr/local/bin/envmux-agent";

/// Find a linux agent binary to ship into containers.
///
/// Search order: an explicit `$ENVMUX_AGENT_BIN`, the state dir's `bin/`, the
/// installed layout beside the executable, and finally the cargo target dir a
/// development build produces (`cargo build -p envmux-agent --release
/// --target x86_64-unknown-linux-musl`). None found means the shim quietly
/// does not exist — a workspace without it behaves exactly as before.
#[must_use]
pub fn locate_agent_binary(state_dir: &std::path::Path) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("ENVMUX_AGENT_BIN") {
        let path = PathBuf::from(explicit);
        return path.is_file().then_some(path);
    }
    let mut candidates = vec![
        state_dir.join("bin").join("envmux-agent"),
        state_dir.join("bin").join("envmux-agent-linux-amd64"),
    ];
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join("envmux-agent-linux-amd64"));
        candidates.push(dir.join("envmux-agent"));
        // target/{debug,release}/envmux.exe -> target/<musl>/release/envmux-agent
        if let Some(target) = dir.parent() {
            candidates.push(
                target
                    .join("x86_64-unknown-linux-musl")
                    .join("release")
                    .join("envmux-agent"),
            );
        }
    }
    candidates.into_iter().find(|c| c.is_file())
}

/// Install the agent into a workspace container and start the bridge.
///
/// Missing binary or a failed install degrades to "no shim" with a log line,
/// never a failed provision: credentials-from-host is a convenience layered
/// on a working workspace, not a prerequisite for one.
pub async fn start(ctx: &Arc<Ctx>, ns: &Arc<NamespaceCtx>, container: &str, workspace: &str) {
    let Some(binary) = locate_agent_binary(&ctx.state_dir) else {
        tracing::debug!(
            container,
            "no envmux-agent binary found; credential shim off"
        );
        return;
    };
    if let Err(e) = install(ctx, container, &binary).await {
        tracing::warn!(container, error = %e, "credential shim install failed; continuing without");
        return;
    }

    let allowlist = allowed_hosts(ns).await;
    let docker = ctx.docker.clone();
    let cancel = ctx.shutdown.clone();
    let (ctx2, ns_name, ws_name, container) = (
        Arc::clone(ctx),
        ns.name.to_string(),
        workspace.to_owned(),
        container.to_owned(),
    );
    tokio::spawn(async move {
        match docker
            .exec_stream(
                &container,
                vec![AGENT_PATH.to_owned(), "serve".to_owned()],
                None,
                None,
                false,
            )
            .await
        {
            Ok(stream) => {
                run_bridge(&ctx2, stream, &allowlist, &ns_name, &ws_name, cancel).await;
            }
            Err(e) => {
                tracing::warn!(container, error = %e, "credential bridge exec failed");
            }
        }
    });
}

async fn install(ctx: &Arc<Ctx>, container: &str, binary: &std::path::Path) -> anyhow::Result<()> {
    let bytes = tokio::fs::read(binary)
        .await
        .with_context(|| format!("reading {}", binary.display()))?;
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o755);
    header.set_cksum();
    builder.append_data(&mut header, "envmux-agent", bytes.as_slice())?;
    let tar_bytes = builder.into_inner()?;
    ctx.docker
        .upload_tar(container, "/usr/local/bin", tar_bytes.into())
        .await
        .context("uploading agent binary")?;
    // System scope for the same reason as safe.directory: [workspace] user
    // may differ from root, and helper config must hold for whoever runs git.
    // Which is also why it is written *as* root — /etc/gitconfig is not the
    // workspace user's to write, and the default image's user is not root.
    let out = ctx
        .docker
        .run_exec(
            container,
            vec![
                "git".into(),
                "config".into(),
                "--system".into(),
                "credential.helper".into(),
                format!("{AGENT_PATH} credential"),
            ],
            Some("root"),
            None,
            vec![],
            None,
        )
        .await
        .context("configuring credential helper")?;
    anyhow::ensure!(out.success(), "git config failed: {}", out.stderr);
    Ok(())
}

/// The hosts this namespace's containers may request credentials for.
async fn allowed_hosts(ns: &Arc<NamespaceCtx>) -> BTreeSet<String> {
    let mut hosts = BTreeSet::new();
    // The repository's real remote — origin as workspaces see it. The
    // mirror's clone source is a local path in v2 and yields no host.
    if let Some(host) = remote_host(&ns.origin_remote) {
        hosts.insert(host);
    }
    let resolved = ns.resolved.read().await;
    if let Some(remote) = &resolved.config.mirror.remote
        && let Some(host) = remote_host(remote)
    {
        hosts.insert(host);
    }
    drop(resolved);
    // An explicit, daemon-side extension for repositories that legitimately
    // pull from more hosts than origin (submodules, cargo git deps). Set on
    // the daemon's environment, never from inside a container.
    if let Ok(extra) = std::env::var("ENVMUX_CREDENTIAL_HOSTS") {
        hosts.extend(
            extra
                .split(',')
                .map(str::trim)
                .filter(|host| !host.is_empty())
                .map(str::to_lowercase),
        );
    }
    hosts
}

/// One request-reply loop for a workspace's lifetime.
async fn run_bridge(
    ctx: &Arc<Ctx>,
    mut stream: envmux_docker::ExecStream,
    allowlist: &BTreeSet<String>,
    ns_name: &str,
    ws_name: &str,
    cancel: CancellationToken,
) {
    loop {
        let request = tokio::select! {
            () = cancel.cancelled() => return,
            frame = read_frame(&mut stream) => match frame {
                Ok(Some(payload)) => payload,
                // EOF or a broken stream: the container is going away.
                Ok(None) | Err(_) => return,
            },
        };
        let reply = answer(ctx, &request, allowlist, ns_name, ws_name).await;
        if write_frame(&mut stream, &reply).await.is_err() {
            return;
        }
    }
}

async fn answer(
    ctx: &Arc<Ctx>,
    request: &[u8],
    allowlist: &BTreeSet<String>,
    ns_name: &str,
    ws_name: &str,
) -> Vec<u8> {
    let text = String::from_utf8_lossy(request);
    let Some((action, block)) = text.split_once('\n') else {
        return Vec::new();
    };
    if action != "get" {
        // store/erase acknowledged, dropped: the host manager owns the
        // credential and the container does not get to edit it.
        return Vec::new();
    }
    let kvs = parse_kv_block(block);
    let host = kvs
        .iter()
        .find(|(k, _)| k == "host")
        .map(|(_, v)| v.clone());
    let Some(host) = host else { return Vec::new() };

    if !allowlist.contains(&host) {
        ctx.event(
            "warn",
            Some(ns_name),
            Some(ws_name),
            "credential",
            &format!("refused credential fill for {host} (not this repo's remote)"),
        )
        .await;
        return Vec::new();
    }

    match host_credential_fill(&kvs).await {
        Ok(filled) => {
            ctx.event(
                "info",
                Some(ns_name),
                Some(ws_name),
                "credential",
                &format!("filled credentials for {host} from the host manager"),
            )
            .await;
            filled
        }
        Err(e) => {
            tracing::debug!(host, error = %e, "host credential fill failed");
            Vec::new()
        }
    }
}

/// Ask the host's own git (and thus its credential manager) to fill.
async fn host_credential_fill(kvs: &[(String, String)]) -> anyhow::Result<Vec<u8>> {
    // Only the descriptive keys cross the boundary into the fill; anything
    // else a container sent is dropped.
    let mut input = String::new();
    for (key, value) in kvs {
        if matches!(key.as_str(), "protocol" | "host" | "path" | "username") {
            input.push_str(key);
            input.push('=');
            input.push_str(value);
            input.push('\n');
        }
    }
    input.push('\n');

    let mut child = tokio::process::Command::new("git");
    // The daemon has no console; without this, Windows allocates a visible
    // console window for every fill (same fix as GitRunner's quiet_command).
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        child.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = child
        .args(["credential", "fill"])
        // A daemon has no terminal; an unknown credential must come back as
        // a failure, not a prompt nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .context("spawning git credential fill")?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes()).await?;
        drop(stdin);
    }
    let out = child.wait_with_output().await?;
    anyhow::ensure!(out.status.success(), "git credential fill: {}", out.status);

    // Pass back only what git needs to authenticate.
    let filled = parse_kv_block(&String::from_utf8_lossy(&out.stdout));
    let mut reply = String::new();
    for (key, value) in &filled {
        if matches!(key.as_str(), "protocol" | "host" | "username" | "password") {
            reply.push_str(key);
            reply.push('=');
            reply.push_str(value);
            reply.push('\n');
        }
    }
    Ok(reply.into_bytes())
}

// ---------------------------------------------------------------------------
// Small pure pieces

fn parse_kv_block(block: &str) -> Vec<(String, String)> {
    block
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            (!key.is_empty()).then(|| (key.to_owned(), value.to_owned()))
        })
        .collect()
}

/// The host of a git remote, across the three spellings that matter:
/// `https://host/...`, `ssh://[user@]host[:port]/...`, and the scp-like
/// `user@host:path`.
#[must_use]
pub fn remote_host(remote: &str) -> Option<String> {
    let remote = remote.trim();
    if let Some(rest) = remote
        .strip_prefix("https://")
        .or_else(|| remote.strip_prefix("http://"))
        .or_else(|| remote.strip_prefix("ssh://"))
    {
        let authority = rest.split('/').next()?;
        let host = authority.rsplit('@').next()?;
        let host = host.split(':').next()?;
        return (!host.is_empty()).then(|| host.to_lowercase());
    }
    // scp-like: user@host:path — but not a Windows drive letter or a plain
    // local path.
    if let Some((authority, _path)) = remote.split_once(':')
        && authority.contains('@')
    {
        let host = authority.rsplit('@').next()?;
        return (!host.is_empty()).then(|| host.to_lowercase());
    }
    None
}

async fn read_frame(
    stream: &mut (impl tokio::io::AsyncRead + Unpin),
) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match stream.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > 1 << 20 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).await?;
    Ok(Some(payload))
}

async fn write_frame(
    stream: &mut (impl tokio::io::AsyncWrite + Unpin),
    payload: &[u8],
) -> std::io::Result<()> {
    let len = u32::try_from(payload.len())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "frame too large"))?;
    stream.write_all(&len.to_be_bytes()).await?;
    stream.write_all(payload).await?;
    stream.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_hosts_across_the_three_spellings() {
        assert_eq!(
            remote_host("https://github.com/acme/thing.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            remote_host("ssh://git@github.com:2222/acme/thing.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            remote_host("git@github.com:acme/thing.git").as_deref(),
            Some("github.com")
        );
        // Case-folded: hostnames compare case-insensitively.
        assert_eq!(
            remote_host("https://GitHub.COM/x").as_deref(),
            Some("github.com")
        );
        // Local paths are not hosts — a file remote must not allowlist "C".
        assert_eq!(remote_host("C:\\repos\\thing"), None);
        assert_eq!(remote_host("/srv/git/thing.git"), None);
        assert_eq!(remote_host("../elsewhere"), None);
    }

    #[test]
    fn kv_blocks_parse_and_ignore_junk() {
        let kvs = parse_kv_block("protocol=https\nhost=github.com\n\nnot a pair\n=empty\n");
        assert_eq!(
            kvs,
            vec![
                ("protocol".to_owned(), "https".to_owned()),
                ("host".to_owned(), "github.com".to_owned()),
            ]
        );
    }

    #[tokio::test]
    async fn frames_round_trip_async() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, b"get\nhost=example.com\n")
            .await
            .expect("write");
        let mut cursor = std::io::Cursor::new(buffer);
        let payload = read_frame(&mut cursor).await.expect("read").expect("some");
        assert_eq!(payload, b"get\nhost=example.com\n");
        // A clean EOF after the frame is "no more requests", not an error.
        assert!(read_frame(&mut cursor).await.expect("eof").is_none());
    }
}
