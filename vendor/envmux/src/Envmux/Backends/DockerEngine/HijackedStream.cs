using System.Globalization;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Text;

namespace Envmux.Backends.DockerEngine;

/// <summary>
/// A connection the engine has stopped speaking HTTP on: after
/// <c>101 UPGRADED</c> it is the exec's own bytes, both ways.
/// </summary>
/// <remarks>
/// <para>
/// The request is written by hand on a connection of its own, and not sent
/// through <see cref="HttpClient"/>. What is wanted is the raw duplex stream
/// after the header block, owned outright — closing it must close the
/// connection, and a half-close must reach the transport — and a pooled
/// handler's view of an <c>Upgrade: tcp</c> it has never heard of is not
/// something to build a terminal on. It is a dozen lines of HTTP/1.1.
/// </para>
/// <para>
/// <b>EOF.</b> When the process exits the engine ends its side: a socket is
/// shut down, and on Windows' message-mode pipe it writes a zero-length
/// message, which a byte-mode reader sees as a read of zero. Either way
/// <see cref="ReadAsync(Memory{byte}, CancellationToken)"/> returns 0, once,
/// and keeps returning it.
/// </para>
/// <para>
/// <b>Half-close.</b> <see cref="CompleteWriteAsync"/> is "stdin has ended"
/// without hanging up — what <c>cat &gt; file</c> is waiting for. On a socket
/// that is <c>shutdown(SHUT_WR)</c>; on the pipe it is the same zero-length
/// message in the other direction, which .NET's pipe stream will not write
/// (it drops an empty write), so it is the raw <c>WriteFile</c>
/// <see cref="Envmux.Docker.Windows.MessagePipeListener"/> already has.
/// </para>
/// </remarks>
internal sealed class HijackedStream : Stream, IHalfClose
{
    private readonly Stream _inner;
    private ReadOnlyMemory<byte> _leftover;
    private bool _ended;
    private bool _writeCompleted;

    private HijackedStream(Stream inner, ReadOnlyMemory<byte> leftover)
    {
        _inner = inner;
        _leftover = leftover;
    }

    /// <summary>
    /// Send one upgrade request on a fresh connection and hand back what follows the response's headers.
    /// </summary>
    /// <exception cref="DockerEngineException">The engine answered with anything but the upgrade; its message is the exception's.</exception>
    public static async Task<HijackedStream> OpenAsync(
        EngineEndpoint endpoint,
        string path,
        string jsonBody,
        CancellationToken ct)
    {
        var connection = await endpoint.ConnectAsync(ct).ConfigureAwait(false);

        try
        {
            var body = Encoding.UTF8.GetBytes(jsonBody);

            var head = Encoding.ASCII.GetBytes(
                $"POST {path} HTTP/1.1\r\n" +
                $"Host: {endpoint.HostHeader}\r\n" +
                "User-Agent: envmux\r\n" +
                "Content-Type: application/json\r\n" +
                "Connection: Upgrade\r\n" +
                "Upgrade: tcp\r\n" +
                $"Content-Length: {body.Length.ToString(CultureInfo.InvariantCulture)}\r\n" +
                "\r\n");

            // One write: on a message-mode pipe each write is a message, and
            // there is no reason to make the engine reassemble two.
            var request = new byte[head.Length + body.Length];
            head.CopyTo(request, 0);
            body.CopyTo(request, head.Length);

            await connection.WriteAsync(request, ct).ConfigureAwait(false);
            await connection.FlushAsync(ct).ConfigureAwait(false);

            var (status, headers, leftover) = await ReadHeadAsync(connection, ct).ConfigureAwait(false);

            // 101 when the upgrade was honoured; 200 from an engine that hijacks
            // without saying so. Both are followed by the raw stream.
            if (status is 101 or 200)
            {
                return new HijackedStream(connection, leftover);
            }

            var text = await ReadErrorBodyAsync(connection, headers, leftover, ct).ConfigureAwait(false);

            throw new DockerEngineException(
                EngineJson.ErrorMessage(text) ?? $"POST {path} answered {status.ToString(CultureInfo.InvariantCulture)}")
            {
                Status = status,
            };
        }
        catch (Exception e)
        {
            await connection.DisposeAsync().ConfigureAwait(false);

            if (e is IOException or SocketException)
            {
                throw new DockerEngineException($"the connection to Docker on {endpoint.Display} broke while opening an exec: {e.Message}", e);
            }

            throw;
        }
    }

    /// <summary>
    /// Read up to the blank line. What was read past it already belongs to the exec.
    /// </summary>
    private static async Task<(int Status, Dictionary<string, string> Headers, ReadOnlyMemory<byte> Leftover)> ReadHeadAsync(
        Stream connection,
        CancellationToken ct)
    {
        var buffer = new byte[4096];
        var filled = 0;

        while (true)
        {
            var end = buffer.AsSpan(0, filled).IndexOf("\r\n\r\n"u8);

            if (end >= 0)
            {
                var lines = Encoding.ASCII.GetString(buffer, 0, end).Split("\r\n");
                var parts = lines[0].Split(' ', 3);

                if (parts.Length < 2 || !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var status))
                {
                    throw new DockerEngineException($"what answered is not a Docker engine: it said '{lines[0]}'");
                }

                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

                foreach (var line in lines.Skip(1))
                {
                    var colon = line.IndexOf(':', StringComparison.Ordinal);

                    if (colon > 0)
                    {
                        headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
                    }
                }

                return (status, headers, buffer.AsMemory(end + 4, filled - end - 4));
            }

            if (filled == buffer.Length)
            {
                throw new DockerEngineException("the engine's answer to an exec had headers longer than any engine sends");
            }

            var read = await connection.ReadAsync(buffer.AsMemory(filled), ct).ConfigureAwait(false);

            if (read == 0)
            {
                throw new DockerEngineException("the engine closed the connection before answering an exec");
            }

            filled += read;
        }
    }

    /// <summary>The body of a refusal, which is small and says why.</summary>
    private static async Task<string> ReadErrorBodyAsync(
        Stream connection,
        Dictionary<string, string> headers,
        ReadOnlyMemory<byte> leftover,
        CancellationToken ct)
    {
        using var body = new MemoryStream();
        body.Write(leftover.Span);

        // With a length, read that much. Without one the engine closes when it
        // is done — and if it is chunked the framing is left in, which for one
        // line of JSON between two chunk markers ErrorMessage reads well enough.
        var wanted = headers.TryGetValue("Content-Length", out var length) &&
                     int.TryParse(length, NumberStyles.None, CultureInfo.InvariantCulture, out var n)
            ? n
            : 64 * 1024;

        var chunked = headers.TryGetValue("Transfer-Encoding", out var encoding) &&
                      encoding.Contains("chunked", StringComparison.OrdinalIgnoreCase);

        var buffer = new byte[4096];

        using var patience = CancellationTokenSource.CreateLinkedTokenSource(ct);
        patience.CancelAfter(TimeSpan.FromSeconds(5));

        try
        {
            // Chunked is how the engine actually answers, on a connection it
            // keeps open: the last chunk is the only end there is.
            while (body.Length < wanted && !(chunked && EndsWithLastChunk(body)))
            {
                var read = await connection.ReadAsync(buffer, patience.Token).ConfigureAwait(false);

                if (read == 0)
                {
                    break;
                }

                body.Write(buffer, 0, read);
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // Kept alive and chunked: what has arrived is the message.
        }

        var text = Encoding.UTF8.GetString(body.GetBuffer(), 0, (int)body.Length);

        // Chunked: "2f\r\n{json}\r\n0\r\n\r\n". Keep the JSON.
        var open = text.IndexOf('{', StringComparison.Ordinal);
        var close = text.LastIndexOf('}');

        return open >= 0 && close > open ? text[open..(close + 1)] : text;
    }

    private static bool EndsWithLastChunk(MemoryStream body) =>
        body.Length >= 5 && body.GetBuffer().AsSpan(0, (int)body.Length).EndsWith("0\r\n\r\n"u8);

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
        if (buffer.Length == 0 || _ended)
        {
            return 0;
        }

        if (_leftover.Length > 0)
        {
            var take = Math.Min(_leftover.Length, buffer.Length);
            _leftover[..take].CopyTo(buffer);
            _leftover = _leftover[take..];
            return take;
        }

        int read;

        try
        {
            read = await _inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
        }
        catch (IOException) when (!cancellationToken.IsCancellationRequested)
        {
            // "The pipe has been ended", "connection reset": the engine hung up
            // rather than half-closing. To a reader that is the same event.
            read = 0;
        }

        if (read == 0)
        {
            // Sticky. On a message pipe a zero read is one empty message, and
            // the read after it would wait for a next message that never comes.
            _ended = true;
        }

        return read;
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public override int Read(byte[] buffer, int offset, int count) =>
        ReadAsync(buffer.AsMemory(offset, count), CancellationToken.None).AsTask().GetAwaiter().GetResult();

    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
    {
        // An empty write on a message pipe would BE the end-of-input signal if
        // it got through; it is never what a caller copying a stream meant.
        return buffer.Length == 0 ? ValueTask.CompletedTask : _inner.WriteAsync(buffer, cancellationToken);
    }

    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public override void Write(byte[] buffer, int offset, int count)
    {
        if (count > 0)
        {
            _inner.Write(buffer, offset, count);
        }
    }

    public override void Flush() => _inner.Flush();

    public override Task FlushAsync(CancellationToken cancellationToken) => _inner.FlushAsync(cancellationToken);

    /// <inheritdoc/>
    public async ValueTask CompleteWriteAsync(CancellationToken ct = default)
    {
        if (_writeCompleted)
        {
            return;
        }

        _writeCompleted = true;

        try
        {
            await _inner.FlushAsync(ct).ConfigureAwait(false);

            switch (_inner)
            {
                case NetworkStream network:
                    network.Socket.Shutdown(SocketShutdown.Send);
                    break;

                case NamedPipeClientStream pipe when OperatingSystem.IsWindows():
                    Envmux.Docker.Windows.MessagePipeListener.Native.WriteEof(pipe.SafePipeHandle);
                    break;
            }
        }
        catch (Exception e) when (e is IOException or SocketException or ObjectDisposedException)
        {
            // Already gone, which is the end state that was being asked for.
        }
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _inner.Dispose();
        }

        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await _inner.DisposeAsync().ConfigureAwait(false);
        await base.DisposeAsync().ConfigureAwait(false);
    }
}
