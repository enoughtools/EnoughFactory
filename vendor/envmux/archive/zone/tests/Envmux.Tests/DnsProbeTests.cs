using System.Net;

using Envmux.Host;

namespace Envmux.Tests;

/// <summary>
/// The forty lines of DNS that <c>envmux install</c> checks the path with.
/// </summary>
/// <remarks>
/// Written against bytes rather than against a server, because the point of the
/// probe is to be the one part of that check which cannot itself be what is
/// wrong. The replies here are shaped like dnsmasq's — a compressed name
/// pointing back at the question — since dnsmasq is what will be answering.
/// </remarks>
public class DnsProbeTests
{
    private const ushort Id = 0xBEEF;

    /// <summary>The header, the question, and nothing after it.</summary>
    [Fact]
    public void AQueryIsAHeaderAndOneQuestion()
    {
        var query = DnsProbe.Encode("envmux-util.envmux", Id);

        byte[] expected =
        [
            0xBE, 0xEF,             // id
            0x01, 0x00,             // a query, recursion desired
            0x00, 0x01,             // one question
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            11, (byte)'e', (byte)'n', (byte)'v', (byte)'m', (byte)'u', (byte)'x', (byte)'-', (byte)'u', (byte)'t', (byte)'i', (byte)'l',
            6, (byte)'e', (byte)'n', (byte)'v', (byte)'m', (byte)'u', (byte)'x',
            0,
            0x00, 0x01,             // A
            0x00, 0x01,             // IN
        ];

        Assert.Equal(expected, query);
    }

    /// <summary>A trailing dot is the same name, not an empty label.</summary>
    [Fact]
    public void ATrailingDotIsTheSameName() =>
        Assert.Equal(DnsProbe.Encode("a.incus", Id), DnsProbe.Encode("a.incus.", Id));

    [Theory]
    [InlineData("")]
    [InlineData("a..b")]
    [InlineData("a-label-that-runs-well-past-the-sixty-three-characters-dns-allows-one.x")]
    public void ANameDnsCannotCarryIsRefused(string name) =>
        Assert.Throws<ArgumentException>(() => DnsProbe.Encode(name, Id));

    /// <summary>The ordinary answer: one A record whose name is a pointer back at the question.</summary>
    [Fact]
    public void AnAnswerIsReadThroughACompressedName()
    {
        var answer = DnsProbe.Decode(Reply(0, A([10, 252, 20, 2])), Id);

        Assert.NotNull(answer);
        Assert.Equal(0, answer.ResponseCode);
        Assert.Equal([IPAddress.Parse("10.252.20.2")], answer.Addresses);
    }

    /// <summary>A CNAME in front of the address is stepped over rather than mistaken for it.</summary>
    [Fact]
    public void ARecordThatIsNotAnAddressIsSteppedOver()
    {
        byte[] cname = [0xC0, 0x0C, 0x00, 0x05, 0x00, 0x01, 0, 0, 0, 60, 0x00, 0x02, 0xC0, 0x0C];

        var answer = DnsProbe.Decode(Reply(0, cname, A([10, 100, 0, 2])), Id);

        Assert.NotNull(answer);
        Assert.Equal([IPAddress.Parse("10.100.0.2")], answer.Addresses);
    }

    /// <summary>
    /// "No such name" is still an answer.
    /// </summary>
    /// <remarks>
    /// It matters which: a reply of any kind proves the route and the forwarding,
    /// and sends the diagnosis to the bridge's dnsmasq instead of to the host's
    /// firewall.
    /// </remarks>
    [Fact]
    public void NoSuchNameIsAnAnswerWithNoAddresses()
    {
        var answer = DnsProbe.Decode(Reply(3), Id);

        Assert.NotNull(answer);
        Assert.Equal(3, answer.ResponseCode);
        Assert.Equal("NXDOMAIN", answer.Code);
        Assert.Empty(answer.Addresses);
    }

    /// <summary>Somebody else's transaction, or our own query echoed back, is not a reply.</summary>
    [Fact]
    public void AnythingThatIsNotAReplyToThisQueryIsIgnored()
    {
        Assert.Null(DnsProbe.Decode(Reply(0, A([10, 0, 0, 1])), 0x1234));
        Assert.Null(DnsProbe.Decode(DnsProbe.Encode("envmux-util.envmux", Id), Id));
        Assert.Null(DnsProbe.Decode([0xBE, 0xEF, 0x81], Id));
    }

    /// <summary>A datagram cut short anywhere is malformed, never an exception.</summary>
    [Fact]
    public void ATruncatedReplyIsMalformedAtEveryLength()
    {
        var whole = Reply(0, A([10, 252, 20, 2]));

        for (var length = 12; length < whole.Length; length++)
        {
            Assert.Null(DnsProbe.Decode(whole.AsSpan(0, length), Id));
        }

        Assert.NotNull(DnsProbe.Decode(whole, Id));
    }

    /// <summary>An A record: a pointer to the question's name, IN, a TTL, four bytes.</summary>
    private static byte[] A(byte[] address) =>
        [0xC0, 0x0C, 0x00, 0x01, 0x00, 0x01, 0, 0, 0, 60, 0x00, 0x04, .. address];

    /// <summary>A response to the question <see cref="DnsProbe.Encode"/> writes, carrying these records.</summary>
    private static byte[] Reply(int code, params byte[][] records)
    {
        var message = DnsProbe.Encode("envmux-util.envmux", Id).ToList();

        message[2] = 0x81;                  // a response, recursion desired
        message[3] = (byte)(0x80 | code);   // recursion available, and the code
        message[7] = (byte)records.Length;  // the answer count's low byte

        foreach (var record in records)
        {
            message.AddRange(record);
        }

        return [.. message];
    }
}
