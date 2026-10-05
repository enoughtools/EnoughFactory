using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Envmux.Tests.EndToEnd;

/// <summary>
/// The client half of SOCKS5 with a username and password, and one HTTP request over it.
/// </summary>
/// <remarks>
/// Written out rather than borrowed from <see cref="HttpClient"/>'s SOCKS
/// support, because that one resolves <c>localhost</c> on this machine before
/// it asks the proxy — the one thing the session's proxy exists to prevent —
/// and so would test the wrong <c>localhost</c>. This sends the name, as the
/// browsers do.
/// </remarks>
internal static class SocksClient
{
    /// <summary>Connect through the proxy, or throw with the reply it gave.</summary>
    public static async Task<NetworkStream> ConnectAsync(Uri proxy, string host, int port, CancellationToken ct)
    {
        var client = new TcpClient();
        await client.ConnectAsync(proxy.Host, proxy.Port, ct);
        var stream = client.GetStream();

        var (user, password) = Credentials(proxy);

        await stream.WriteAsync(new byte[] { 5, 1, 2 }, ct);
        var method = await ReadAsync(stream, 2, ct);

        if (method[1] != 2)
        {
            throw new IOException($"the proxy chose method {method[1]}, not username/password");
        }

        var u = Encoding.UTF8.GetBytes(user);
        var p = Encoding.UTF8.GetBytes(password);
        await stream.WriteAsync((byte[])[1, (byte)u.Length, .. u, (byte)p.Length, .. p], ct);

        if ((await ReadAsync(stream, 2, ct))[1] != 0)
        {
            throw new IOException("the proxy refused the credentials");
        }

        var name = Encoding.ASCII.GetBytes(host);
        await stream.WriteAsync((byte[])[5, 1, 0, 3, (byte)name.Length, .. name, (byte)(port >> 8), (byte)port], ct);

        var reply = await ReadAsync(stream, 10, ct);

        if (reply[1] != 0)
        {
            client.Dispose();
            throw new SocksRefused(reply[1]);
        }

        return stream;
    }

    /// <summary>GET a path over a fresh connection through the proxy, and read the whole answer.</summary>
    public static async Task<HttpAnswer> GetAsync(Uri proxy, string host, int port, string path, CancellationToken ct)
    {
        await using var stream = await ConnectAsync(proxy, host, port, ct);

        var request = $"GET {path} HTTP/1.1\r\nHost: {host}:{port.ToString(CultureInfo.InvariantCulture)}\r\n" +
                      "Connection: close\r\nAccept: */*\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(request), ct);

        using var buffer = new MemoryStream();
        await stream.CopyToAsync(buffer, ct);

        return HttpAnswer.Parse(Encoding.UTF8.GetString(buffer.ToArray()));
    }

    /// <summary>The user and password a proxy URL carries.</summary>
    public static (string User, string Password) Credentials(Uri proxy)
    {
        var info = Uri.UnescapeDataString(proxy.UserInfo);
        var colon = info.IndexOf(':', StringComparison.Ordinal);
        return (info[..colon], info[(colon + 1)..]);
    }

    internal static async Task<byte[]> ReadAsync(Stream stream, int count, CancellationToken ct)
    {
        var buffer = new byte[count];
        await stream.ReadExactlyAsync(buffer, ct);
        return buffer;
    }
}

/// <summary>A CONNECT the proxy answered with something other than success.</summary>
internal sealed class SocksRefused(byte reply) : IOException($"the proxy answered CONNECT with {reply}")
{
    public byte Reply { get; } = reply;
}

/// <summary>An HTTP answer, whole: its status, its headers, its body.</summary>
internal sealed record HttpAnswer(int Status, IReadOnlyDictionary<string, string> Headers, string Body)
{
    public static HttpAnswer Parse(string raw)
    {
        var split = raw.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        var head = split < 0 ? raw : raw[..split];
        var body = split < 0 ? "" : raw[(split + 4)..];
        var lines = head.Split("\r\n");

        var status = lines.Length > 0 && lines[0].Split(' ') is { Length: > 1 } parts &&
                     int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var code)
            ? code
            : 0;

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var line in lines.Skip(1))
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);

            if (colon > 0)
            {
                headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
            }
        }

        return new HttpAnswer(status, headers, body);
    }
}

/// <summary>
/// A SOCKS5 port that asks for nothing, and dials the session's proxy with its credentials.
/// </summary>
/// <remarks>
/// For headless Chrome, which cannot send a SOCKS password and is not a
/// browser the session launched — so it would be refused, correctly. This
/// stands where a person's own browser configured by hand would stand, with
/// the credentials added, and passes each CONNECT through unchanged.
/// </remarks>
internal sealed class CredentialFront : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly Uri _proxy;
    private readonly CancellationTokenSource _stopping = new();

    public CredentialFront(Uri proxy)
    {
        _proxy = proxy;
        _listener.Start();
        _ = AcceptAsync();
    }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

    private async Task AcceptAsync()
    {
        while (!_stopping.IsCancellationRequested)
        {
            TcpClient client;

            try
            {
                client = await _listener.AcceptTcpClientAsync(_stopping.Token);
            }
            catch (Exception e) when (e is OperationCanceledException or SocketException or ObjectDisposedException)
            {
                return;
            }

            _ = ServeAsync(client);
        }
    }

    private async Task ServeAsync(TcpClient client)
    {
        using var _ = client;
        var stream = client.GetStream();
        var ct = _stopping.Token;

        try
        {
            var head = await SocksClient.ReadAsync(stream, 2, ct);
            await SocksClient.ReadAsync(stream, head[1], ct);
            await stream.WriteAsync(new byte[] { 5, 0 }, ct);

            var request = await SocksClient.ReadAsync(stream, 4, ct);
            string host = request[3] switch
            {
                1 => new IPAddress(await SocksClient.ReadAsync(stream, 4, ct)).ToString(),
                4 => new IPAddress(await SocksClient.ReadAsync(stream, 16, ct)).ToString(),
                _ => Encoding.ASCII.GetString(await SocksClient.ReadAsync(stream, (await SocksClient.ReadAsync(stream, 1, ct))[0], ct)),
            };
            var portBytes = await SocksClient.ReadAsync(stream, 2, ct);
            var port = (portBytes[0] << 8) | portBytes[1];

            NetworkStream upstream;

            try
            {
                upstream = await SocksClient.ConnectAsync(_proxy, host, port, ct);
            }
            catch (SocksRefused refused)
            {
                await stream.WriteAsync(new byte[] { 5, refused.Reply, 0, 1, 0, 0, 0, 0, 0, 0 }, ct);
                return;
            }

            await using (upstream)
            {
                await stream.WriteAsync(new byte[] { 5, 0, 0, 1, 0, 0, 0, 0, 0, 0 }, ct);
                await Task.WhenAny(stream.CopyToAsync(upstream, ct), upstream.CopyToAsync(stream, ct));
            }
        }
        catch (Exception e) when (e is IOException or SocketException or OperationCanceledException or EndOfStreamException)
        {
            // Chrome gave up on a connection, or the test is over.
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _stopping.CancelAsync();
        _listener.Stop();
        _listener.Dispose();
        _stopping.Dispose();
    }
}
