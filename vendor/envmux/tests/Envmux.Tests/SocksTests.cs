using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

using Envmux.Config;
using Envmux.Session;
using Envmux.Socks;

namespace Envmux.Tests;

/// <summary>
/// What a <c>browser</c> block resolves to.
/// </summary>
/// <remarks>
/// The default egress is the decision worth pinning: everything that is not the
/// instance's loopback leaves from this machine unless somebody says otherwise,
/// so a map or a sign-in page works the way it does in any other browser.
/// </remarks>
public class SocksPlanTests
{
    private static SocksPlan Resolve(string json) =>
        SocksPlan.Resolve(
            JsonSerializer.Deserialize<SessionConfig>(json, SessionConfig.JsonOptions)!.Browser,
            "shop-amber-fox");

    [Fact]
    public void IsOnWithLocalEgressOnTenEightyWhenNothingIsSaid()
    {
        var plan = Resolve("{}");

        Assert.True(plan.Enabled);
        Assert.Equal(Egress.Local, plan.Egress);
        Assert.Equal(1080, plan.Port.First);
        Assert.Equal("shop-amber-fox", plan.User);
        Assert.NotEmpty(plan.Password);
    }

    [Fact]
    public void MintsThePasswordPerSessionAndNoneWhenOff()
    {
        Assert.NotEqual(Resolve("{}").Password, Resolve("{}").Password);
        Assert.Equal("", Resolve("""{"browser":{"enabled":false}}""").Password);
    }

    [Fact]
    public void TakesInstanceEgressAndAPortRange()
    {
        var plan = Resolve("""{"browser":{"egress":"instance","port":[2080,2089],"use":"firefox"}}""");

        Assert.Equal(Egress.Instance, plan.Egress);
        Assert.Equal(PortSpec.Range(2080, 2089), plan.Port);
        Assert.Equal("firefox", plan.Use);
    }

    [Fact]
    public void RefusesAnEgressItDoesNotKnow()
    {
        var e = Assert.Throws<ConfigException>(() => Resolve("""{"browser":{"egress":"vpn"}}"""));

        Assert.Contains("browser.egress", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RejectsAFieldItDoesNotKnow()
    {
        Assert.ThrowsAny<JsonException>(() =>
            JsonSerializer.Deserialize<SessionConfig>("""{"browser":{"proxy":true}}""", SessionConfig.JsonOptions));
    }

    [Fact]
    public void PutsTheCredentialsInTheUrl()
    {
        var plan = Resolve("{}");

        Assert.Equal($"socks5h://shop-amber-fox:{plan.Password}@127.0.0.1:1081", plan.Url(1081));
    }
}

/// <summary>
/// Which connections go into the instance and which leave from here.
/// </summary>
public class SocksRouteTests
{
    [Theory]
    [InlineData("localhost")]
    [InlineData("LOCALHOST")]
    [InlineData("app.localhost")]
    [InlineData("127.0.0.1")]
    [InlineData("127.3.2.1")]
    [InlineData("::1")]
    [InlineData("[::1]")]
    public void TheLoopbackIsTheInstanceWhateverTheEgress(string host)
    {
        var target = new SocksTarget(host, 3000);

        Assert.True(target.IsLoopback);
        Assert.Equal(SocksRoute.Instance, SocksListener.Choose(target, Egress.Local));
        Assert.Equal(SocksRoute.Instance, SocksListener.Choose(target, Egress.Instance));
    }

    [Theory]
    [InlineData("fonts.googleapis.com")]
    [InlineData("login.microsoftonline.com")]
    [InlineData("192.168.1.10")]
    [InlineData("notlocalhost")]
    public void TheRestLeavesFromWhereTheEgressSays(string host)
    {
        var target = new SocksTarget(host, 443);

        Assert.False(target.IsLoopback);
        Assert.Equal(SocksRoute.Local, SocksListener.Choose(target, Egress.Local));
        Assert.Equal(SocksRoute.Instance, SocksListener.Choose(target, Egress.Instance));
    }

    [Theory]
    [InlineData("shop-amber-fox-db.envmux")]
    [InlineData("SHOP-AMBER-FOX.ENVMUX")]
    [InlineData("envmux")]
    public void NamesUnderTheSessionsDomainGoInWhateverTheEgress(string host)
    {
        // A service's name resolves only inside the host, so a client pointed
        // at the proxy reaches it by that name even with local egress.
        Assert.Equal(SocksRoute.Instance, SocksListener.Choose(new SocksTarget(host, 5432), Egress.Local, "envmux"));
    }

    [Fact]
    public void ANameThatOnlyEndsLikeTheDomainStaysLocal()
    {
        Assert.Equal(SocksRoute.Local, SocksListener.Choose(new SocksTarget("notenvmux", 443), Egress.Local, "envmux"));
        Assert.Equal(SocksRoute.Local, SocksListener.Choose(new SocksTarget("example.com", 443), Egress.Local, ""));
    }

    [Fact]
    public void ALoopbackNameIsTriedOnBothFamiliesAndALiteralAsItIs()
    {
        // Debian's cloud /etc/hosts lists localhost on both, and a Node server
        // binds whichever its resolver found first.
        Assert.Equal(["127.0.0.1", "::1"], new SocksTarget("localhost", 5173).LoopbackCandidates);
        Assert.Equal(["::1"], new SocksTarget("[::1]", 5173).LoopbackCandidates);
        Assert.Equal(["127.0.0.2"], new SocksTarget("127.0.0.2", 5173).LoopbackCandidates);
    }
}

/// <summary>
/// The SOCKS5 wire format, byte for byte, against RFC 1928 and RFC 1929.
/// </summary>
public class Socks5Tests
{
    [Fact]
    public async Task ReadsAGreetingAndAnswersWithTheMethod()
    {
        var input = new MemoryStream([5, 2, 0, 2]);
        var methods = await Socks5.ReadGreetingAsync(input, CancellationToken.None);

        Assert.Equal([0, 2], methods);

        var output = new MemoryStream();
        await Socks5.SelectAsync(output, Socks5.UsernamePassword, CancellationToken.None);
        Assert.Equal([5, 2], output.ToArray());
    }

    [Fact]
    public async Task RefusesSocks4()
    {
        await Assert.ThrowsAsync<SocksException>(() =>
            Socks5.ReadGreetingAsync(new MemoryStream([4, 1, 0]), CancellationToken.None));
    }

    [Fact]
    public async Task ReadsCredentials()
    {
        var input = new MemoryStream([1, 3, (byte)'b', (byte)'o', (byte)'b', 2, (byte)'p', (byte)'w']);

        Assert.Equal(("bob", "pw"), await Socks5.ReadCredentialsAsync(input, CancellationToken.None));

        var output = new MemoryStream();
        await Socks5.AnswerCredentialsAsync(output, accepted: false, CancellationToken.None);
        Assert.Equal([1, 1], output.ToArray());
    }

    [Fact]
    public void MatchesOnlyTheRightPairAndNeverAnEmptyPassword()
    {
        Assert.True(Socks5.Matches("s", "pw", "s", "pw"));
        Assert.False(Socks5.Matches("s", "px", "s", "pw"));
        Assert.False(Socks5.Matches("t", "pw", "s", "pw"));
        Assert.False(Socks5.Matches("s", "", "s", ""));
    }

    [Fact]
    public async Task ReadsANamedTarget()
    {
        // CONNECT localhost:3000, the way Chrome sends even a literal address.
        var bytes = new List<byte> { 5, 1, 0, 3, 9 };
        bytes.AddRange(Encoding.ASCII.GetBytes("localhost"));
        bytes.AddRange([0x0B, 0xB8]);

        var (target, _) = await Socks5.ReadRequestAsync(new MemoryStream([.. bytes]), CancellationToken.None);

        Assert.Equal(new SocksTarget("localhost", 3000), target);
    }

    [Fact]
    public async Task ReadsAddressTargets()
    {
        var (v4, _) = await Socks5.ReadRequestAsync(
            new MemoryStream([5, 1, 0, 1, 127, 0, 0, 1, 0x1F, 0x90]), CancellationToken.None);
        Assert.Equal(new SocksTarget("127.0.0.1", 8080), v4);

        byte[] v6Bytes = [5, 1, 0, 4, .. IPAddress.IPv6Loopback.GetAddressBytes(), 0x00, 0x50];
        var (v6, _) = await Socks5.ReadRequestAsync(new MemoryStream(v6Bytes), CancellationToken.None);
        Assert.Equal(new SocksTarget("::1", 80), v6);
    }

    [Fact]
    public async Task SaysBindIsNotSupported()
    {
        var (target, refusal) = await Socks5.ReadRequestAsync(
            new MemoryStream([5, 2, 0, 1, 127, 0, 0, 1, 0, 80]), CancellationToken.None);

        Assert.Null(target);
        Assert.Equal(SocksReply.CommandNotSupported, refusal);
    }

    [Fact]
    public async Task RepliesWithAnEmptyBoundAddress()
    {
        var output = new MemoryStream();
        await Socks5.ReplyAsync(output, SocksReply.ConnectionRefused, CancellationToken.None);

        Assert.Equal([5, 5, 0, 1, 0, 0, 0, 0, 0, 0], output.ToArray());
    }
}

/// <summary>
/// The listener on a real loopback port, with a server on another standing in
/// for the instance.
/// </summary>
public sealed class SocksListenerTests : IAsyncLifetime, IDisposable
{
    private readonly TcpListener _box = new(IPAddress.Loopback, 0);
    private readonly SessionLog _log = new();
    private readonly List<(IReadOnlyList<string> Hosts, int Port)> _dialled = [];
    private SocksListener? _listener;
    private SocksPlan _plan = null!;

    public Task InitializeAsync()
    {
        _box.Start();
        _ = ServeBoxAsync();
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        if (_listener is not null)
        {
            await _listener.DisposeAsync();
        }

        _box.Stop();
        _box.Dispose();
    }

    public void Dispose() => _box.Dispose();

    /// <summary>The box answers every connection with what it was sent, upper-cased.</summary>
    private async Task ServeBoxAsync()
    {
        while (true)
        {
            TcpClient client;

            try
            {
                client = await _box.AcceptTcpClientAsync();
            }
            catch (Exception e) when (e is SocketException or ObjectDisposedException)
            {
                return;
            }

            _ = Task.Run(async () =>
            {
                using var _ = client;
                var stream = client.GetStream();
                var buffer = new byte[64];
                var read = await stream.ReadAsync(buffer);
                await stream.WriteAsync(Encoding.ASCII.GetBytes(Encoding.ASCII.GetString(buffer, 0, read).ToUpperInvariant()));
            });
        }
    }

    private SocksListener Start(LaunchedBrowsers? launched = null, string json = "{}")
    {
        _plan = SocksPlan.Resolve(
            JsonSerializer.Deserialize<SessionConfig>(json, SessionConfig.JsonOptions)!.Browser,
            "shop-amber-fox") with
        { Port = PortSpec.Range(0, 0) };

        _listener = new SocksListener(_plan, launched ?? new LaunchedBrowsers(), async (hosts, port, ct) =>
        {
            lock (_dialled)
            {
                _dialled.Add((hosts, port));
            }

            var box = new TcpClient();
            await box.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)_box.LocalEndpoint).Port, ct);
            return box.GetStream();
        }, _log);

        _listener.Start();
        return _listener;
    }

    private async Task<NetworkStream> ConnectAsync()
    {
        var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, _listener!.Port);
        return client.GetStream();
    }

    private static byte[] ConnectTo(string host, int port) =>
        [5, 1, 0, 3, (byte)host.Length, .. Encoding.ASCII.GetBytes(host), (byte)(port >> 8), (byte)port];

    private static async Task<byte[]> ReadAsync(Stream stream, int count)
    {
        var buffer = new byte[count];
        await stream.ReadExactlyAsync(buffer);
        return buffer;
    }

    [Fact]
    public async Task CarriesLocalhostIntoTheInstanceWithTheRightCredentials()
    {
        Start();
        using var stream = await ConnectAsync();

        await stream.WriteAsync(new byte[] { 5, 1, 2 });
        Assert.Equal([5, 2], await ReadAsync(stream, 2));

        var user = Encoding.UTF8.GetBytes(_plan.User);
        var password = Encoding.UTF8.GetBytes(_plan.Password);
        await stream.WriteAsync((byte[])[1, (byte)user.Length, .. user, (byte)password.Length, .. password]);
        Assert.Equal([1, 0], await ReadAsync(stream, 2));

        await stream.WriteAsync(ConnectTo("localhost", 3000));
        Assert.Equal([5, 0, 0, 1, 0, 0, 0, 0, 0, 0], await ReadAsync(stream, 10));

        await stream.WriteAsync(Encoding.ASCII.GetBytes("hello"));
        Assert.Equal("HELLO", Encoding.ASCII.GetString(await ReadAsync(stream, 5)));

        var (hosts, port) = Assert.Single(_dialled);
        Assert.Equal(["127.0.0.1", "::1"], hosts);
        Assert.Equal(3000, port);
    }

    [Fact]
    public async Task RefusesTheWrongPassword()
    {
        Start();
        using var stream = await ConnectAsync();

        await stream.WriteAsync(new byte[] { 5, 1, 2 });
        await ReadAsync(stream, 2);

        var user = Encoding.UTF8.GetBytes(_plan.User);
        await stream.WriteAsync((byte[])[1, (byte)user.Length, .. user, 5, .. "wrong"u8.ToArray()]);

        Assert.Equal([1, 1], await ReadAsync(stream, 2));
        Assert.Empty(_dialled);
    }

    [Fact]
    public async Task RefusesNoPasswordFromAProcessItDidNotLaunch()
    {
        // This test process is exactly that: on this machine, holding no password.
        Start();
        using var stream = await ConnectAsync();

        await stream.WriteAsync(new byte[] { 5, 1, 0 });

        Assert.Equal([5, Socks5.NoAcceptableMethods], await ReadAsync(stream, 2));
        Assert.Contains(_log.Entries, line => line.Message.Contains("refused", StringComparison.Ordinal));
    }

    [SkippableFact]
    public async Task LetsInALaunchedProcessWithNoPassword()
    {
        Skip.IfNot(OperatingSystem.IsWindows() || OperatingSystem.IsMacOS(), "process ownership requires Windows or macOS");

        // The test process stands in for the browser: it is the one holding the
        // client end, so registering it is what launching a browser does.
        var launched = new LaunchedBrowsers();
        using (var self = System.Diagnostics.Process.GetCurrentProcess())
        {
            launched.Add(self);
        }

        Start(launched);
        using var stream = await ConnectAsync();

        await stream.WriteAsync(new byte[] { 5, 1, 0 });
        Assert.Equal([5, 0], await ReadAsync(stream, 2));

        await stream.WriteAsync(ConnectTo("127.0.0.1", 5173));
        Assert.Equal(0, (await ReadAsync(stream, 10))[1]);

        await stream.WriteAsync(Encoding.ASCII.GetBytes("vite"));
        Assert.Equal("VITE", Encoding.ASCII.GetString(await ReadAsync(stream, 4)));
        Assert.Equal(["127.0.0.1"], Assert.Single(_dialled).Hosts);
    }

    [Fact]
    public async Task SendsEverythingThroughTheInstanceWhenTheEgressSaysSo()
    {
        Start(json: """{"browser":{"egress":"instance"}}""");
        using var stream = await ConnectAsync();

        await stream.WriteAsync(new byte[] { 5, 1, 2 });
        await ReadAsync(stream, 2);
        var user = Encoding.UTF8.GetBytes(_plan.User);
        var password = Encoding.UTF8.GetBytes(_plan.Password);
        await stream.WriteAsync((byte[])[1, (byte)user.Length, .. user, (byte)password.Length, .. password]);
        await ReadAsync(stream, 2);

        await stream.WriteAsync(ConnectTo("db", 5432));
        Assert.Equal(0, (await ReadAsync(stream, 10))[1]);

        Assert.Equal(["db"], Assert.Single(_dialled).Hosts);
    }

    /// <summary>A listener whose instance has nothing listening anywhere, and expects something on 5174.</summary>
    private async Task<NetworkStream> ConnectToAnEmptyInstanceAsync(string host, int port)
    {
        _plan = SocksPlan.Resolve(null, "shop-amber-fox") with { Port = PortSpec.Range(0, 0) };
        _listener = new SocksListener(
            _plan,
            new LaunchedBrowsers(),
            (_, _, _) => Task.FromResult<Stream?>(null),
            _log,
            p => p == 5174 ? new ExpectedPort("proof", 5174, "Task 'proof' is waiting on proof-install.") : null);
        _listener.Start();

        var stream = await ConnectAsync();
        await stream.WriteAsync(new byte[] { 5, 1, 2 });
        await ReadAsync(stream, 2);
        var user = Encoding.UTF8.GetBytes(_plan.User);
        var password = Encoding.UTF8.GetBytes(_plan.Password);
        await stream.WriteAsync((byte[])[1, (byte)user.Length, .. user, (byte)password.Length, .. password]);
        await ReadAsync(stream, 2);
        await stream.WriteAsync(ConnectTo(host, port));
        return stream;
    }

    [Fact]
    public async Task AnswersAnExpectedPortThatIsNotUpWithTheLoadingPage()
    {
        using var stream = await ConnectToAnEmptyInstanceAsync("localhost", 5174);

        Assert.Equal(0, (await ReadAsync(stream, 10))[1]);

        await stream.WriteAsync("GET / HTTP/1.1\r\nHost: localhost:5174\r\n\r\n"u8.ToArray());
        var response = await new StreamReader(stream).ReadToEndAsync();

        Assert.StartsWith("HTTP/1.1 503 ", response, StringComparison.Ordinal);
        Assert.Contains($"{LoadingPage.Header}: 1", response, StringComparison.Ordinal);
        Assert.Contains("proof is starting", response, StringComparison.Ordinal);
        Assert.Contains("waiting on proof-install", response, StringComparison.Ordinal);
    }

    [Fact]
    public async Task HangsUpOnTlsToAnExpectedPort()
    {
        // No certificate here to answer an https route's ClientHello with.
        using var stream = await ConnectToAnEmptyInstanceAsync("localhost", 5174);
        await ReadAsync(stream, 10);

        await stream.WriteAsync(new byte[] { 0x16, 3, 1, 0, 5, 1, 0, 0, 1, 0 });

        Assert.Equal(0, await stream.ReadAsync(new byte[16]));
    }

    [Fact]
    public async Task StillRefusesAPortNobodyDeclared()
    {
        using var stream = await ConnectToAnEmptyInstanceAsync("localhost", 5999);

        Assert.Equal((byte)SocksReply.ConnectionRefused, (await ReadAsync(stream, 10))[1]);
    }

    [Fact]
    public void WalksUpwardFromATakenPort()
    {
        using var squatter = new TcpListener(IPAddress.Loopback, 0);
        squatter.Start();
        var taken = ((IPEndPoint)squatter.LocalEndpoint).Port;

        var plan = SocksPlan.Resolve(new BrowserConfig { Port = PortSpec.Single(taken) }, "x");
        _listener = new SocksListener(plan, new LaunchedBrowsers(), (_, _, _) => Task.FromResult<Stream?>(null), _log);
        _listener.Start();

        Assert.NotEqual(taken, _listener.Port);
        Assert.InRange(_listener.Port, taken + 1, taken + PortSpec.DefaultWalk);
    }
}

/// <summary>The page for a port that is coming but not up.</summary>
public class LoadingPageTests
{
    [Fact]
    public void IsA503ThatSaysItIsEnvmuxAndIsNeverCached()
    {
        var response = Encoding.UTF8.GetString(LoadingPage.Response(new ExpectedPort("web", 3000, null), html: true));

        Assert.StartsWith("HTTP/1.1 503 Service Unavailable\r\n", response, StringComparison.Ordinal);
        Assert.Contains("Cache-Control: no-store\r\n", response, StringComparison.Ordinal);
        Assert.Contains("X-Envmux-Loading: 1\r\n", response, StringComparison.Ordinal);
        Assert.Contains("Connection: close\r\n", response, StringComparison.Ordinal);
    }

    [Fact]
    public void PollsForTheHeaderToGoAway()
    {
        var html = LoadingPage.Html(new ExpectedPort("web", 3000, null));

        Assert.Contains("answer.headers.has(\"X-Envmux-Loading\")", html, StringComparison.Ordinal);
        Assert.Contains("location.reload()", html, StringComparison.Ordinal);
        Assert.Contains("http-equiv=\"refresh\"", html, StringComparison.Ordinal);
    }

    [Fact]
    public void EscapesWhatItIsTold()
    {
        var html = LoadingPage.Html(new ExpectedPort("<web>", 3000, "a & b"));

        Assert.Contains("&lt;web&gt; is starting", html, StringComparison.Ordinal);
        Assert.Contains("a &amp; b", html, StringComparison.Ordinal);
        Assert.DoesNotContain("<web>", html, StringComparison.Ordinal);
    }
}

/// <summary>What a launched browser is told, which is what makes localhost the instance.</summary>
public class BrowserLaunchTests
{
    [Fact]
    public void ChromiumTakesLoopbackOutOfItsBypassAndGetsItsOwnProfile()
    {
        var arguments = BrowserLaunch.ChromiumArguments(1080, @"C:\p", "http://localhost:3000/", "envmux shop-amber-fox");

        Assert.Contains("--window-name=envmux shop-amber-fox", arguments);

        Assert.Contains("--proxy-server=socks5://127.0.0.1:1080", arguments);
        Assert.Contains("--proxy-bypass-list=<-loopback>", arguments);
        Assert.Contains(@"--user-data-dir=C:\p", arguments);
        Assert.Equal("http://localhost:3000/", arguments[^1]);
    }

    [Fact]
    public void FirefoxResolvesThroughTheProxyAndLetsItHaveLocalhost()
    {
        var preferences = BrowserLaunch.FirefoxPreferences(1081);

        Assert.Contains("user_pref(\"network.proxy.socks_port\", 1081);", preferences, StringComparison.Ordinal);
        Assert.Contains("user_pref(\"network.proxy.socks_remote_dns\", true);", preferences, StringComparison.Ordinal);
        Assert.Contains("user_pref(\"network.proxy.allow_hijacking_localhost\", true);", preferences, StringComparison.Ordinal);
        Assert.DoesNotContain("\r", preferences, StringComparison.Ordinal);
    }

    private static readonly Routing.RoutedEndpoint[] Routes =
    [
        new("docs", 5173, "envmux-a.envmux"),
        new("proof", 5174, "envmux-a.envmux"),
        new("db", 5432, "envmux-a.envmux", "postgres"),
    ];

    [Fact]
    public void StartsAtTheFirstWebRouteOnLocalhost()
    {
        Assert.Equal("http://localhost:5173/", BrowserLaunch.StartUrl(null, Routes));
        Assert.Equal("about:blank", BrowserLaunch.StartUrl(null, [Routes[2]]));
    }

    [Theory]
    [InlineData("proof", "http://localhost:5174/")]
    [InlineData("PROOF", "http://localhost:5174/")]
    [InlineData("localhost:5173/admin", "http://localhost:5173/admin")]
    [InlineData("https://example.com/", "https://example.com/")]
    public void StartsWhereBrowserOpenSays(string open, string expected)
    {
        Assert.Equal(expected, BrowserLaunch.StartUrl(open, Routes));
    }

    [Theory]
    [InlineData("proof", true)]
    [InlineData("localhost:5174", false)]
    [InlineData("example.com", false)]
    [InlineData("/admin", false)]
    public void TellsARouteNameFromAUrl(string open, bool isRoute)
    {
        Assert.Equal(isRoute, BrowserLaunch.IsRouteName(open));
    }

    [Fact]
    public void GivesASessionTheSameColourEveryTimeAndReadsAnOverride()
    {
        Assert.Equal(BrowserLaunch.ColourFor("shop-amber-fox"), BrowserLaunch.ColourFor("shop-amber-fox"));
        Assert.Contains(BrowserLaunch.ColourFor("shop-amber-fox"), BrowserLaunch.Palette);

        // Ten names should not all land on one colour.
        Assert.True(Enumerable.Range(0, 10).Select(i => BrowserLaunch.ColourFor($"p-s{i}")).Distinct().Count() > 3);

        Assert.Equal(0xFF00897Bu, BrowserLaunch.ParseColour("#00897b"));
        Assert.Null(BrowserLaunch.ParseColour("teal"));
        Assert.Null(BrowserLaunch.ParseColour("#0089"));
    }

    [Fact]
    public void SeedsANewChromiumProfileWithItsNameAndColourAndLeavesAnOldOneAlone()
    {
        var profile = Directory.CreateTempSubdirectory("envmux-profile-").FullName;

        try
        {
            BrowserLaunch.SeedChromiumProfile(profile, "envmux shop-amber-fox", 0xFF00897B);

            var preferences = File.ReadAllText(Path.Combine(profile, "Default", "Preferences"));
            Assert.Contains("\"user_color2\":-16742021", preferences, StringComparison.Ordinal);
            Assert.Contains("envmux shop-amber-fox", File.ReadAllText(Path.Combine(profile, "Local State")), StringComparison.Ordinal);

            // Chrome owns the files once it has run: a second seed changes nothing.
            BrowserLaunch.SeedChromiumProfile(profile, "other", 0xFF1E88E5);
            Assert.Contains("envmux shop-amber-fox", File.ReadAllText(Path.Combine(profile, "Local State")), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(profile, recursive: true);
        }
    }

    [Theory]
    [InlineData(@"C:\x\chrome.exe", "Chrome")]
    [InlineData("/usr/bin/firefox", "Firefox")]
    [InlineData(@"C:\x\msedge.exe", "Edge")]
    public void KnowsABrowserByItsFileName(string path, string kind)
    {
        Assert.Equal(kind, BrowserLaunch.KindOf(path)?.ToString());
    }

    [Fact]
    public void ChoosesTheFirstFoundOrTheOneNamed()
    {
        InstalledBrowser[] found =
        [
            new(BrowserKind.Chrome, @"C:\chrome.exe"),
            new(BrowserKind.Edge, @"C:\msedge.exe"),
        ];

        Assert.Equal(BrowserKind.Chrome, BrowserLaunch.Choose(null, found).Kind);
        Assert.Equal(BrowserKind.Edge, BrowserLaunch.Choose("EDGE", found).Kind);

        var e = Assert.Throws<BrowserException>(() => BrowserLaunch.Choose("firefox", found));
        Assert.Contains("not installed", e.Message, StringComparison.Ordinal);

        Assert.Throws<BrowserException>(() => BrowserLaunch.Choose("netscape", found));
        Assert.Throws<BrowserException>(() => BrowserLaunch.Choose(null, []));
    }
}
