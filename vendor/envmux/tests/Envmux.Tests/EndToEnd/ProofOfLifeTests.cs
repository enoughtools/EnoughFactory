using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace Envmux.Tests.EndToEnd;

/// <summary>
/// A session, end to end, on each backend: up, reachable through the proxy,
/// looked at in a browser, and gone again.
/// </summary>
/// <remarks>
/// <para>
/// What "working" means for a session now that it is reached only through the
/// browser proxy: the starting page while the app installs, the app itself
/// once it is up — served from the instance's own loopback, which nothing else
/// can reach — its HMR websocket, the rest of the web leaving from this
/// machine, and a real browser rendering all of it. The same test for every
/// target, so an Incus VM, an Incus remote and Docker are held to one promise.
/// </para>
/// <para>
/// Opt-in: <c>ENVMUX_E2E=incus-remote;docker</c> (see <see cref="Targets"/>).
/// A run takes minutes per target — most of it installing Node in a fresh
/// instance — and leaves nothing behind when it finishes.
/// </para>
/// </remarks>
[Trait("Category", "EndToEnd")]
public sealed class ProofOfLifeTests
{
    private static readonly TimeSpan Starting = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan Installing = TimeSpan.FromMinutes(8);

    public static TheoryData<string> Cases => Targets.Names();

    [SkippableTheory]
    [MemberData(nameof(Cases))]
    public async Task ASessionIsReachedOnlyThroughItsBrowser(string name)
    {
        Skip.If(name == Targets.Unset, $"set {Targets.Variable} to run these, e.g. {Targets.Variable}=incus-remote;docker");

        var target = Targets.Find(name)!;
        var sessionName = $"e2e-{target.Name}-{Random.Shared.Next(1000, 9999).ToString(CultureInfo.InvariantCulture)}";

        await using var session = await SessionUnderTest.StartAsync(target, sessionName);

        var proxy = await session.ProxyAsync(Starting);
        var instance = await session.InstanceAsync(Starting);

        // 1. While Node installs, the declared port answers with envmux's
        //    starting page rather than a refusal — then with the app.
        var (sawStarting, app) = await UntilTheAppAnswersAsync(proxy, session);
        Assert.True(sawStarting, "the starting page was never served while the app installed");
        Assert.Contains("proof of life", app.Body, StringComparison.Ordinal);

        // These commands once silently chose Incus even for a Docker session.
        // Exercise them with the same binary the archive check extracted.
        if (target.Backend == "docker")
        {
            var code = await session.CommandAsync("code", sessionName, "--print", "--backend", "docker");
            Assert.Equal(0, code.Code);
            Assert.Contains("attached-container", code.Output, StringComparison.Ordinal);
            var logs = await session.CommandAsync("logs", sessionName, "proof", "--backend", "docker");
            Assert.Equal(0, logs.Code);
            Assert.Contains("vite", logs.Output, StringComparison.OrdinalIgnoreCase);
            var prune = await session.CommandAsync("prune", "--dry-run", "--backend", "docker");
            Assert.Equal(0, prune.Code);
            Assert.Contains("running", prune.Output, StringComparison.Ordinal);
        }

        // 2. It is the instance that answered: Vite's define carries the
        //    hostname of the machine the dev server runs on.
        var env = await SocksClient.GetAsync(proxy, "localhost", 5174, "/@vite/env", CancellationToken.None);
        Assert.Contains(instance, env.Body, StringComparison.Ordinal);

        // 3. The HMR websocket upgrades through the relay, and Vite says hello.
        Assert.Contains("\"connected\"", await WebSocketHelloAsync(proxy), StringComparison.Ordinal);

        // 4. The rest of the web leaves from this machine.
        await using (await SocksClient.ConnectAsync(proxy, "fonts.googleapis.com", 443, CancellationToken.None))
        {
        }

        // 5. A real browser renders it: the served-by line, the websocket, and a
        //    Google font, all through the proxy.
        if (Chrome() is { } chrome)
        {
            var dom = await RenderAsync(chrome, proxy);

            Assert.Contains(instance, dom, StringComparison.Ordinal);
            Assert.Contains(">connected<", dom, StringComparison.Ordinal);
            Assert.Contains("loaded from Google", dom, StringComparison.Ordinal);
        }

        // 6. Stopped the way a person stops it; the instance goes with it.
        Assert.True(await session.StopAsync(TimeSpan.FromMinutes(3)), "envmux did not exit after /api/stop");
        Assert.Equal(0, session.ExitCode);
        Assert.Contains(session.Lines, l => l.Contains($"{instance} removed", StringComparison.Ordinal));
    }

    /// <summary>
    /// Poll the app's port through the proxy until the app answers, noting
    /// whether envmux's starting page was served first.
    /// </summary>
    private static async Task<(bool SawStarting, HttpAnswer App)> UntilTheAppAnswersAsync(
        Uri proxy,
        SessionUnderTest session)
    {
        var sawStarting = false;
        var deadline = DateTime.UtcNow + Installing;

        while (DateTime.UtcNow < deadline && !session.HasExited)
        {
            try
            {
                var answer = await SocksClient.GetAsync(proxy, "localhost", 5174, "/", CancellationToken.None);

                if (answer.Headers.ContainsKey("X-Envmux-Loading"))
                {
                    sawStarting = true;
                }
                else if (answer.Status == 200)
                {
                    return (sawStarting, answer);
                }
            }
            catch (Exception e) when (e is IOException or System.Net.Sockets.SocketException)
            {
                // Refused before the session knew the port, or the instance is
                // still coming up: ask again.
            }

            await Task.Delay(TimeSpan.FromSeconds(2));
        }

        throw new TimeoutException(
            "the app never answered through the proxy. The log:\n" + string.Join('\n', session.Lines.TakeLast(60)));
    }

    /// <summary>A websocket handshake to Vite's HMR endpoint, and the first frame after it.</summary>
    private static async Task<string> WebSocketHelloAsync(Uri proxy)
    {
        await using var stream = await SocksClient.ConnectAsync(proxy, "localhost", 5174, CancellationToken.None);

        var handshake =
            "GET / HTTP/1.1\r\nHost: localhost:5174\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Protocol: vite-hmr\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(handshake));

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var buffer = new byte[4096];
        var said = new StringBuilder();

        while (!said.ToString().Contains("connected", StringComparison.Ordinal))
        {
            var read = await stream.ReadAsync(buffer, timeout.Token);

            if (read == 0)
            {
                break;
            }

            said.Append(Encoding.Latin1.GetString(buffer, 0, read));
        }

        Assert.StartsWith("HTTP/1.1 101", said.ToString(), StringComparison.Ordinal);
        return said.ToString();
    }

    /// <summary>
    /// Headless Chrome on a scratch profile, through the proxy, and the page as
    /// it stands after its scripts have run.
    /// </summary>
    private static async Task<string> RenderAsync(string chrome, Uri proxy)
    {
        await using var front = new CredentialFront(proxy);
        var profile = Directory.CreateTempSubdirectory("envmux-e2e-chrome-").FullName;

        try
        {
            var start = new ProcessStartInfo(chrome)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };

            foreach (var argument in new[]
                     {
                         "--headless=new",
                         $"--user-data-dir={profile}",
                         "--no-first-run",
                         $"--proxy-server=socks5://127.0.0.1:{front.Port.ToString(CultureInfo.InvariantCulture)}",
                         "--proxy-bypass-list=<-loopback>",
                         "--virtual-time-budget=10000",
                         "--dump-dom",
                         "http://localhost:5174/",
                     })
            {
                start.ArgumentList.Add(argument);
            }

            using var process = System.Diagnostics.Process.Start(start)!;
            _ = process.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            try
            {
                // Chrome on macOS can emit its complete DOM and then hang in
                // display-link shutdown. The rendered document is the evidence;
                // waiting for browser exit adds an unrelated display dependency.
                var dom = new StringBuilder();
                var buffer = new char[4096];
                while (!dom.ToString().Contains("</html>", StringComparison.OrdinalIgnoreCase))
                {
                    var read = await process.StandardOutput.ReadAsync(buffer, timeout.Token);
                    if (read == 0)
                    {
                        break;
                    }

                    dom.Append(buffer, 0, read);
                }

                return dom.ToString();
            }
            finally
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }

                await process.WaitForExitAsync();
            }
        }
        finally
        {
            try
            {
                Directory.Delete(profile, recursive: true);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Chrome's crashpad can hold a file a moment longer.
            }
        }
    }

    private static string? Chrome() =>
        Envmux.Socks.BrowserLaunch.Candidates(Envmux.Socks.BrowserKind.Chrome).FirstOrDefault(File.Exists);
}

/// <summary>What <see cref="Targets"/> reads out of <c>ENVMUX_E2E</c>.</summary>
public sealed class TargetsTests
{
    [Fact]
    public void ReadsNamesHomesAndBackends()
    {
        var targets = Targets.Parse(@"incus-remote; incus-hyperv=D:\envmux-hyperv ;docker");

        Assert.Equal(["incus-remote", "incus-hyperv", "docker"], targets.Select(t => t.Name));
        Assert.Equal(["incus", "incus", "docker"], targets.Select(t => t.Backend));
        Assert.Equal([null, @"D:\envmux-hyperv", null], targets.Select(t => t.Home));
    }

    [Fact]
    public void ReadsNothingFromNothing()
    {
        Assert.Empty(Targets.Parse(null));
        Assert.Empty(Targets.Parse(" ; "));
    }
}
