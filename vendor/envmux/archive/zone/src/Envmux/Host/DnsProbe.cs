using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace Envmux.Host;

/// <summary>What one server said about one name.</summary>
/// <param name="ResponseCode">The RCODE: 0 is an answer, 3 is "no such name", 5 is "refused".</param>
/// <param name="Addresses">The A records in it, in the order they came.</param>
internal sealed record DnsAnswer(int ResponseCode, IReadOnlyList<IPAddress> Addresses)
{
    /// <summary>The RCODE in words, for a line somebody has to act on.</summary>
    public string Code => ResponseCode switch
    {
        0 => "NOERROR",
        1 => "FORMERR",
        2 => "SERVFAIL",
        3 => "NXDOMAIN",
        4 => "NOTIMP",
        5 => "REFUSED",
        _ => $"RCODE {ResponseCode.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
    };
}

/// <summary>
/// One DNS question, put to one server, over UDP — and nothing else.
/// </summary>
/// <remarks>
/// <para>
/// <c>envmux install</c> ends by wiring a route and a resolver rule, and the
/// honest test of both is a real query to the real resolver from this machine:
/// the packet leaves by the route, is forwarded by the Incus host, and the
/// answer comes back the same way. <c>Dns.GetHostAddresses</c> cannot be that
/// test. It asks Windows, which asks NRPT, which caches, falls back to other
/// resolvers and takes seconds to admit to a timeout — a failure there says
/// something is wrong and nothing about what.
/// </para>
/// <para>
/// So this is the forty lines of RFC 1035 needed to ask for an A record and read
/// the reply, addressed to a server by IP. No dependency, no retries, no TCP
/// fallback: an answer to this question fits in one datagram, and a caller that
/// wants patience loops.
/// </para>
/// </remarks>
internal static class DnsProbe
{
    private const int HeaderLength = 12;
    private const ushort TypeA = 1;
    private const ushort ClassIn = 1;

    /// <summary>The query for a name's A records, as it goes on the wire.</summary>
    /// <param name="name">The name, with or without its trailing dot.</param>
    /// <param name="id">The transaction id the reply has to echo.</param>
    public static byte[] Encode(string name, ushort id)
    {
        var labels = name.Trim().TrimEnd('.').Split('.');

        if (labels.Any(label => label.Length is 0 or > 63) || labels.Sum(label => label.Length + 1) > 254)
        {
            throw new ArgumentException($"'{name}' is not a name DNS can carry", nameof(name));
        }

        var message = new byte[HeaderLength + labels.Sum(label => label.Length + 1) + 1 + 4];

        BinaryPrimitives.WriteUInt16BigEndian(message, id);

        // Recursion desired, and nothing else. A forwarder answers either way;
        // this is simply what every stub resolver sends, so the query looks like
        // the ones that will follow it.
        BinaryPrimitives.WriteUInt16BigEndian(message.AsSpan(2), 0x0100);
        BinaryPrimitives.WriteUInt16BigEndian(message.AsSpan(4), 1);

        var offset = HeaderLength;

        foreach (var label in labels)
        {
            message[offset++] = (byte)label.Length;
            offset += Encoding.ASCII.GetBytes(label, message.AsSpan(offset));
        }

        message[offset++] = 0;

        BinaryPrimitives.WriteUInt16BigEndian(message.AsSpan(offset), TypeA);
        BinaryPrimitives.WriteUInt16BigEndian(message.AsSpan(offset + 2), ClassIn);

        return message;
    }

    /// <summary>
    /// Read a reply: its response code and whatever A records it carries.
    /// </summary>
    /// <remarks>
    /// Null for anything that is not a well-formed response to <paramref name="id"/>
    /// — a truncated datagram, a query echoed back, somebody else's transaction.
    /// Names are skipped rather than read, compression pointers included: the
    /// question was ours, so what the answer is <em>about</em> is already known,
    /// and a CNAME in front of the address is stepped over like any other record
    /// that is not an A.
    /// </remarks>
    public static DnsAnswer? Decode(ReadOnlySpan<byte> message, ushort id)
    {
        if (message.Length < HeaderLength ||
            BinaryPrimitives.ReadUInt16BigEndian(message) != id ||
            (message[2] & 0x80) == 0)
        {
            return null;
        }

        var code = message[3] & 0x0F;
        var questions = BinaryPrimitives.ReadUInt16BigEndian(message[4..]);
        var answers = BinaryPrimitives.ReadUInt16BigEndian(message[6..]);

        var offset = HeaderLength;

        for (var i = 0; i < questions; i++)
        {
            if ((offset = SkipName(message, offset)) < 0 || (offset += 4) > message.Length)
            {
                return null;
            }
        }

        var addresses = new List<IPAddress>();

        for (var i = 0; i < answers; i++)
        {
            // Name, then type, class, a four byte TTL and the data's length.
            if ((offset = SkipName(message, offset)) < 0 || offset + 10 > message.Length)
            {
                return null;
            }

            var type = BinaryPrimitives.ReadUInt16BigEndian(message[offset..]);
            var @class = BinaryPrimitives.ReadUInt16BigEndian(message[(offset + 2)..]);
            var length = BinaryPrimitives.ReadUInt16BigEndian(message[(offset + 8)..]);

            offset += 10;

            if (offset + length > message.Length)
            {
                return null;
            }

            if (type == TypeA && @class == ClassIn && length == 4)
            {
                addresses.Add(new IPAddress(message.Slice(offset, 4)));
            }

            offset += length;
        }

        return new DnsAnswer(code, addresses);
    }

    /// <summary>
    /// Ask <paramref name="server"/> for <paramref name="name"/>, and wait this long and no longer.
    /// </summary>
    /// <remarks>
    /// Null is "no answer", whatever the reason — the datagram was dropped on the
    /// way, the reply was dropped on the way back, nothing is listening, or
    /// Windows had no route. From here they are the same event, and telling them
    /// apart is the caller's job because it is the caller who knows what else to
    /// try.
    /// </remarks>
    public static async Task<DnsAnswer?> QueryAsync(
        IPAddress server,
        string name,
        TimeSpan timeout,
        CancellationToken ct = default)
    {
        var id = (ushort)RandomNumberGenerator.GetInt32(ushort.MaxValue + 1);

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(timeout);

        try
        {
            // Connected, so the socket only hears the server that was asked.
            using var udp = new UdpClient(server.AddressFamily);
            udp.Connect(server, 53);

            await udp.SendAsync(Encode(name, id), deadline.Token).ConfigureAwait(false);

            while (true)
            {
                var reply = await udp.ReceiveAsync(deadline.Token).ConfigureAwait(false);

                if (Decode(reply.Buffer, id) is { } answer)
                {
                    return answer;
                }
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return null;
        }
        catch (SocketException)
        {
            // An ICMP "port unreachable" comes back as a reset on Windows: the
            // address is there and nothing is listening on 53.
            return null;
        }
    }

    /// <summary>The offset just past a name, or -1 when it runs off the end.</summary>
    private static int SkipName(ReadOnlySpan<byte> message, int offset)
    {
        while (offset < message.Length)
        {
            var length = message[offset];

            if (length == 0)
            {
                return offset + 1;
            }

            // A pointer is two bytes and always the last thing in a name.
            if ((length & 0xC0) == 0xC0)
            {
                return offset + 2 <= message.Length ? offset + 2 : -1;
            }

            offset += 1 + length;
        }

        return -1;
    }
}
