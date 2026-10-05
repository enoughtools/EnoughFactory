using System.Buffers;
using System.Globalization;
using System.Text;

using Envmux.Docker;
using Envmux.Incus;

namespace Envmux.Backends.DockerEngine;

/// <summary>
/// Exec on a Docker engine: a terminal over a hijacked connection, and a
/// captured run with its two streams taken back apart.
/// </summary>
/// <remarks>
/// <para>
/// Plain methods, not the backend seam: the seam (<c>IExec</c>,
/// <c>IInteractiveExec</c>) is being written beside this, and its Docker adapter
/// will wrap <see cref="InteractiveAsync"/> and <see cref="CapturedAsync"/>
/// rather than the other way round. Not to be confused with
/// <see cref="Envmux.Docker.DockerExec"/>, which is an Incus exec dressed for
/// the VS Code shim; this one talks to a real engine.
/// </para>
/// <para>
/// An instance's name is its container's name, so <c>container</c> goes to the
/// engine as it arrives. Every exec runs as root whatever the container's own
/// user is — <see cref="Command.AsUser"/> has already wrapped the command in
/// <c>runuser</c> when it is to run as somebody, and runuser has to be root to
/// drop. The container's environment is inherited and the request's set over
/// the top, which is the engine's own behaviour.
/// </para>
/// <para>
/// <b>What the engine does not do, measured on Docker Desktop 29.6.1 (API 1.55).</b>
/// </para>
/// <para>
/// <i>It has no exec-signal API</i>, and the pid <c>ExecInspect</c> reports is
/// the pid in the engine's own pid namespace — the VM's, on Docker Desktop. An
/// exec whose inspect said <c>Pid: 31403</c> was pid 18 inside the container,
/// <c>kill -0 31403</c> from a second exec answered "No such process", and
/// <c>NSpid</c> in <c>/proc/18/status</c> shows only the inner number: from
/// inside there is no way from the one to the other. So every exec is created
/// with <see cref="MarkerVariable"/> set to a fresh id, and a signal is a second
/// exec that finds the first by it — see <see cref="SignalScript"/>.
/// </para>
/// <para>
/// <i>Closing the connection does not end the process.</i> On Incus the pty
/// belongs to the connection; here it belongs to the engine. A tty
/// <c>sleep 777</c> whose hijacked connection was closed was still
/// <c>Running</c>, and still in <c>ps</c>, afterwards. A task's follower is a
/// <c>tail -F</c> that is only ever ended by being disposed, so disposing hangs
/// the exec up by hand: SIGHUP and SIGCONT to its session, as a closing pty
/// would, and SIGKILL to whatever is still there a second later.
/// </para>
/// <para>
/// <i>The connection does close when the command exits</i>, including the case
/// that hung Incus for eighteen minutes: <c>sh -c 'sleep 6 &amp; echo out; exit
/// 7'</c> gave end-of-stream at once with a tty, and two seconds after the exit
/// without one — the engine gives a stream held open by an orphan that long and
/// then lets go. It is watched from this side as well, since an older engine
/// made no such promise.
/// </para>
/// <para>
/// <i>A command that cannot start is not an error from the engine.</i> The start
/// still upgrades, the reason arrives as output — "OCI runtime exec failed: …
/// executable file not found in $PATH", and the same for a working directory
/// that does not exist — and the exit code is 127. Which is already the shape a
/// captured run hands back, so there is nothing to translate.
/// </para>
/// </remarks>
internal sealed class EngineExec(IDockerEngine engine)
{
    /// <summary>The variable an exec is found again by. Its value is an id made for that exec alone.</summary>
    /// <remarks>
    /// It is inherited, so it is also in the environment of anything the exec
    /// starts — a tmux server, and through tmux every pane. That is why finding
    /// the exec takes more than the variable: see <see cref="SignalScript"/>.
    /// </remarks>
    public const string MarkerVariable = "ENVMUX_EXEC_ID";

    /// <summary>Root, by number: an image need not have a passwd entry for the name.</summary>
    internal const string Root = "0:0";

    /// <summary>How long a stream that outlives its command is given to finish saying what it has.</summary>
    internal TimeSpan DrainGrace { get; init; } = TimeSpan.FromSeconds(2);

    /// <summary>How often a captured run that is still open is asked whether its command has ended.</summary>
    internal TimeSpan WatchInterval { get; init; } = TimeSpan.FromSeconds(1);

    /// <summary>How long the engine is given to say how an exec ended, once its stream has.</summary>
    internal static readonly TimeSpan SettleTimeout = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Find one exec's processes from inside the container, and signal them.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>$1</c> is the marker's value, <c>$2</c> the signal's number, <c>$3</c>
    /// who gets it. The exec's own process is the one that carries the marker
    /// <em>and</em> has no parent in the container's pid namespace — the engine
    /// started it from outside, so its ppid reads 0 — and it is a session leader,
    /// with or without a tty. Both measured. Everything it started that has not
    /// deliberately left is in that session.
    /// </para>
    /// <para>
    /// The session is the scope, rather than every process that carries the
    /// marker, because of the latch. <c>tmux new-session -d</c> run down an exec
    /// leaves a server (ppid 1, a session of its own) and panes (sessions of
    /// their own) that all inherited the marker; signalling by marker alone would
    /// make ending the exec that launched a task the end of the task.
    /// </para>
    /// <para>
    /// <c>all</c> signals the session. <c>fg</c> signals the terminal's
    /// foreground process group — what the line discipline does with a Ctrl-C,
    /// without depending on the terminal still being in a mode that reads one —
    /// and falls back to the session where there is no terminal. <c>hangup</c>
    /// is a closing pty done by hand: SIGHUP and SIGCONT, a second to act on it,
    /// SIGKILL for what is left. Exit 3 is "there is no such exec here": it has
    /// ended, or it has not got as far as existing yet.
    /// </para>
    /// <para>
    /// POSIX sh, <c>grep</c> and <c>cat</c>, nothing else. A process that
    /// overwrites its own environment block — <c>postgres</c> does, to set its
    /// title — cannot be found this way; none of those is ever the process an
    /// exec starts with, which is <c>runuser</c>, <c>sh</c> or the tool itself.
    /// </para>
    /// </remarks>
    internal static readonly string SignalScript = SignalSource.ReplaceLineEndings("\n");

    /// <summary><see cref="SignalScript"/> as written here, with whatever line endings this file was checked out with.</summary>
    /// <remarks>
    /// Never sent as it is: on a Windows checkout every line of it ends in a
    /// carriage return, and a signal called <c>15\r</c> does not exist.
    /// </remarks>
    private const string SignalSource =
        """
        marker="ENVMUX_EXEC_ID=$1"; sig=$2; scope=$3
        root=; tpgid=0
        for e in /proc/[0-9]*/environ; do
          p=${e#/proc/}; p=${p%/environ}
          grep -qF "$marker" "$e" 2>/dev/null || continue
          s=$(cat "/proc/$p/stat" 2>/dev/null) || continue
          set -- ${s##*) }
          if [ "$2" = 0 ]; then root=$p; tpgid=$6; break; fi
        done
        [ -n "$root" ] || exit 3
        if [ "$scope" = fg ] && [ "$tpgid" -gt 0 ]; then
          kill "-$sig" -- "-$tpgid"
          exit $?
        fi
        targets=
        for f in /proc/[0-9]*/stat; do
          s=$(cat "$f" 2>/dev/null) || continue
          p=${s%% *}
          set -- ${s##*) }
          [ "$4" = "$root" ] && targets="$targets $p"
        done
        [ -n "$targets" ] || exit 3
        if [ "$scope" != hangup ]; then
          kill "-$sig" $targets
          exit $?
        fi
        kill -HUP $targets 2>/dev/null
        kill -CONT $targets 2>/dev/null
        n=0
        while [ "$n" -lt 10 ]; do
          alive=
          for p in $targets; do kill -0 "$p" 2>/dev/null && alive=1; done
          [ -n "$alive" ] || exit 0
          sleep 0.1 2>/dev/null || sleep 1
          n=$((n + 1))
        done
        kill -KILL $targets 2>/dev/null
        exit 0
        """;

    /// <summary>
    /// Start a command with a terminal, and hand back the session it is.
    /// </summary>
    /// <param name="command">The command as its own arguments; already wrapped by <see cref="Command.AsUser"/> when it is to run as somebody.</param>
    /// <param name="width">The terminal's columns at birth.</param>
    /// <param name="height">Its rows.</param>
    public async Task<EngineExecSession> InteractiveAsync(
        string container,
        IReadOnlyList<string> command,
        string? cwd = null,
        IReadOnlyDictionary<string, string>? environment = null,
        int width = 80,
        int height = 24,
        CancellationToken ct = default)
    {
        var marker = NewMarker();

        var id = await engine.ExecCreateAsync(container, Create(command, cwd, environment, width, height, marker, tty: true), ct)
            .ConfigureAwait(false);
        var stream = await engine.ExecStartAsync(id, tty: true, ct).ConfigureAwait(false);

        return new EngineExecSession(engine, container, id, marker, stream);
    }

    /// <summary>
    /// Run a command with no terminal, and collect what it wrote.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Both streams, in the order their pieces arrived, which is as close to
    /// "what a terminal would have drawn" as two pipes allow. The exit code is
    /// the engine's, asked for once the stream has ended: there is a moment
    /// where the connection has closed and inspect still says running, so it is
    /// asked again, briefly, rather than believed the first time.
    /// </para>
    /// <para>
    /// Cancelling ends the command as well as the wait — closing the connection
    /// would not, here — so a provisioning step that was abandoned is not still
    /// running in the instance when the next one starts.
    /// </para>
    /// </remarks>
    public async Task<RunResult> CapturedAsync(
        string container,
        IReadOnlyList<string> command,
        string? cwd = null,
        IReadOnlyDictionary<string, string>? environment = null,
        CancellationToken ct = default)
    {
        var marker = NewMarker();
        var create = Create(command, cwd, environment, width: 0, height: 0, marker, tty: false);

        var (code, output) = await CaptureAsync(engine, container, create, marker, WatchInterval, DrainGrace, ct)
            .ConfigureAwait(false);

        return new RunResult(code, output);
    }

    /// <summary>The exec as the engine is asked for it.</summary>
    internal static ExecCreate Create(
        IReadOnlyList<string> command,
        string? cwd,
        IReadOnlyDictionary<string, string>? environment,
        int width,
        int height,
        string marker,
        bool tty)
    {
        var env = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var (key, value) in environment ?? new Dictionary<string, string>(StringComparer.Ordinal))
        {
            env[key] = value;
        }

        env[MarkerVariable] = marker;

        return new ExecCreate
        {
            Cmd = command,
            Tty = tty,

            // Nothing is ever typed into a captured run, and a process that is
            // offered no stdin reads end-of-file rather than waiting on one.
            AttachStdin = tty,
            User = Root,
            WorkingDir = string.IsNullOrEmpty(cwd) ? null : cwd,
            Env = env,

            // At birth, so the first screen is drawn once at the right size
            // rather than at 80x24 and again.
            ConsoleSize = tty ? (Math.Max(1, width), Math.Max(1, height)) : null,
        };
    }

    private static string NewMarker() => Guid.NewGuid().ToString("N");

    /// <summary>
    /// Signal an exec by its marker, from a second exec.
    /// </summary>
    /// <returns>
    /// What the script exited with — 0 when the signal was sent, 3 when there was
    /// no such exec — or null when the second exec could not be run at all.
    /// </returns>
    internal static async Task<int?> SignalByMarkerAsync(
        IDockerEngine engine,
        string container,
        string marker,
        int signal,
        string scope,
        CancellationToken ct)
    {
        var create = new ExecCreate
        {
            Cmd =
            [
                "sh", "-c", SignalScript, "envmux-signal",
                marker, signal.ToString(CultureInfo.InvariantCulture), scope,
            ],
            User = Root,
        };

        try
        {
            // No marker of its own: there is nothing to do about a signal that
            // will not end except stop waiting for it.
            var (code, _) = await CaptureAsync(
                    engine, container, create, marker: null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1), ct)
                .ConfigureAwait(false);
            return code;
        }
        catch (Exception e) when (e is BackendException or IOException or ObjectDisposedException
                                      or InvalidOperationException or OperationCanceledException)
        {
            return null;
        }
    }

    /// <summary>
    /// Whether an exec has ended, and with what.
    /// </summary>
    /// <remarks>
    /// <c>Running: false</c> is not the answer on its own: an exec that has been
    /// created and not yet started says the same, with no exit code. Ended is
    /// not running <em>and</em> a code.
    /// </remarks>
    internal static async Task<int?> EndedAsync(IDockerEngine engine, string execId, CancellationToken ct)
    {
        var inspect = await engine.ExecInspectAsync(execId, ct).ConfigureAwait(false);
        return inspect is { Running: false, ExitCode: { } code } ? code : null;
    }

    /// <summary>
    /// The exit code of an exec whose stream has ended, asked for until the engine has one.
    /// </summary>
    /// <remarks>
    /// Quickly at first, because the window is usually a few milliseconds, and
    /// backing off, because when it is not — the container went, the engine is
    /// restarting — asking harder does not help.
    /// </remarks>
    /// <returns>The code, or null when the engine never said.</returns>
    internal static async Task<int?> SettleAsync(IDockerEngine engine, string execId, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow + SettleTimeout;
        var delay = TimeSpan.FromMilliseconds(10);

        while (true)
        {
            try
            {
                if (await EndedAsync(engine, execId, ct).ConfigureAwait(false) is { } code)
                {
                    return code;
                }
            }
            catch (DockerEngineException e) when (e.IsNotFound)
            {
                // The exec went with its container. Nobody is going to say.
                return null;
            }

            if (DateTimeOffset.UtcNow >= deadline)
            {
                return null;
            }

            await Task.Delay(delay, ct).ConfigureAwait(false);
            delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, 250));
        }
    }

    private static async Task<(int Code, string Output)> CaptureAsync(
        IDockerEngine engine,
        string container,
        ExecCreate create,
        string? marker,
        TimeSpan watchInterval,
        TimeSpan drainGrace,
        CancellationToken ct)
    {
        var id = await engine.ExecCreateAsync(container, create, ct).ConfigureAwait(false);
        var stream = await engine.ExecStartAsync(id, tty: false, ct).ConfigureAwait(false);
        var transcript = new Transcript();

        try
        {
            // The reader's own token: cancelled by the caller, or by the watcher
            // once the command has ended and the stream has had its grace.
            using var draining = CancellationTokenSource.CreateLinkedTokenSource(ct);
            using var watching = CancellationTokenSource.CreateLinkedTokenSource(ct);

            // Disposing as well as cancelling. Whether a read on a hijacked
            // connection can be cancelled is the transport's business — a named
            // pipe, a unix socket — and a read on a disposed stream always
            // comes back.
            await using var closing = draining.Token.Register(stream.Dispose).ConfigureAwait(false);

            var watcher = WatchAsync(engine, id, watchInterval, drainGrace, draining, watching.Token);

            try
            {
                await foreach (var (from, payload) in StdCopyReader.FramesAsync(stream, draining.Token).ConfigureAwait(false))
                {
                    transcript.Append(from, payload.Span);
                }
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException or OperationCanceledException)
            {
                // The connection was cut or closed under the read: by the
                // engine, which is an end; by the watcher, which is an end; or
                // by the caller, which is decided below.
            }

            await watching.CancelAsync().ConfigureAwait(false);
            await watcher.ConfigureAwait(false);

            ct.ThrowIfCancellationRequested();

            var code = await SettleAsync(engine, id, ct).ConfigureAwait(false);
            var output = transcript.ToString();

            if (code is null && output.Length == 0)
            {
                output = $"the exec in '{container}' ended and the engine never said how";
            }

            // No code is not a success: the container went, or the engine did.
            return (code ?? 1, output);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested && marker is not null)
        {
            using var timeout = new CancellationTokenSource(SettleTimeout);

            await SignalByMarkerAsync(engine, container, marker, Signals.Kill, "all", timeout.Token)
                .ConfigureAwait(false);

            throw;
        }
        finally
        {
            await stream.DisposeAsync().ConfigureAwait(false);
        }
    }

    /// <summary>
    /// While a captured run's stream is open, ask now and then whether its command has ended.
    /// </summary>
    /// <remarks>
    /// The stream ending is the usual way to find out and costs nothing, so this
    /// does not ask at all for the first second — which is every command
    /// provisioning runs but the long ones. When it does find the command gone
    /// with the stream still open, something the command started is holding the
    /// pipe: the stream is given <see cref="DrainGrace"/> more and then closed.
    /// </remarks>
    private static async Task WatchAsync(
        IDockerEngine engine,
        string execId,
        TimeSpan interval,
        TimeSpan grace,
        CancellationTokenSource draining,
        CancellationToken stop)
    {
        try
        {
            while (true)
            {
                await Task.Delay(interval, stop).ConfigureAwait(false);

                if (await EndedAsync(engine, execId, stop).ConfigureAwait(false) is not null)
                {
                    draining.CancelAfter(grace);
                    return;
                }
            }
        }
        catch (Exception e) when (e is BackendException or IOException or OperationCanceledException
                                      or ObjectDisposedException)
        {
            // Stopped, or the engine would not say. The stream ending is still
            // watched for, by the read.
        }
    }

    /// <summary>
    /// Two streams of bytes as one piece of text, in the order the pieces arrived.
    /// </summary>
    /// <remarks>
    /// A decoder for each, because a frame boundary can fall inside a character,
    /// and the next frame to arrive may belong to the other stream.
    /// </remarks>
    private sealed class Transcript
    {
        private readonly StringBuilder _text = new();
        private readonly Decoder _stdout = Encoding.UTF8.GetDecoder();
        private readonly Decoder _stderr = Encoding.UTF8.GetDecoder();

        public void Append(byte stream, ReadOnlySpan<byte> payload)
        {
            var decoder = stream == StdCopy.Stderr ? _stderr : _stdout;
            var chars = ArrayPool<char>.Shared.Rent(decoder.GetCharCount(payload, flush: false));

            try
            {
                var written = decoder.GetChars(payload, chars, flush: false);
                _text.Append(chars, 0, written);
            }
            finally
            {
                ArrayPool<char>.Shared.Return(chars);
            }
        }

        public override string ToString() => _text.ToString();
    }
}

/// <summary>
/// One interactive exec on a Docker engine: the hijacked connection as the
/// terminal, and the engine's API for everything said about it.
/// </summary>
/// <remarks>
/// <para>
/// The shape of <see cref="ExecSession"/>, and what the seam's
/// <c>IInteractiveExec</c> adapter will hand out. With a tty the hijacked
/// connection is the pty's bytes and nothing else — no framing, stderr already
/// merged — so <see cref="Terminal"/> is that stream, wrapped only to notice
/// when it ends.
/// </para>
/// <para>
/// <b>The process does not belong to the connection</b>, which is the one way
/// this differs from Incus and the reason for most of what is here: see
/// <see cref="EngineExec"/> for what was measured. Signals travel as a second
/// exec, and disposing ends the process by hand because closing the connection
/// would not.
/// </para>
/// </remarks>
internal sealed class EngineExecSession : IInteractiveExec
{
    /// <summary>SIGHUP, SIGTSTP: the two <see cref="Signals"/> has no name for.</summary>
    private const int Hup = 1;
    private const int Tstp = 20;

    private readonly IDockerEngine _engine;
    private readonly string _container;
    private readonly string _marker;
    private readonly TerminalStream _terminal;
    private int? _exitCode;
    private bool _disposed;

    /// <summary>The engine's id for this exec, for asking what it exited with.</summary>
    public string ExecId { get; }

    /// <summary>The terminal, both ways.</summary>
    public Stream Terminal => _terminal;

    internal EngineExecSession(IDockerEngine engine, string container, string execId, string marker, Stream stream)
    {
        _engine = engine;
        _container = container;
        _marker = marker;
        _terminal = new TerminalStream(stream);
        ExecId = execId;
    }

    /// <summary>Tell the far pty how big the window is now. Never throws.</summary>
    public async Task ResizeAsync(int columns, int rows, CancellationToken ct = default)
    {
        try
        {
            await _engine.ExecResizeAsync(ExecId, Math.Max(1, columns), Math.Max(1, rows), ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is BackendException or IOException or ObjectDisposedException
                                      or InvalidOperationException or OperationCanceledException)
        {
            // The exec has gone. So has the reason to care what size it was.
        }
    }

    /// <summary>
    /// Forward a signal rather than a keystroke. Never throws.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The engine has no call for this, so it is a second exec that finds this
    /// one's processes and signals them — <see cref="EngineExec.SignalScript"/>.
    /// SIGINT, SIGQUIT and SIGTSTP go to the terminal's foreground process
    /// group, which is where the keystroke would have sent them; everything else
    /// goes to the whole of the exec's session, because SIGTERM to a
    /// <c>runuser</c> or a <c>sh -c</c> alone is a signal its child may never
    /// hear about.
    /// </para>
    /// <para>
    /// When the second exec cannot do it — the image has no <c>sh</c>, the
    /// process has not started yet — the three with a keystroke are typed
    /// instead.
    /// </para>
    /// </remarks>
    public async Task SignalAsync(int signal, CancellationToken ct = default)
    {
        if (_disposed || _exitCode is not null)
        {
            return;
        }

        var scope = signal is Signals.Int or Signals.Quit or Tstp ? "fg" : "all";

        var sent = await EngineExec.SignalByMarkerAsync(_engine, _container, _marker, signal, scope, ct)
            .ConfigureAwait(false);

        if (sent == 0)
        {
            return;
        }

        byte[]? keystroke = signal switch
        {
            Signals.Int => [0x03],
            Signals.Quit => [0x1C],
            Tstp => [0x1A],
            _ => null,
        };

        if (keystroke is null)
        {
            return;
        }

        try
        {
            await _terminal.WriteAsync(keystroke, ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidOperationException
                                      or OperationCanceledException)
        {
            // Same.
        }
    }

    /// <summary>What the command exited with, or null while it is still running.</summary>
    public async Task<int?> ExitCodeAsync(CancellationToken ct = default)
    {
        if (_exitCode is not null)
        {
            return _exitCode;
        }

        try
        {
            return _exitCode = await EngineExec.EndedAsync(_engine, ExecId, ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is BackendException or IOException or OperationCanceledException)
        {
            return null;
        }
    }

    /// <summary>
    /// Wait for the command to finish, and hand back what it exited with.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The engine has nothing to block on — no <c>/wait</c> for an exec — so it
    /// is asked, at an interval that starts short for the command that was only
    /// ever going to take a moment and lengthens for the follower that runs all
    /// afternoon. The terminal ending cuts the interval short: that is nearly
    /// always the command ending, and what is left is the few milliseconds in
    /// which the connection has closed and inspect still says running.
    /// </para>
    /// <para>
    /// Asked from the start rather than once the terminal ends, for the reason
    /// <see cref="Command.RunAsync(IExec, string, IReadOnlyList{string}, string?, string?, IReadOnlyDictionary{string, string}?, Action{string}?, CancellationToken)"/> gives: the two are different events, and
    /// only this one is promised.
    /// </para>
    /// </remarks>
    public async Task<int> WaitAsync(CancellationToken ct = default)
    {
        var delay = TimeSpan.FromMilliseconds(50);
        DateTimeOffset? endedAt = null;

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            if (_exitCode is { } known)
            {
                return known;
            }

            try
            {
                if (await EngineExec.EndedAsync(_engine, ExecId, ct).ConfigureAwait(false) is { } code)
                {
                    _exitCode = code;
                    return code;
                }
            }
            catch (DockerEngineException e) when (e.IsNotFound)
            {
                // The exec went with its container. Not a success.
                return 1;
            }

            if (_terminal.Ended.IsCompleted)
            {
                endedAt ??= DateTimeOffset.UtcNow;

                if (DateTimeOffset.UtcNow - endedAt > EngineExec.SettleTimeout)
                {
                    // The terminal closed and the engine never said how it
                    // ended. Not a success either.
                    return 1;
                }

                await Task.Delay(TimeSpan.FromMilliseconds(25), ct).ConfigureAwait(false);
                continue;
            }

            try
            {
                await _terminal.Ended.WaitAsync(delay, ct).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, 2000));
            }
        }
    }

    /// <summary>
    /// End the exec: hang it up if it is still running, then close the connection.
    /// </summary>
    /// <remarks>
    /// In that order, and the first half is the part that matters — see the
    /// class remarks. It costs an inspect when the command has already ended,
    /// and a second exec when it has not.
    /// </remarks>
    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        try
        {
            using var timeout = new CancellationTokenSource(EngineExec.SettleTimeout);

            if (await ExitCodeAsync(timeout.Token).ConfigureAwait(false) is null)
            {
                await EngineExec.SignalByMarkerAsync(_engine, _container, _marker, Hup, "hangup", timeout.Token)
                    .ConfigureAwait(false);
            }
        }
        catch (Exception e) when (e is BackendException or IOException or ObjectDisposedException
                                      or InvalidOperationException or OperationCanceledException)
        {
            // The engine has gone, and the exec with it.
        }

        await _terminal.DisposeAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// The hijacked connection, with its ending noticed and its writes taken one at a time.
    /// </summary>
    /// <remarks>
    /// A connection that is cut reads as one that ended: a terminal has no
    /// other way to end, and what the far side did is asked of the engine, not
    /// of the socket. Writes are serialised because a signal's keystroke can
    /// arrive while a person is typing.
    /// </remarks>
    private sealed class TerminalStream(Stream inner) : Stream
    {
        private readonly TaskCompletionSource _ended = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly SemaphoreSlim _writing = new(1, 1);

        /// <summary>Completed when a read has seen the end of the terminal.</summary>
        public Task Ended => _ended.Task;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            int read;

            try
            {
                read = await inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException)
            {
                read = 0;
            }

            if (read == 0 && buffer.Length > 0)
            {
                _ended.TrySetResult();
            }

            return read;
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override int Read(byte[] buffer, int offset, int count)
        {
            int read;

            try
            {
                read = inner.Read(buffer, offset, count);
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException)
            {
                read = 0;
            }

            if (read == 0 && count > 0)
            {
                _ended.TrySetResult();
            }

            return read;
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await _writing.WaitAsync(cancellationToken).ConfigureAwait(false);

            try
            {
                await inner.WriteAsync(buffer, cancellationToken).ConfigureAwait(false);
                await inner.FlushAsync(cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                _writing.Release();
            }
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override void Write(byte[] buffer, int offset, int count)
        {
            _writing.Wait();

            try
            {
                inner.Write(buffer, offset, count);
                inner.Flush();
            }
            finally
            {
                _writing.Release();
            }
        }

        public override void Flush()
        {
            // Every write is already on the wire.
        }

        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                inner.Dispose();
                _ended.TrySetResult();
            }

            base.Dispose(disposing);
        }

        public override async ValueTask DisposeAsync()
        {
            await inner.DisposeAsync().ConfigureAwait(false);
            _ended.TrySetResult();

            await base.DisposeAsync().ConfigureAwait(false);
        }
    }
}
