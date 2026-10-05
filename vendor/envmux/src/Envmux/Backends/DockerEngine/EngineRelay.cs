using System.Globalization;
using System.Text;

using Envmux.Docker;
using Envmux.Incus;
using Envmux.Socks;

namespace Envmux.Backends.DockerEngine;

/// <summary>
/// A TCP connection made from inside a container, carried out over a Docker exec.
/// </summary>
/// <remarks>
/// <para>
/// The Docker twin of <see cref="InstanceRelay"/>, and the whole of how a
/// session on a Docker engine is reached: it publishes no port, so the SOCKS
/// proxy's <c>localhost</c> is this. The command is the same few lines of bash
/// (<see cref="InstanceRelay.Script"/>, reused rather than copied) opening the
/// port with <c>/dev/tcp</c> and copying both ways; what differs is the
/// channel. An Incus exec gives stdin, stdout and stderr as three websockets;
/// a Docker exec without a tty gives one hijacked connection, stdin raw going
/// in and stdout and stderr stdcopy-framed coming out. So the marker is waited
/// for on stream 2, and the stream handed back is stream 1's payloads with the
/// framing taken off.
/// </para>
/// <para>
/// <b>Ending it is the half-close.</b> The engine does not end a process when
/// its connection closes (<see cref="EngineExec"/> measured this), so a relay
/// that was merely hung up on would sit in the container until the far server
/// closed. Disposing the stream first says stdin has ended
/// (<see cref="IHalfClose"/>): <c>cat &lt;&amp;5</c> sees EOF and exits, the
/// script's <c>wait -n</c> returns, it kills the other copy, and bash goes.
/// Measured live: the relay's processes are gone about 70 ms after the dispose.
/// </para>
/// <para>
/// <b>Cost.</b> One exec per connection, as on Incus. Measured on Docker
/// Desktop 29.6.1 (API 1.55) over the named pipe, a <c>debian:trixie-slim</c>
/// container, a server on its own <c>127.0.0.1</c>: exec create, start and the
/// marker in 49 ms per dial at the median of twenty (27 min, 132 max; the first
/// of a run 71 ms) — the same order as the 50–65 ms <see cref="InstanceRelay"/>
/// pays against a LAN Incus, and a browser pays it per socket, not per request.
/// A 200 KB response then arrives in about 6 ms. A refused port comes back as
/// null in about 60 ms.
/// </para>
/// <para>
/// A dial that neither connects nor is refused — a host that drops SYNs —
/// times out here after <see cref="DialTimeout"/>, and the bash left behind
/// gives up on its own when the kernel's connect does, a minute or two later.
/// Nothing is leaked past that.
/// </para>
/// </remarks>
internal static class EngineRelay
{
    /// <summary>How long a dial inside the container may take before it counts as unreachable.</summary>
    private static readonly TimeSpan DialTimeout = TimeSpan.FromSeconds(15);

    /// <summary>
    /// What the relay writes on stderr once it is connected, and nothing else
    /// ever does. The same bytes <see cref="InstanceRelay.Script"/> prints —
    /// pinned by a test, since that constant is that class's own.
    /// </summary>
    internal const string Connected = "envmux-relay-connected";

    /// <summary>
    /// Dial <paramref name="port"/> on the first of <paramref name="hosts"/>
    /// that answers, from inside <paramref name="container"/>.
    /// </summary>
    /// <param name="user">Who dials, through <c>runuser</c>; null or empty is root.</param>
    /// <returns>The connection, or null when nothing answered.</returns>
    public static async Task<Stream?> DialAsync(
        IDockerEngine engine,
        string container,
        string? user,
        IReadOnlyList<string> hosts,
        int port,
        CancellationToken ct)
    {
        string[] relay =
        [
            "bash", "-c", InstanceRelay.Script, "envmux-relay",
            port.ToString(CultureInfo.InvariantCulture),
            .. hosts,
        ];

        // Root, and runuser drops when there is somebody to drop to — the same
        // shape as every other exec envmux runs, so the dial happens as the
        // session's account and sees what it would see.
        var id = await engine.ExecCreateAsync(
            container,
            new ExecCreate
            {
                Cmd = Command.AsUser(user, relay),
                Tty = false,
                AttachStdin = true,
                User = EngineExec.Root,
            },
            ct).ConfigureAwait(false);

        var connection = await engine.ExecStartAsync(id, tty: false, ct).ConfigureAwait(false);
        var stream = new RelayStream(connection);

        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(DialTimeout);

            if (await stream.ConnectedAsync(deadline.Token).ConfigureAwait(false))
            {
                return stream;
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // The dial took too long: unreachable, as far as the browser is concerned.
        }

        await stream.DisposeAsync().ConfigureAwait(false);
        return null;
    }

    /// <summary>
    /// The hijacked connection as one stream: stdout's payloads out, stdin in.
    /// </summary>
    /// <remarks>
    /// Frames are read header first and then payload straight into the
    /// caller's buffer (<see cref="StdCopyReader.ReadHeaderAsync"/>), across as
    /// many reads as the buffer needs, so a browser's download is not copied
    /// once more on the way. Stderr after the marker is drained and dropped:
    /// the script sends its errors to <c>/dev/null</c>, so there is none.
    /// </remarks>
    private sealed class RelayStream(Stream connection) : Stream
    {
        private readonly byte[] _header = new byte[StdCopy.HeaderLength];
        private byte _from;
        private int _remaining;
        private bool _ended;
        private bool _disposed;

        /// <summary>Read frames until the relay says it is connected, or the exec ends.</summary>
        /// <remarks>
        /// Nothing arrives on stdout before the marker — the script connects
        /// before it starts copying — so a stdout frame here is unexpected and
        /// is dropped rather than kept: it cannot be the server's, because the
        /// connection it would have come over does not exist yet.
        /// </remarks>
        public async Task<bool> ConnectedAsync(CancellationToken ct)
        {
            var said = new StringBuilder();

            await foreach (var (from, payload) in StdCopyReader.FramesAsync(connection, ct).ConfigureAwait(false))
            {
                if (from != StdCopy.Stderr)
                {
                    continue;
                }

                said.Append(Encoding.ASCII.GetString(payload.Span));

                if (said.ToString().Contains(Connected, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            _ended = true;
            return false;
        }

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
            if (_ended || buffer.Length == 0)
            {
                return 0;
            }

            try
            {
                while (true)
                {
                    if (_remaining == 0)
                    {
                        if (await StdCopyReader.ReadHeaderAsync(connection, _header, cancellationToken).ConfigureAwait(false)
                            is not var (from, length))
                        {
                            _ended = true;
                            return 0;
                        }

                        _from = from;
                        _remaining = length;
                        continue;
                    }

                    var take = buffer[..Math.Min(buffer.Length, _remaining)];
                    var read = await connection.ReadAsync(take, cancellationToken).ConfigureAwait(false);

                    if (read == 0)
                    {
                        _ended = true;
                        return 0;
                    }

                    _remaining -= read;

                    if (_from == StdCopy.Stderr)
                    {
                        // Drained into the caller's buffer and not reported: it
                        // is overwritten by the data that follows.
                        continue;
                    }

                    return read;
                }
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException)
            {
                // The engine hung up, or the listener disposed this under a
                // pending read. Either is the end.
                _ended = true;
                return 0;
            }
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            try
            {
                await connection.WriteAsync(buffer, cancellationToken).ConfigureAwait(false);
                await connection.FlushAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException)
            {
                throw new IOException("the relay in the container has gone", e);
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

        /// <summary>Half-close, so the script ends itself, then hang up.</summary>
        public override async ValueTask DisposeAsync()
        {
            if (!_disposed)
            {
                _disposed = true;

                if (connection is IHalfClose input)
                {
                    try
                    {
                        using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                        await input.CompleteWriteAsync(patience.Token).ConfigureAwait(false);
                    }
                    catch (Exception e) when (e is IOException or ObjectDisposedException or OperationCanceledException)
                    {
                        // Already gone, which is the end state being asked for.
                    }
                }

                await connection.DisposeAsync().ConfigureAwait(false);
            }

            await base.DisposeAsync().ConfigureAwait(false);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && !_disposed)
            {
                _ = DisposeAsync().AsTask();
            }

            base.Dispose(disposing);
        }
    }
}
