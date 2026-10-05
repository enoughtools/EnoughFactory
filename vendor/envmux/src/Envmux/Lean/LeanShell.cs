using Envmux.Editor;
using Envmux.Process;
using Envmux.Session;
using Envmux.Ui;

namespace Envmux.Lean;

/// <summary>
/// The lean UI: a loop, a frame, and the keys.
/// </summary>
/// <remarks>
/// <para>
/// The whole of it. There is no view model, because there is nothing to notify
/// — the frame is composed from the session every time it is drawn, and the
/// session is the only copy of the truth. There is no dispatcher, because
/// nothing has to be marshalled anywhere: a background thread that logs a line
/// sets a flag, and the loop that owns the terminal is the only thing that
/// reads the session or writes to the screen.
/// </para>
/// <para>
/// Polled rather than event-driven, and that is the deliberate trade. A key
/// arrives within a frame of being pressed and a resize within a frame of
/// happening, at the cost of a syscall every twenty milliseconds — which buys
/// the absence of an input thread, a signal handler, and any question about
/// which thread is allowed to touch what.
/// </para>
/// </remarks>
internal sealed class LeanShell : IDisposable
{
    /// <summary>How long the loop sleeps between looks at the keyboard.</summary>
    private const int TickMs = 20;

    /// <summary>How long a frame may stand before it is drawn again anyway.</summary>
    /// <remarks>
    /// For the parts of the screen that move on their own: the spinner, and the
    /// count of seconds a first-run pull has been going. Everything else is
    /// drawn because something changed.
    /// </remarks>
    private const int RestlessMs = 250;

    private readonly Session.Session _session;
    private readonly LeanConsole _console;
    private readonly LeanState _state = new();

    private volatile bool _dirty = true;
    private bool _quit;
    private bool _disposed;

    public LeanShell(Session.Session session, LeanConsole console)
    {
        _session = session;
        _console = console;

        _session.Changed += OnChanged;
        _session.Log.Appended += OnLogged;
        _session.StopRequested += OnStopRequested;
    }

    private void OnChanged() => _dirty = true;

    private void OnStopRequested() => _quit = true;

    private void OnLogged(LogEntry entry)
    {
        _state.Logged();
        _dirty = true;
    }

    public async Task RunAsync()
    {
        var drawn = 0L;

        while (!_quit)
        {
            var acted = false;

            while (!_quit && Read() is { } key)
            {
                await KeyAsync(key).ConfigureAwait(false);
                acted = true;
            }

            if (_console.Resized())
            {
                _dirty = true;
            }

            var now = Environment.TickCount64;

            if (_dirty || acted || now - drawn >= RestlessMs)
            {
                _dirty = false;
                Draw();
                drawn = now;
            }

            await Task.Delay(TickMs).ConfigureAwait(false);
        }
    }

    private void Draw()
    {
        var frame = LeanFrame.Compose(_session, _state, _console.Width, _console.Height);
        _console.Frame(frame.Rows, frame.Caret);
    }

    private static ConsoleKeyInfo? Read()
    {
        try
        {
            return Console.KeyAvailable ? Console.ReadKey(intercept: true) : null;
        }
        catch (InvalidOperationException)
        {
            // Input is not a console. Nothing will ever be typed, and the
            // session runs until it is interrupted from outside.
            return null;
        }
    }

    private async Task KeyAsync(ConsoleKeyInfo key)
    {
        // Ctrl-C wherever you are, including mid-word at the command line. It
        // is a key in here rather than a signal, so this is the only thing that
        // acts on it and the exit runs teardown like any other.
        if (key.Key == ConsoleKey.C && key.Modifiers.HasFlag(ConsoleModifiers.Control))
        {
            _quit = true;
            return;
        }

        if (_state.Typing)
        {
            await TypedAsync(key).ConfigureAwait(false);
            return;
        }

        await PressedAsync(key).ConfigureAwait(false);
    }

    /// <summary>The command line has the keys.</summary>
    private async Task TypedAsync(ConsoleKeyInfo key)
    {
        switch (key.Key)
        {
            case ConsoleKey.Enter:
                var typed = _state.Typed;
                _state.Typed = "";
                _state.Typing = false;
                await RunAsync(Repl.Parse(typed)).ConfigureAwait(false);
                return;

            case ConsoleKey.Escape:
                _state.Typed = "";
                _state.Typing = false;
                return;

            case ConsoleKey.Backspace:
                if (_state.Typed.Length > 0)
                {
                    _state.Typed = _state.Typed[..^1];
                }

                return;

            default:
                // Printable only. A control character in the middle of a
                // command is a command that fails for a reason nobody can see.
                if (!char.IsControl(key.KeyChar))
                {
                    _state.Typed += key.KeyChar;
                }

                return;
        }
    }

    /// <summary>The panes have the keys.</summary>
    private async Task PressedAsync(ConsoleKeyInfo key)
    {
        switch (key.Key)
        {
            case ConsoleKey.F1:
                _state.Screen = LeanScreen.Dashboard;
                return;

            case ConsoleKey.F2:
                _state.Screen = LeanScreen.Log;
                _state.Focus = LeanPane.Log;
                return;

            case ConsoleKey.Tab:
                Cycle();
                return;

            case ConsoleKey.UpArrow:
                Move(-1);
                return;

            case ConsoleKey.DownArrow:
                Move(1);
                return;

            case ConsoleKey.PageUp:
                _state.LogScroll += Math.Max(1, _console.Height / 2);
                return;

            case ConsoleKey.PageDown:
                _state.LogScroll = Math.Max(0, _state.LogScroll - Math.Max(1, _console.Height / 2));
                return;

            case ConsoleKey.End:
                _state.LogScroll = 0;
                return;

            case ConsoleKey.Enter:
                Look();
                return;

            default:
                break;
        }

        switch (char.ToLowerInvariant(key.KeyChar))
        {
            case 'q':
                _quit = true;
                return;

            case ':' or '/':
                _state.Typing = true;
                _state.Typed = "";
                return;

            case '?':
                Help();
                return;

            case 'o':
                Open();
                return;

            case 'p':
                Portal();
                return;

            case 'b':
                OpenBrowser([]);
                return;

            case 'e':
                Editor();
                return;

            case 'r':
                Detached("restart", () => _session.RestartAsync());
                return;

            case 'k':
                WithTask("restart", t => t.RestartAsync());
                return;

            case 'x':
                WithTask("stop", t => t.State is TaskState.Running or TaskState.Starting or TaskState.Waiting
                    ? t.StopAsync()
                    : t.StartWhenReadyAsync());
                return;

            case 'c':
                await AttachAsync().ConfigureAwait(false);
                return;

            default:
                return;
        }
    }

    /// <summary>Run what was typed.</summary>
    /// <remarks>
    /// The same parser the windowed UI uses, so a command means the same thing
    /// in both. The verbs about tabs are the ones this UI does not have; they
    /// say so rather than doing nothing, because a command that is silently
    /// ignored is indistinguishable from one that is broken.
    /// </remarks>
    private async Task RunAsync(ReplCommand command)
    {
        switch (command.Verb)
        {
            case ReplVerb.Nothing:
                return;

            case ReplVerb.Help:
                Help();
                return;

            case ReplVerb.Quit:
                _quit = true;
                return;

            case ReplVerb.Status:
                Status();
                return;

            case ReplVerb.Open:
                Open(command.Argument);
                return;

            case ReplVerb.Portal:
                Portal();
                return;

            case ReplVerb.Browser:
                OpenBrowser(command.Arguments);
                return;

            case ReplVerb.Code:
                Editor();
                return;

            case ReplVerb.Restart:
                Detached("restart", () => _session.RestartAsync());
                return;

            case ReplVerb.Screen:
                Screen(command.Argument);
                return;

            case ReplVerb.Task:
                TaskCommand(command);
                return;

            case ReplVerb.Shell:
                await AttachAsync().ConfigureAwait(false);
                return;

            default:
                _session.Log.Warn($"'{command.Typed}' is not a command — try /help");
                return;
        }
    }

    private void Help()
    {
        _session.Log.Info("commands:");

        foreach (var line in Repl.Help())
        {
            _session.Log.Info(line);
        }

        _session.Log.Info("keys:" + LeanFrame.Legend);
    }

    private void Status()
    {
        _session.Log.Info($"{_session.Plan.Project} / {_session.Plan.Session} on {_session.Plan.Branch}");
        _session.Log.Info(
            $"instance {_session.Plan.InstanceName} at {_session.Address}, user {_session.ContainerUser}");

        foreach (var route in _session.Listed)
        {
            _session.Log.Info($"route {route.Name} → {route.Url}");
        }

        if (_session.PortalUrl is { } portal)
        {
            _session.Log.Info($"portal → {portal}");
        }

        if (_session.BrowserProxyUrl is { } proxy)
        {
            _session.Log.Info($"browser proxy → {proxy}");
        }
    }

    /// <summary>Swap the layout, or say what the layouts are called.</summary>
    /// <remarks>
    /// With no name it toggles. There are two of them, so "the other one" is
    /// unambiguous and is what somebody typing <c>/screen</c> on its own means.
    /// </remarks>
    private void Screen(string? name)
    {
        if (name is not { Length: > 0 })
        {
            _state.Screen = _state.Screen == LeanScreen.Log ? LeanScreen.Dashboard : LeanScreen.Log;
            return;
        }

        if (Screens.Parse(name) is not { } screen)
        {
            _session.Log.Warn($"no screen called '{name}' — there is {string.Join(" and ", Screens.Names)}");
            return;
        }

        _state.Screen = screen;
    }

    private void TaskCommand(ReplCommand command)
    {
        if (command.Arguments.Count < 2)
        {
            _session.Log.Warn("/task <start|stop|restart> <name>");
            return;
        }

        var what = command.Arguments[0].ToLowerInvariant();
        var name = command.Arguments[1];

        if (_session.FindTask(name) is not { } task)
        {
            _session.Log.Warn($"no task called '{name}'");
            return;
        }

        switch (what)
        {
            case "start":
                Detached($"task '{name}'", () => task.StartWhenReadyAsync());
                return;

            case "stop":
                Detached($"task '{name}'", () => task.StopAsync());
                return;

            case "restart":
                Detached($"task '{name}'", () => task.RestartAsync());
                return;

            default:
                _session.Log.Warn($"'{what}' is not one of start, stop, restart");
                return;
        }
    }

    private void Open(string? name = null)
    {
        // The listed routes, so that `o` on the envmux row and `/open envmux`
        // both reach the portal — with its token on the URL, which is what
        // makes the link one a browser can be handed.
        var listed = _session.Listed;

        var route = name is { Length: > 0 }
            ? listed.FirstOrDefault(r => r.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
            : listed.Count > 0 && _state.Route < listed.Count
                ? listed[_state.Route]
                : null;

        if (route is null)
        {
            _session.Log.Warn(name is { Length: > 0 }
                ? $"no route called '{name}'"
                : "no route to open");
            return;
        }

        // The portal is this machine's loopback, which the session's browser
        // would take into the instance; it opens in the ordinary one. Every
        // other route is only reachable in the session's browser.
        if (route.IsPortal)
        {
            Portal();
            return;
        }

        OpenBrowser([route.Url]);
    }

    /// <summary>
    /// Open the portal, and put its link in the log either way.
    /// </summary>
    /// <remarks>
    /// The link carries the token, which is the only place it is ever written
    /// down — so this is also how somebody who closed the tab gets back in, and
    /// why it is logged even when the browser opened.
    /// </remarks>
    private void Portal()
    {
        if (_session.PortalUrl is not { } url)
        {
            _session.Log.Warn(_session.Plan.Portal.Enabled
                ? "the portal is not up yet"
                : "this session has no portal — set portal.enabled in .envmux.json");
            return;
        }

        _session.Log.Info(url);

        if (Browser.TryOpen(url, out var why))
        {
            _session.Log.Info("opened the portal");
        }
        else
        {
            _session.Log.Warn($"could not open a browser: {why}");
        }
    }

    /// <summary>
    /// Enter on a pane: open the selected task or route in the session's browser.
    /// </summary>
    /// <remarks>
    /// The thing selected is the thing somebody wants to look at, and the only
    /// place it can be looked at is a browser whose <c>localhost</c> is the
    /// instance. On the log, Enter does nothing: there is nothing there to open.
    /// </remarks>
    private void Look()
    {
        switch (_state.Screen == LeanScreen.Log ? LeanPane.Log : _state.Focus)
        {
            case LeanPane.Tasks when _state.Task < _session.Tasks.Count:
                var task = _session.Tasks[_state.Task];

                if (_session.BrowserTargetFor(task) is { } target)
                {
                    OpenBrowser([target]);
                }
                else
                {
                    _session.Log.Warn(
                        $"task '{task.Plan.Name}' serves no port to open — give it \"ready\", or a route with its name");
                }

                return;

            case LeanPane.Routes when _state.Route < _session.Listed.Count:
                var route = _session.Listed[_state.Route];

                if (route.IsPortal)
                {
                    // The portal is this machine's loopback, which in the
                    // session's browser is the instance's. It opens here.
                    Portal();
                }
                else
                {
                    OpenBrowser([route.Url]);
                }

                return;

            default:
                return;
        }
    }

    /// <summary>
    /// Open a browser on the session's proxy: a browser name, a route or URL, both or neither.
    /// </summary>
    /// <remarks>
    /// Either order, because both read naturally — <c>/browser firefox</c>,
    /// <c>/browser proof</c>, <c>/browser localhost:5173/admin</c> — and neither
    /// a route nor a URL parses as a browser's name.
    /// </remarks>
    private void OpenBrowser(IReadOnlyList<string> arguments)
    {
        string? use = null;
        string? url = null;

        foreach (var argument in arguments)
        {
            if (Enum.TryParse<Socks.BrowserKind>(argument, ignoreCase: true, out var kind) && Enum.IsDefined(kind))
            {
                use = argument;
            }
            else
            {
                url = argument;
            }
        }

        try
        {
            _session.OpenBrowser(use, url);
        }
        catch (Socks.BrowserException e)
        {
            _session.Log.Warn($"browser: {e.Message}");
        }
    }

    private void Editor() => _ = Task.Run(async () =>
    {
        try
        {
            await _session.OpenInEditorAsync().ConfigureAwait(false);
        }
        catch (EditorException e)
        {
            _session.Log.Error(e.Message);
        }
    });

    /// <summary>
    /// Give the terminal to a shell in the instance, and take it back after.
    /// </summary>
    /// <remarks>
    /// Rather than draw a terminal inside a terminal, hand the real one over.
    /// What the shell does happens on the normal screen; the UI is still on the
    /// alternate one underneath it, untouched, and comes back exactly as it was
    /// left. There is no emulator in envmux to do it the other way, and this
    /// needs none — which is most of why there is no emulator.
    /// </remarks>
    private async Task AttachAsync()
    {
        if (_session.Address.Length == 0)
        {
            _session.Log.Warn("there is no instance to open a shell in yet");
            return;
        }

        _console.Suspend();

        try
        {
            Console.WriteLine($"envmux: {_session.Plan.Session} — exit the shell to come back");
            Console.WriteLine("        it is latched, so detaching leaves it running");
            await _session.AttachShellAsync().ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _session.Log.Error($"shell: {e.Message}");
        }
        finally
        {
            _console.Resume();
            _dirty = true;
        }
    }

    private void WithTask(string what, Func<SessionTask, Task> action)
    {
        if (_session.Tasks.Count == 0 || _state.Task >= _session.Tasks.Count)
        {
            _session.Log.Warn($"no task selected to {what}");
            return;
        }

        var task = _session.Tasks[_state.Task];
        Detached($"task '{task.Plan.Name}'", () => action(task));
    }

    private void Detached(string what, Func<Task> action) =>
        _ = Task.Run(async () =>
        {
            try
            {
                await action().ConfigureAwait(false);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                _session.Log.Error($"{what}: {e.Message}");
            }
        });

    /// <summary>Move the cursor between the panes that have one.</summary>
    private void Cycle() => _state.Focus = _state.Screen == LeanScreen.Log
        ? LeanPane.Log
        : _state.Focus switch
        {
            LeanPane.Routes => LeanPane.Tasks,
            LeanPane.Tasks => LeanPane.Log,
            _ => LeanPane.Routes,
        };

    /// <summary>Up and down, in whichever list is listening.</summary>
    private void Move(int by)
    {
        switch (_state.Screen == LeanScreen.Log ? LeanPane.Log : _state.Focus)
        {
            case LeanPane.Routes when _session.Listed.Count > 0:
                _state.Route = Math.Clamp(_state.Route + by, 0, _session.Listed.Count - 1);
                return;

            case LeanPane.Tasks when _session.Tasks.Count > 0:
                _state.Task = Math.Clamp(_state.Task + by, 0, _session.Tasks.Count - 1);
                return;

            case LeanPane.Log:
                // Up goes back through the transcript, which is up the screen
                // and further from the newest line — so the scroll, which is
                // measured from the newest line, goes the other way.
                _state.LogScroll = Math.Max(0, _state.LogScroll - by);
                return;

            default:
                return;
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _session.Changed -= OnChanged;
        _session.StopRequested -= OnStopRequested;
        _session.Log.Appended -= OnLogged;
    }
}
