using System.Globalization;
using System.Text;

using Envmux.Backends;
using Envmux.Backends.DockerEngine;
using Envmux.Incus;

using StdCopy = Envmux.Docker.StdCopy;

namespace Envmux.Tests.DockerEngine;

/// <summary>
/// <see cref="EngineExec"/> against an engine that does what the test says: what
/// is asked of the engine, and what is made of its answers.
/// </summary>
/// <remarks>
/// What the real engine does is <see cref="EngineExecLiveTests"/>' business.
/// Here are the things a live run cannot arrange on purpose: a frame boundary
/// inside a character, an inspect that still says running after the stream has
/// ended, a stream that never ends at all.
/// </remarks>
public sealed class EngineExecTests
{
    private const string Instance = "swarmtest-exec-fake";

    private static async Task<FakeDockerEngine> EngineAsync()
    {
        var engine = new FakeDockerEngine { ImagesMustExist = false };
        await engine.CreateContainerAsync(Instance, new ContainerCreate { Image = "golden" });
        await engine.StartAsync(Instance);
        return engine;
    }

    private static bool IsSignal(FakeExec exec) => exec.Create.Cmd.Contains("envmux-signal");

    /// <summary>The (marker, signal, scope) a signalling exec was given.</summary>
    private static (string Marker, string Signal, string Scope) SignalOf(FakeExec exec)
    {
        var at = exec.Create.Cmd.ToList().IndexOf("envmux-signal");
        return (exec.Create.Cmd[at + 1], exec.Create.Cmd[at + 2], exec.Create.Cmd[at + 3]);
    }

    [Fact]
    public void AnExecIsAskedForAsRootWithTheRequestAndAMarkerOfItsOwn()
    {
        string[] command = ["runuser", "-u", "matt", "--", "bash"];
        var environment = new Dictionary<string, string> { ["HOME"] = "/home/matt", ["TERM"] = "xterm-256color" };

        var tty = EngineExec.Create(command, "/work", environment, 132, 43, "abc", tty: true);

        Assert.Equal(command, tty.Cmd);
        Assert.True(tty.Tty);
        Assert.True(tty.AttachStdin);
        Assert.Equal("0:0", tty.User);
        Assert.Equal("/work", tty.WorkingDir);
        Assert.Equal((132, 43), tty.ConsoleSize);
        Assert.Equal("/home/matt", tty.Env!["HOME"]);
        Assert.Equal("xterm-256color", tty.Env["TERM"]);
        Assert.Equal("abc", tty.Env[EngineExec.MarkerVariable]);

        var captured = EngineExec.Create(command, "", environment, 0, 0, "def", tty: false);

        Assert.False(captured.Tty);
        Assert.False(captured.AttachStdin);
        Assert.Null(captured.WorkingDir);
        Assert.Null(captured.ConsoleSize);
        Assert.Equal("def", captured.Env![EngineExec.MarkerVariable]);
    }

    [Fact]
    public void TheSignalScriptCarriesNoCarriageReturn()
    {
        // The bug ShellScriptTests exists for, in the one script that is a raw
        // string literal and so takes its line endings from the checkout.
        Assert.DoesNotContain('\r', EngineExec.SignalScript);
        Assert.Contains("\n", EngineExec.SignalScript, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ACapturedRunIsBothStreamsInTheOrderTheyArrivedAndTheEnginesExitCode()
    {
        await using var engine = await EngineAsync();
        var stream = new ScriptedExecStream();
        engine.OnExecStream = _ => stream;

        var running = new EngineExec(engine).CapturedAsync(Instance, ["make"]);

        // "é" is two bytes, and the frame boundary falls between them — with a
        // frame of the other stream in the gap.
        var e = Encoding.UTF8.GetBytes("é");

        stream.Feed(
            StdCopy.Frame(StdCopy.Stdout, [.. "caf"u8, e[0]]),
            StdCopy.Frame(StdCopy.Stderr, "warning\n"u8),
            StdCopy.Frame(StdCopy.Stdout, [e[1], .. "\n"u8]));

        var exec = Assert.Single(engine.AllExecs);
        exec.Exit(7);
        stream.End();

        var result = await running.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(7, result.ExitCode);
        Assert.Equal("cafwarning\né\n", result.Output);
        Assert.True(stream.Closed);
    }

    [Fact]
    public async Task AnInspectThatStillSaysRunningAfterTheStreamEndedIsAskedAgain()
    {
        await using var engine = await EngineAsync();
        var stream = new ScriptedExecStream();
        engine.OnExecStream = _ => stream;

        var inspects = 0;

        engine.Intercept = (operation, _) =>
        {
            // The window: the connection has closed, and the third inspect is
            // the first to know the process has.
            if (operation.Equals("ExecInspect", StringComparison.Ordinal) && ++inspects == 3)
            {
                engine.AllExecs.Single().Exit(0);
            }

            return Task.CompletedTask;
        };

        var running = new EngineExec(engine).CapturedAsync(Instance, ["true"]);

        stream.Feed(StdCopy.Frame(StdCopy.Stdout, "done\n"u8));
        stream.End();

        var result = await running.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("done", result.Text);
        Assert.True(inspects >= 3);
    }

    [Fact]
    public async Task AStreamThatOutlivesItsCommandIsGivenAGraceAndThenClosed()
    {
        await using var engine = await EngineAsync();
        var stream = new ScriptedExecStream();
        engine.OnExecStream = _ => stream;

        var exec = new EngineExec(engine)
        {
            WatchInterval = TimeSpan.FromMilliseconds(50),
            DrainGrace = TimeSpan.FromMilliseconds(100),
        };

        var running = exec.CapturedAsync(Instance, ["apt-get", "install", "-y", "openssh-server"]);

        // The postinst started a daemon that holds the pipe: the command has
        // exited and the stream never ends.
        stream.Feed(StdCopy.Frame(StdCopy.Stdout, "Setting up openssh-server\n"u8));
        engine.AllExecs.Single().Exit(0);

        var result = await running.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("Setting up openssh-server", result.Text);
        Assert.True(stream.Closed);
    }

    [Fact]
    public async Task CancellingACapturedRunKillsItClosesTheConnectionAndIsACancellation()
    {
        await using var engine = await EngineAsync();
        var stream = new ScriptedExecStream();
        engine.OnExecStream = exec => IsSignal(exec) ? null : stream;

        using var cancel = new CancellationTokenSource();

        var running = new EngineExec(engine).CapturedAsync(Instance, ["sleep", "1000"], ct: cancel.Token);

        stream.Feed(StdCopy.Frame(StdCopy.Stdout, "started\n"u8));
        await Task.Delay(50);
        await cancel.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => running.WaitAsync(TimeSpan.FromSeconds(10)));

        Assert.True(stream.Closed);

        var command = engine.AllExecs.Single(e => !IsSignal(e));
        var signal = SignalOf(engine.AllExecs.Single(IsSignal));

        // Closing the connection ends nothing on this engine: the kill is what does.
        Assert.Equal(command.Create.Env![EngineExec.MarkerVariable], signal.Marker);
        Assert.Equal(Signals.Kill.ToString(CultureInfo.InvariantCulture), signal.Signal);
        Assert.Equal("all", signal.Scope);
    }

    [Fact]
    public async Task ARunInAContainerThatIsNotThereIsTheEnginesOwnRefusal()
    {
        await using var engine = await EngineAsync();

        var refused = await Assert.ThrowsAnyAsync<BackendException>(
            () => new EngineExec(engine).CapturedAsync("swarmtest-exec-nowhere", ["true"]));

        Assert.Contains("swarmtest-exec-nowhere", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ATerminalIsTheConnectionBothWaysAndTheEngineIsAskedForEverythingElse()
    {
        await using var engine = await EngineAsync();
        var stream = new ScriptedExecStream();
        engine.OnExecStream = exec => IsSignal(exec) ? null : stream;

        await using var exec = await new EngineExec(engine).InteractiveAsync(Instance, ["bash"], width: 100, height: 30);

        var created = engine.AllExecs.Single();
        Assert.True(created.Create.Tty);
        Assert.Equal((100, 30), created.Create.ConsoleSize);

        // Raw, both ways: a prompt is not a stdcopy frame and is not read as one.
        stream.Feed("$ "u8.ToArray());
        var buffer = new byte[16];
        var read = await exec.Terminal.ReadAsync(buffer);
        Assert.Equal("$ ", Encoding.UTF8.GetString(buffer, 0, read));

        await exec.Terminal.WriteAsync("ls\n"u8.ToArray());
        Assert.Equal("ls\n", Encoding.UTF8.GetString(stream.Written));

        await exec.ResizeAsync(80, 24);
        Assert.Equal([(80, 24)], created.Resizes);

        Assert.Null(await exec.ExitCodeAsync());

        var waiting = exec.WaitAsync();
        await Task.Delay(100);
        Assert.False(waiting.IsCompleted);

        created.Exit(7);
        stream.End();
        Assert.Equal(0, await exec.Terminal.ReadAsync(buffer));

        Assert.Equal(7, await waiting.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Equal(7, await exec.ExitCodeAsync());
    }

    [Fact]
    public async Task WaitingDoesNotNeedTheTerminalToEnd()
    {
        await using var engine = await EngineAsync();
        var stream = new ScriptedExecStream();
        engine.OnExecStream = exec => IsSignal(exec) ? null : stream;

        await using var exec = await new EngineExec(engine).InteractiveAsync(Instance, ["apt-get"]);

        // Command.RunAsync's case: the command is done, and something it
        // started still holds the pty.
        engine.AllExecs.Single().Exit(0);

        Assert.Equal(0, await exec.WaitAsync().WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.False(stream.Closed);
    }

    [Fact]
    public async Task ASignalIsASecondExecThatFindsTheFirstByItsMarker()
    {
        await using var engine = await EngineAsync();
        var stream = new ScriptedExecStream();
        engine.OnExecStream = exec => IsSignal(exec) ? null : stream;

        await using var exec = await new EngineExec(engine).InteractiveAsync(Instance, ["sleep", "1000"]);

        var marker = engine.AllExecs.Single().Create.Env![EngineExec.MarkerVariable];

        await exec.SignalAsync(Signals.Term);
        await exec.SignalAsync(Signals.Int);

        var signals = engine.AllExecs.Where(IsSignal).Select(SignalOf).ToList();

        // SIGTERM to everything the exec started; SIGINT to where Ctrl-C would have gone.
        Assert.Equal([(marker, "15", "all"), (marker, "2", "fg")], signals);

        // Both found their exec, so nothing was typed.
        Assert.Empty(stream.Written);

        var helper = engine.AllExecs.First(IsSignal).Create;
        Assert.Equal("0:0", helper.User);
        Assert.False(helper.Tty);
        Assert.Equal(["sh", "-c", EngineExec.SignalScript], helper.Cmd.Take(3));
    }

    [Fact]
    public async Task ASignalThatCannotBeSentIsTypedWhenItHasAKeystroke()
    {
        await using var engine = await EngineAsync();
        var stream = new ScriptedExecStream();
        engine.OnExecStream = exec => IsSignal(exec) ? null : stream;

        // Exit 3: the script found no such exec — it has not started yet, or
        // its environment is not there to be read.
        engine.OnExec = _ => new FakeExecResult(3);

        await using var exec = await new EngineExec(engine).InteractiveAsync(Instance, ["vim"]);

        await exec.SignalAsync(Signals.Int);
        await exec.SignalAsync(Signals.Quit);
        await exec.SignalAsync(Signals.Term);

        Assert.Equal([0x03, 0x1C], stream.Written);
    }

    [Fact]
    public async Task DisposingAnExecThatIsStillRunningHangsItUpBecauseClosingTheConnectionWouldNot()
    {
        await using var engine = await EngineAsync();
        var stream = new ScriptedExecStream();
        engine.OnExecStream = exec => IsSignal(exec) ? null : stream;

        var exec = await new EngineExec(engine).InteractiveAsync(Instance, ["tail", "-F", "/var/log/envmux/t.log"]);
        var marker = engine.AllExecs.Single().Create.Env![EngineExec.MarkerVariable];

        await exec.DisposeAsync();
        await exec.DisposeAsync();

        Assert.Equal((marker, "1", "hangup"), SignalOf(Assert.Single(engine.AllExecs, IsSignal)));
        Assert.True(stream.Closed);
    }

    [Fact]
    public async Task DisposingAnExecThatHasEndedOnlyClosesTheConnection()
    {
        await using var engine = await EngineAsync();
        var stream = new ScriptedExecStream();
        engine.OnExecStream = exec => IsSignal(exec) ? null : stream;

        var exec = await new EngineExec(engine).InteractiveAsync(Instance, ["true"]);
        engine.AllExecs.Single().Exit(0);
        stream.End();

        await exec.DisposeAsync();

        Assert.DoesNotContain(engine.AllExecs, IsSignal);
        Assert.True(stream.Closed);
    }

    [Fact]
    public async Task NothingSaidAboutATerminalThrowsOnceTheEngineHasGone()
    {
        await using var engine = await EngineAsync();
        var stream = new ScriptedExecStream();
        engine.OnExecStream = exec => IsSignal(exec) ? null : stream;

        var exec = await new EngineExec(engine).InteractiveAsync(Instance, ["bash"]);

        engine.Intercept = (operation, _) => operation.StartsWith("Exec", StringComparison.Ordinal)
            ? throw new DockerEngineException("the engine has gone") { Status = 500 }
            : Task.CompletedTask;

        await exec.ResizeAsync(80, 24);
        await exec.SignalAsync(Signals.Term);
        Assert.Null(await exec.ExitCodeAsync());
        await exec.DisposeAsync();

        Assert.True(stream.Closed);
    }
}
