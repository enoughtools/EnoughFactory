using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace Envmux.Socks;

/// <summary>A client that did not speak SOCKS5, or stopped halfway through.</summary>
internal sealed class SocksException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>Where a CONNECT asked to go.</summary>
/// <param name="Host">A name, or an address as text. Chrome sends a name even for a literal address.</param>
/// <param name="Port">The port on it.</param>
internal sealed record SocksTarget(string Host, int Port)
{
    /// <summary>
    /// Whether this is the machine's own loopback — which, through this proxy,
    /// is the instance's.
    /// </summary>
    /// <remarks>
    /// The same set Chromium's <c>&lt;-loopback&gt;</c> takes out of its implicit
    /// bypass: <c>localhost</c>, anything under <c>.localhost</c>, <c>127/8</c>
    /// and <c>[::1]</c>. Keeping the two sets equal is what makes "the browser
    /// sent it here" and "it goes into the instance" the same statement.
    /// </remarks>
    public bool IsLoopback =>
        Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
        Host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase) ||
        (IPAddress.TryParse(Host.Trim('[', ']'), out var address) && IPAddress.IsLoopback(address));

    /// <summary>
    /// The addresses to try inside the instance for a loopback target, in order.
    /// </summary>
    /// <remarks>
    /// A literal is dialled as it is. A name is IPv4 then IPv6, because the
    /// images disagree about which one <c>localhost</c> is — Debian's cloud
    /// <c>/etc/hosts</c> lists both — and Node's resolver, and therefore Vite,
    /// binds whichever it finds first. Trying both is cheaper than being right.
    /// </remarks>
    public IReadOnlyList<string> LoopbackCandidates =>
        IPAddress.TryParse(Host.Trim('[', ']'), out var address)
            ? [address.ToString()]
            : ["127.0.0.1", "::1"];

    public override string ToString() =>
        Host.Contains(':', StringComparison.Ordinal)
            ? $"[{Host}]:{Port.ToString(CultureInfo.InvariantCulture)}"
            : $"{Host}:{Port.ToString(CultureInfo.InvariantCulture)}";
}

/// <summary>The reply codes of RFC 1928 §6 that are worth sending.</summary>
internal enum SocksReply : byte
{
    Succeeded = 0,
    GeneralFailure = 1,
    NotAllowed = 2,
    HostUnreachable = 4,
    ConnectionRefused = 5,
    CommandNotSupported = 7,
    AddressTypeNotSupported = 8,
}

/// <summary>
/// The server half of SOCKS5 (RFC 1928) and its username/password method (RFC 1929).
/// </summary>
/// <remarks>
/// <para>
/// CONNECT only. BIND and UDP ASSOCIATE are answered "command not supported":
/// a browser uses neither, and QUIC — the one thing that would want UDP —
/// falls back to TCP when the proxy cannot carry it.
/// </para>
/// <para>
/// Free of sockets, so what a client sent and what it was answered can be
/// tested on a pair of streams. The wire format is pinned by
/// <c>Socks5Tests</c>, byte for byte, against the RFCs.
/// </para>
/// </remarks>
internal static class Socks5
{
    public const byte Version = 5;

    public const byte NoAuthentication = 0;
    public const byte UsernamePassword = 2;
    public const byte NoAcceptableMethods = 0xFF;

    /// <summary>RFC 1929's own version byte, which is not SOCKS' one.</summary>
    private const byte CredentialsVersion = 1;

    private const byte Connect = 1;

    /// <summary>The methods a client offers in its greeting.</summary>
    public static async Task<byte[]> ReadGreetingAsync(Stream stream, CancellationToken ct)
    {
        var head = await ReadAsync(stream, 2, ct).ConfigureAwait(false);

        if (head[0] != Version)
        {
            throw new SocksException(
                $"not SOCKS5 (version byte {head[0].ToString(CultureInfo.InvariantCulture)})");
        }

        return await ReadAsync(stream, head[1], ct).ConfigureAwait(false);
    }

    /// <summary>Answer the greeting with the method chosen, or <see cref="NoAcceptableMethods"/>.</summary>
    public static Task SelectAsync(Stream stream, byte method, CancellationToken ct) =>
        WriteAsync(stream, [Version, method], ct);

    /// <summary>Read an RFC 1929 username and password.</summary>
    public static async Task<(string User, string Password)> ReadCredentialsAsync(Stream stream, CancellationToken ct)
    {
        var head = await ReadAsync(stream, 2, ct).ConfigureAwait(false);

        if (head[0] != CredentialsVersion)
        {
            throw new SocksException("the username/password exchange had the wrong version");
        }

        var user = Encoding.UTF8.GetString(await ReadAsync(stream, head[1], ct).ConfigureAwait(false));
        var length = (await ReadAsync(stream, 1, ct).ConfigureAwait(false))[0];
        var password = Encoding.UTF8.GetString(await ReadAsync(stream, length, ct).ConfigureAwait(false));

        return (user, password);
    }

    /// <summary>Say whether the credentials were right. Anything but zero is a refusal.</summary>
    public static Task AnswerCredentialsAsync(Stream stream, bool accepted, CancellationToken ct) =>
        WriteAsync(stream, [CredentialsVersion, accepted ? (byte)0 : (byte)1], ct);

    /// <summary>
    /// Whether what was sent is what was expected, in time that does not depend
    /// on where they first differ.
    /// </summary>
    public static bool Matches(string user, string password, string expectedUser, string expectedPassword) =>
        expectedPassword.Length > 0 &&
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(user), Encoding.UTF8.GetBytes(expectedUser)) &
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(password), Encoding.UTF8.GetBytes(expectedPassword));

    /// <summary>
    /// Read the request, returning where it wants to go, or the reply that
    /// refuses it.
    /// </summary>
    public static async Task<(SocksTarget? Target, SocksReply Refusal)> ReadRequestAsync(Stream stream, CancellationToken ct)
    {
        // VER CMD RSV ATYP
        var head = await ReadAsync(stream, 4, ct).ConfigureAwait(false);

        if (head[0] != Version)
        {
            throw new SocksException("the request was not SOCKS5");
        }

        string host;

        switch (head[3])
        {
            case 1:
                host = new IPAddress(await ReadAsync(stream, 4, ct).ConfigureAwait(false)).ToString();
                break;

            case 4:
                host = new IPAddress(await ReadAsync(stream, 16, ct).ConfigureAwait(false)).ToString();
                break;

            case 3:
                var length = (await ReadAsync(stream, 1, ct).ConfigureAwait(false))[0];
                host = Encoding.ASCII.GetString(await ReadAsync(stream, length, ct).ConfigureAwait(false));
                break;

            default:
                return (null, SocksReply.AddressTypeNotSupported);
        }

        var port = await ReadAsync(stream, 2, ct).ConfigureAwait(false);
        var target = new SocksTarget(host, (port[0] << 8) | port[1]);

        return head[1] == Connect && host.Length > 0 && target.Port > 0
            ? (target, SocksReply.Succeeded)
            : (null, head[1] == Connect ? SocksReply.HostUnreachable : SocksReply.CommandNotSupported);
    }

    /// <summary>
    /// Answer the request.
    /// </summary>
    /// <remarks>
    /// The bound address is always <c>0.0.0.0:0</c>. It is meant to be the
    /// proxy's own end of the outbound connection, which for a connection that
    /// is an exec in another machine does not exist; no browser reads it.
    /// </remarks>
    public static Task ReplyAsync(Stream stream, SocksReply reply, CancellationToken ct) =>
        WriteAsync(stream, [Version, (byte)reply, 0, 1, 0, 0, 0, 0, 0, 0], ct);

    /// <summary>What a failed dial is, as a reply.</summary>
    public static SocksReply ReplyFor(SocketException e) => e.SocketErrorCode switch
    {
        SocketError.ConnectionRefused => SocksReply.ConnectionRefused,
        SocketError.HostNotFound or SocketError.HostUnreachable or SocketError.NoData
            or SocketError.NetworkUnreachable or SocketError.TimedOut => SocksReply.HostUnreachable,
        _ => SocksReply.GeneralFailure,
    };

    private static async Task<byte[]> ReadAsync(Stream stream, int count, CancellationToken ct)
    {
        var buffer = new byte[count];

        try
        {
            await stream.ReadExactlyAsync(buffer, ct).ConfigureAwait(false);
        }
        catch (EndOfStreamException e)
        {
            throw new SocksException("the client hung up mid-handshake", e);
        }

        return buffer;
    }

    private static async Task WriteAsync(Stream stream, byte[] bytes, CancellationToken ct)
    {
        await stream.WriteAsync(bytes, ct).ConfigureAwait(false);
        await stream.FlushAsync(ct).ConfigureAwait(false);
    }
}
