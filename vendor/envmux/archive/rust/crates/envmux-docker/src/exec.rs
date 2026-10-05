//! Exec streams: `exec_create`/`exec_start` wrapped into an [`ExecStream`]
//! implementing `AsyncRead + AsyncWrite`. Used by the tmux client,
//! in-container git, service `mc` calls, and file transfer.

use std::pin::Pin;
use std::task::{Context, Poll};

use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bytes::{Buf as _, BytesMut};
use futures_util::StreamExt as _;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::{DockerError, DockerHandle};

/// Captured output of a one-shot exec.
#[derive(Debug, Clone)]
pub struct ExecOutput {
    pub exit_code: i64,
    pub stdout: String,
    pub stderr: String,
}

impl ExecOutput {
    #[must_use]
    pub fn success(&self) -> bool {
        self.exit_code == 0
    }
}

/// A live exec session as one bidirectional byte stream.
pub struct ExecStream {
    pub exec_id: String,
    output: Pin<
        Box<
            dyn futures_util::Stream<
                    Item = Result<bollard::container::LogOutput, bollard::errors::Error>,
                > + Send,
        >,
    >,
    input: Pin<Box<dyn AsyncWrite + Send>>,
    buffer: BytesMut,
    eof: bool,
}

impl ExecStream {
    /// Poll the exec's exit code once the stream has ended.
    pub async fn exit_code(&self, docker: &DockerHandle) -> Result<Option<i64>, DockerError> {
        let inspect = docker.raw().inspect_exec(&self.exec_id).await?;
        Ok(inspect.exit_code)
    }
}

impl AsyncRead for ExecStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        loop {
            if !self.buffer.is_empty() {
                let n = self.buffer.len().min(buf.remaining());
                buf.put_slice(&self.buffer[..n]);
                self.buffer.advance(n);
                return Poll::Ready(Ok(()));
            }
            if self.eof {
                return Poll::Ready(Ok(()));
            }
            match self.output.as_mut().poll_next(cx) {
                Poll::Ready(Some(Ok(log))) => {
                    // stdout and stderr are interleaved into one byte stream;
                    // callers that need separation use `run` instead.
                    self.buffer.extend_from_slice(&log.into_bytes());
                }
                Poll::Ready(Some(Err(e))) => {
                    return Poll::Ready(Err(std::io::Error::other(e)));
                }
                Poll::Ready(None) => {
                    self.eof = true;
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

impl AsyncWrite for ExecStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        self.input.as_mut().poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        self.input.as_mut().poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        self.input.as_mut().poll_shutdown(cx)
    }
}

impl DockerHandle {
    /// Open an interactive exec stream (TTY) in a container. The tmux client
    /// and attach brokering run over this.
    pub async fn exec_stream(
        &self,
        container: &str,
        cmd: Vec<String>,
        user: Option<&str>,
        working_dir: Option<&str>,
        tty: bool,
    ) -> Result<ExecStream, DockerError> {
        let create = self
            .raw()
            .create_exec(
                container,
                CreateExecOptions {
                    cmd: Some(cmd),
                    user: user.map(str::to_owned),
                    working_dir: working_dir.map(str::to_owned),
                    attach_stdin: Some(true),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    tty: Some(tty),
                    ..Default::default()
                },
            )
            .await?;
        let started = self
            .raw()
            .start_exec(
                &create.id,
                Some(StartExecOptions {
                    detach: false,
                    tty,
                    ..Default::default()
                }),
            )
            .await?;
        match started {
            StartExecResults::Attached { output, input } => Ok(ExecStream {
                exec_id: create.id,
                output: Box::pin(output),
                input,
                buffer: BytesMut::new(),
                eof: false,
            }),
            StartExecResults::Detached => Err(DockerError::Exec {
                context: container.to_owned(),
                message: "exec unexpectedly detached".into(),
            }),
        }
    }

    /// Resize a live exec's TTY (terminal attach resize control frames).
    pub async fn resize_exec(
        &self,
        exec_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), DockerError> {
        self.raw()
            .resize_exec(
                exec_id,
                bollard::exec::ResizeExecOptions {
                    height: rows,
                    width: cols,
                },
            )
            .await?;
        Ok(())
    }

    /// Run a command to completion in a container, capturing stdout, stderr,
    /// and the real exit code. Optionally feed stdin.
    pub async fn run_exec(
        &self,
        container: &str,
        cmd: Vec<String>,
        user: Option<&str>,
        working_dir: Option<&str>,
        env: Vec<String>,
        stdin: Option<&[u8]>,
    ) -> Result<ExecOutput, DockerError> {
        let create = self
            .raw()
            .create_exec(
                container,
                CreateExecOptions {
                    cmd: Some(cmd),
                    user: user.map(str::to_owned),
                    working_dir: working_dir.map(str::to_owned),
                    env: if env.is_empty() { None } else { Some(env) },
                    attach_stdin: Some(stdin.is_some()),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    tty: Some(false),
                    ..Default::default()
                },
            )
            .await?;
        let started = self.raw().start_exec(&create.id, None).await?;
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        match started {
            StartExecResults::Attached {
                mut output,
                mut input,
            } => {
                if let Some(data) = stdin {
                    use tokio::io::AsyncWriteExt as _;
                    input.write_all(data).await.map_err(|e| DockerError::Exec {
                        context: container.to_owned(),
                        message: format!("writing stdin: {e}"),
                    })?;
                    input.shutdown().await.ok();
                }
                while let Some(chunk) = output.next().await {
                    match chunk? {
                        bollard::container::LogOutput::StdOut { message } => {
                            stdout.extend_from_slice(&message);
                        }
                        bollard::container::LogOutput::StdErr { message } => {
                            stderr.extend_from_slice(&message);
                        }
                        _ => {}
                    }
                }
            }
            StartExecResults::Detached => {
                return Err(DockerError::Exec {
                    context: container.to_owned(),
                    message: "exec unexpectedly detached".into(),
                });
            }
        }
        let inspect = self.raw().inspect_exec(&create.id).await?;
        Ok(ExecOutput {
            exit_code: inspect.exit_code.unwrap_or(-1),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }
}
