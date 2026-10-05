using System.Collections.Concurrent;
using System.Globalization;
using System.Text;

using Envmux.Config;
using Envmux.Incus;

namespace Envmux.Session;

/// <summary>Where a task is in its life.</summary>
internal enum TaskState
{
    /// <summary>Declared, not started — either not yet, or because it does not autostart.</summary>
    Idle,

    Starting,
    Running,

    /// <summary>It ended on its own. <see cref="SessionTask.ExitCode"/> says how.</summary>
    Exited,

    /// <summary>envmux stopped it.</summary>
    Stopped,

    /// <summary>It could not be started at all.</summary>
    Failed,

    /// <summary>Waiting for what it depends on.</summary>
    Waiting,

    /// <summary>What it depends on did not come up, so it never started.</summary>
    Blocked,
}

/// <summary>
/// One running task: a latched process, its log, and what to do when it ends.
/// </summary>
/// <remarks>
/// <para>
/// The process is not envmux's child, and that is the whole point. It is started
/// inside a <c>tmux</c> session named after the task and then left there, and
/// what envmux holds is a second exec following the log file. Closing that exec
/// — quitting, losing the connection, restarting envmux — costs the following
/// and nothing else: the build carries on, its output carries on being written,
/// and reattaching picks up from the file.
/// </para>
/// <para>
/// That is not a nicety. An interactive exec is a pty owned by its websocket, so
/// a task started directly down one dies the moment the connection does — and
/// with <c>record-output</c> deliberately unused, its output would die with it.
/// The multiplexer is what stands between those two facts, which is why it is
/// baked into the golden instance rather than assumed.
/// </para>
/// </remarks>
internal sealed class SessionTask(TaskPlan plan, SessionLog log) : IDisposable
{
    /// <summary>How many lines of a task's output are kept in memory.</summary>
    /// <remarks>
    /// Deep enough to hold a webpack build and the stack trace after it, and
    /// shallow enough that a task logging a line per request for eight hours
    /// does not become the process's memory profile. The whole of it is on disk
    /// in the instance regardless, which is what the files API reads.
    /// </remarks>
    private const int OutputCapacity = 2000;

    /// <summary>
    /// What the launcher writes after the command, carrying its exit code.
    /// </summary>
    /// <remarks>
    /// The log is the only channel back: the process is detached inside tmux, so
    /// there is no exec whose exit code could be read. A line the follower
    /// recognises is how a finished task announces itself, and it is prefixed
    /// with something no build output plausibly starts with.
    /// </remarks>
    internal const string ExitMarker = "envmux-exit:";

    /// <summary>How long to wait before starting a task again under a restart policy.</summary>
    /// <remarks>
    /// A task that fails instantly and restarts instantly is a spin, and the
    /// output pane fills with the same error faster than it can be read.
    /// </remarks>
    private static readonly TimeSpan RestartDelay = TimeSpan.FromSeconds(2);

    /// <summary>
    /// How long a readiness probe waits before the session carries on without it.
    /// </summary>
    /// <remarks>
    /// It gives up rather than blocking forever, and what it depends on starts
    /// anyway. A mistyped <c>ready</c> port should cost a warning and a wait, not
    /// a session that never finishes coming up with nothing on screen saying why.
    /// </remarks>
    private static readonly TimeSpan ReadyTimeout = TimeSpan.FromSeconds(90);

    private readonly ConcurrentQueue<string> _output = new();

    /// <summary>The URL this task's output is being watched for, when it declared one.</summary>
    private readonly UrlCapture? _url = plan.UrlPattern is { } pattern ? new UrlCapture(pattern) : null;

    /// <summary>Held across appending a line and telling the followers about it.</summary>
    private readonly Lock _readers = new();
    private readonly SemaphoreSlim _transition = new(1, 1);

    /// <summary>
    /// Completed when this task counts as up, or as never going to be.
    /// </summary>
    /// <remarks>
    /// What "up" means is the difference between the two kinds of task. A
    /// <c>once</c> task is up when it has finished and exited zero; an ongoing
    /// one is up when it is running and — if it declared a <c>ready</c> port —
    /// when something is answering there.
    /// </remarks>
    private TaskCompletionSource<bool> _satisfied =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private CancellationTokenSource? _attached;
    private Task? _running;
    private Backends.IExec? _exec;
    private string? _instance;
    private string? _user;

    /// <summary>The tasks this one waits for. Services are waited on by connecting.</summary>
    private IReadOnlyList<SessionTask> _dependencies = [];

    /// <summary>How the instance is asked whether an endpoint is accepting yet.</summary>
    private Func<TaskDependency, CancellationToken, Task<bool>>? _probe;

    public TaskPlan Plan { get; } = plan;

    public TaskState State { get; private set; } = TaskState.Idle;

    /// <summary>What it exited with, once it has.</summary>
    public int? ExitCode { get; private set; }

    public DateTimeOffset? StartedAt { get; private set; }

    /// <summary>How many times it has been started, to tell a restart from a start.</summary>
    public int Runs { get; private set; }

    /// <summary>The tmux session it is latched to, which is also its log's name.</summary>
    public string LatchId { get; private set; } = "";

    /// <summary>Where its whole output is, inside the instance.</summary>
    public string LogPath => LatchId.Length > 0 ? Latch.LogPath(LatchId) : "";

    /// <summary>Raised whenever the state or the output changed.</summary>
    public event Action? Changed;

    /// <summary>Raised for each line, so a headless run can print it as it arrives.</summary>
    public event Action<string>? Line;

    /// <summary>
    /// Raised when the task's output has just yielded its URL, with the URL as printed.
    /// </summary>
    /// <remarks>
    /// As printed — <c>localhost</c> and all. Which route it is for, and what
    /// hostname belongs there, is the session's to know.
    /// </remarks>
    public event Action<string>? UrlPrinted;

    /// <summary>
    /// The URL this task printed, as printed, once it has. Null for a task with
    /// no <c>url</c> pattern, and again from the start of each run until the
    /// new one matches.
    /// </summary>
    public string? PrintedUrl => _url?.Url;

    public IReadOnlyList<string> Output => [.. _output];

    /// <summary>The newest line, for a one-line summary next to the name.</summary>
    public string LastLine => _output.LastOrDefault() ?? "";

    /// <summary>A word for the state, for the list and the reports.</summary>
    public string Status => State switch
    {
        TaskState.Idle => "idle",
        TaskState.Waiting => "waiting",
        TaskState.Starting => "starting",
        TaskState.Running => "running",
        TaskState.Stopped => "stopped",
        TaskState.Failed => "failed",
        TaskState.Blocked => "blocked",
        TaskState.Exited when ExitCode is 0 => "done",
        TaskState.Exited => $"exit {ExitCode?.ToString(CultureInfo.InvariantCulture)}",
        _ => "",
    };

    /// <summary>Whether this task counts as up, for anything waiting on it.</summary>
    public bool IsSatisfied => _satisfied.Task is { IsCompletedSuccessfully: true, Result: true };

    /// <summary>
    /// Tell it what it waits for, and how to ask the instance about an endpoint.
    /// </summary>
    public void DependOn(
        IReadOnlyList<SessionTask> dependencies,
        Func<TaskDependency, CancellationToken, Task<bool>> probe)
    {
        _dependencies = dependencies;
        _probe = probe;
    }

    /// <summary>Bind the task to the instance it runs in.</summary>
    /// <remarks>
    /// Separate from starting because a task outlives a restart: the same task,
    /// with the same output history, pointed at the instance as it is now.
    /// </remarks>
    public void Bind(Backends.IExec exec, string instance, string user, string latchId)
    {
        _exec = exec;
        _instance = instance;
        _user = user;
        LatchId = latchId;
    }

    /// <summary>
    /// Wait for everything this task depends on, then start it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Every task does its own waiting and they are all launched at once, so the
    /// tree resolves itself concurrently: two tasks that both depend on the
    /// database start together as soon as it answers, rather than one after the
    /// other in whatever order the file listed them.
    /// </para>
    /// <para>
    /// A dependency that fails blocks this one rather than starting it anyway.
    /// A migration against a database that never came up produces an error about
    /// the migration, and the cause is two panes away.
    /// </para>
    /// </remarks>
    public async Task StartWhenReadyAsync(CancellationToken ct = default)
    {
        if (Plan.DependsOn.Count > 0)
        {
            Set(TaskState.Waiting);

            foreach (var dependency in Plan.DependsOn)
            {
                if (await SatisfiedAsync(dependency, ct).ConfigureAwait(false))
                {
                    continue;
                }

                Block(dependency);
                return;
            }
        }

        await StartAsync(ct).ConfigureAwait(false);
    }

    private async Task<bool> SatisfiedAsync(TaskDependency dependency, CancellationToken ct)
    {
        if (dependency.IsService)
        {
            Write($"── waiting for {dependency} ──");

            // A service instance is already running by now. This is the stronger
            // statement: that the thing inside it is answering. "Running" and
            // "accepting connections" are minutes apart for a database.
            return _probe is null || await _probe(dependency, ct).ConfigureAwait(false);
        }

        var on = _dependencies.FirstOrDefault(d => d.Plan.Name.Equals(dependency.Name, StringComparison.Ordinal));
        if (on is null)
        {
            return true;
        }

        if (!on.IsSatisfied)
        {
            Write($"── waiting for {dependency.Name} ──");
        }

        try
        {
            return await on._satisfied.Task.WaitAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    private void Block(TaskDependency dependency)
    {
        Write($"── {dependency.Name} did not come up; not starting ──");
        log.Warn($"task '{Plan.Name}' is blocked: '{dependency.Name}' did not come up");
        Set(TaskState.Blocked);
        _satisfied.TrySetResult(false);
    }

    /// <summary>
    /// Start it, and keep it running for as long as its restart policy says.
    /// </summary>
    /// <remarks>
    /// Returns as soon as the launch has been asked for rather than when the
    /// task ends — every caller wants the session to carry on around it.
    /// </remarks>
    public async Task StartAsync(CancellationToken ct = default)
    {
        await _transition.WaitAsync(ct).ConfigureAwait(false);

        try
        {
            if (State is TaskState.Starting or TaskState.Running)
            {
                return;
            }

            // Whatever it was blocked on, it is being started now.
            if (State == TaskState.Blocked)
            {
                log.Info($"task '{Plan.Name}' was blocked; starting it anyway");
            }

            if (_exec is null || _instance is null || _user is null)
            {
                Fail("there is no instance to run it in");
                return;
            }

            _attached?.Dispose();
            _attached = CancellationTokenSource.CreateLinkedTokenSource(ct);

            // A fresh promise for a fresh run: anything that waited on the last
            // one already has its answer.
            if (_satisfied.Task.IsCompleted)
            {
                _satisfied = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            }

            Set(TaskState.Starting);
            _running = SuperviseAsync(_attached.Token);
        }
        finally
        {
            _transition.Release();
        }
    }

    /// <summary>
    /// Stop it: end the tmux session, which ends everything in it.
    /// </summary>
    /// <remarks>
    /// One call, and it reaches the workers too. Under Docker this had to walk
    /// <c>/proc</c> looking for a marker in each process's environment, because
    /// there was no pid to signal and a pidfile stops being true the moment a
    /// task forks. A multiplexer session is a process group with a name, so
    /// killing it by name is exact.
    /// </remarks>
    public async Task StopAsync(CancellationToken ct = default)
    {
        await _transition.WaitAsync(ct).ConfigureAwait(false);

        try
        {
            // Cancelled first, so the supervisor knows this was asked for and
            // does not apply the restart policy to it.
            await (_attached?.CancelAsync() ?? Task.CompletedTask).ConfigureAwait(false);

            await KillLatchAsync().ConfigureAwait(false);

            if (_running is { } running)
            {
                try
                {
                    await running.WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None)
                        .ConfigureAwait(false);
                }
                catch (Exception e) when (e is TimeoutException or OperationCanceledException)
                {
                    // The follower did not unwind. It is a websocket read, and
                    // the session is going away underneath it regardless.
                }
            }

            if (State is not (TaskState.Exited or TaskState.Failed))
            {
                Set(TaskState.Stopped);
            }
        }
        finally
        {
            _transition.Release();
        }
    }

    /// <summary>
    /// Detach without stopping anything.
    /// </summary>
    /// <remarks>
    /// What quitting does to a session that is being kept: envmux stops
    /// following, and the task goes on running inside the instance. Starting a
    /// session of the same name again reattaches to it.
    /// </remarks>
    public async Task DetachAsync()
    {
        await (_attached?.CancelAsync() ?? Task.CompletedTask).ConfigureAwait(false);

        if (State is TaskState.Running or TaskState.Starting)
        {
            Set(TaskState.Idle);
        }
    }

    /// <summary>Stop it and start it again.</summary>
    public async Task RestartAsync(CancellationToken ct = default)
    {
        await StopAsync(ct).ConfigureAwait(false);
        Write($"── restarting {Plan.Name} ──");
        await StartAsync(ct).ConfigureAwait(false);
    }

    private async Task SuperviseAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            StartedAt = DateTimeOffset.UtcNow;
            Runs++;

            // A new run prints a new URL — and, for the server this exists for,
            // a new token. The old one stopped opening anything the moment the
            // old process ended, so the route goes back to its port until the
            // new line arrives.
            _url?.Reset();

            Set(TaskState.Running);

            // An ongoing task announces itself as up once it is running, or once
            // whatever it declared a `ready` port for is answering. A `once` task
            // is not up until it has finished, which is handled below.
            if (Plan.Kind == TaskKind.Ongoing)
            {
                _ = AnnounceWhenReadyAsync(ct);
            }

            int? code;

            try
            {
                code = await RunLatchedAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Asked to stop, or detached. Whichever set the state, set it.
                return;
            }
            catch (IncusException e)
            {
                Fail(e.Message);
                return;
            }

            if (code is null)
            {
                // The follower ended without the marker: the instance went, or
                // the connection did. Not a task failure, and not something to
                // restart into.
                Set(TaskState.Stopped);
                _satisfied.TrySetResult(false);
                return;
            }

            ExitCode = code;
            Set(TaskState.Exited);

            var ok = code == 0;

            // A `once` task's whole purpose is to finish, and finishing well is
            // what anything downstream was waiting for. An ongoing task that
            // ended has stopped being up, and if it never got there, whatever
            // was waiting on it needs to stop waiting.
            _satisfied.TrySetResult(Plan.Kind == TaskKind.Once && ok);

            log.Info(Plan.Kind == TaskKind.Once && ok
                ? $"task '{Plan.Name}' finished"
                : ok
                    ? $"task '{Plan.Name}' ended"
                    : $"task '{Plan.Name}' exited {code}");

            var again = Plan.Restart switch
            {
                RestartPolicy.Always => true,
                RestartPolicy.OnFailure => !ok,
                _ => false,
            };

            if (!again)
            {
                return;
            }

            Write($"── {Plan.Restart.ToString().ToLowerInvariant()}: starting again in " +
                  $"{RestartDelay.TotalSeconds.ToString("F0", CultureInfo.InvariantCulture)}s ──");

            try
            {
                await Task.Delay(RestartDelay, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>
    /// Launch the task into its latch, then follow its log until it ends.
    /// </summary>
    /// <returns>What it exited with, or null if the following ended first.</returns>
    private async Task<int?> RunLatchedAsync(CancellationToken ct)
    {
        var exec = _exec!;
        var instance = _instance!;

        // Whatever was in this latch belongs to an earlier run of this same
        // task. Reusing it would attach a new follower to an old process and
        // report the old one's exit as this one's.
        await KillLatchAsync().ConfigureAwait(false);

        var launch = await Command.ShellAsync(exec, instance, LaunchScript(), _user, null, ct)
            .ConfigureAwait(false);

        if (!launch.Ok)
        {
            throw new IncusException(
                $"{Latch.Multiplexer} would not start '{Plan.Name}': {Trim(launch.Text)}");
        }

        int? code = null;

        // Cancelled from inside the reader the moment the marker arrives: the
        // follower is a `tail -F`, which by design never ends on its own.
        using var finished = CancellationTokenSource.CreateLinkedTokenSource(ct);

        try
        {
            await Command.RunAsync(
                exec,
                instance,
                ["tail", "-n", "+1", "-F", LogPath],
                _user,
                null,
                null,
                line =>
                {
                    if (!line.StartsWith(ExitMarker, StringComparison.Ordinal))
                    {
                        Write(line);

                        // Here, on the task's own lines, rather than in Write:
                        // Write also carries envmux's "── restarting ──"
                        // notes, and a pattern loose enough to match one of
                        // those should not be able to.
                        if (_url?.Observe(line) is true)
                        {
                            UrlPrinted?.Invoke(_url.Url!);
                            Changed?.Invoke();
                        }

                        return;
                    }

                    code = int.TryParse(
                        line[ExitMarker.Length..].Trim(), CultureInfo.InvariantCulture, out var value)
                        ? value
                        : 0;

                    finished.Cancel();
                },
                finished.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (code is not null)
        {
            // The expected way out: the task finished and the reader said so.
        }

        return code;
    }

    /// <summary>
    /// The shell that starts the task detached, teeing its output to a file.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>pipefail</c> matters: without it the status after the pipe is
    /// <c>tee</c>'s, so every task in the world exits zero and no restart policy
    /// ever fires.
    /// </para>
    /// <para>
    /// The log is truncated at each start rather than appended to, because it is
    /// what the follower replays from the top — an appended log would replay
    /// every previous run of the task into the pane on every restart.
    /// </para>
    /// </remarks>
    internal string LaunchScript()
    {
        var command = string.Join(' ', Plan.Command.Select(Workspace.Quote));
        var log_ = Workspace.Quote(LogPath);

        var inner = new StringBuilder();
        inner.Append("set -o pipefail 2>/dev/null || true; ");
        inner.Append($"cd {Workspace.Quote(Plan.Workdir)} 2>/dev/null || cd /; ");

        foreach (var (key, value) in Plan.Env.OrderBy(e => e.Key, StringComparer.Ordinal))
        {
            inner.Append($"export {key}={Workspace.Quote(value)}; ");
        }

        inner.Append($"{command} 2>&1 | tee -a {log_}; ");
        inner.Append($"printf '{ExitMarker}%d\\n' \"$?\" >> {log_}");

        var script = new StringBuilder();
        script.Line($"mkdir -p {Workspace.Quote(Latch.LogDirectory)} 2>/dev/null || true");
        script.Line($": > {log_}");
        script.Line(
            $"{Latch.Multiplexer} new-session -d -s {Workspace.Quote(LatchId)} " +
            $"bash -lc {Workspace.Quote(inner.ToString())}");

        return script.ToString();
    }

    private async Task KillLatchAsync()
    {
        if (_exec is null || _instance is null || LatchId.Length == 0)
        {
            return;
        }

        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));

            await Command.CaptureAsync(_exec, _instance, Latch.Kill(LatchId), _user, ct: timeout.Token)
                .ConfigureAwait(false);
        }
        catch (Exception e) when (e is IncusException or OperationCanceledException)
        {
            log.Debug($"task '{Plan.Name}': could not end its latch ({e.Message})");
        }
    }

    /// <summary>
    /// Say this task is up — once it is running, or once its port answers.
    /// </summary>
    /// <remarks>
    /// Without a <c>ready</c> port, "up" can only mean "the command was
    /// launched", which for a dev server is several seconds before it is any
    /// use. With one, this is the difference between a dependent task starting
    /// and a dependent task working.
    /// </remarks>
    private async Task AnnounceWhenReadyAsync(CancellationToken ct)
    {
        if (Plan.ReadyPort is not { } port || _probe is null)
        {
            _satisfied.TrySetResult(true);
            return;
        }

        var probing = new TaskDependency(Plan.Name, IsService: false, "127.0.0.1", port);

        try
        {
            if (await _probe(probing, ct).ConfigureAwait(false))
            {
                Write($"── ready: {port.ToString(CultureInfo.InvariantCulture)} is accepting ──");
            }
            else
            {
                // Not fatal. Whatever was waiting starts anyway, because a wrong
                // port number should not wedge the session.
                Write($"── nothing on {port.ToString(CultureInfo.InvariantCulture)} yet; carrying on ──");
                log.Warn($"task '{Plan.Name}': nothing reached port {port} — anything waiting on it starts anyway");
            }
        }
        catch (OperationCanceledException)
        {
            return;
        }

        _satisfied.TrySetResult(true);
    }

    /// <summary>How long a readiness probe is given.</summary>
    public static TimeSpan ReadyWait => ReadyTimeout;

    private void Fail(string reason)
    {
        Write($"── {reason} ──");
        log.Error($"task '{Plan.Name}' did not start: {reason}");
        Set(TaskState.Failed);
        _satisfied.TrySetResult(false);
    }

    private void Set(TaskState state)
    {
        State = state;
        Changed?.Invoke();
    }

    /// <summary>
    /// Start following the output, and get everything said so far.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Subscribing and reading the backlog have to happen together or a reader
    /// misses a line or shows one twice: read first and a line written in
    /// between is lost, subscribe first and it arrives in both. Taken under the
    /// same lock <see cref="Write"/> holds, so there is no in-between to fall
    /// into.
    /// </para>
    /// <para>
    /// For the portal, which starts reading a task's output at whatever moment
    /// somebody opened a tab. The terminal UI does not need this — it composes
    /// every frame from <see cref="Output"/> and cannot be between anything.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> Follow(Action<string> reader)
    {
        lock (_readers)
        {
            Line += reader;
            return Output;
        }
    }

    /// <summary>Stop following it.</summary>
    public void Unfollow(Action<string> reader)
    {
        lock (_readers)
        {
            Line -= reader;
        }
    }

    private void Write(string line)
    {
        lock (_readers)
        {
            _output.Enqueue(line);

            while (_output.Count > OutputCapacity && _output.TryDequeue(out _))
            {
                // Oldest first.
            }

            // Inside the lock, so that a reader joining now sees this line in
            // its backlog or in its stream and never in both.
            Line?.Invoke(line);
        }

        Changed?.Invoke();
    }

    private static string Trim(string output) =>
        output.Split('\n', StringSplitOptions.RemoveEmptyEntries).LastOrDefault()?.Trim() ?? "no output";

    public void Dispose()
    {
        _attached?.Dispose();
        _attached = null;
        _transition.Dispose();
    }
}
