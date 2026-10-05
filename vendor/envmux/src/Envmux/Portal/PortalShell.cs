using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

using Envmux.Incus;

namespace Envmux.Portal;

/// <summary>
/// A shell in the instance, spliced to a terminal in a browser tab.
/// </summary>
/// <remarks>
/// <para>
/// One socket is one attachment, and the shell behind it is latched. Closing
/// the tab detaches; opening it again finds the same shell, mid-command, with
/// its scrollback. That used to be the wrong answer — a shell that outlived
/// envmux would have outlived the container it was in — and it is the right one
/// now, because the instance is a machine that outlives envmux by design.
/// </para>
/// <para>
/// The wire is the instance's pty with the browser's half made explicit: bytes
/// from the instance arrive as binary frames and are written to the terminal;
/// binary frames from the browser are keystrokes and go to the pty; text frames
/// are control messages, and the only one is
/// <c>{"resize":{"cols":C,"rows":R}}</c>. Keeping keystrokes on binary frames
/// is what stops the server having to consider whether each keystroke might be
/// JSON.
/// </para>
/// </remarks>
internal static class PortalShell
{
    /// <summary>How much is read from the pty at once.</summary>
    /// <remarks>
    /// A full-screen redraw of a wide terminal is a few tens of kilobytes and
    /// arrives as one burst; anything smaller only splits it into more frames.
    /// </remarks>
    private const int BufferSize = 16 * 1024;

    /// <summary>The two escape sequences the server writes for itself.</summary>
    /// <remarks>
    /// Everything envmux says on this socket is said quietly, so that the one
    /// line it adds to a shell's output cannot be mistaken for the shell's.
    /// </remarks>
    private const string Dim = "\u001b[2m";

    private const string Plain = "\u001b[0m";

    /// <summary>How long the last words are given to get out.</summary>
    /// <remarks>
    /// The close frame has been written and a browser answers it at once; this
    /// is the ceiling for one that has stopped listening, not a wait anybody
    /// meets.
    /// </remarks>
    private static readonly TimeSpan Farewell = TimeSpan.FromSeconds(2);

    /// <summary>For the one thing the server says that is bad news.</summary>
    private const string Red = "\u001b[31m";

    /// <summary>
    /// The script that drops a terminal straight into a mounted coding tool.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The tool is <em>exec</em>'d, so it is the process the pty is attached to
    /// and quitting it ends the shell — dropping into <c>claude</c> should feel
    /// like running <c>claude</c>, not like a shell that happens to have run it.
    /// </para>
    /// <para>
    /// Where it is not there, the terminal says so and hands over a shell
    /// instead of closing a second after it opened. That case is common enough
    /// to be worth the two lines: mounting a tool's state says it is signed in
    /// on the host, and says nothing at all about whether the image has it
    /// installed.
    /// </para>
    /// <para>
    /// <c>~/.local/bin</c> is put on the <c>PATH</c> first, because a Debian
    /// <c>.profile</c> would have and the account envmux bootstraps does not
    /// have one — and because that is exactly where Claude Code's own installer
    /// puts itself. Without this, installing a tool the way its documentation
    /// says to leaves a button reporting that it is not installed.
    /// </para>
    /// <para>
    /// Both values are composed into a shell command, and both are ours: the
    /// name has been checked against the tools this session mounted, and the
    /// shell is the one from the resolved plan.
    /// </para>
    /// </remarks>
    public static string LaunchScript(string tool, string shell) =>
        $"export PATH=\"$HOME/.local/bin:$HOME/bin:$PATH\"; " +
        $"if command -v {tool} >/dev/null 2>&1; then exec {tool}; fi; " +
        $"printf '{Red}envmux: {tool} is not installed in this container{Plain}\\n'; " +
        $"printf '{Dim}its state from your machine is mounted, so installing it here finds you signed in{Plain}\\n'; " +
        $"exec {shell}";

    /// <summary>Pump both ways until either end closes.</summary>
    public static async Task PumpAsync(WebSocket socket, Backends.IInteractiveExec exec, CancellationToken ct)
    {
        var terminal = exec.Terminal;

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var token = linked.Token;

        var outbound = OutboundAsync();
        var inbound = InboundAsync();
        Task? first = null;

        try
        {
            first = await Task.WhenAny(outbound, inbound).ConfigureAwait(false);
        }
        catch
        {
            // Whichever side failed, the other is about to be cancelled and the
            // socket about to be closed. Nothing here would be improved by
            // reporting it.
        }

        // Everything the server has left to say has to be said now, while the
        // socket is still healthy. Cancelling a pending ReceiveAsync does not
        // end it politely — it aborts the WebSocket — so a message written
        // after the cancellation below is a message nobody receives. This is
        // only worth doing when it was the shell that ended: when it was the
        // browser, there is nobody on the other end to tell.
        if (first == outbound)
        {
            await EpilogueAsync().ConfigureAwait(false);
            await FinishAsync(socket).ConfigureAwait(false);

            // A moment for the close to be acknowledged, so the last frames go
            // out cleanly rather than being cut off by the abort below.
            await Task.WhenAny(inbound, Task.Delay(Farewell, ct)).ConfigureAwait(false);
        }

        await linked.CancelAsync().ConfigureAwait(false);

        try
        {
            await Task.WhenAll(outbound, inbound).ConfigureAwait(false);
        }
        catch
        {
            // Expected: cancelling is how this ends.
        }

        await CloseAsync(socket).ConfigureAwait(false);

        async Task OutboundAsync()
        {
            var buffer = new byte[BufferSize];

            while (!token.IsCancellationRequested)
            {
                var read = await terminal.ReadAsync(buffer, token).ConfigureAwait(false);

                if (read == 0 || socket.State != WebSocketState.Open)
                {
                    // The exec ended, or the tab did. Either way the shell is
                    // over rather than paused.
                    break;
                }

                await socket
                    .SendAsync(new ArraySegment<byte>(buffer, 0, read), WebSocketMessageType.Binary, true, token)
                    .ConfigureAwait(false);
            }
        }

        async Task InboundAsync()
        {
            var buffer = new byte[BufferSize];

            while (!token.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                var received = await socket.ReceiveAsync(buffer, token).ConfigureAwait(false);

                if (received.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }

                if (received.Count == 0)
                {
                    continue;
                }

                if (received.MessageType == WebSocketMessageType.Text &&
                    TryReadResize(buffer.AsSpan(0, received.Count), out var columns, out var rows))
                {
                    // Down the exec's control socket, because the one under this
                    // one is busy being a terminal.
                    await exec.ResizeAsync(columns, rows, token).ConfigureAwait(false);
                    continue;
                }

                await terminal.WriteAsync(buffer.AsMemory(0, received.Count), token).ConfigureAwait(false);
                await terminal.FlushAsync(token).ConfigureAwait(false);
            }
        }

        // What it exited with, if the host still remembers. A shell that ended
        // because the command in it failed is worth being told about; without
        // this the terminal simply stops answering and looks broken.
        async Task EpilogueAsync()
        {
            try
            {
                var code = await exec.ExitCodeAsync(CancellationToken.None).ConfigureAwait(false);
                var said = code?.ToString(CultureInfo.InvariantCulture) ?? "—";

                await SayAsync(socket, $"\r\n{Dim}-- shell exited {said}{Plain}\r\n", CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch (Exception e) when (e is IncusException or WebSocketException or ObjectDisposedException)
            {
                // The host may have forgotten the operation and the browser may
                // have gone. Neither deserves a stack trace.
            }
        }
    }

    /// <summary>Say something to the terminal in the browser, as text.</summary>
    /// <remarks>
    /// For the two things the server has to say for itself — why a shell could
    /// not be opened, and what one exited with. Everything else on this socket
    /// came out of the container.
    /// </remarks>
    public static async Task SayAsync(WebSocket socket, string message, CancellationToken ct)
    {
        if (socket.State != WebSocketState.Open)
        {
            return;
        }

        try
        {
            await socket.SendAsync(Encoding.UTF8.GetBytes(message), WebSocketMessageType.Text, true, ct)
                .ConfigureAwait(false);
        }
        catch (WebSocketException)
        {
            // Saying why the shell failed is best-effort by definition.
        }
    }

    /// <summary>
    /// Say we are done, without waiting to be answered.
    /// </summary>
    /// <remarks>
    /// <c>CloseOutputAsync</c> rather than <c>CloseAsync</c>: the full close
    /// waits for the other end's close frame, and the thing that would read it
    /// is the receive loop this is being called instead of.
    /// </remarks>
    private static async Task FinishAsync(WebSocket socket)
    {
        if (socket.State != WebSocketState.Open)
        {
            return;
        }

        try
        {
            await socket
                .CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "shell ended", CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (WebSocketException)
        {
            // The connection went first. There was nothing left to say anyway.
        }
    }

    /// <summary>Close it, without making a fuss if it has already gone.</summary>
    public static async Task CloseAsync(WebSocket socket)
    {
        if (socket.State != WebSocketState.Open)
        {
            return;
        }

        try
        {
            await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "shell closed", CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (WebSocketException)
        {
            // The other end closed first, which is the usual way this happens.
        }
    }

    /// <summary>Read a <c>{"resize":{"cols":C,"rows":R}}</c> control frame.</summary>
    internal static bool TryReadResize(ReadOnlySpan<byte> frame, out int columns, out int rows)
    {
        columns = 0;
        rows = 0;

        try
        {
            using var document = JsonDocument.Parse(frame.ToArray());

            if (!document.RootElement.TryGetProperty("resize", out var resize) ||
                !resize.TryGetProperty("cols", out var wide) ||
                !resize.TryGetProperty("rows", out var tall))
            {
                return false;
            }

            columns = wide.GetInt32();
            rows = tall.GetInt32();

            // A zero-column terminal is a tab that has not been laid out yet,
            // and telling the pty about it makes everything drawn since wrong.
            return columns > 0 && rows > 0;
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException)
        {
            // Not a control frame, so it was keystrokes — which is all a text
            // frame that is not this JSON can have been.
            return false;
        }
    }
}
