using System.Diagnostics;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

using Envmux.Host;

namespace Envmux.Tests;

/// <summary>
/// A trust token read as directions to the daemon, and the dialling that follows them.
/// </summary>
/// <remarks>
/// The fixture is the first real remote, as it was: eight addresses of which one
/// was any use from a workstation on the same switch, and an Operator who had
/// been handed a URL for one of the other seven.
/// </remarks>
public class TrustTokenTests
{
    private const string Fingerprint = "003dc56ecba7e6ead676fa00a3a7e9a7d7ad2a9c9f566cb5bd33c827f74a0c13";

    /// <summary>Opens nothing. A value to look for in places it must not be.</summary>
    private const string Secret = "5e3c1e7-not-a-real-secret-b2a9";

    private const string Lan = "192.168.19.43:8443";
    private const string Overlay = "100.100.1.100:8443";

    private static readonly string[] Listed =
    [
        Lan,
        Overlay,
        "[fd42:8c1e:51a2:9e01::1]:8443",
        "172.21.0.1:8443",
        "172.17.0.1:8443",
        "172.20.0.1:8443",
        "10.252.20.1:8443",
        "[fd7a:115c:a1e0::6401:164]:8443",
    ];

    /// <summary>The workstation: on the switch, and on the overlay.</summary>
    private static readonly LocalInterface[] Workstation =
    [
        new(IPAddress.Parse("192.168.19.21"), 24),
        new(IPAddress.Parse("100.100.0.1"), 22),
    ];

    /// <summary>The shape Incus mints: base64 over this object, in Go's standard alphabet.</summary>
    private static string Encode(
        IEnumerable<string>? addresses = null,
        string fingerprint = Fingerprint,
        string secret = Secret,
        string expiresAt = "0001-01-01T00:00:00Z") =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["client_name"] = "envmux",
            ["fingerprint"] = fingerprint,
            ["addresses"] = (addresses ?? Listed).ToArray(),
            ["secret"] = secret,
            ["expires_at"] = expiresAt,
            ["type"] = "",
        })));

    private static TrustToken Parse(string text)
    {
        Assert.True(TrustToken.TryParse(text, out var token));
        return token;
    }

    [Fact]
    public void ATokenSaysWhoTheDaemonIsAndWhereItListens()
    {
        var token = Parse(Encode());

        Assert.Equal("envmux", token.ClientName);
        Assert.Equal(Fingerprint, token.Fingerprint);
        Assert.Equal(Listed, token.Addresses);
        Assert.Null(token.ExpiresAt);
        Assert.False(token.IsExpired(DateTimeOffset.UtcNow));
    }

    [Fact]
    public void TheSecretIsNowhereOnTheParsedToken()
    {
        var token = Parse(Encode());

        Assert.DoesNotContain(Secret, token.ToString(), StringComparison.Ordinal);

        // Not by convention but by construction: there is no member holding it,
        // so nothing written later can print it.
        foreach (var field in typeof(TrustToken).GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            var value = field.GetValue(token);
            var text = value is IEnumerable<string> many ? string.Join(' ', many) : value?.ToString() ?? "";

            Assert.DoesNotContain(Secret, text, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void HowItWasPastedDoesNotMatter()
    {
        var text = Encode();

        // Wrapped by a terminal, unpadded, and in the other base64 alphabet.
        var mangled = string.Join("\r\n  ", text.TrimEnd('=').Replace('+', '-').Replace('/', '_').Chunk(40).Select(c => new string(c)));

        Assert.Equal(Fingerprint, Parse($"  {mangled}\n").Fingerprint);
    }

    [Fact]
    public void AFingerprintWrittenWithColonsIsTheSameFingerprint()
    {
        var spaced = string.Join(':', Fingerprint.ToUpperInvariant().Chunk(2).Select(c => new string(c)));

        Assert.Equal(Fingerprint, Parse(Encode(fingerprint: spaced)).Fingerprint);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not base64 at all !!")]
    [InlineData("bm90IGpzb24=")]                 // "not json"
    [InlineData("WzEsMiwzXQ==")]                 // [1,2,3]
    public void SomethingThatIsNotATokenIsRefused(string? text)
    {
        Assert.False(TrustToken.TryParse(text, out _));
    }

    [Fact]
    public void ATokenMissingAPartIsATokenForSomethingElse()
    {
        Assert.False(TrustToken.TryParse(Encode(secret: ""), out _));
        Assert.False(TrustToken.TryParse(Encode(fingerprint: "abc123"), out _));
        Assert.False(TrustToken.TryParse(Encode(addresses: []), out _));
    }

    [Fact]
    public void ATokenKnowsWhenItStopsBeingHonoured()
    {
        var token = Parse(Encode(expiresAt: "2026-09-18T22:00:00Z"));
        var at = new DateTimeOffset(2026, 9, 18, 22, 0, 0, TimeSpan.Zero);

        Assert.Equal(at, token.ExpiresAt);
        Assert.False(token.IsExpired(at.AddMinutes(-1)));
        Assert.True(token.IsExpired(at));
    }

    [Fact]
    public void TheLanComesFirstAndTheInsideOfTheHostLast()
    {
        var order = Parse(Encode()).Candidates(Workstation);

        Assert.Equal(
            [
                Lan,                                   // on our switch
                Overlay,                               // on-link too, but over the mesh
                "[fd42:8c1e:51a2:9e01::1]:8443",       // IPv6 after every usable IPv4
                "[fd7a:115c:a1e0::6401:164]:8443",
                "172.21.0.1:8443",                     // Docker's bridges, in the daemon's order
                "172.17.0.1:8443",
                "172.20.0.1:8443",
                "10.252.20.1:8443",                    // and Incus' own
            ],
            order.Select(c => c.Authority));

        Assert.Equal(CandidateKind.OnLink, order[0].Kind);
        Assert.Equal(CandidateKind.Overlay, order[1].Kind);
        Assert.All(order.Skip(4), c => Assert.Equal(CandidateKind.Bridge, c.Kind));
    }

    [Fact]
    public void TheDaemonsOrderDoesNotDecideOurs()
    {
        var order = Parse(Encode(Listed.Reverse())).Candidates(Workstation);

        Assert.Equal(Lan, order[0].Authority);
        Assert.Equal(Overlay, order[1].Authority);
    }

    [Fact]
    public void ABridgeLookingAddressOnOurOwnSubnetIsJustTheLan()
    {
        // Somebody's office really is 172.16.0.0/12, and their server really is .1.
        var token = Parse(Encode(["10.9.9.9:8443", "172.20.0.1:8443"]));
        var order = token.Candidates([new LocalInterface(IPAddress.Parse("172.20.0.57"), 16)]);

        Assert.Equal("172.20.0.1:8443", order[0].Authority);
        Assert.Equal(CandidateKind.OnLink, order[0].Kind);
    }

    [Fact]
    public void WithNothingKnownAboutThisMachineEveryAddressIsStillTried()
    {
        var order = Parse(Encode()).Candidates([]);

        Assert.Equal(Listed.Length, order.Count);
        Assert.Equal([Lan, Overlay], order.Take(2).Select(c => c.Authority));
    }

    /// <summary>The remote as it behaved: one address answers, one drops, the rest are not for us.</summary>
    private static async Task<string> Remote(string authority, CancellationToken ct)
    {
        switch (authority)
        {
            case Lan:
                await Task.Delay(5, ct);
                return Fingerprint;

            case Overlay:
                // 8443 on the overlay: packets in, nothing out, for as long as anyone waits.
                await Task.Delay(Timeout.Infinite, ct);
                return "";

            default:
                throw new SocketException((int)(authority.StartsWith('[')
                    ? SocketError.NetworkUnreachable
                    : SocketError.ConnectionRefused));
        }
    }

    [Fact]
    public async Task TheProbeSettlesOnTheLanAddressAtOnce()
    {
        var token = Parse(Encode());
        var clock = Stopwatch.StartNew();

        var result = await token.ProbeAsync(
            token.Candidates(Workstation), Remote, TrustToken.DefaultPerAddress, TrustToken.DefaultStagger, default);

        Assert.Equal(Lan, result.Chosen?.Authority);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(2), $"took {clock.Elapsed}");

        // Nothing else was waited for, and nothing else is reported as a failure.
        Assert.Equal("192.168.19.43:8443 presented the token's certificate", result.Describe());
    }

    [Fact]
    public async Task ADroppingAddressAheadOfTheRightOneCostsAStaggerNotATimeout()
    {
        // No interfaces known, and the daemon listed the overlay first: the
        // worst order there is. The address that says nothing must not be
        // waited out before the one that answers is tried.
        var token = Parse(Encode([Overlay, "172.17.0.1:8443", Lan]));
        var clock = Stopwatch.StartNew();

        var result = await token.ProbeAsync(
            token.Candidates([]), Remote, TimeSpan.FromSeconds(3), TimeSpan.FromMilliseconds(200), default);

        Assert.Equal(Lan, result.Chosen?.Authority);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(2), $"took {clock.Elapsed}");
    }

    [Fact]
    public async Task WhenNothingIsTheDaemonEveryFailureIsNamed()
    {
        // The Operator's afternoon: the LAN address not in play, only the ones
        // that could never have worked.
        var token = Parse(Encode([Overlay, "172.17.0.1:8443", "[fd42:8c1e:51a2:9e01::1]:8443"]));

        var result = await token.ProbeAsync(
            token.Candidates(Workstation), Remote, TimeSpan.FromMilliseconds(300), TimeSpan.FromMilliseconds(20), default);

        Assert.Null(result.Chosen);
        Assert.Equal(
            "100.100.1.100:8443 timed out (filtered, or nothing at that address); " +
            "[fd42:8c1e:51a2:9e01::1]:8443 is not reachable from here; " +
            "172.17.0.1:8443 refused the connection (nothing listening there)",
            result.Describe());
    }

    [Fact]
    public async Task SomethingElseAnsweringThereIsNotTheDaemon()
    {
        var token = Parse(Encode([Lan]));

        var result = await token.ProbeAsync(
            token.Candidates(Workstation),
            (_, _) => Task.FromResult(new string('a', 64)),
            TimeSpan.FromSeconds(1),
            TimeSpan.Zero,
            default);

        Assert.Null(result.Chosen);
        Assert.Equal(AttemptOutcome.WrongCertificate, result.Attempts[0].Outcome);
        Assert.Equal("192.168.19.43:8443 presented a different certificate", result.Describe());
    }

    [Fact]
    public async Task ABetterPlacedAddressAMomentBehindIsStillTheOneChosen()
    {
        // Both are the daemon. The overlay answers first; the LAN address is
        // the one a route can name, and it is the one kept.
        //
        // The numbers are wide on purpose. The overlay is dialled one stagger
        // in and answers at about 205 ms, which opens one more stagger of
        // grace, to about 405 ms; the LAN address answers at 280 ms, inside it
        // with over a hundred milliseconds to spare on either side. An earlier
        // version had the LAN answer land fifteen milliseconds *after* the
        // grace closed, and passed only where timers are coarse enough to blur
        // that — Windows — and one run in five not even there.
        var token = Parse(Encode([Lan, Overlay]));

        var result = await token.ProbeAsync(
            token.Candidates(Workstation),
            async (authority, ct) =>
            {
                await Task.Delay(authority == Lan ? 280 : 5, ct);
                return Fingerprint;
            },
            TimeSpan.FromSeconds(5),
            TimeSpan.FromMilliseconds(200),
            default);

        Assert.Equal(Lan, result.Chosen?.Authority);
    }

    [Fact]
    public async Task CancellingTheProbeCancelsIt()
    {
        var token = Parse(Encode([Overlay]));
        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => token.ProbeAsync(
            token.Candidates(Workstation), Remote, TimeSpan.FromSeconds(30), TimeSpan.Zero, cancel.Token));
    }

    /// <summary>
    /// The real dial, against real sockets: a TLS listener that is the daemon,
    /// one that is not, and a port with nothing on it.
    /// </summary>
    [Fact]
    public async Task OverRealSocketsTheCertificateDecides()
    {
        using var daemon = SelfSigned("CN=the daemon");
        using var impostor = SelfSigned("CN=something else on 8443");

        using var stop = new CancellationTokenSource();
        var right = Listen(daemon, stop.Token);
        var wrong = Listen(impostor, stop.Token);

        var token = Parse(Encode(
            [$"127.0.0.1:{wrong}", $"127.0.0.1:{right}"],
            fingerprint: ClientCertificate.Fingerprint(daemon)));

        var result = await token.ProbeAsync(token.Candidates([]), default);

        await stop.CancelAsync();

        Assert.Equal($"127.0.0.1:{right}", result.Chosen?.Authority);
        Assert.Equal(AttemptOutcome.WrongCertificate, result.Attempts[0].Outcome);
        Assert.Equal(AttemptOutcome.Matched, result.Attempts[1].Outcome);
    }

    [Fact]
    public async Task OverRealSocketsAClosedPortIsARefusal()
    {
        // A port that was just free, and is closed again. Windows takes a
        // couple of seconds to believe a refusal, which is inside the timeout
        // and is why the dials overlap rather than queue.
        var closed = new TcpListener(IPAddress.Loopback, 0);
        closed.Start();
        var nothing = ((IPEndPoint)closed.LocalEndpoint).Port;
        closed.Stop();

        var token = Parse(Encode([$"127.0.0.1:{nothing}"]));
        var result = await token.ProbeAsync(token.Candidates([]), default);

        Assert.Null(result.Chosen);
        Assert.Equal(AttemptOutcome.Refused, result.Attempts[0].Outcome);
        Assert.Equal($"127.0.0.1:{nothing} refused the connection (nothing listening there)", result.Describe());
    }

    private static X509Certificate2 SelfSigned(string subject)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest(subject, key, HashAlgorithmName.SHA256);

        using var ephemeral = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(1));

        // Through PKCS#12 and back, because SChannel will not serve a
        // certificate whose key exists only in this process' memory.
        return X509CertificateLoader.LoadPkcs12(ephemeral.Export(X509ContentType.Pfx), null);
    }

    /// <summary>Serve TLS handshakes on a loopback port until told to stop, and say which port.</summary>
    private static int Listen(X509Certificate2 certificate, CancellationToken stop)
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();

        _ = Task.Run(async () =>
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    using var client = await listener.AcceptTcpClientAsync(stop);
                    await using var tls = new SslStream(client.GetStream());

                    try
                    {
                        await tls.AuthenticateAsServerAsync(
                            new SslServerAuthenticationOptions { ServerCertificate = certificate }, stop);
                    }
                    catch (Exception e) when (e is IOException or System.Security.Authentication.AuthenticationException)
                    {
                        // The client read the certificate and hung up, which is all it came for.
                    }
                }
            }
            catch (OperationCanceledException)
            {
            }
            finally
            {
                listener.Stop();
            }
        }, CancellationToken.None);

        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
