using System.Diagnostics;
using System.Text;

using Envmux.Backends;
using Envmux.Backends.DockerEngine;
using Envmux.Incus;

using Xunit.Abstractions;

namespace Envmux.Tests;

/// <summary>
/// One container on the local engine for every test in <see cref="EngineExecLiveTests"/>.
/// </summary>
/// <remarks>
/// <para>
/// Skipped, with the engine's own sentence as the reason, when nothing answers,
/// and by <c>ENVMUX_DOCKER_LIVE=0</c> on a machine that has an engine and would
/// rather not. The container is <c>swarmtest-exec-…</c>, labelled
/// <c>envmux.swarmtest=1</c>, publishes nothing, and is removed afterwards;
/// one left by a run that was killed before it could is removed first. Nothing
/// else on the engine is looked at.
/// </para>
/// <para>
/// The image is <c>ENVMUX_DOCKER_LIVE_IMAGE</c> when that is set — the golden
/// image, for the tmux case, which is skipped where there is no tmux — and
/// <c>alpine:latest</c> otherwise, which is the other half of the point: the
/// signal script has to run in busybox's <c>sh</c> as well as in dash. An image
/// is pulled only if the engine lacks it, and removed only if this pulled it.
/// </para>
/// </remarks>
public sealed class EngineExecFixture : IAsyncLifetime
{
    private const string Prefix = "swarmtest-exec-";

    private static readonly Dictionary<string, string> Labels = new(StringComparer.Ordinal)
    {
        ["envmux.swarmtest"] = "1",
    };

    private bool _pulled;

    internal DockerEngineClient? Engine { get; private set; }

    public string Image { get; } = Environment.GetEnvironmentVariable("ENVMUX_DOCKER_LIVE_IMAGE") is { Length: > 0 } image
        ? image
        : "alpine:latest";

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
                    Entrypoint = ["sleep"],
                    Cmd = ["86400"],
                    Labels = Labels,
                });

            await engine.StartAsync(Container);
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
/// <see cref="EngineExec"/> against the real engine: the findings in its remarks, as assertions.
/// </summary>
/// <remarks>
/// Every long-lived command is a <c>sleep</c> of a number no other test uses, so
/// "is it still running" is a question <c>/proc</c> can answer about one test at
/// a time.
/// </remarks>
public sealed class EngineExecLiveTests(EngineExecFixture fixture, ITestOutputHelper output)
    : IClassFixture<EngineExecFixture>
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(20);

    private EngineExec Exec
    {
        get
        {
            Skip.If(fixture.SkipReason is not null, fixture.SkipReason);
            return new EngineExec(fixture.Engine!);
        }
    }

    private static string[] Shell(string script) => ["sh", "-c", script];

    /// <summary>Whether any process in the container has this in its command line.</summary>
    private async Task<bool> IsRunningAsync(string commandLine)
    {
        // Out of /proc rather than ps, which busybox and procps spell differently; anchored, so a
        // wrapper with the command in its own arguments is not the command; and the first
        // character bracketed, so the search does not find itself.
        var pattern = $"^[{commandLine[0]}]{commandLine[1..]}";
        var found = await Exec.CapturedAsync(
            fixture.Container,
            Shell($"for c in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < $c; echo; done 2>/dev/null | grep -c '{pattern}'"));

        return !found.Text.Trim().Equals("0", StringComparison.Ordinal);
    }

    private static async Task<string> ReadUntilAsync(Stream terminal, string expected, CancellationToken ct)
    {
        var seen = new StringBuilder();
        var buffer = new byte[4096];

        while (!seen.ToString().Contains(expected, StringComparison.Ordinal))
        {
            var read = await terminal.ReadAsync(buffer, ct);

            if (read == 0)
            {
                throw new EndOfStreamException($"the terminal ended before '{expected}'; it said: {seen}");
            }

            seen.Append(Encoding.UTF8.GetString(buffer, 0, read));
        }

        return seen.ToString();
    }

    [SkippableFact]
    public async Task ATerminalRoundTripsIsBornAtItsSizeResizesAndExitsWithItsCode()
    {
        var exec = Exec;
        using var deadline = new CancellationTokenSource(Patience);
        var ct = deadline.Token;

        var watch = Stopwatch.StartNew();

        await using var shell = await exec.InteractiveAsync(
            fixture.Container,
            ["sh"],
            cwd: "/tmp",
            environment: new Dictionary<string, string> { ["EXECTEST"] = "kākā", ["PS1"] = "" },
            width: 132,
            height: 43,
            ct);

        output.WriteLine($"interactive exec open in {watch.ElapsedMilliseconds} ms");

        // The size it was born with, before any resize: rows then columns.
        await shell.Terminal.WriteAsync(Encoding.UTF8.GetBytes("echo \"at=$(pwd) who=$(id -u) v=$EXECTEST size=$(stty size)\"\n"), ct);
        var first = await ReadUntilAsync(shell.Terminal, "size=43 132", ct);
        Assert.Contains("at=/tmp who=0 v=kākā size=43 132", first, StringComparison.Ordinal);

        Assert.Null(await shell.ExitCodeAsync(ct));

        await shell.ResizeAsync(100, 30, ct);
        await shell.Terminal.WriteAsync("echo \"resized=$(stty size)\"\n"u8.ToArray(), ct);
        await ReadUntilAsync(shell.Terminal, "resized=30 100", ct);

        await shell.Terminal.WriteAsync("exit 7\n"u8.ToArray(), ct);

        Assert.Equal(7, await shell.WaitAsync(ct));
        Assert.Equal(7, await shell.ExitCodeAsync(ct));

        // And the terminal ends, rather than staying open on a finished command.
        var buffer = new byte[4096];
        while (await shell.Terminal.ReadAsync(buffer, ct) > 0)
        {
        }
    }

    [SkippableFact]
    public async Task ACommandThatSucceedsExitsZero()
    {
        var exec = Exec;
        using var deadline = new CancellationTokenSource(Patience);

        await using var done = await exec.InteractiveAsync(fixture.Container, ["true"], ct: deadline.Token);

        Assert.Equal(0, await done.WaitAsync(deadline.Token));
    }

    [SkippableFact]
    public async Task ACapturedRunHasBothStreamsTheExitCodeTheEnvironmentAndTheDirectory()
    {
        var exec = Exec;
        using var deadline = new CancellationTokenSource(Patience);

        var watch = Stopwatch.StartNew();

        var result = await exec.CapturedAsync(
            fixture.Container,
            Shell("echo \"out $EXECTEST $(pwd) $(id -u)\"; echo err >&2; exit 3"),
            cwd: "/tmp",
            environment: new Dictionary<string, string> { ["EXECTEST"] = "tākapu" },
            deadline.Token);

        output.WriteLine($"captured exec in {watch.ElapsedMilliseconds} ms");

        Assert.Equal(3, result.ExitCode);
        Assert.Contains("out tākapu /tmp 0", result.Output, StringComparison.Ordinal);
        Assert.Contains("err", result.Output, StringComparison.Ordinal);
    }

    [SkippableFact]
    public async Task ACommandThatCannotStartIsAResultAndAContainerThatIsNotThereIsARefusal()
    {
        var exec = Exec;
        using var deadline = new CancellationTokenSource(Patience);

        var missing = await exec.CapturedAsync(fixture.Container, ["exectest-is-not-installed"], ct: deadline.Token);

        Assert.Equal(127, missing.ExitCode);
        Assert.Contains("exectest-is-not-installed", missing.Output, StringComparison.Ordinal);

        var nowhere = await exec.CapturedAsync(fixture.Container, ["pwd"], cwd: "/no/such/directory", ct: deadline.Token);

        Assert.NotEqual(0, nowhere.ExitCode);
        Assert.Contains("/no/such/directory", nowhere.Output, StringComparison.Ordinal);

        await Assert.ThrowsAnyAsync<BackendException>(
            () => exec.CapturedAsync("swarmtest-exec-nowhere", ["true"], ct: deadline.Token));
    }

    [SkippableFact]
    public async Task FiveMegabytesComeBackWholeCapturedAndDownATerminal()
    {
        var exec = Exec;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;

        const int Size = 5 * 1024 * 1024;
        const string Script = "head -c 5242880 /dev/zero | tr '\\0' 'x'";

        var watch = Stopwatch.StartNew();
        var captured = await exec.CapturedAsync(fixture.Container, Shell(Script), ct: ct);
        output.WriteLine($"5 MiB captured in {watch.ElapsedMilliseconds} ms");

        Assert.Equal(0, captured.ExitCode);
        Assert.Equal(Size, captured.Output.Length);
        Assert.True(captured.Output.AsSpan().IndexOfAnyExcept('x') < 0);

        // The way Command.RunAsync reads one: the wait running beside the read.
        watch.Restart();
        await using var terminal = await exec.InteractiveAsync(fixture.Container, Shell(Script), ct: ct);
        var waiting = terminal.WaitAsync(ct);

        var buffer = new byte[64 * 1024];
        long total = 0;
        int read;

        while ((read = await terminal.Terminal.ReadAsync(buffer, ct)) > 0)
        {
            total += buffer.AsSpan(0, read).Count((byte)'x');
        }

        Assert.Equal(0, await waiting);
        Assert.Equal(Size, total);
        output.WriteLine($"5 MiB down a terminal in {watch.ElapsedMilliseconds} ms");
    }

    [SkippableTheory]
    [InlineData(Signals.Int, 130, "sleep 1101")]
    [InlineData(Signals.Term, 143, "sleep 1102")]
    [InlineData(Signals.Kill, 137, "sleep 1103")]
    public async Task ASignalEndsTheCommand(int signal, int expected, string command)
    {
        var exec = Exec;
        using var deadline = new CancellationTokenSource(Patience);
        var ct = deadline.Token;

        await using var sleeping = await exec.InteractiveAsync(fixture.Container, command.Split(' '), ct: ct);

        var waiting = sleeping.WaitAsync(ct);
        Assert.True(await UntilAsync(() => IsRunningAsync(command), ct));

        var watch = Stopwatch.StartNew();
        await sleeping.SignalAsync(signal, ct);

        Assert.Equal(expected, await waiting);
        output.WriteLine($"signal {signal} ended '{command}' in {watch.ElapsedMilliseconds} ms");
        Assert.False(await IsRunningAsync(command));
    }

    [SkippableFact]
    public async Task SigtermReachesWhatAShellStartedAndNotOnlyTheShell()
    {
        var exec = Exec;
        using var deadline = new CancellationTokenSource(Patience);
        var ct = deadline.Token;

        // The shape of every task and tool: a wrapper, and the thing itself as
        // its child. The trailing echo keeps the shell from exec'ing the sleep.
        await using var wrapped = await exec.InteractiveAsync(fixture.Container, Shell("sleep 1104; echo never"), ct: ct);

        var waiting = wrapped.WaitAsync(ct);
        Assert.True(await UntilAsync(() => IsRunningAsync("sleep 1104"), ct));

        await wrapped.SignalAsync(Signals.Term, ct);

        Assert.Equal(143, await waiting);
        Assert.False(await IsRunningAsync("sleep 1104"));
    }

    [SkippableFact]
    public async Task DisposingATerminalEndsWhatWasRunningInIt()
    {
        var exec = Exec;
        using var deadline = new CancellationTokenSource(Patience);
        var ct = deadline.Token;

        var sleeping = await exec.InteractiveAsync(fixture.Container, Shell("sleep 1105; echo never"), ct: ct);
        Assert.True(await UntilAsync(() => IsRunningAsync("sleep 1105"), ct));

        var watch = Stopwatch.StartNew();
        await sleeping.DisposeAsync();
        output.WriteLine($"dispose of a running exec took {watch.ElapsedMilliseconds} ms");

        Assert.False(await IsRunningAsync("sleep 1105"));
    }

    [SkippableFact]
    public async Task CancellingACapturedRunEndsTheCommandAsWellAsTheWait()
    {
        var exec = Exec;
        using var cancel = new CancellationTokenSource();

        var running = exec.CapturedAsync(fixture.Container, Shell("echo started; sleep 1106; echo never"), ct: cancel.Token);

        using var deadline = new CancellationTokenSource(Patience);
        Assert.True(await UntilAsync(() => IsRunningAsync("sleep 1106"), deadline.Token));

        var watch = Stopwatch.StartNew();
        await cancel.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => running.WaitAsync(Patience));
        output.WriteLine($"cancellation came back in {watch.ElapsedMilliseconds} ms");

        Assert.False(await IsRunningAsync("sleep 1106"));
    }

    [SkippableFact]
    public async Task ACapturedRunReturnsWhenItsCommandDoesNotWhenItsOrphansDo()
    {
        var exec = Exec;
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(40));

        var watch = Stopwatch.StartNew();

        // The eighteen-minute apt, in miniature: the command is done at once and
        // something it started holds the pipe for half a minute.
        var result = await exec.CapturedAsync(fixture.Container, Shell("sleep 30 & echo said; exit 7"), ct: deadline.Token);

        output.WriteLine($"a run whose orphan holds stdout came back in {watch.ElapsedMilliseconds} ms");

        Assert.Equal(7, result.ExitCode);
        Assert.Equal("said", result.Text);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(10), $"took {watch.Elapsed}");
    }

    [SkippableFact]
    public async Task AFollowerReadDownATerminalEndsWhenItsReaderDisposesIt()
    {
        var exec = Exec;
        using var deadline = new CancellationTokenSource(Patience);
        var ct = deadline.Token;

        await exec.CapturedAsync(
            fixture.Container,
            Shell("printf 'one\\ntwo\\nenvmux-exit:0\\n' > /tmp/exectest-follow.log"),
            ct: ct);

        var watch = Stopwatch.StartNew();

        // SessionTask.RunLatchedAsync's shape: a tail -F that never ends on its
        // own, read until its reader has seen enough, then disposed.
        var follower = await exec.InteractiveAsync(fixture.Container, ["tail", "-n", "+1", "-F", "/tmp/exectest-follow.log"], ct: ct);
        var seen = await ReadUntilAsync(follower.Terminal, "envmux-exit:0", ct);

        Assert.Contains("one", seen, StringComparison.Ordinal);
        Assert.Contains("two", seen, StringComparison.Ordinal);
        Assert.True(await IsRunningAsync("tail -n +1 -F /tmp/exectest-follow.log"));

        await follower.DisposeAsync();

        output.WriteLine($"the follower was gone after {watch.ElapsedMilliseconds} ms");
        Assert.False(await IsRunningAsync("tail -n +1 -F /tmp/exectest-follow.log"));
    }

    [SkippableFact]
    public async Task ALatchedTaskOutlivesTheExecThatLaunchedItAndTheOneThatAttached()
    {
        var exec = Exec;
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(40));
        var ct = deadline.Token;

        var tmux = await exec.CapturedAsync(fixture.Container, Shell("command -v tmux"), ct: ct);
        Skip.If(!tmux.Ok, $"{fixture.Image} has no tmux; set ENVMUX_DOCKER_LIVE_IMAGE to the golden image for this one");

        const string Latched = "exectest-latch";

        try
        {
            // SessionTask.LaunchScript's shape: a captured exec starts a detached
            // session, and is gone. The server and the pane both inherit that
            // exec's marker, which is the case the signal script's scope is for.
            var launch = await exec.CapturedAsync(
                fixture.Container,
                Shell($"tmux new-session -d -s {Latched} 'echo latched-and-running; sleep 1107'"),
                ct: ct);

            Assert.True(launch.Ok, launch.Output);

            // Latch.Shell's shape: attach down a terminal, see what is there, and go.
            var attached = await exec.InteractiveAsync(
                fixture.Container,
                [Latch.Multiplexer, "new-session", "-A", "-s", Latched],
                environment: Command.Defaults,
                ct: ct);

            await ReadUntilAsync(attached.Terminal, "latched-and-running", ct);
            await attached.DisposeAsync();

            var sessions = await exec.CapturedAsync(fixture.Container, Latch.List(), ct: ct);

            Assert.Contains(Latched, Latch.Parse(sessions.Output));
            Assert.True(await IsRunningAsync("sleep 1107"));
        }
        finally
        {
            await exec.CapturedAsync(fixture.Container, Latch.Kill(Latched), ct: CancellationToken.None);
        }

        Assert.False(await IsRunningAsync("sleep 1107"));
    }

    private static async Task<bool> UntilAsync(Func<Task<bool>> condition, CancellationToken ct)
    {
        while (!await condition())
        {
            await Task.Delay(100, ct);
        }

        return true;
    }
}
