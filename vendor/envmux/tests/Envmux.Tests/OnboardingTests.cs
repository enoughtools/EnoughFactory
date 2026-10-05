using System.Net;
using System.Text;
using System.Text.Json;

using Envmux.Commands;
using Envmux.Host;

namespace Envmux.Tests;

/// <summary>
/// One paste: a trust token is everything <c>envmux install</c> needs to find a
/// daemon, and <c>envmux host prepare</c> is what ends in one.
/// </summary>
/// <remarks>
/// <para>
/// Neither command can be run from a test — one redeems a secret against a
/// daemon, the other drives somebody's ssh. What is pinned here is every
/// decision they make on the way: which of an address and a token wins, when a
/// certificate is pinned without a question and when it is refused without
/// one, what <c>prepare</c> was asked for, and what of a host's output is
/// allowed onto the screen.
/// </para>
/// <para>
/// The token is the real one's shape, key for key, read off an Incus 7.0.1
/// daemon: <c>client_name</c>, <c>fingerprint</c>, <c>addresses</c>,
/// <c>secret</c>, <c>expires_at</c> — and a token that never expires carries Go's
/// zero time, year one, rather than nothing.
/// </para>
/// </remarks>
public class OnboardingTests
{
    private const string Fingerprint = "003dc56ecba7e6ead676fa00a3a7e9a7d7ad2a9c9f566cb5bd33c827f74a0c13";
    private const string Secret = "not-a-real-secret-but-it-must-never-be-printed";
    private const string Never = "0001-01-01T00:00:00Z";

    private static readonly DateTimeOffset Now = new(2026, 9, 18, 22, 0, 0, TimeSpan.Zero);

    private static string Token(string expiresAt = Never, params string[] addresses) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["client_name"] = "envmux",
            ["fingerprint"] = Fingerprint,
            ["addresses"] = addresses.Length > 0 ? addresses : ["192.168.19.43:8443", "100.100.1.7:8443", "172.17.0.1:8443"],
            ["secret"] = Secret,
            ["expires_at"] = expiresAt,
        })));

    /// <summary>
    /// Year one is "never", not "long ago".
    /// </summary>
    /// <remarks>
    /// Read naively, a token that never expires expired two thousand years ago,
    /// and every one a default Incus mints would be refused before it was tried.
    /// </remarks>
    [Fact]
    public void ATokenThatNeverExpiresIsNotExpired()
    {
        Assert.True(TrustToken.TryParse(Token(Never), out var token));

        Assert.Null(token.ExpiresAt);
        Assert.False(token.IsExpired(Now));
        Assert.False(token.IsExpired(DateTimeOffset.MaxValue));
        Assert.Equal("", InstallCommand.Source(null, Token(Never), "", null, Now).Refusal);
    }

    /// <summary>A token is enough by itself: no address, so its own are probed.</summary>
    [Fact]
    public void ATokenAloneMeansItsAddressesAreProbed()
    {
        var text = Token();
        var source = InstallCommand.Source(api: null, token: text, recorded: "", typed: null, Now);

        Assert.Null(source.Api);
        Assert.NotNull(source.Token);
        Assert.Equal(Fingerprint, source.Token.Fingerprint);
        Assert.Equal(text, source.TokenText);
        Assert.Equal("", source.Refusal);
    }

    /// <summary>
    /// The address host.json holds does not outrank a token.
    /// </summary>
    /// <remarks>
    /// The token is the newer statement of where the daemon is, and on a
    /// workstation being pointed at another daemon the recorded address is
    /// exactly the wrong one to dial.
    /// </remarks>
    [Fact]
    public void ATokenOutranksTheRecordedAddress() =>
        Assert.Null(InstallCommand.Source(null, Token(), recorded: "192.168.19.47:8443", null, Now).Api);

    /// <summary><c>--api</c> beside a token is an override: that address, held to the token's certificate.</summary>
    [Fact]
    public void AnAddressBesideATokenIsDialledAndTheTokenStillVouches()
    {
        var source = InstallCommand.Source("192.168.19.43", Token(), "192.168.19.47:8443", null, Now);

        Assert.Equal("192.168.19.43", source.Api);
        Assert.Equal(Fingerprint, source.Token!.Fingerprint);
    }

    /// <summary>With neither, the recorded address is used; with nothing at all, there is nothing to dial.</summary>
    [Fact]
    public void WithNoTokenItIsAsItWas()
    {
        Assert.Equal("192.168.19.47:8443", InstallCommand.Source(null, null, "192.168.19.47:8443", null, Now).Api);
        Assert.Equal("incus.lan", InstallCommand.Source(null, null, "", "incus.lan", Now).Api);

        var nothing = InstallCommand.Source(null, null, "", "  ", Now);
        Assert.Null(nothing.Api);
        Assert.Null(nothing.Token);
    }

    /// <summary>A token pasted where the address was asked for is taken as a token.</summary>
    [Fact]
    public void ATokenPastedAtTheAddressPromptIsAToken()
    {
        var text = Token();
        var source = InstallCommand.Source(null, null, "", typed: $"  {text}  ", Now);

        Assert.Null(source.Api);
        Assert.NotNull(source.Token);
        Assert.Equal(text, source.TokenText);
    }

    /// <summary>
    /// A token envmux cannot read is the daemon's to judge, when there is a daemon to send it to.
    /// </summary>
    [Fact]
    public void AnUnreadableTokenFallsBackToTheAddressAndSaysSo()
    {
        var source = InstallCommand.Source("192.168.19.43", "some-other-format", "", null, Now);

        Assert.Equal("192.168.19.43", source.Api);
        Assert.Null(source.Token);
        Assert.Equal("some-other-format", source.TokenText);
        Assert.Contains("cannot vouch", source.Note, StringComparison.Ordinal);
        Assert.Equal("", source.Refusal);
    }

    /// <summary>With no address either, there is nowhere to send it, and that is said.</summary>
    [Fact]
    public void AnUnreadableTokenWithNoAddressIsRefused()
    {
        var source = InstallCommand.Source(null, "some-other-format", "192.168.19.47:8443", null, Now);

        Assert.Contains("--api", source.Refusal, StringComparison.Ordinal);
        Assert.DoesNotContain("some-other-format", source.Refusal, StringComparison.Ordinal);
    }

    /// <summary>An expired token is refused before anything is dialled, with the way to get another.</summary>
    [Fact]
    public void AnExpiredTokenIsRefusedWithTheFix()
    {
        var text = Token("2026-09-18T21:00:00Z");
        var source = InstallCommand.Source("192.168.19.43", text, "", null, Now);

        Assert.Contains("expired at 2026-09-18 21:00 UTC", source.Refusal, StringComparison.Ordinal);
        Assert.Contains("incus config trust add envmux", source.Refusal, StringComparison.Ordinal);
        Assert.Contains("host prepare", source.Refusal, StringComparison.Ordinal);
        Assert.Null(source.Token);
        Assert.Equal("", source.TokenText);
    }

    /// <summary>
    /// Nothing about where the daemon is can print the secret.
    /// </summary>
    /// <remarks>
    /// The text has to be held, because it is what gets redeemed. It is held in
    /// a class with no generated printer, and no message is built from it.
    /// </remarks>
    [Fact]
    public void TheTokenIsNeverInAnythingPrintable()
    {
        var text = Token();

        foreach (var source in new[]
        {
            InstallCommand.Source(null, text, "", null, Now),
            InstallCommand.Source("192.168.19.43", text, "", null, Now),
            InstallCommand.Source(null, Token("2020-01-01T00:00:00Z"), "", null, Now),
        })
        {
            foreach (var printable in new[] { source.ToString()!, source.Note, source.Refusal, $"{source.Token}" })
            {
                Assert.DoesNotContain(Secret, printable, StringComparison.Ordinal);
                Assert.DoesNotContain(text, printable, StringComparison.Ordinal);
            }
        }
    }

    private const string Other = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    /// <summary>
    /// A token's certificate is pinned without a question, and anything else refused without one.
    /// </summary>
    /// <remarks>
    /// Including over a different fingerprint pinned before — a rebuilt daemon
    /// with a fresh token looks exactly like that — and including when the
    /// mismatching certificate is the one that <em>was</em> pinned: "pin it
    /// anyway?" would be an offer to send one daemon's secret to another.
    /// </remarks>
    [Theory]
    [InlineData(Fingerprint, "", Fingerprint, "TokenVouches")]
    [InlineData(Fingerprint, Other, Fingerprint, "TokenVouches")]
    [InlineData(Other, "", Fingerprint, "Refuse")]
    [InlineData(Other, Other, Fingerprint, "Refuse")]
    [InlineData(Fingerprint, Fingerprint, null, "AlreadyPinned")]
    [InlineData(Fingerprint, "", null, "Ask")]
    [InlineData(Fingerprint, Other, null, "Ask")]
    public void TheTokenDecidesThePin(string presented, string pinned, string? vouched, string expected) =>
        Assert.Equal(expected, InstallCommand.Pin(presented, pinned, vouched).ToString());

    /// <summary>With no host.json, prepare is for what install will create.</summary>
    [Fact]
    public void PrepareDefaultsToWhatInstallWillCreate()
    {
        var options = HostCommand.Prepare([], new HostConfig(), recorded: false, out var problem);

        Assert.Equal("", problem);
        Assert.Equal(new HostCommand.PrepareOptions("envmux0", "10.100.0.1/24", "envmux", false, null, []), options,
            Same);
    }

    /// <summary>With one, it is for the network that host already has — unless told otherwise.</summary>
    [Fact]
    public void PrepareDefaultsToTheRecordedNetwork()
    {
        var config = new HostConfig { Provider = HostConfig.Incus, Network = "incusbr0", Cidr = "10.252.20.1/24" };

        var recorded = HostCommand.Prepare(["--check"], config, recorded: true, out _)!;

        Assert.Equal("incusbr0", recorded.Network);
        Assert.Equal("10.252.20.1/24", recorded.Cidr);
        Assert.True(recorded.Check);

        var told = HostCommand.Prepare(
            ["--ssh", "matt@192.168.19.43", "--network", "envmux0", "--cidr", "10.90.0.1/24", "--name", "matt-ws", "--yes"],
            config,
            recorded: true,
            out _)!;

        Assert.Equal("envmux0", told.Network);
        Assert.Equal("10.90.0.1/24", told.Cidr);
        Assert.Equal("matt-ws", told.Name);
        Assert.Equal("matt@192.168.19.43", told.Ssh);
        Assert.False(told.Check);
        Assert.Equal(["--yes"], told.Forwarded);
    }

    /// <summary>
    /// A mistyped option is refused, not ignored.
    /// </summary>
    /// <remarks>
    /// The script changes a firewall as root. <c>--chekc</c> quietly dropped is
    /// a run that was meant to change nothing and changed something.
    /// </remarks>
    [Theory]
    [InlineData(new[] { "--chekc" }, "--chekc")]
    [InlineData(new[] { "matt@host" }, "matt@host")]
    [InlineData(new[] { "--ssh" }, "needs a value")]
    [InlineData(new[] { "--ssh", "--check" }, "needs a value")]
    public void PrepareRefusesWhatItDoesNotUnderstand(string[] args, string expected)
    {
        Assert.Null(HostCommand.Prepare(args, new HostConfig(), recorded: false, out var problem));
        Assert.Contains(expected, problem, StringComparison.Ordinal);
    }

    /// <summary>What prepare was told, install is told too: a bridge that is not envmux0 is one to adopt.</summary>
    [Fact]
    public void InstallCarriesOnWithWhatPrepareWasTold()
    {
        var text = Token();

        string[] plain = ["--ssh", "matt@host"];
        Assert.Equal(
            ["--provider", "incus", "--token", text],
            HostCommand.InstallArguments(HostCommand.Prepare(plain, new HostConfig(), false, out _)!, plain, text));

        string[] adopting = ["--ssh", "matt@host", "--network", "incusbr0", "--cidr", "10.252.20.1/24", "--yes"];
        Assert.Equal(
            ["--provider", "incus", "--token", text, "--network", "incusbr0", "--yes"],
            HostCommand.InstallArguments(HostCommand.Prepare(adopting, new HostConfig(), false, out _)!, adopting, text));

        // --force went with the wiring it re-pointed. It is refused like any
        // other option prepare does not know, rather than carried into install
        // to mean nothing there.
        Assert.Null(HostCommand.Prepare(["--force"], new HostConfig(), false, out var problem));
        Assert.Contains("--force", problem, StringComparison.Ordinal);

        string[] ranged = ["--ssh", "matt@host", "--cidr", "10.90.0.1/24"];
        Assert.Equal(
            ["--provider", "incus", "--token", text, "--cidr", "10.90.0.1/24"],
            HostCommand.InstallArguments(HostCommand.Prepare(ranged, new HostConfig(), false, out _)!, ranged, text));
    }

    /// <summary>
    /// A captured run over <c>ssh -t</c>: everything reaches the screen but the token, and the token comes out whole.
    /// </summary>
    /// <remarks>
    /// Fed in the ragged pieces a pipe delivers — mid-line, mid-marker — with a
    /// terminal's carriage returns on every line. The sudo prompt has no end of
    /// line and must be on the screen the moment it arrives, or the person it is
    /// asking sits looking at nothing.
    /// </remarks>
    [Fact]
    public void TheTokenLineIsKeptOffTheScreenAndNothingElseIs()
    {
        var text = Token();

        var transcript =
            "envmux host prepare: network envmux0 (10.100.0.0/24), client envmux\r\n" +
            "  ok     incus 7.0.1 answers this account\r\n" +
            "[sudo] password for matt: " +
            "\r\n  ok     net.ipv4.ip_forward is on\r\n" +
            "  ok     DOCKER-USER already accepts traffic in from and out to envmux0, already handled by " +
            "/etc/systemd/system/incus-firewall.service (left alone)\r\n" +
            "\r\nThis host is ready. On the workstation:  envmux install --token <the token below>\r\n" +
            $"{HostPrep.TokenMarker}{text}\r\n";

        var filter = new HostCommand.TokenLineFilter();
        var screen = new StringBuilder();
        var prompt = transcript.IndexOf("password for matt: ", StringComparison.Ordinal) + "password for matt: ".Length;

        // Everything up to the prompt, in sevens; then look at the screen while sudo is still waiting.
        foreach (var piece in transcript[..prompt].Chunk(7))
        {
            screen.Append(filter.Feed(new string(piece)));
        }

        Assert.EndsWith("[sudo] password for matt: ", screen.ToString(), StringComparison.Ordinal);

        foreach (var piece in transcript[prompt..].Chunk(7))
        {
            screen.Append(filter.Feed(new string(piece)));
        }

        screen.Append(filter.Flush());

        Assert.Contains("already handled by /etc/systemd/system/incus-firewall.service", screen.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain(text, screen.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain(HostPrep.TokenMarker, screen.ToString(), StringComparison.Ordinal);

        Assert.Equal(transcript, filter.Transcript);
        Assert.Equal(text, HostPrep.TokenFrom(filter.Transcript));
        Assert.Equal($"{HostPrep.TokenMarker}{text}\r\n", filter.Held);
    }

    /// <summary>A <c>--check</c> run's last line says there is no token, and is shown as it came.</summary>
    [Fact]
    public void ACheckRunHasNoTokenAndItsLastLineIsShown()
    {
        var filter = new HostCommand.TokenLineFilter();

        var screen = filter.Feed("  would  mint a one-time trust token\nENVMUX-TOK") +
                     filter.Feed("EN: none (--check)\n") +
                     filter.Flush();

        Assert.Equal("  would  mint a one-time trust token\n", screen);
        Assert.Equal("ENVMUX-TOKEN: none (--check)\n", filter.Held);
        Assert.Null(HostPrep.TokenFrom(filter.Transcript));
    }

    /// <summary>A line that only starts like the marker is an ordinary line, and output with no last newline is not lost.</summary>
    [Fact]
    public void AlmostTheMarkerIsJustALine()
    {
        var filter = new HostCommand.TokenLineFilter();

        Assert.Equal("ENVMUX is ready\nENV", filter.Feed("ENVMUX is ready\nENV") + filter.Flush());
        Assert.Equal("", filter.Held);
    }

    /// <summary>Records holding lists compare by reference; this compares what is in them.</summary>
    private static readonly IEqualityComparer<HostCommand.PrepareOptions?> Same =
        EqualityComparer<HostCommand.PrepareOptions?>.Create((a, b) =>
            a is not null && b is not null &&
            (a.Network, a.Cidr, a.Name, a.Check, a.Ssh) == (b.Network, b.Cidr, b.Name, b.Check, b.Ssh) &&
            a.Forwarded.SequenceEqual(b.Forwarded));
}
