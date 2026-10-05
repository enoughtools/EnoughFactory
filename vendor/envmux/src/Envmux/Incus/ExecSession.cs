using System.Globalization;
using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Incus;

/// <summary>
/// A message down the control socket: a resize, or a signal.
/// </summary>
/// <remarks>
/// The shape is Incus' <c>InstanceExecControl</c>. The two arms use different
/// halves of it — a resize carries <c>args</c> whose values are strings even
/// though they are numbers, and a signal carries a bare integer beside them —
/// which is why this is one record with optional halves rather than two.
/// </remarks>
internal sealed record ExecControl
{
    /// <summary>"window-resize" or "signal".</summary>
    public required string Command { get; init; }

    public IReadOnlyDictionary<string, string>? Args { get; init; }

    [JsonPropertyName("signal")]
    public int? Signal { get; init; }

    public static ExecControl Resize(int columns, int rows) => new()
    {
        Command = "window-resize",
        Args = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["width"] = Math.Max(1, columns).ToString(CultureInfo.InvariantCulture),
            ["height"] = Math.Max(1, rows).ToString(CultureInfo.InvariantCulture),
        },
    };

    public static ExecControl Interrupt(int number) => new() { Command = "signal", Signal = number };
}

/// <summary>The signals worth having a name for.</summary>
internal static class Signals
{
    public const int Int = 2;
    public const int Quit = 3;
    public const int Term = 15;
    public const int Kill = 9;
    public const int Winch = 28;
}

/// <summary>
/// One interactive exec: a terminal, and a second socket to talk about it on.
/// </summary>
/// <remarks>
/// <para>
/// Every exec is interactive, which is a decision rather than a default.
/// <c>record-output</c> and the three-socket non-interactive mode are not used:
/// one shape of exec means one code path for the shell, the tasks and the
/// one-shot commands, and the thing that made the other shapes attractive —
/// output that outlives the connection — is solved better inside the instance
/// than by the daemon.
/// </para>
/// <para>
/// <b>The PTY belongs to the connection.</b> Closing the websocket tears down
/// the terminal and kills the process group with it. That is why nothing
/// long-running is ever started directly: a build begun by a client that then
/// drops is a build that dies, and with no <c>record-output</c> its output dies
/// too. <see cref="Latch"/> is what stands between those two facts.
/// </para>
/// </remarks>
internal sealed class ExecSession : Backends.IInteractiveExec
{
    private readonly IncusApi _api;
    private readonly ClientWebSocket _terminal;
    private readonly ClientWebSocket? _control;
    private bool _disposed;

    /// <summary>The operation this exec is, for asking what it exited with.</summary>
    public string OperationId { get; }

    /// <summary>The terminal itself: bytes in are keystrokes, bytes out are what was drawn.</summary>
    public Stream Terminal { get; }

    private ExecSession(IncusApi api, string operationId, ClientWebSocket terminal, ClientWebSocket? control)
    {
        _api = api;
        OperationId = operationId;
        _terminal = terminal;
        _control = control;

        Terminal = WebSocketStream.Create(terminal, WebSocketMessageType.Binary, ownsWebSocket: false);
    }

    /// <summary>
    /// Ask for an exec and connect to both of its sockets.
    /// </summary>
    /// <remarks>
    /// <c>wait-for-websocket</c> means the command does not start until something
    /// has attached, so the first bytes it writes are not lost to a socket that
    /// was not open yet. The secrets in <c>metadata.fds</c> are one-time: dialling
    /// the same one twice fails, which is why both are dialled here and neither
    /// is kept.
    /// </remarks>
    public static async Task<ExecSession> StartAsync(
        IncusApi api,
        string instance,
        ExecPost request,
        CancellationToken ct = default)
    {
        if (!request.Interactive || !request.WaitForWebsocket)
        {
            throw new IncusException("envmux only ever runs interactive execs that wait for a websocket");
        }

        var response = await api.Client
            .PostAsync($"{IncusClient.V1}/instances/{instance}/exec", request, ct)
            .ConfigureAwait(false);

        if (!response.IsAsync)
        {
            throw new IncusException($"exec in '{instance}' did not start an operation");
        }

        var id = response.OperationId;

        var fds = (response.As<IncusOperation>() ?? new IncusOperation { Metadata = response.Metadata }).Fds();

        if (!fds.TryGetValue("0", out var terminalSecret))
        {
            throw new IncusException(
                $"exec in '{instance}' answered without a terminal socket — " +
                "the host may have read this as a non-interactive exec");
        }

        var terminal = await api.Client.ConnectAsync(id, terminalSecret, ct).ConfigureAwait(false);

        ClientWebSocket? control = null;

        try
        {
            if (fds.TryGetValue("control", out var controlSecret))
            {
                control = await api.Client.ConnectAsync(id, controlSecret, ct).ConfigureAwait(false);
            }
        }
        catch (IncusException)
        {
            // A terminal with no control socket still works: it cannot be
            // resized and Ctrl-C has to travel as a keystroke instead of a
            // signal, which is what a real terminal does anyway.
            control = null;
        }

        return new ExecSession(api, id, terminal, control);
    }

    /// <summary>
    /// Tell the far pty how big the window is now.
    /// </summary>
    /// <remarks>
    /// Failures are swallowed. A resize arriving after the command exited is
    /// answered with an error, and a window that was dragged as a build finished
    /// is not something to raise on a UI thread.
    /// </remarks>
    public async Task ResizeAsync(int columns, int rows, CancellationToken ct = default)
    {
        await SendAsync(ExecControl.Resize(columns, rows), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Forward a signal rather than a keystroke.
    /// </summary>
    /// <remarks>
    /// Ctrl-C typed into the terminal is a byte and the pty turns it into a
    /// signal, which is right for anything with a line discipline. This is for
    /// the other case: the client deciding to interrupt something, with nobody
    /// typing.
    /// </remarks>
    public Task SignalAsync(int signal, CancellationToken ct = default) =>
        SendAsync(ExecControl.Interrupt(signal), ct);

    private async Task SendAsync(ExecControl message, CancellationToken ct)
    {
        if (_control is not { State: WebSocketState.Open })
        {
            return;
        }

        try
        {
            var bytes = WireJson.SerializeToUtf8Bytes(message, IncusJson.Options);

            await _control.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct)
                .ConfigureAwait(false);
        }
        catch (Exception e) when (e is WebSocketException or ObjectDisposedException or InvalidOperationException
                                      or OperationCanceledException)
        {
            // The exec has gone. So has the reason to care what size it was.
        }
    }

    /// <summary>
    /// What the command exited with, or null while it is still running.
    /// </summary>
    /// <remarks>
    /// Read off the operation rather than off the socket: the terminal closing
    /// says the pty is gone, not what the process did.
    /// </remarks>
    public async Task<int?> ExitCodeAsync(CancellationToken ct = default)
    {
        try
        {
            var response = await _api.Client
                .GetAsync($"{IncusClient.V1}/operations/{OperationId}", ct)
                .ConfigureAwait(false);

            var operation = response.As<IncusOperation>();

            return operation is null || !IncusStatus.IsFinished(operation.StatusCode)
                ? null
                : operation.ReturnCode;
        }
        catch (Exception e) when (e is IncusException or JsonException or OperationCanceledException)
        {
            return null;
        }
    }

    /// <summary>
    /// Wait for the command to finish, and hand back what it exited with.
    /// </summary>
    /// <remarks>
    /// Through the operation's own <c>/wait</c>, which blocks server-side rather
    /// than being polled — and which reports a command that failed as an
    /// operation that succeeded, because an exec exiting non-zero is the exec
    /// working.
    /// </remarks>
    public async Task<int> WaitAsync(CancellationToken ct = default)
    {
        while (true)
        {
            ct.ThrowIfCancellationRequested();

            // Bounded, and re-asked. An unbounded /wait blocks the server for as
            // long as the command runs, which for a shell is the afternoon — and
            // the client's own timeout would fire long before, reporting a
            // command that is still running as one that failed.
            var response = await _api.Client
                .GetAsync($"{IncusClient.V1}/operations/{OperationId}/wait?timeout=20", ct)
                .ConfigureAwait(false);

            var operation = response.As<IncusOperation>();

            if (operation is null)
            {
                return 1;
            }

            if (!IncusStatus.IsFinished(operation.StatusCode))
            {
                continue;
            }

            return operation.ReturnCode ?? (operation.Succeeded ? 0 : 1);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        await Terminal.DisposeAsync().ConfigureAwait(false);
        await CloseAsync(_terminal).ConfigureAwait(false);
        await CloseAsync(_control).ConfigureAwait(false);

        _terminal.Dispose();
        _control?.Dispose();
    }

    private static async Task CloseAsync(WebSocket? socket)
    {
        if (socket is not { State: WebSocketState.Open })
        {
            return;
        }

        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));

            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, timeout.Token)
                .ConfigureAwait(false);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
            // A close handshake nobody is going to answer. Disposing is enough.
        }
    }
}

/// <summary>
/// tmux, and why an exec has to go through it.
/// </summary>
/// <remarks>
/// <para>
/// An interactive exec is a pty owned by a websocket, and closing that websocket
/// kills the process group. Without a multiplexer in the instance a dropped
/// connection kills a running build — and since <c>record-output</c> is not in
/// use, the output goes with it.
/// </para>
/// <para>
/// <c>tmux new-session -A -s &lt;taskId&gt;</c> attaches to an existing session
/// or creates it if there is none, which is exactly the latch: attach, detach,
/// reattach, with the process alive throughout. It also keeps scrollback, so a
/// client that comes back sees what it missed — which a socket-only multiplexer
/// like <c>dtach</c> would not give.
/// </para>
/// <para>
/// The session name is the orchestrator's contract with itself. A stable id per
/// logical task is what makes reattachment deterministic rather than a guess.
/// </para>
/// </remarks>
internal static class Latch
{
    /// <summary>Where a latched command's output is kept, inside the instance.</summary>
    public const string LogDirectory = "/var/log/envmux";

    /// <summary>The program that has to be in the golden image for any of this to work.</summary>
    public const string Multiplexer = "tmux";

    /// <summary>The log a task writes to, by its id.</summary>
    /// <remarks>
    /// The actual launch is <see cref="Session.SessionTask.LaunchScript"/>, which
    /// tees to this path itself. A <c>tmux</c>-side attach/capture helper existed
    /// here and never had a caller: the launch does the teeing, and reattachment
    /// is a plain <see cref="Shell"/> onto the same session name.
    /// </remarks>
    public static string LogPath(string taskId) => $"{LogDirectory}/{taskId}.log";

    /// <summary>A plain interactive shell, latched the same way as everything else.</summary>
    public static IReadOnlyList<string> Shell(string taskId, string shell) =>
        [Multiplexer, "new-session", "-A", "-s", taskId, shell];

    /// <summary>What is currently latchable in an instance.</summary>
    public static IReadOnlyList<string> List() =>
        [Multiplexer, "list-sessions", "-F", "#{session_name}"];

    /// <summary>End a session and whatever it was running.</summary>
    public static IReadOnlyList<string> Kill(string taskId) =>
        [Multiplexer, "kill-session", "-t", taskId];

    /// <summary>The names in a <c>list-sessions</c> answer, with the terminal's own noise removed.</summary>
    public static IReadOnlyList<string> Parse(string output) =>
    [
        .. output.ReplaceLineEndings("\n")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(line => !line.StartsWith("no server running", StringComparison.OrdinalIgnoreCase))
            .Where(line => line.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.')),
    ];

    /// <summary>
    /// A task id that tmux will accept and that reads back as what it is.
    /// </summary>
    /// <remarks>
    /// tmux treats a dot as a pane separator and a colon as a window one, so a
    /// name containing either is a name that cannot be targeted.
    /// </remarks>
    public static string Id(string project, string session, string task) =>
        $"{Config.Slug.From(project)}-{Config.Slug.From(session)}-{Config.Slug.From(task)}";
}
