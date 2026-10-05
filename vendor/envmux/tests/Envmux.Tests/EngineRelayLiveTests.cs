using System.Diagnostics;
using System.Text;

using Envmux.Backends;
using Envmux.Backends.DockerEngine;

using Xunit.Abstractions;

namespace Envmux.Tests;

/// <summary>
/// One container with a server on its own <c>127.0.0.1</c>, for every test in <see cref="EngineRelayLiveTests"/>.
/// </summary>
/// <remarks>
/// <para>
/// Skipped, with the engine's own sentence as the reason, when nothing answers,
/// and by <c>ENVMUX_DOCKER_LIVE=0</c>. The container is <c>swarmtest-relay-…</c>,
/// labelled <c>envmux.swarmtest=1</c>, publishes nothing — that is the point —
/// and is removed afterwards. The image is <c>debian:trixie-slim</c>, pulled
/// only if the engine lacks it and removed only if this pulled it: the relay is
/// bash and <c>/dev/tcp</c>, and the server is perl, both of which Debian's
/// smallest image has and busybox's does not.
/// </para>
/// <para>
/// The server binds <c>127.0.0.1</c> only. Nothing outside the container can
/// reach it any other way, which is what makes a successful GET a proof.
/// </para>
/// </remarks>
public sealed class EngineRelayFixture : IAsyncLifetime
{
    public const string Image = "debian:trixie-slim";

    public const int Port = 18080;

    /// <summary>What the server answers: a small line, then enough to span many stdcopy frames.</summary>
    public const int BodyLength = 200_000;

    private const string Prefix = "swarmtest-relay-";

    private static readonly Dictionary<string, string> Labels = new(StringComparer.Ordinal)
    {
        ["envmux.swarmtest"] = "1",
    };

    /// <summary>
    /// A one-file HTTP server on the container's own loopback: close-after-response, body of a known length.
    /// </summary>
    /// <remarks>
    /// Single-threaded, which is a feature: a relay that did not end when its
    /// stream was disposed would wedge it, and every test after would fail. It
    /// ignores SIGPIPE and answers only a request that arrived, because one
    /// test connects and hangs up without sending, and a default perl dies on
    /// the write to that closed socket.
    /// </remarks>
    private const string Server =
        "perl -MIO::Socket::INET -e '" +
        "$|=1; $SIG{PIPE}=\"IGNORE\"; my $s=IO::Socket::INET->new(LocalAddr=>\"127.0.0.1\",LocalPort=>18080,Listen=>16,ReuseAddr=>1) or die $!; " +
        "while(my $c=$s->accept){ my $req=\"\"; while(<$c>){ $req.=$_; last if /^\\r?$/ } " +
        "if(length $req){ my $body=\"relay-hello:\".(\"x\" x 200000); " +
        "print $c \"HTTP/1.0 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: \".length($body).\"\\r\\nConnection: close\\r\\n\\r\\n\".$body } " +
        "close $c }'";

    private bool _pulled;

    internal DockerEngineClient? Engine { get; private set; }

    public string Container { get; } = Prefix + Guid.NewGuid().ToString("N")[..6];

    public string? SkipReason { get; private set; }

    public async Task InitializeAsync()
    {
        if (Environment.GetEnvironmentVariable("ENVMUX_DOCKER_LIVE") is "0" or "false")
        {
            SkipReason = "ENVMUX_DOCKER_LIVE=0";
            return;
        }

        var engine = DockerEngineClient.Connect();

        try
        {
            var version = await engine.VersionAsync();

            if (!version.Os.Equals("linux", StringComparison.Ordinal))
            {
                SkipReason = $"the engine on {engine.Endpoint} runs {version.Os} containers, and these tests want linux";
                await engine.DisposeAsync();
                return;
            }

            foreach (var stale in await engine.ContainersAsync(Labels))
            {
                if (stale.Names.Any(n => n.TrimStart('/').StartsWith(Prefix, StringComparison.Ordinal)))
                {
                    await engine.RemoveAsync(stale.Id, force: true, volumes: true);
                }
            }

            if (await engine.ImageAsync(Image) is null)
            {
                await engine.PullAsync(Image);
                _pulled = true;
            }

            Engine = engine;

            await engine.CreateContainerAsync(
                Container,
                new ContainerCreate
                {
                    Image = Image,
                    Cmd = ["sleep", "86400"],
                    Labels = Labels,
                });

            await engine.StartAsync(Container);

            // The server, started by an exec that returns at once: its output
            // goes to a file, so nothing holds the exec's stdout open.
            var started = await new EngineExec(engine).CapturedAsync(
                Container,
                ["sh", "-c", $"nohup {Server} >/tmp/server.log 2>&1 &"]);

            if (!started.Ok)
            {
                SkipReason = $"could not start the server in {Container}: {started.Text}";
                await DisposeAsync();
            }
        }
        catch (Exception e) when (e is BackendException or IOException or TimeoutException)
        {
            SkipReason = e.Message;
            await DisposeAsync();
        }
    }

    public async Task DisposeAsync()
    {
        if (Engine is not { } engine)
        {
            return;
        }

        Engine = null;

        try
        {
            await engine.RemoveAsync(Container, force: true, volumes: true);

            if (_pulled)
            {
                await engine.RemoveImageAsync(Image);
            }
        }
        finally
        {
            await engine.DisposeAsync();
        }
    }
}

/// <summary>
/// <see cref="EngineRelay"/> against the real engine: a server on a container's
/// own <c>127.0.0.1</c>, reached, and the relay gone when the stream is.
/// </summary>
public sealed class EngineRelayLiveTests(EngineRelayFixture fixture, ITestOutputHelper output)
    : IClassFixture<EngineRelayFixture>
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    private DockerEngineClient Engine
    {
        get
        {
            Skip.If(fixture.SkipReason is not null, fixture.SkipReason);
            return fixture.Engine!;
        }
    }

    /// <summary>Dial the fixture's server, waiting for it to be up the first time.</summary>
    private async Task<Stream> DialAsync(string? user, IReadOnlyList<string> hosts, CancellationToken ct)
    {
        var clock = Stopwatch.StartNew();

        while (true)
        {
            if (await EngineRelay.DialAsync(Engine, fixture.Container, user, hosts, EngineRelayFixture.Port, ct) is { } stream)
            {
                return stream;
            }

            if (clock.Elapsed > TimeSpan.FromSeconds(10))
            {
                var log = await new EngineExec(Engine).CapturedAsync(fixture.Container, ["cat", "/tmp/server.log"], ct: ct);
                throw new TimeoutException($"nothing answered on {fixture.Container}'s 127.0.0.1:{EngineRelayFixture.Port}; the server said: {log.Text}");
            }

            await Task.Delay(200, ct);
        }
    }

    private static async Task<string> GetAsync(Stream stream, CancellationToken ct)
    {
        await stream.WriteAsync("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n"u8.ToArray(), ct);

        using var collected = new MemoryStream();
        var buffer = new byte[16 * 1024];
        int read;

        while ((read = await stream.ReadAsync(buffer, ct)) > 0)
        {
            collected.Write(buffer, 0, read);
        }

        return Encoding.ASCII.GetString(collected.ToArray());
    }

    /// <summary>How many relays are running in the container right now.</summary>
    private async Task<int> RelaysAsync(CancellationToken ct)
    {
        // One line per process — the relay's command line is the script, newlines
        // and all — and the first character bracketed, so the search does not
        // find itself.
        var counted = await new EngineExec(Engine).CapturedAsync(
            fixture.Container,
            ["sh", "-c", "for c in /proc/[0-9]*/cmdline; do tr '\\0\\n' '  ' < $c; echo; done 2>/dev/null | grep -c '[e]nvmux-relay'"],
            ct: ct);

        return int.Parse(counted.Text.Trim(), System.Globalization.CultureInfo.InvariantCulture);
    }

    [SkippableFact]
    public async Task AServerOnTheContainersOwnLoopbackAnswersAGetThroughTheRelay()
    {
        using var deadline = new CancellationTokenSource(Patience);
        var ct = deadline.Token;

        await using var stream = await DialAsync(null, ["127.0.0.1"], ct);

        var clock = Stopwatch.StartNew();
        var response = await GetAsync(stream, ct);
        output.WriteLine($"GET answered in {clock.ElapsedMilliseconds} ms, {response.Length} bytes");

        Assert.StartsWith("HTTP/1.0 200 OK", response, StringComparison.Ordinal);

        var body = response[(response.IndexOf("\r\n\r\n", StringComparison.Ordinal) + 4)..];
        Assert.StartsWith("relay-hello:", body, StringComparison.Ordinal);
        Assert.Equal("relay-hello:".Length + EngineRelayFixture.BodyLength, body.Length);
        Assert.True(body.AsSpan("relay-hello:".Length).IndexOfAnyExcept('x') < 0);

        // The server closed, so the relay ended, so the stream did: a second read is still the end.
        Assert.Equal(0, await stream.ReadAsync(new byte[16], ct));
    }

    [SkippableFact]
    public async Task ANameIsTriedAfterAnAddressThatRefusesAndSomebodyOtherThanRootCanDial()
    {
        using var deadline = new CancellationTokenSource(Patience);
        var ct = deadline.Token;

        // ::1 refuses (the server is IPv4 only), then localhost resolves and answers.
        await using (var stream = await DialAsync(null, ["::1", "localhost"], ct))
        {
            Assert.StartsWith("HTTP/1.0 200 OK", await GetAsync(stream, ct), StringComparison.Ordinal);
        }

        // Through runuser, as a session's account would.
        await using (var stream = await DialAsync("nobody", ["127.0.0.1"], ct))
        {
            Assert.StartsWith("HTTP/1.0 200 OK", await GetAsync(stream, ct), StringComparison.Ordinal);
        }
    }

    [SkippableFact]
    public async Task APortNothingListensOnIsNullAndQuickly()
    {
        using var deadline = new CancellationTokenSource(Patience);

        var clock = Stopwatch.StartNew();
        var refused = await EngineRelay.DialAsync(Engine, fixture.Container, null, ["127.0.0.1", "::1"], 18099, deadline.Token);
        output.WriteLine($"a refused port came back in {clock.ElapsedMilliseconds} ms");

        Assert.Null(refused);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5), $"took {clock.Elapsed}");

        // A relay that could not connect exits by itself; nothing is left running.
        await Task.Delay(500, deadline.Token);
        Assert.Equal(0, await RelaysAsync(deadline.Token));
    }

    [SkippableFact]
    public async Task DisposingTheStreamEndsTheRelayInTheContainer()
    {
        using var deadline = new CancellationTokenSource(Patience);
        var ct = deadline.Token;

        // Connected and idle: the server is waiting for a request, the relay is
        // copying nothing. Closing the connection alone would leave it there.
        var stream = await DialAsync(null, ["127.0.0.1"], ct);
        Assert.Equal(1, await RelaysAsync(ct));

        var clock = Stopwatch.StartNew();
        await stream.DisposeAsync();

        while (await RelaysAsync(ct) > 0)
        {
            Assert.True(clock.Elapsed < TimeSpan.FromSeconds(10), "the relay outlived its stream");
            await Task.Delay(100, ct);
        }

        output.WriteLine($"the relay was gone {clock.ElapsedMilliseconds} ms after the dispose");
    }

    [SkippableFact]
    public async Task ADialCostsAboutOneExec()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;

        // The first one also proves the server is up, and is measured apart.
        var first = Stopwatch.StartNew();
        await using (var warm = await DialAsync(null, ["127.0.0.1"], ct))
        {
            first.Stop();
            await GetAsync(warm, ct);
        }

        var samples = new List<double>();

        for (var i = 0; i < 20; i++)
        {
            var clock = Stopwatch.StartNew();
            var stream = await EngineRelay.DialAsync(Engine, fixture.Container, null, ["127.0.0.1"], EngineRelayFixture.Port, ct);
            clock.Stop();

            Assert.NotNull(stream);
            samples.Add(clock.Elapsed.TotalMilliseconds);

            await using (stream)
            {
                Assert.StartsWith("HTTP/1.0 200 OK", await GetAsync(stream, ct), StringComparison.Ordinal);
            }
        }

        samples.Sort();

        output.WriteLine(
            $"dial: first {first.Elapsed.TotalMilliseconds:F0} ms; then over {samples.Count}: " +
            $"min {samples[0]:F0} ms, median {samples[samples.Count / 2]:F0} ms, max {samples[^1]:F0} ms");

        Assert.True(samples[samples.Count / 2] < 2000, $"a dial took {samples[samples.Count / 2]:F0} ms at the median");
        Assert.Equal(0, await RelaysAsync(ct));
    }
}
