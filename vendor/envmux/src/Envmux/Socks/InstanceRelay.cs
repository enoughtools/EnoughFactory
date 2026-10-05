using System.Net.WebSockets;
using System.Text;

using Envmux.Docker;
using Envmux.Incus;

namespace Envmux.Socks;

/// <summary>
/// A TCP connection made from inside the instance, carried out over an Incus exec.
/// </summary>
/// <remarks>
/// <para>
/// The channel is the one envmux already has: an exec, non-interactive, so its
/// stdin and stdout are two byte-clean websockets. The command in the instance
/// opens the connection with bash's <c>/dev/tcp</c> and copies both ways, so
/// nothing has to be installed — bash is in every image a session can start
/// from — and a server that bound the instance's <c>127.0.0.1</c> is as
/// reachable as one that bound everything.
/// </para>
/// <para>
/// One exec per connection. A browser opens a handful per origin and keeps them
/// alive, so the cost of an exec is paid per socket rather than per request.
/// A multiplexed stream over one long-lived exec is the step after this, if
/// measurement asks for it; <c>docs/backends.md</c> already chose tunnel-over-exec
/// as the backend-neutral channel.
/// </para>
/// </remarks>
internal static class InstanceRelay
{
    /// <summary>How long a dial inside the instance may take before it counts as unreachable.</summary>
    private static readonly TimeSpan DialTimeout = TimeSpan.FromSeconds(15);

    /// <summary>
    /// What the relay writes on stderr once it is connected, and nothing else
    /// ever does: the dial's own errors go to <c>/dev/null</c>.
    /// </summary>
    private const string Connected = "envmux-relay-connected";

    /// <summary>
    /// The relay, given the port and then the addresses to try.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>command exec</c> rather than <c>exec</c>, because a failed redirection
    /// on the special builtin ends a POSIX shell and the second address would
    /// never be tried. Stdin is kept on fd 5 because bash gives a background job
    /// without job control <c>/dev/null</c> for stdin unless it is redirected
    /// explicitly.
    /// </para>
    /// <para>
    /// <c>wait -n</c> ends the relay when either direction does, and the other
    /// copy is killed so the exec's stdout closes. A browser never half-closes,
    /// so nothing is lost by not waiting for the other side to finish.
    /// </para>
    /// <para>
    /// The target reaches bash as arguments, never inside the script: a host
    /// name in a SOCKS request is up to 255 bytes of whatever the client liked.
    /// </para>
    /// </remarks>
    public static string Script { get; } = new StringBuilder()
        .Line("exec 4>&2 2>/dev/null 5<&0")
        .Line("port=$1; shift")
        .Line("for host in \"$@\"; do")
        .Line("  command exec 3<>\"/dev/tcp/$host/$port\" && break")
        .Line("done")
        .Line("{ true >&3; } 2>/dev/null || exit 1")
        .Line($"printf '{Connected}' >&4")
        .Line("exec 4>&-")
        .Line("cat <&3 & reader=$!")
        .Line("cat <&5 >&3 & writer=$!")
        .Line("wait -n")
        .Line("kill $reader $writer 2>/dev/null")
        .ToString();

    /// <summary>
    /// Dial <paramref name="port"/> on the first of <paramref name="hosts"/>
    /// that answers, from inside <paramref name="instance"/>.
    /// </summary>
    /// <returns>The connection, or null when nothing answered.</returns>
    public static async Task<Stream?> DialAsync(
        IncusApi api,
        string instance,
        string user,
        IReadOnlyList<string> hosts,
        int port,
        CancellationToken ct)
    {
        string[] command =
        [
            "bash", "-c", Script, "envmux-relay",
            port.ToString(System.Globalization.CultureInfo.InvariantCulture),
            .. hosts,
        ];

        var exec = await DockerExec.StartAsync(api, instance, command, tty: false, user: user, ct: ct)
            .ConfigureAwait(false);

        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(DialTimeout);

            if (await ConnectedAsync(exec.Sockets["2"], deadline.Token).ConfigureAwait(false))
            {
                return new ExecStream(exec);
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // The dial took too long: unreachable, as far as the browser is concerned.
        }

        await exec.DisposeAsync().ConfigureAwait(false);
        return null;
    }

    /// <summary>Read stderr until the relay says it is connected, or the relay ends.</summary>
    private static async Task<bool> ConnectedAsync(ClientWebSocket stderr, CancellationToken ct)
    {
        var said = new StringBuilder();
        var buffer = new byte[256];

        while (stderr.State == WebSocketState.Open)
        {
            var result = await stderr.ReceiveAsync(buffer, ct).ConfigureAwait(false);

            if (result.MessageType == WebSocketMessageType.Close || result.Count == 0)
            {
                break;
            }

            said.Append(Encoding.ASCII.GetString(buffer, 0, result.Count));

            if (said.ToString().Contains(Connected, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// The exec's stdin and stdout as one stream, so the listener pumps an
    /// instance connection exactly as it pumps a local one.
    /// </summary>
    /// <remarks>
    /// Incus ends an output stream with an <em>empty</em> message rather than a
    /// close (<see cref="ExecBridge"/> learned this), so either one reads as the
    /// end. Writes are one message each; the listener's pump is the only writer.
    /// </remarks>
    private sealed class ExecStream(DockerExec exec) : Stream
    {
        private readonly ClientWebSocket _stdin = exec.Stdin;
        private readonly ClientWebSocket _stdout = exec.Sockets["1"];
        private bool _ended;
        private bool _disposed;

        public override bool CanRead => true;

        public override bool CanWrite => true;

        public override bool CanSeek => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_ended || _stdout.State != WebSocketState.Open)
            {
                return 0;
            }

            try
            {
                var result = await _stdout.ReceiveAsync(buffer, cancellationToken).ConfigureAwait(false);

                if (result.MessageType == WebSocketMessageType.Close || (result.Count == 0 && result.EndOfMessage))
                {
                    _ended = true;
                    return 0;
                }

                return result.Count;
            }
            catch (WebSocketException)
            {
                _ended = true;
                return 0;
            }
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            try
            {
                await _stdin.SendAsync(buffer, WebSocketMessageType.Binary, endOfMessage: true, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (WebSocketException e)
            {
                throw new IOException("the relay in the instance has gone", e);
            }
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override async ValueTask DisposeAsync()
        {
            if (!_disposed)
            {
                _disposed = true;
                await exec.DisposeAsync().ConfigureAwait(false);
            }

            await base.DisposeAsync().ConfigureAwait(false);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && !_disposed)
            {
                _disposed = true;
                _ = exec.DisposeAsync().AsTask();
            }

            base.Dispose(disposing);
        }
    }
}
