using System.Buffers;
using System.Globalization;
using System.IO.Pipelines;
using System.Text;
using System.Text.Json;

namespace Envmux.Docker;

/// <summary>Something the client sent that is not HTTP the shim can serve.</summary>
internal sealed class ShimProtocolException(string message) : Exception(message);

/// <summary>One request, parsed as far as the shim needs.</summary>
/// <remarks>
/// The API version prefix the CLI puts on every path — <c>/v1.47/containers/json</c>
/// — is already stripped from <see cref="Path"/>.
/// </remarks>
internal sealed record ShimRequest
{
    public required string Method { get; init; }

    public required string Path { get; init; }

    public required IReadOnlyDictionary<string, string> Query { get; init; }

    public required IReadOnlyDictionary<string, string> Headers { get; init; }

    /// <summary>The body, bounded by its length or its chunking. Empty when there is none.</summary>
    public required Stream Body { get; init; }

    /// <summary>
    /// Signalled if the client goes away while the handler is still working.
    /// </summary>
    /// <remarks>
    /// Only watched on a request with no body — watching means reading, and a
    /// read while the body is being read is two readers on one connection.
    /// That covers the two that need it: a <c>wait</c> the client abandons,
    /// and an <c>events</c> stream it stops listening to.
    /// </remarks>
    public CancellationToken Aborted { get; init; }

    /// <summary>Whether the client asked to take the connection over (<c>Connection: Upgrade</c>).</summary>
    public bool WantsUpgrade =>
        Headers.TryGetValue("Connection", out var connection) &&
        connection.Contains("upgrade", StringComparison.OrdinalIgnoreCase);

    public string this[string query] => Query.TryGetValue(query, out var value) ? value : "";

    public async Task<T?> JsonAsync<T>(CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        await Body.CopyToAsync(buffer, ct).ConfigureAwait(false);

        return buffer.Length == 0
            ? default
            : WireJson.Deserialize<T>(buffer.GetBuffer().AsSpan(0, (int)buffer.Length), DockerJson.Options);
    }
}

/// <summary>
/// The response side of one request: headers once, then a body, a stream, or
/// the connection itself.
/// </summary>
internal sealed class ShimResponse(Stream output, Func<Stream> hijack) : IDisposable
{
    private static readonly Dictionary<int, string> Reasons = new()
    {
        [101] = "UPGRADED",
        [200] = "OK",
        [201] = "Created",
        [204] = "No Content",
        [400] = "Bad Request",
        [404] = "Not Found",
        [405] = "Method Not Allowed",
        [500] = "Internal Server Error",
    };

    private readonly SemaphoreSlim _writing = new(1, 1);
    private bool _chunked;

    public bool Started { get; private set; }

    public bool Hijacked { get; private set; }

    /// <summary>Headers to add to whatever is sent next. Cleared once the head is written.</summary>
    public Dictionary<string, string> Headers { get; } = new(StringComparer.OrdinalIgnoreCase);

    public Task JsonAsync(object value, CancellationToken ct) => JsonAsync(value, 200, ct);

    public Task JsonAsync(object value, int status, CancellationToken ct) =>
        BytesAsync(WireJson.SerializeToUtf8Bytes(value, DockerJson.Options), status, "application/json", ct);

    public Task ErrorAsync(int status, string message, CancellationToken ct) =>
        JsonAsync(WireJson.Object(DockerJson.Options, ("message", message)), status, ct);

    public Task EmptyAsync(int status, CancellationToken ct) => BytesAsync([], status, null, ct);

    public async Task BytesAsync(byte[] body, int status, string? contentType, CancellationToken ct)
    {
        if (contentType is not null)
        {
            Headers["Content-Type"] = contentType;
        }

        Headers["Content-Length"] = body.Length.ToString(CultureInfo.InvariantCulture);

        await _writing.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await output.WriteAsync(Head(status), ct).ConfigureAwait(false);

            if (body.Length > 0)
            {
                await output.WriteAsync(body, ct).ConfigureAwait(false);
            }

            await output.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _writing.Release();
        }
    }

    /// <summary>Send the head of a response whose length is not known: chunked, until <see cref="EndStreamAsync"/>.</summary>
    public async Task StartStreamAsync(int status, string contentType, CancellationToken ct)
    {
        Headers["Content-Type"] = contentType;
        Headers["Transfer-Encoding"] = "chunked";
        _chunked = true;

        await _writing.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await output.WriteAsync(Head(status), ct).ConfigureAwait(false);
            await output.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _writing.Release();
        }
    }

    public async Task WriteChunkAsync(ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        if (!_chunked || data.Length == 0)
        {
            return;
        }

        await _writing.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await output.WriteAsync(
                Encoding.ASCII.GetBytes(data.Length.ToString("x", CultureInfo.InvariantCulture) + "\r\n"),
                ct).ConfigureAwait(false);
            await output.WriteAsync(data, ct).ConfigureAwait(false);
            await output.WriteAsync("\r\n"u8.ToArray(), ct).ConfigureAwait(false);
            await output.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _writing.Release();
        }
    }

    public async Task EndStreamAsync(CancellationToken ct)
    {
        if (!_chunked)
        {
            return;
        }

        _chunked = false;

        await _writing.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await output.WriteAsync("0\r\n\r\n"u8.ToArray(), ct).ConfigureAwait(false);
            await output.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _writing.Release();
        }
    }

    /// <summary>
    /// Answer 101 and hand the raw connection back.
    /// </summary>
    /// <remarks>
    /// What Docker calls a hijack. From here on the connection is not HTTP: it
    /// is the exec's bytes in both directions until the shim ends it, and the
    /// client reads EOF as the command being over. The content type says which
    /// framing to expect (§6.2).
    /// </remarks>
    public async Task<Stream> HijackAsync(bool tty, CancellationToken ct)
    {
        Headers["Content-Type"] = tty
            ? "application/vnd.docker.raw-stream"
            : "application/vnd.docker.multiplexed-stream";
        Headers["Connection"] = "Upgrade";
        Headers["Upgrade"] = "tcp";

        await _writing.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await output.WriteAsync(Head(101), ct).ConfigureAwait(false);
            await output.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _writing.Release();
        }

        Hijacked = true;
        return hijack();
    }

    private byte[] Head(int status)
    {
        Started = true;

        var head = new StringBuilder();
        head.Append(CultureInfo.InvariantCulture, $"HTTP/1.1 {status} {(Reasons.TryGetValue(status, out var reason) ? reason : "Status")}\r\n");
        head.Append(CultureInfo.InvariantCulture, $"Api-Version: {DockerShim.ApiVersion}\r\n");
        head.Append("Server: envmux\r\n");

        foreach (var (name, value) in Headers)
        {
            head.Append(CultureInfo.InvariantCulture, $"{name}: {value}\r\n");
        }

        head.Append("\r\n");
        Headers.Clear();

        return Encoding.ASCII.GetBytes(head.ToString());
    }

    public void Dispose() => _writing.Dispose();
}

/// <summary>
/// Just enough HTTP/1.1 to serve the docker CLI over a duplex stream.
/// </summary>
/// <remarks>
/// <para>
/// Hand-written, and deliberately: Kestrel refuses an upgrade request that
/// carries a body (<c>UpgradeRequestCannotHavePayload</c>), and Docker's
/// <c>POST /exec/{id}/start</c> is exactly that — a JSON body with
/// <c>Connection: Upgrade</c> on it. There is one client, its requests are
/// simple, and a loop that reads a head, hands over a body, and steps out of
/// the way on a hijack is smaller than an argument with a framework.
/// </para>
/// <para>
/// Keep-alive is honoured: the CLI reuses connections, and a hijack can arrive
/// on one that has already served a dozen inspects.
/// </para>
/// </remarks>
internal sealed class ShimHttp(Stream stream) : IAsyncDisposable
{
    private readonly PipeReader _reader = PipeReader.Create(stream, new StreamPipeReaderOptions(leaveOpen: true));

    /// <summary>
    /// Serve requests until the client stops, or a handler takes the connection.
    /// </summary>
    /// <returns>True if the connection was hijacked and is now the handler's.</returns>
    public async Task<bool> ServeAsync(Func<ShimRequest, ShimResponse, Task> handler, CancellationToken ct)
    {
        while (true)
        {
            var head = await ReadHeadAsync(ct).ConfigureAwait(false);

            if (head is null)
            {
                return false;
            }

            var (request, bodyless) = Parse(head, out var body);
            using var aborted = new CancellationTokenSource();
            var watching = bodyless ? WatchForDisconnectAsync(aborted) : Task.CompletedTask;

            using var response = new ShimResponse(stream, () => new HijackedStream(_reader.AsStream(leaveOpen: true), stream));

            try
            {
                await handler(request with { Aborted = aborted.Token }, response).ConfigureAwait(false);
            }
            catch (Exception e) when (!response.Started &&
                                      e is Incus.IncusException or IOException or JsonException
                                          or InvalidOperationException or ShimProtocolException)
            {
                await response.ErrorAsync(500, $"envmux: {e.Message}", ct).ConfigureAwait(false);
            }

            if (bodyless)
            {
                _reader.CancelPendingRead();
                await watching.ConfigureAwait(false);
            }

            if (response.Hijacked)
            {
                return true;
            }

            if (!response.Started)
            {
                await response.ErrorAsync(404, $"envmux shim: nothing answered {request.Method} {request.Path}", ct)
                    .ConfigureAwait(false);
            }

            // Whatever the handler did not read of the body is still in the
            // connection, and would be read as the next request line.
            await body.DrainAsync(ct).ConfigureAwait(false);

            if (aborted.IsCancellationRequested ||
                (request.Headers.TryGetValue("Connection", out var connection) &&
                 connection.Equals("close", StringComparison.OrdinalIgnoreCase)))
            {
                return false;
            }
        }
    }

    private async Task WatchForDisconnectAsync(CancellationTokenSource aborted)
    {
        try
        {
            var result = await _reader.ReadAsync(CancellationToken.None).ConfigureAwait(false);

            if (result.IsCanceled)
            {
                return;
            }

            if (result.Buffer.IsEmpty && result.IsCompleted)
            {
                await aborted.CancelAsync().ConfigureAwait(false);
            }

            _reader.AdvanceTo(result.Buffer.Start, result.Buffer.End);
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidOperationException)
        {
            await aborted.CancelAsync().ConfigureAwait(false);
        }
    }

    private async Task<string?> ReadHeadAsync(CancellationToken ct)
    {
        while (true)
        {
            var result = await _reader.ReadAsync(ct).ConfigureAwait(false);
            var buffer = result.Buffer;
            var reader = new SequenceReader<byte>(buffer);

            if (reader.TryReadTo(out ReadOnlySequence<byte> head, "\r\n\r\n"u8, advancePastDelimiter: true))
            {
                var text = Encoding.ASCII.GetString(head);
                _reader.AdvanceTo(reader.Position);
                return text;
            }

            if (result.IsCompleted || result.IsCanceled)
            {
                _reader.AdvanceTo(buffer.End);
                return null;
            }

            _reader.AdvanceTo(buffer.Start, buffer.End);
        }
    }

    private (ShimRequest Request, bool Bodyless) Parse(string head, out BodyStream body)
    {
        var lines = head.Split("\r\n");
        var parts = lines[0].Split(' ', 3);

        if (parts.Length < 2)
        {
            throw new ShimProtocolException($"not a request line: {lines[0]}");
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

        var target = parts[1];
        var question = target.IndexOf('?', StringComparison.Ordinal);
        var path = question < 0 ? target : target[..question];
        var query = question < 0 ? "" : target[(question + 1)..];

        // The CLI prefixes the API version it negotiated: /v1.47/containers/json.
        if (path.StartsWith("/v", StringComparison.Ordinal))
        {
            var slash = path.IndexOf('/', 1);
            var version = slash < 0 ? path[2..] : path[2..slash];

            if (version.Length > 0 && version.All(c => char.IsAsciiDigit(c) || c == '.'))
            {
                path = slash < 0 ? "/" : path[slash..];
            }
        }

        var chunked = headers.TryGetValue("Transfer-Encoding", out var encoding) &&
                      encoding.Contains("chunked", StringComparison.OrdinalIgnoreCase);
        var length = headers.TryGetValue("Content-Length", out var lengthText) &&
                     long.TryParse(lengthText, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : 0;

        body = chunked ? BodyStream.Chunked(_reader) : BodyStream.OfLength(_reader, length);

        return (new ShimRequest
        {
            Method = parts[0],
            Path = path,
            Query = ParseQuery(query),
            Headers = headers,
            Body = body,
        }, !chunked && length == 0);
    }

    internal static IReadOnlyDictionary<string, string> ParseQuery(string query)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = pair.IndexOf('=', StringComparison.Ordinal);
            var name = Uri.UnescapeDataString(eq < 0 ? pair : pair[..eq]);
            map[name] = eq < 0 ? "" : Uri.UnescapeDataString(pair[(eq + 1)..].Replace('+', ' '));
        }

        return map;
    }

    public async ValueTask DisposeAsync()
    {
        await _reader.CompleteAsync().ConfigureAwait(false);
    }
}

/// <summary>A request body read out of the connection: exactly this many bytes, or these chunks.</summary>
internal sealed class BodyStream : Stream
{
    private readonly PipeReader _reader;
    private readonly bool _chunked;
    private long _remaining;
    private bool _done;

    private BodyStream(PipeReader reader, bool chunked, long length)
    {
        _reader = reader;
        _chunked = chunked;
        _remaining = length;
        _done = !chunked && length == 0;
    }

    public static BodyStream OfLength(PipeReader reader, long length) => new(reader, false, length);

    public static BodyStream Chunked(PipeReader reader) => new(reader, true, 0);

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
    {
        if (_done || buffer.Length == 0)
        {
            return 0;
        }

        if (_chunked && _remaining == 0)
        {
            _remaining = await ReadChunkSizeAsync(ct).ConfigureAwait(false);

            if (_remaining == 0)
            {
                await ReadTrailersAsync(ct).ConfigureAwait(false);
                _done = true;
                return 0;
            }
        }

        var result = await _reader.ReadAsync(ct).ConfigureAwait(false);
        var available = result.Buffer;

        if (available.IsEmpty)
        {
            _reader.AdvanceTo(available.Start);

            if (result.IsCompleted)
            {
                throw new IOException("the client closed the connection mid-body");
            }

            return await ReadAsync(buffer, ct).ConfigureAwait(false);
        }

        var take = (int)Math.Min(Math.Min(available.Length, buffer.Length), _remaining);
        available.Slice(0, take).CopyTo(buffer.Span);
        _reader.AdvanceTo(available.GetPosition(take));
        _remaining -= take;

        if (_remaining == 0)
        {
            if (_chunked)
            {
                await ExpectAsync("\r\n"u8.ToArray(), ct).ConfigureAwait(false);
            }
            else
            {
                _done = true;
            }
        }

        return take;
    }

    public override int Read(byte[] buffer, int offset, int count) =>
        ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

    /// <summary>Read and discard whatever the handler left.</summary>
    public async Task DrainAsync(CancellationToken ct)
    {
        var scratch = new byte[16 * 1024];

        while (await ReadAsync(scratch, ct).ConfigureAwait(false) > 0)
        {
        }
    }

    private async Task<long> ReadChunkSizeAsync(CancellationToken ct)
    {
        var line = await ReadLineAsync(ct).ConfigureAwait(false);
        var semicolon = line.IndexOf(';', StringComparison.Ordinal);
        var digits = (semicolon < 0 ? line : line[..semicolon]).Trim();

        return long.TryParse(digits, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var size)
            ? size
            : throw new ShimProtocolException($"not a chunk size: '{line}'");
    }

    private async Task ReadTrailersAsync(CancellationToken ct)
    {
        while ((await ReadLineAsync(ct).ConfigureAwait(false)).Length > 0)
        {
        }
    }

    private async Task<string> ReadLineAsync(CancellationToken ct)
    {
        while (true)
        {
            var result = await _reader.ReadAsync(ct).ConfigureAwait(false);
            var reader = new SequenceReader<byte>(result.Buffer);

            if (reader.TryReadTo(out ReadOnlySequence<byte> line, "\r\n"u8, advancePastDelimiter: true))
            {
                var text = Encoding.ASCII.GetString(line);
                _reader.AdvanceTo(reader.Position);
                return text;
            }

            if (result.IsCompleted)
            {
                throw new IOException("the client closed the connection mid-body");
            }

            _reader.AdvanceTo(result.Buffer.Start, result.Buffer.End);
        }
    }

    private async Task ExpectAsync(byte[] bytes, CancellationToken ct)
    {
        var expected = bytes.Length;

        while (expected > 0)
        {
            var result = await _reader.ReadAsync(ct).ConfigureAwait(false);

            if (result.Buffer.IsEmpty)
            {
                if (result.IsCompleted)
                {
                    throw new IOException("the client closed the connection mid-body");
                }

                continue;
            }

            var take = (int)Math.Min(result.Buffer.Length, expected);
            _reader.AdvanceTo(result.Buffer.GetPosition(take));
            expected -= take;
        }
    }

    public override void Flush()
    {
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

/// <summary>The connection after a hijack: whatever was already buffered, then the wire.</summary>
internal sealed class HijackedStream(Stream input, Stream output) : Stream
{
    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => true;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) =>
        input.ReadAsync(buffer, ct);

    public override int Read(byte[] buffer, int offset, int count) => input.Read(buffer, offset, count);

    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default) =>
        output.WriteAsync(buffer, ct);

    public override void Write(byte[] buffer, int offset, int count) => output.Write(buffer, offset, count);

    public override Task FlushAsync(CancellationToken ct) => output.FlushAsync(ct);

    public override void Flush() => output.Flush();

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();
}
