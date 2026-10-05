using System.Net.WebSockets;

namespace Envmux.Docker;

/// <summary>
/// Pumps one hijacked exec between the client connection and Incus' sockets.
/// </summary>
/// <remarks>
/// <para>
/// This is the critical path (§4.4). In one direction, whatever the client
/// writes is stdin; in the other, Incus' output is framed for the client —
/// raw for a TTY, stdcopy-wrapped otherwise (§6.2). The frames are byte-faithful:
/// no line handling, no translation, backpressure honoured both ways.
/// </para>
/// <para>
/// Two subtleties, both learned rather than read. Incus signals a stream's EOF
/// with an <em>empty</em> websocket message, not a close — and on a PTY it
/// then leaves the socket open until the client lets go, so the empty message
/// is answered with a close from this side. And the operation finishing is not
/// the same event as the sockets closing: a PTY can outlive the command, and a
/// command's last output can arrive after the operation is done. So the bridge
/// ends when the output sockets close, with the operation only a fallback that
/// waits for the output to fall quiet first.
/// </para>
/// </remarks>
internal static class ExecBridge
{
    private static readonly TimeSpan OutputIdleGrace = TimeSpan.FromSeconds(2);

    /// <summary>
    /// Run the exec to completion over the connection, and return its exit code.
    /// </summary>
    /// <param name="connection">The client connection, for the half-close when output is done.</param>
    /// <param name="io">The hijacked stream: buffered reads from the client, writes to it.</param>
    /// <param name="exec">The Incus exec whose sockets are bridged.</param>
    /// <param name="ct">Cancellation.</param>
    public static async Task<int> RunAsync(IShimConnection connection, Stream io, DockerExec exec, CancellationToken ct)
    {
        using var finished = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var stream = io;
        var lastOutput = DateTime.UtcNow;
        var outputLock = new object();

        // Client → stdin. A read returning zero is the client's half-close,
        // which for a non-tty exec is stdin's EOF: close Incus' stdin socket so
        // a `cat` waiting on it can finish.
        async Task PumpInAsync()
        {
            var buffer = new byte[64 * 1024];

            try
            {
                while (true)
                {
                    var read = await stream.ReadAsync(buffer, finished.Token).ConfigureAwait(false);

                    if (read == 0)
                    {
                        break;
                    }

                    if (exec.Stdin.State == WebSocketState.Open)
                    {
                        await exec.Stdin.SendAsync(
                            buffer.AsMemory(0, read),
                            WebSocketMessageType.Binary,
                            endOfMessage: true,
                            finished.Token).ConfigureAwait(false);
                    }
                }
            }
            catch (Exception e) when (e is OperationCanceledException or WebSocketException or IOException
                                          or ObjectDisposedException or InvalidOperationException)
            {
                // The exec ended, or the client dropped. The other pumps notice.
            }

            if (!exec.Tty)
            {
                await CloseAsync(exec.Stdin).ConfigureAwait(false);
            }
        }

        // Incus stdout/stderr → client, framed. An empty message is EOF.
        async Task PumpOutAsync(string descriptor, byte stream_)
        {
            var socket = exec.Sockets[descriptor];
            var buffer = new byte[64 * 1024];

            while (socket.State == WebSocketState.Open)
            {
                WebSocketReceiveResult result;

                try
                {
                    result = await socket.ReceiveAsync(buffer, finished.Token).ConfigureAwait(false);
                }
                catch (Exception e) when (e is OperationCanceledException or WebSocketException or ObjectDisposedException)
                {
                    break;
                }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }

                if (result.Count == 0)
                {
                    // Incus' EOF for this stream. On a PTY the socket stays open
                    // afterwards, so close it to make the read above return.
                    await CloseAsync(socket).ConfigureAwait(false);
                    break;
                }

                var payload = buffer.AsMemory(0, result.Count);
                var out_ = exec.Tty ? payload : StdCopy.Frame(stream_, payload.Span).AsMemory();

                try
                {
                    await stream.WriteAsync(out_, finished.Token).ConfigureAwait(false);
                    await stream.FlushAsync(finished.Token).ConfigureAwait(false);
                }
                catch (Exception e) when (e is OperationCanceledException or IOException or ObjectDisposedException)
                {
                    break;
                }

                lock (outputLock)
                {
                    lastOutput = DateTime.UtcNow;
                }
            }
        }

        var outputs = exec.Tty
            ? [PumpOutAsync("0", StdCopy.Stdout)]
            : new[] { PumpOutAsync("1", StdCopy.Stdout), PumpOutAsync("2", StdCopy.Stderr) };

        var pumpIn = PumpInAsync();

        // The fallback: if the operation finishes but the sockets have not
        // closed, end once the output has been quiet for the grace period.
        var exitCode = 0;
        var operationDone = Task.Run(async () =>
        {
            exitCode = await exec.WaitAsync(ct).ConfigureAwait(false);

            while (!finished.IsCancellationRequested)
            {
                TimeSpan idle;
                lock (outputLock)
                {
                    idle = DateTime.UtcNow - lastOutput;
                }

                if (idle >= OutputIdleGrace)
                {
                    await finished.CancelAsync().ConfigureAwait(false);
                    return;
                }

                await Task.Delay(TimeSpan.FromMilliseconds(250), CancellationToken.None).ConfigureAwait(false);
            }
        }, CancellationToken.None);

        await Task.WhenAll(outputs).ConfigureAwait(false);

        // Output is done; the command's exit code is the authority.
        if (!finished.IsCancellationRequested)
        {
            await finished.CancelAsync().ConfigureAwait(false);
        }

        await pumpIn.ConfigureAwait(false);

        try
        {
            await operationDone.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // ct itself fired; the code below still reports what we have.
        }

        if (exitCode == 0 && !ct.IsCancellationRequested)
        {
            // The output closed before the wait returned; ask once more.
            exitCode = await SafeExitAsync(exec).ConfigureAwait(false);
        }

        await connection.CompleteWriteAsync(CancellationToken.None).ConfigureAwait(false);
        return exitCode;
    }

    private static async Task<int> SafeExitAsync(DockerExec exec)
    {
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            return await exec.WaitAsync(deadline.Token).ConfigureAwait(false);
        }
        catch (Exception e) when (e is Incus.IncusException or OperationCanceledException)
        {
            return 0;
        }
    }

    private static async Task CloseAsync(WebSocket socket)
    {
        if (socket.State != WebSocketState.Open)
        {
            return;
        }

        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, deadline.Token)
                .ConfigureAwait(false);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
            // Already gone.
        }
    }
}
