using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using Envmux.Commands;
using Envmux.Config;

namespace Envmux.Agents;

/// <summary>Where a remote agent is in its life.</summary>
internal static class AgentState
{
    /// <summary>Spawned; its process has not yet written anything.</summary>
    public const string Launching = "launching";

    /// <summary>The session is coming up: instance, workspace, tasks.</summary>
    public const string Starting = "starting";

    /// <summary>The agent is working.</summary>
    public const string Running = "running";

    /// <summary>The agent's command exited and the session is bringing its commits back.</summary>
    public const string Finishing = "finishing";

    /// <summary>Done. <see cref="AgentRecord.Result"/> says what came back.</summary>
    public const string Finished = "finished";

    /// <summary>Told to stop, or its process went away before it finished.</summary>
    public const string Stopped = "stopped";

    /// <summary>The session could not start, or the agent's command failed.</summary>
    public const string Failed = "failed";
}

/// <summary>What a remote agent left in the repository when its session ended.</summary>
/// <param name="Branch">The branch its commits are on, in this repository.</param>
/// <param name="Head">Where that branch points, short.</param>
/// <param name="CommitsAhead">How many commits it added.</param>
/// <param name="DirtyFiles">How many files it changed and did not commit — still in the instance.</param>
internal sealed record AgentResult(string Branch, string Head, int CommitsAhead, int DirtyFiles);

/// <summary>
/// One remote agent, as the workstation knows it.
/// </summary>
/// <param name="Name">The session name: its branch's suffix, its instance, its nick in the room.</param>
/// <param name="Project">The project it belongs to, which binds it to a room.</param>
/// <param name="Branch">The branch its work lands on.</param>
/// <param name="Instance">The instance it runs in.</param>
/// <param name="Nick">What it answers to in the room.</param>
/// <param name="Summary">The first line of its task, for a listing.</param>
/// <param name="StartedAt">When it was started.</param>
/// <param name="Pid">The envmux process running its session, on this machine.</param>
/// <param name="State">One of <see cref="AgentState"/>.</param>
/// <param name="ExitCode">What the agent's command exited with, once it has.</param>
/// <param name="Result">What came back into this repository, once the session ended.</param>
/// <param name="EndedAt">When the session ended.</param>
/// <param name="Delegator">Who handed it the task, and whom it reports to in the room.</param>
internal sealed record AgentRecord(
    string Name,
    string Project,
    string Branch,
    string Instance,
    string Nick,
    string Summary,
    DateTimeOffset StartedAt,
    int Pid,
    string State,
    int? ExitCode = null,
    AgentResult? Result = null,
    DateTimeOffset? EndedAt = null,
    string Delegator = Chatroom.DefaultNick,
    Backends.BackendKind? Backend = null)
{
    /// <summary>Whether the state says the agent is still going.</summary>
    public bool IsActive => State is AgentState.Launching or AgentState.Starting or AgentState.Running or AgentState.Finishing;
}

/// <summary>
/// The remote agents this repository has, on disk under <c>.envmux/agents/</c>.
/// </summary>
/// <remarks>
/// <para>
/// There is no daemon to ask, so the registry is files: one record per agent,
/// the prompt it was given, the log its session wrote, and — when somebody wants
/// it gone — a stop file its process is polling for. Every envmux on this
/// machine reads and writes the same directory, which is what lets the portal in
/// one process list an agent the command line started in another, with nothing
/// between them but a filesystem.
/// </para>
/// <para>
/// An agent is its own <c>envmux</c> process running a headless session. Not a
/// second <see cref="Session.Session"/> inside the headed one, deliberately: a
/// remote agent working overnight should not die because the person who
/// delegated to it closed their laptop, and a process of its own is the only
/// arrangement in which it does not. It also means the agent is exactly a
/// session — <c>envmux logs</c>, <c>envmux code</c>, <c>envmux prune</c> all
/// already know what to do with it.
/// </para>
/// <para>
/// Under <c>.envmux/</c> because that is the directory envmux already owns in a
/// repository and <c>init</c> already ignores; the plugin's <c>.context/</c> is
/// the agents' room, and a process registry is not a thing to put in a room.
/// </para>
/// </remarks>
internal static class AgentRegistry
{
    /// <summary>Where the records are, relative to the repository root.</summary>
    public static readonly string Directory = Path.Combine(SessionConfig.StateDirectory, "agents");

    /// <summary>The task a remote agent runs as, in its session.</summary>
    /// <remarks>
    /// Fixed, so that <c>envmux logs &lt;name&gt; agent</c> is the agent's
    /// transcript in every session, and so the portal can pick it out.
    /// </remarks>
    public const string TaskName = "agent";

    /// <summary>How often a running agent looks for its stop file.</summary>
    public static readonly TimeSpan StopPoll = TimeSpan.FromSeconds(2);

    /// <summary>How a record is spelled — on disk, and on the portal's API, which is the same shape.</summary>
    internal static readonly JsonSerializerOptions Json = new()
    {
        TypeInfoResolver = WireJsonContext.Default,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    public static string Root(string repository) => Path.Combine(repository, Directory);

    public static string RecordPath(string repository, string name) => Path.Combine(Root(repository), $"{name}.json");

    /// <summary>The task, as it was handed over. Markdown, and the agent's to read.</summary>
    public static string PromptPath(string repository, string name) => Path.Combine(Root(repository), $"{name}.prompt.md");

    /// <summary>The agent's <em>session</em> log — what a headless run would have printed. Not its transcript.</summary>
    public static string LogPath(string repository, string name) => Path.Combine(Root(repository), $"{name}.log");

    /// <summary>Its existence is the request. The process removes it when it has complied.</summary>
    public static string StopPath(string repository, string name) => Path.Combine(Root(repository), $"{name}.stop");

    public static AgentRecord? Load(string repository, string name)
    {
        var path = RecordPath(repository, name);

        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            return WireJson.Deserialize<AgentRecord>(File.ReadAllText(path, Encoding.UTF8), Json);
        }
        catch (JsonException)
        {
            // Half-written by another process, or edited by hand. A record that
            // cannot be read is an agent that cannot be listed, not a crash.
            return null;
        }
    }

    /// <summary>Every agent this repository has had, most recently started first.</summary>
    public static IReadOnlyList<AgentRecord> List(string repository)
    {
        var root = Root(repository);

        if (!System.IO.Directory.Exists(root))
        {
            return [];
        }

        return
        [
            .. System.IO.Directory.EnumerateFiles(root, "*.json")
                .Select(p => Load(repository, Path.GetFileNameWithoutExtension(p)))
                .OfType<AgentRecord>()
                .Select(Reconcile)
                .OrderByDescending(r => r.StartedAt),
        ];
    }

    /// <summary>
    /// Write a record, whole, in one step.
    /// </summary>
    /// <remarks>
    /// Through a temporary file and a rename, because two processes write this
    /// directory — the one that started the agent and the agent's own — and a
    /// reader that lands between a truncate and a write sees an empty file.
    /// </remarks>
    public static void Save(string repository, AgentRecord record)
    {
        var path = RecordPath(repository, record.Name);
        System.IO.Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        var temporary = $"{path}.{Environment.ProcessId.ToString(CultureInfo.InvariantCulture)}.tmp";
        File.WriteAllText(temporary, WireJson.Serialize(record, Json), Encoding.UTF8);
        File.Move(temporary, path, overwrite: true);
    }

    /// <summary>
    /// A record as it is, corrected for a process that is no longer there.
    /// </summary>
    /// <remarks>
    /// The record says "running" until the process that would say otherwise
    /// writes again, and a process that was killed writes nothing. So the state
    /// on disk is checked against the process table on the way out: an active
    /// record whose pid is gone is reported as stopped, with the instance
    /// presumably kept and its commits still in it — which is exactly what
    /// starting that session again is for.
    /// </remarks>
    internal static AgentRecord Reconcile(AgentRecord record) =>
        record.IsActive && record.Pid > 0 && !IsAlive(record.Pid)
            ? record with { State = AgentState.Stopped, EndedAt = record.EndedAt ?? DateTimeOffset.UtcNow }
            : record;

    private static bool IsAlive(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            return false;
        }
    }

    /// <summary>Ask a running agent to stop, from any process on this machine.</summary>
    public static void RequestStop(string repository, string name)
    {
        System.IO.Directory.CreateDirectory(Root(repository));
        File.WriteAllText(StopPath(repository, name), DateTimeOffset.UtcNow.ToString("O"), Encoding.UTF8);
    }

    public static bool StopRequested(string repository, string name) => File.Exists(StopPath(repository, name));

    public static void ClearStop(string repository, string name)
    {
        try
        {
            File.Delete(StopPath(repository, name));
        }
        catch (IOException)
        {
            // Somebody else's problem to notice; it will be re-read as a request,
            // which for a process that is stopping anyway costs nothing.
        }
    }

    /// <summary>The first line of a prompt, cut to fit a listing.</summary>
    internal static string Summarise(string prompt)
    {
        var first = prompt.ReplaceLineEndings("\n").Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0) ?? "";
        return first.Length > 72 ? first[..69].TrimEnd() + "…" : first;
    }

    /// <summary>
    /// Start a remote agent: write its task down, then spawn the process that runs it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The prompt goes to disk first and the process reads it from there, so
    /// nothing of the task passes through a command line — a task is paragraphs,
    /// and a command line is the wrong shape for paragraphs on every platform.
    /// </para>
    /// <para>
    /// The child is this same binary, told to <c>agent run</c>, so a development
    /// build spawns a development build and an installed one spawns itself. It is
    /// started detached: on Windows with no console, so a Ctrl-C in the terminal
    /// that started it does not reach it; elsewhere through <c>nohup</c> and a
    /// background <c>&amp;</c>, so the terminal closing does not either. Its
    /// output goes nowhere on purpose — the session writes its own log under
    /// <see cref="LogPath"/>, which survives the terminal.
    /// </para>
    /// </remarks>
    /// <exception cref="AgentException">There is already an active agent by that name, or the process would not start.</exception>
    /// <param name="delegator">Who is handing the task over — the nick the agent will report to.</param>
    /// <param name="spawn">How to start the process. The real one by default; tests hand in a fake.</param>
    public static AgentRecord Start(
        string repository,
        Session.SessionPlan plan,
        string prompt,
        string delegator = Chatroom.DefaultNick,
        Func<string, IReadOnlyList<string>, int>? spawn = null,
        int? maximumActive = null)
    {
        var name = plan.Session;
        System.IO.Directory.CreateDirectory(Root(repository));
        using var launchLock = LockLaunch(repository);

        if (maximumActive is { } limit && List(repository).Count(a => a.IsActive) >= limit)
        {
            throw new AgentException($"the kitchen already has {limit.ToString(CultureInfo.InvariantCulture)} active workers; wait or stop one");
        }

        if (Load(repository, name) is { } existing && Reconcile(existing).IsActive)
        {
            throw new AgentException(
                $"an agent called '{name}' is already {existing.State} (pid {existing.Pid}). " +
                $"`{CommandName.Current} agent stop {name}` first, or pick another name.");
        }

        System.IO.Directory.CreateDirectory(Root(repository));
        File.WriteAllText(PromptPath(repository, name), prompt.ReplaceLineEndings("\n"), Encoding.UTF8);
        ClearStop(repository, name);

        // Truncated, not appended: this is the log of this run of the agent,
        // and a previous run's lines above it would read as this one's.
        File.WriteAllText(LogPath(repository, name), "", Encoding.UTF8);

        var record = new AgentRecord(
            name,
            plan.Project,
            plan.Branch,
            plan.InstanceName,
            Chatroom.Nick(name),
            Summarise(prompt),
            DateTimeOffset.UtcNow,
            0,
            AgentState.Launching,
            Delegator: Chatroom.IsNick(delegator) ? delegator : Chatroom.DefaultNick,
            Backend: plan.Backend ?? Backends.BackendCatalog.Default);

        Save(repository, record);

        int pid;
        try
        {
            pid = (spawn ?? Spawn)(repository, ["-C", repository, "agent", "run", name]);
        }
        catch
        {
            Save(repository, record with { State = AgentState.Failed, EndedAt = DateTimeOffset.UtcNow });
            throw;
        }

        record = record with { Pid = pid };
        Save(repository, record);
        return record;
    }

    private static FileStream LockLaunch(string repository)
    {
        try
        {
            return new FileStream(Path.Combine(Root(repository), ".launch.lock"), FileMode.OpenOrCreate,
                FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException e)
        {
            throw new AgentException("another process is dispatching a worker; list the agents and retry", e);
        }
    }

    /// <summary>
    /// Run this binary again, detached from this terminal, and hand back its pid.
    /// </summary>
    private static int Spawn(string repository, IReadOnlyList<string> arguments)
    {
        var self = Environment.ProcessPath
            ?? throw new AgentException("envmux cannot tell what binary it is running as, so it cannot start another one");

        ProcessStartInfo info;

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            // No console of its own and none inherited: a Ctrl-C in this
            // terminal is a console event, and a process with no console does not
            // receive it. Nothing is redirected — a pipe with nobody reading it
            // would block the child the first time it wrote.
            info = new ProcessStartInfo(self)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = repository,
            };

            foreach (var argument in arguments)
            {
                info.ArgumentList.Add(argument);
            }

            try
            {
                using var process = System.Diagnostics.Process.Start(info)
                    ?? throw new AgentException("the agent's process did not start");

                return process.Id;
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
            {
                throw new AgentException($"could not start the agent's process: {e.Message}", e);
            }
        }

        // nohup for the hangup, & for the detach, $! for the pid — the whole of
        // what a daemoniser does, in a shell that is on every Unix. setsid would
        // be tidier and is not on macOS.
        info = new ProcessStartInfo("/bin/sh")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            WorkingDirectory = repository,
        };

        info.ArgumentList.Add("-c");
        info.ArgumentList.Add("nohup \"$@\" </dev/null >/dev/null 2>&1 & echo $!");
        info.ArgumentList.Add("envmux-agent");
        info.ArgumentList.Add(self);

        foreach (var argument in arguments)
        {
            info.ArgumentList.Add(argument);
        }

        try
        {
            using var shell = System.Diagnostics.Process.Start(info)
                ?? throw new AgentException("the agent's process did not start");

            var said = shell.StandardOutput.ReadToEnd().Trim();
            shell.WaitForExit();

            return int.TryParse(said, NumberStyles.Integer, CultureInfo.InvariantCulture, out var pid) ? pid : 0;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            throw new AgentException($"could not start the agent's process: {e.Message}", e);
        }
    }

    /// <summary>
    /// What <c>agent start</c> prints: everything the person — or the agent — who
    /// started it needs next, and nothing they have to go and find.
    /// </summary>
    /// <remarks>
    /// Every instruction names the command that printed it. This text is read by
    /// an agent that will run what it says, and a development build installed as
    /// <c>devenvmux</c> that told it to run <c>envmux</c> would send it to
    /// whatever else is on the PATH.
    /// </remarks>
    public static string StartReport(AgentRecord record, string command, bool claudeCarried)
    {
        var text = new StringBuilder();

        text.AppendLine($"{record.Name} — remote agent starting (pid {record.Pid.ToString(CultureInfo.InvariantCulture)})");
        text.AppendLine($"  branch    {record.Branch}");
        text.AppendLine($"  instance  {record.Instance}");
        text.AppendLine($"  room      {Chatroom.RoomDirectory}/  — it answers to @{record.Nick}");
        text.AppendLine($"  prompt    {Directory}/{record.Name}.prompt.md");
        text.AppendLine();
        text.AppendLine("  talk to it");
        text.AppendLine($"    {command} agent say \"@{record.Nick} …\"          a line in the room; it reads the room as it works");
        text.AppendLine($"    {command} agent read [--follow]           the last hour of the room, or watch it");
        text.AppendLine("  watch it");
        text.AppendLine($"    {command} agent ls                        where every agent of this repository is");
        text.AppendLine($"    {command} agent logs {record.Name} --follow    its transcript, out of the instance");
        text.AppendLine($"    {Directory}/{record.Name}.log               its session's own log");
        text.AppendLine("  when it is done");
        text.AppendLine($"    it commits on {record.Branch}, signs off in the room, and its session ends on its own;");
        text.AppendLine($"    the commits are fetched into this repository — `git log {record.Branch}`, then merge.");
        text.AppendLine($"    {command} agent stop {record.Name}           ends it early, bringing back what it has committed");

        if (!claudeCarried)
        {
            text.AppendLine();
            text.AppendLine("  warning   'claude' is not in this project's tools, so the agent arrives signed out.");
            text.AppendLine("            Add \"tools\": { \"claude\": \"auto\" } to .envmux.json and start it again.");
        }

        return text.ToString();
    }

    /// <summary>One agent, as <c>agent ls</c> lists it.</summary>
    public static string Describe(AgentRecord record)
    {
        var state = record.State;

        if (record.Result is { } result)
        {
            state += result.CommitsAhead > 0
                ? $" — {result.CommitsAhead.ToString(CultureInfo.InvariantCulture)} commit(s) on {result.Branch}"
                : " — nothing committed";

            if (result.DirtyFiles > 0)
            {
                state += $", {result.DirtyFiles.ToString(CultureInfo.InvariantCulture)} uncommitted in {record.Instance}";
            }
        }
        else if (record.ExitCode is { } code && code != 0)
        {
            state += $" — exit {code.ToString(CultureInfo.InvariantCulture)}";
        }

        return $"{record.Name,-20} {state,-40} {record.Summary}";
    }
}

/// <summary>Something about a remote agent that stops the command.</summary>
internal sealed class AgentException(string message, Exception? inner = null) : Exception(message, inner);
