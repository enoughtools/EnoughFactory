using System.Globalization;
using System.Text;
using System.Text.Json;

using Envmux.Agents;
using Envmux.Config;
using Envmux.Session;

namespace Envmux.Commands;

/// <summary>What the command line asked the <c>agent</c> command to do.</summary>
/// <param name="Verb">start, ls, say, read, stop, logs, run, prompt.</param>
/// <param name="Name">The agent, for the verbs that take one.</param>
/// <param name="Prompt">The task, given inline.</param>
/// <param name="PromptFile">The task, as a file to read.</param>
/// <param name="Nick">Who the workstation side speaks as.</param>
/// <param name="To">Whom a line is addressed to.</param>
/// <param name="Text">The line to say.</param>
/// <param name="Buckets">How many quarter hours to read back.</param>
/// <param name="Follow">Keep reading as more arrives.</param>
/// <param name="Portal">A running session's portal link, to drive instead of acting directly.</param>
internal sealed record AgentInvocation(
    string Verb,
    string? Name = null,
    string? Prompt = null,
    string? PromptFile = null,
    string Nick = Chatroom.DefaultNick,
    string? To = null,
    string? Text = null,
    int Buckets = Chatroom.RecentBuckets,
    bool Follow = false,
    string? Portal = null);

/// <summary>The command line was wrong, and this is what to say about it.</summary>
internal sealed class AgentUsageException(string message) : Exception(message);

/// <summary>
/// Remote agents: sessions with Claude Code in them, on a task, reachable
/// through the room.
/// </summary>
/// <remarks>
/// <para>
/// The grammar follows the rest of envmux — a verb, then the session name the
/// way <c>envmux code &lt;session&gt;</c> and <c>envmux logs &lt;session&gt;</c>
/// take it — and picks its verbs from what already exists where it can:
/// <c>start</c>/<c>stop</c> are a session's own life, <c>logs</c> is
/// <c>envmux logs</c> with the task filled in, <c>prompt</c> is what
/// <c>autoconfigure</c> is. <c>say</c> and <c>read</c> are the room, and are
/// named for what a person does in one rather than for the files underneath.
/// </para>
/// <para>
/// Two ways to do everything. Given a running session's portal link — on the
/// command line or in <c>ENVMUX_PORTAL</c> — the verbs are calls to that
/// session's API, so the browser page and this command are looking at one
/// thing. Given nothing, they act directly on the same files and the same
/// host, and the portal sees the result the next time it reads them. See
/// <see cref="PortalClient"/> for why the link is asked for rather than found.
/// </para>
/// <para>
/// <c>run</c> is the agent itself: a headless session with one task added,
/// which is what <c>start</c> spawns and what a supervisor would run. It is in
/// the usage so that somebody reading <c>ps</c> can find out what it is.
/// </para>
/// </remarks>
internal static class AgentCommand
{
    private const string Usage = """
        usage:
          envmux agent start <name> (--prompt <text> | --prompt-file <path>) [--as <nick>]
          envmux agent ls
          envmux agent say <text> [--as <nick>] [--to <name>]
          envmux agent read [--buckets <n>] [--follow]
          envmux agent stop <name>
          envmux agent logs <name> [--follow]
          envmux agent prompt
          envmux agent run <name>

        commands:
          start         Start a remote agent: a headless session on the branch envmux/<name>
                        with Claude Code running in it on the task, latched, talking through
                        the room. Prints what to do next. With neither --prompt nor
                        --prompt-file, the task is read from stdin.
          ls            Every agent this repository has started, and where each is.
          say           One line into the room, as --as (default: chef). --to prefixes @name.
          read          The last hour of the room — the last four quarter-hour buckets —
                        or --buckets more. --follow keeps printing as lines arrive.
          stop          Ask an agent to stop. Its session ends and its commits come back.
          logs          The agent's transcript, read out of its instance: `envmux logs <name> agent`.
          prompt        Print the briefing for an agent on this side: how to delegate, talk,
                        watch, and merge. The shipped skill defers to this.
          run           Be the agent: the headless session `start` spawns. Foreground.

        options:
          --portal <url>   Drive a running session's portal — the link it logged, ?k= and all
                           — instead of acting directly. ENVMUX_PORTAL does the same.
          -C, --directory  Run against this directory instead of the current one.

        The room is .context/chatroom/ in this repository, in the format the prompt-context
        plugin defines; it is carried into every session's instance live, over envmux's own API.
        """;

    /// <summary>Read the command line, or say what is wrong with it.</summary>
    /// <exception cref="AgentUsageException">The line does not parse.</exception>
    public static AgentInvocation Parse(IReadOnlyList<string> args)
    {
        if (args.Count == 0)
        {
            throw new AgentUsageException("agent needs a command: start, ls, say, read, stop, logs, prompt, run");
        }

        var verb = args[0];
        var invocation = new AgentInvocation(verb);
        var positional = new List<string>();

        for (var i = 1; i < args.Count; i++)
        {
            switch (args[i])
            {
                case "--prompt":
                    invocation = invocation with { Prompt = Value(args, ref i) };
                    break;

                case "--prompt-file":
                    invocation = invocation with { PromptFile = Value(args, ref i) };
                    break;

                case "--as":
                    var nick = Value(args, ref i);

                    if (!Chatroom.IsNick(nick))
                    {
                        throw new AgentUsageException(
                            $"'{nick}' is not a name the room accepts: lowercase, starting with a letter, 24 characters at most");
                    }

                    invocation = invocation with { Nick = nick };
                    break;

                case "--to":
                    invocation = invocation with { To = Value(args, ref i) };
                    break;

                case "--buckets":
                    var count = Value(args, ref i);

                    if (!int.TryParse(count, NumberStyles.Integer, CultureInfo.InvariantCulture, out var buckets) || buckets < 1)
                    {
                        throw new AgentUsageException($"--buckets takes a positive number, not '{count}'");
                    }

                    invocation = invocation with { Buckets = buckets };
                    break;

                case "-f" or "--follow":
                    invocation = invocation with { Follow = true };
                    break;

                case "--portal":
                    invocation = invocation with { Portal = Value(args, ref i) };
                    break;

                case "-h" or "--help":
                    throw new AgentUsageException("");

                default:
                    if (args[i].StartsWith('-'))
                    {
                        throw new AgentUsageException($"unknown option '{args[i]}'");
                    }

                    positional.Add(args[i]);
                    break;
            }
        }

        switch (verb)
        {
            case "start" or "stop" or "logs" or "run":
                if (positional.Count != 1)
                {
                    throw new AgentUsageException(positional.Count == 0
                        ? $"agent {verb} needs the agent's name"
                        : $"agent {verb} takes one name, not {positional.Count.ToString(CultureInfo.InvariantCulture)}");
                }

                if (verb == "start" && invocation is { Prompt: not null, PromptFile: not null })
                {
                    throw new AgentUsageException("--prompt and --prompt-file are two ways of saying the same thing; use one");
                }

                return invocation with { Name = positional[0] };

            case "say":
                if (positional.Count == 0)
                {
                    throw new AgentUsageException("agent say needs something to say");
                }

                if (invocation.To is { } to && !Chatroom.IsNick(to))
                {
                    throw new AgentUsageException($"--to '{to}' is not a name the room accepts");
                }

                return invocation with { Text = string.Join(' ', positional) };

            case "ls" or "read" or "prompt":
                if (positional.Count > 0)
                {
                    throw new AgentUsageException($"agent {verb} takes no arguments ('{positional[0]}')");
                }

                return invocation;

            default:
                throw new AgentUsageException($"'{verb}' is not an agent command: start, ls, say, read, stop, logs, prompt, run");
        }
    }

    private static string Value(IReadOnlyList<string> args, ref int i)
    {
        if (i + 1 >= args.Count || args[i + 1].StartsWith("--", StringComparison.Ordinal))
        {
            throw new AgentUsageException($"{args[i]} needs a value");
        }

        return args[++i];
    }

    public static async Task<int> RunAsync(string directory, IReadOnlyList<string> args, CancellationToken ct = default)
    {
        AgentInvocation asked;

        try
        {
            asked = Parse(args);
        }
        catch (AgentUsageException e)
        {
            if (e.Message.Length > 0)
            {
                Console.Error.WriteLine($"envmux: {e.Message}");
            }

            Console.Error.WriteLine(Usage);
            return e.Message.Length == 0 ? 0 : 2;
        }

        try
        {
            using var portal = asked.Verb is "run" or "prompt" or "logs" ? null : PortalClient.From(asked.Portal);

            return asked.Verb switch
            {
                "start" => await StartAsync(directory, asked, portal, ct).ConfigureAwait(false),
                "ls" => await ListAsync(directory, portal, ct).ConfigureAwait(false),
                "say" => await SayAsync(directory, asked, portal, ct).ConfigureAwait(false),
                "read" => await ReadAsync(directory, asked, portal, ct).ConfigureAwait(false),
                "stop" => await StopAsync(directory, asked.Name!, portal, ct).ConfigureAwait(false),
                "logs" => await LogsCommand.RunAsync(directory, asked.Name, AgentRegistry.TaskName, asked.Follow,
                        requested: asked.Name is { } name ? AgentRegistry.Load(directory, Slug.From(name))?.Backend : null, ct: ct)
                    .ConfigureAwait(false),
                "prompt" => Prompt(),
                "run" => await RunAgentAsync(directory, asked.Name!, ct).ConfigureAwait(false),
                _ => 2,
            };
        }
        catch (AgentException e)
        {
            Console.Error.WriteLine($"envmux: {e.Message}");
            return 1;
        }
    }

    private static int Prompt()
    {
        Console.Write(AgentPrompt.Local(CommandName.Current));
        return 0;
    }

    /// <summary>Start one, and say what to do next.</summary>
    private static async Task<int> StartAsync(string directory, AgentInvocation asked, PortalClient? portal, CancellationToken ct)
    {
        var task = await TaskTextAsync(asked, ct).ConfigureAwait(false);

        if (string.IsNullOrWhiteSpace(task))
        {
            Console.Error.WriteLine("envmux: the task is empty. --prompt <text>, --prompt-file <path>, or pipe it in.");
            return 2;
        }

        var config = SessionConfig.Load(directory);
        var plan = SessionPlan.Resolve(config, directory, asked.Name);
        var claude = plan.Tools.TryGetValue("claude", out var mode) && !mode.Equals("off", StringComparison.OrdinalIgnoreCase);

        AgentRecord record;

        if (portal is not null)
        {
            var answer = await portal.PostAsync("/agents", WireJson.Object(AgentRegistry.Json, ("name", plan.Session), ("prompt", task), ("nick", asked.Nick)), ct)
                .ConfigureAwait(false);

            record = WireJson.Deserialize<AgentRecord>(answer, AgentRegistry.Json)
                ?? throw new AgentException("the portal started the agent but did not describe it");

            Console.Error.WriteLine($"envmux: started through the portal at {portal.Describe()}");
        }
        else
        {
            record = AgentRegistry.Start(directory, plan, task, asked.Nick);

            // The delegator's own line: the room should say who handed what to
            // whom, and the agent's join line — a minute or two away — says only
            // that it arrived.
            await Chatroom.AppendAsync(
                directory,
                Chatroom.Event(DateTime.Now, asked.Nick, $"started {record.Nick} on {record.Branch} — {record.Summary}"),
                DateTime.Now,
                ct).ConfigureAwait(false);
        }

        Console.Write(AgentRegistry.StartReport(record, CommandName.Current, claude));
        return 0;
    }

    /// <summary>The task, from wherever it was given.</summary>
    private static async Task<string> TaskTextAsync(AgentInvocation asked, CancellationToken ct)
    {
        if (asked.Prompt is { } inline)
        {
            return inline;
        }

        if (asked.PromptFile is { } file)
        {
            if (!File.Exists(file))
            {
                throw new AgentException($"there is no file at {file}");
            }

            return await File.ReadAllTextAsync(file, Encoding.UTF8, ct).ConfigureAwait(false);
        }

        // Neither given. A pipe is the third way — `envmux agent start x < task.md`
        // — and a terminal with nothing on it is a question, not a hang.
        if (Console.IsInputRedirected)
        {
            return await Console.In.ReadToEndAsync(ct).ConfigureAwait(false);
        }

        return "";
    }

    private static async Task<int> ListAsync(string directory, PortalClient? portal, CancellationToken ct)
    {
        IReadOnlyList<AgentRecord> agents;

        if (portal is not null)
        {
            var answer = await portal.GetAsync("/agents", ct).ConfigureAwait(false);
            agents = answer.TryGetProperty("agents", out var list)
                ? WireJson.Deserialize<List<AgentRecord>>(list, AgentRegistry.Json) ?? []
                : [];
        }
        else
        {
            agents = AgentRegistry.List(directory);
        }

        if (agents.Count == 0)
        {
            Console.WriteLine("no remote agents have been started from this repository.");
            Console.WriteLine($"  {CommandName.Current} agent start <name> --prompt \"…\"   starts one");
            return 0;
        }

        foreach (var agent in agents)
        {
            Console.WriteLine(AgentRegistry.Describe(agent));
        }

        return 0;
    }

    private static async Task<int> SayAsync(string directory, AgentInvocation asked, PortalClient? portal, CancellationToken ct)
    {
        var now = DateTime.Now;
        var line = asked.To is { } to
            ? Chatroom.SayTo(now, asked.Nick, to, asked.Text!)
            : Chatroom.Say(now, asked.Nick, asked.Text!);

        if (portal is not null)
        {
            var answer = await portal.PostAsync("/chat", WireJson.Object(AgentRegistry.Json, ("nick", asked.Nick), ("to", asked.To), ("text", asked.Text)), ct)
                .ConfigureAwait(false);

            Console.WriteLine(answer.TryGetProperty("line", out var said) ? said.GetString() : line);
            return 0;
        }

        await Chatroom.AppendAsync(directory, line, now, ct).ConfigureAwait(false);
        Console.WriteLine(line);
        return 0;
    }

    /// <summary>
    /// The recent room, and optionally everything after it as it arrives.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Following is a cursor and a wait. Through the portal it is the long poll
    /// — <c>GET /api/chat?after=…&amp;wait=25</c>, answered the moment a line
    /// lands and asked again with the cursor it hands back. Without a portal it
    /// is the same thing in-process: a <see cref="RoomFeed"/> on the files,
    /// waited on the same way. Either way a line is printed once, and the
    /// quarter-hour rollover is the cursor's problem rather than this loop's.
    /// </para>
    /// <para>
    /// How long to hold each ask is a balance the client sets: long enough
    /// that a quiet room is not a request a second, short enough to be inside
    /// the HTTP client's own timeout with room to spare.
    /// </para>
    /// </remarks>
    private static async Task<int> ReadAsync(string directory, AgentInvocation asked, PortalClient? portal, CancellationToken ct)
    {
        using var feed = portal is null ? new RoomFeed(directory) : null;

        RoomCursor cursor;

        if (feed is not null)
        {
            var recent = feed.Recent(asked.Buckets);

            foreach (var line in Chatroom.ParseAll(recent.Entries.Select(e => e.Raw)))
            {
                Console.WriteLine(line.Raw);
            }

            cursor = recent.Cursor;
        }
        else
        {
            var answer = await portal!.GetAsync($"/chat?buckets={asked.Buckets.ToString(CultureInfo.InvariantCulture)}", ct)
                .ConfigureAwait(false);

            if (answer.TryGetProperty("lines", out var lines))
            {
                foreach (var line in lines.EnumerateArray())
                {
                    Console.WriteLine(line.GetProperty("raw").GetString() ?? "");
                }
            }

            // An older portal without a cursor is followed from the start of
            // nothing, which the loop below treats as "from now".
            if (!RoomCursor.TryParse(answer.TryGetProperty("cursor", out var at) ? at.GetString() : null, out cursor))
            {
                cursor = RoomCursor.Start;
            }
        }

        if (!asked.Follow)
        {
            return 0;
        }

        Console.Error.WriteLine("envmux: following the room — interrupt to stop");

        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (feed is not null)
                {
                    var delta = await feed.WaitAsync(cursor, FollowWait, ct).ConfigureAwait(false);

                    foreach (var entry in delta.Entries)
                    {
                        Console.WriteLine(entry.Raw);
                    }

                    cursor = delta.Cursor;
                    continue;
                }

                var answer = await portal!.GetAsync(
                    $"/chat?after={Uri.EscapeDataString(cursor.ToString())}&wait={((int)FollowWait.TotalSeconds).ToString(CultureInfo.InvariantCulture)}",
                    ct).ConfigureAwait(false);

                if (answer.TryGetProperty("lines", out var arrived))
                {
                    foreach (var entry in arrived.EnumerateArray())
                    {
                        Console.WriteLine(entry.GetProperty("raw").GetString() ?? "");
                    }
                }

                if (answer.TryGetProperty("cursor", out var next) && RoomCursor.TryParse(next.GetString(), out var moved))
                {
                    cursor = moved;
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        return 0;
    }

    /// <summary>How long one ask of the room is held open while following it.</summary>
    /// <remarks>
    /// Under the portal client's thirty-second timeout by enough that a slow
    /// answer is still an answer, and long enough that a quiet room costs a
    /// request every half minute rather than every few seconds.
    /// </remarks>
    private static readonly TimeSpan FollowWait = TimeSpan.FromSeconds(25);

    private static async Task<int> StopAsync(string directory, string name, PortalClient? portal, CancellationToken ct)
    {
        var session = Slug.From(name);

        if (portal is not null)
        {
            await portal.PostAsync($"/agents/{Uri.EscapeDataString(session)}/stop", WireJson.Object(AgentRegistry.Json), ct).ConfigureAwait(false);
            Console.WriteLine($"{session}: asked to stop through the portal");
            return 0;
        }

        if (AgentRegistry.Load(directory, session) is not { } record)
        {
            Console.Error.WriteLine($"envmux: no agent called '{session}' was started from this repository");
            return 1;
        }

        if (!AgentRegistry.Reconcile(record).IsActive)
        {
            Console.WriteLine($"{session} is already {AgentRegistry.Reconcile(record).State}");
            return 0;
        }

        AgentRegistry.RequestStop(directory, session);

        Console.WriteLine($"{session}: asked to stop. Its session ends and its commits are fetched onto {record.Branch};");
        Console.WriteLine($"  {CommandName.Current} agent ls   says when it has.");
        return 0;
    }

    /// <summary>
    /// The session's plan with the agent in it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// One more task, declared by envmux rather than the config and marked so.
    /// It waits on every <c>once</c> task that autostarts — the installs, the
    /// migrations, the toolchain — because an agent that begins before
    /// <c>npm ci</c> has finished spends its first minutes diagnosing a
    /// half-installed tree. It does not wait on the ongoing ones; a dev server
    /// is not a precondition for editing code.
    /// </para>
    /// <para>
    /// The session's environment gets <c>TZ</c>, so that <c>date</c> inside the
    /// instance agrees with the workstation about which quarter hour it is. Added
    /// under the config's own <c>env</c>, never over it.
    /// </para>
    /// <para>
    /// The room comes too, whether or not the repository has a <c>.context/</c>
    /// — an agent with nobody to talk to is not an agent anybody delegated to.
    /// The client that carries it is one more task (<see cref="RoomClient"/>),
    /// and the agent's own task gets the API's address and the session's token
    /// in its environment, so an agent that wants the room faster than the
    /// files can <c>curl</c> it itself. In the exec's environment and nowhere
    /// else: the token is never written into the instance.
    /// </para>
    /// </remarks>
    /// <exception cref="AgentException">The config already declares a task by the agent's name.</exception>
    internal static SessionPlan WithAgent(SessionPlan plan, string task, string nick, string delegator, TimeSpan utcOffset)
    {
        if (plan.Tasks.Any(t => t.Name.Equals(AgentRegistry.TaskName, StringComparison.Ordinal)))
        {
            throw new AgentException(
                $"this project declares a task called '{AgentRegistry.TaskName}', which is the name the remote agent runs as. Rename it.");
        }

        var setup = plan.Tasks
            .Where(t => t.Kind == TaskKind.Once && t.Autostart)
            .Select(t => new TaskDependency(t.Name, IsService: false, null, 0))
            .ToList();

        var agentEnv = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [EnvKeys.Task] = AgentRegistry.TaskName,
            [AgentPrompt.PromptVariable] = AgentPrompt.Remote(plan, nick, task, delegator),
        };

        var tasks = plan.Tasks.ToList();

        if (RoomClient.Reachable(plan.Portal))
        {
            foreach (var (key, value) in Portal.ApiBridge.Environment(plan.Portal.RoomToken))
            {
                agentEnv[key] = value;
            }

            if (!tasks.Any(RoomClient.Is))
            {
                if (tasks.Any(t => t.Name.Equals(RoomClient.TaskName, StringComparison.Ordinal)))
                {
                    throw new AgentException(
                        $"this project declares a task called '{RoomClient.TaskName}', which is the name the room's client runs as. Rename it.");
                }

                tasks.Add(RoomClient.Task(plan.Workdir, plan.Portal));
            }
        }

        var agent = new TaskPlan
        {
            Name = AgentRegistry.TaskName,
            Kind = TaskKind.Once,
            DependsOn = setup,
            ReadyPort = null,
            // The agent task prints no URL anybody should open; its output is a
            // transcript.
            UrlPattern = null,
            Command = [.. TaskPlan.Shell, AgentPrompt.Command],
            Display = AgentPrompt.Display,
            Workdir = plan.Workdir,
            Env = agentEnv,
            Autostart = true,
            Restart = RestartPolicy.Never,
            IsInternal = true,
        };

        tasks.Add(agent);

        var env = new Dictionary<string, string>(plan.Env, StringComparer.Ordinal);
        env.TryAdd(Chatroom.TimeZoneVariable, Chatroom.PosixTimeZone(utcOffset));
        env.TryAdd("ENVMUX_AGENT", nick);
        env.TryAdd("ENVMUX_ROOM", Chatroom.Room(plan.Project));

        return plan with { Tasks = tasks, Env = env, Chef = false };
    }

    /// <summary>Whether a task has reached a state it will not leave on its own.</summary>
    internal static bool IsOver(TaskState state) =>
        state is TaskState.Exited or TaskState.Failed or TaskState.Blocked or TaskState.Stopped;

    /// <summary>
    /// Be the agent: a headless session with the task in it, until the task is
    /// done or somebody asks it to stop.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The headless loop from <c>Program</c> with three differences. The log goes
    /// to a file, because there is no terminal — <c>start</c> detached this
    /// process from the one it had. The session ends on its own when the
    /// agent's task does, because an agent that has signed off and a session
    /// that keeps its instance running for nobody are not the same thing. And
    /// a stop file is polled beside Ctrl-C, because a process with no console
    /// has no Ctrl-C to receive and this is the only door left.
    /// </para>
    /// <para>
    /// The record is written at every transition, so <c>agent ls</c> in another
    /// process — or the portal — is never more than one step behind.
    /// </para>
    /// </remarks>
    private static async Task<int> RunAgentAsync(string directory, string name, CancellationToken ct)
    {
        var session = Slug.From(name);

        var record = AgentRegistry.Load(directory, session)
            ?? throw new AgentException(
                $"no agent called '{session}' has been started here — `{CommandName.Current} agent start {session} --prompt …` does that");

        var promptPath = AgentRegistry.PromptPath(directory, session);

        if (!File.Exists(promptPath))
        {
            throw new AgentException($"the task for '{session}' is missing: {promptPath}");
        }

        var task = await File.ReadAllTextAsync(promptPath, Encoding.UTF8, ct).ConfigureAwait(false);

        var plan = WithAgent(
            SessionPlan.Resolve(SessionConfig.Load(directory), directory, session) with { Backend = record.Backend },
            task,
            record.Nick,
            record.Delegator,
            TimeZoneInfo.Local.GetUtcOffset(DateTimeOffset.Now));

        record = record with
        {
            Pid = Environment.ProcessId,
            State = AgentState.Starting,
            Instance = plan.InstanceName,
            Branch = plan.Branch,
        };

        AgentRegistry.Save(directory, record);

        await using var log = new StreamWriter(
            new FileStream(AgentRegistry.LogPath(directory, session), FileMode.Append, FileAccess.Write, FileShare.Read),
            new UTF8Encoding(false))
        { AutoFlush = true };

        var echo = !Console.IsOutputRedirected;

        void Write(string line)
        {
            try
            {
                log.WriteLine(line);

                if (echo)
                {
                    Console.WriteLine(line);
                }
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException)
            {
                // The log is the only place this could be reported.
            }
        }

        await using var live = new Session.Session(plan);

        live.Log.Appended += entry => Write(entry.ToString());
        live.TaskOutput += (which, line) => Write($"{which,10} | {line}");

        using var shutdown = new CancellationTokenSource();
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, shutdown.Token);

        ConsoleCancelEventHandler onCancel = (_, e) =>
        {
            e.Cancel = true;
            shutdown.Cancel();
        };

        Console.CancelKeyPress += onCancel;

        int? exit = null;
        var askedToStop = false;

        try
        {
            Write($"{Stamp()}  agent {record.Nick}: session {plan.Session} on {plan.Branch}, pid {Environment.ProcessId.ToString(CultureInfo.InvariantCulture)}");

            await live.PreflightAsync().ConfigureAwait(false);
            await live.StartAsync(linked.Token).ConfigureAwait(false);

            if (!plan.Tasks.Any(RoomClient.Is))
            {
                Write($"{Stamp()}  the room is not carried into {plan.InstanceName}: the portal or its token is off in .envmux.json, " +
                      "so the agent works alone and reports only through its commits");
            }

            await Chatroom.AppendAsync(
                directory,
                Chatroom.Event(DateTime.Now, record.Nick,
                    $"joined (Claude / envmux remote agent, {plan.InstanceName}) — taking: {record.Summary}"),
                DateTime.Now,
                linked.Token).ConfigureAwait(false);

            AgentRegistry.Save(directory, record = record with { State = AgentState.Running });
            Write($"{Stamp()}  running — the agent is in {plan.InstanceName}; stop with `{CommandName.Current} agent stop {session}`");

            while (!linked.IsCancellationRequested)
            {
                if (AgentRegistry.StopRequested(directory, session))
                {
                    askedToStop = true;
                    Write($"{Stamp()}  asked to stop");
                    break;
                }

                if (live.FindTask(AgentRegistry.TaskName) is { } running && IsOver(running.State))
                {
                    exit = running.ExitCode ?? (running.State == TaskState.Exited ? 0 : 1);
                    Write($"{Stamp()}  the agent's task is {running.Status}");
                    break;
                }

                try
                {
                    await Task.Delay(AgentRegistry.StopPoll, linked.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }

            AgentRegistry.Save(directory, record = record with { State = AgentState.Finishing, ExitCode = exit });

            await Chatroom.AppendAsync(
                directory,
                Chatroom.Event(DateTime.Now, record.Nick, askedToStop
                    ? $"leaving — asked to stop; bringing back what is committed on {plan.Branch}"
                    : exit is { } code
                        ? $"agent exited ({code.ToString(CultureInfo.InvariantCulture)}) — session ending, commits come back onto {plan.Branch}"
                        : $"leaving — interrupted; bringing back what is committed on {plan.Branch}"),
                DateTime.Now,
                CancellationToken.None).ConfigureAwait(false);

            // A moment for the room's client in the instance to post the agent's
            // sign-off — written seconds ago, and carried on a loop of about a
            // second — before the instance is stopped under it.
            if (plan.Tasks.Any(RoomClient.Is))
            {
                try
                {
                    await Task.Delay(RoomClient.Grace, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // Interrupted while waiting; the stop below is what was asked for.
                }
            }

            await shutdown.CancelAsync().ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            askedToStop = true;
        }
        catch (Exception e) when (e is SessionException or Incus.IncusException or Git.GitException or ConfigException)
        {
            Write($"{Stamp()}  failed: {e.Message}");
            AgentRegistry.Save(directory, record with { State = AgentState.Failed, EndedAt = DateTimeOffset.UtcNow });
            AgentRegistry.ClearStop(directory, session);
            Console.CancelKeyPress -= onCancel;
            await live.StopAsync().ConfigureAwait(false);
            return 1;
        }

        Console.CancelKeyPress -= onCancel;

        var status = await live.StopAsync().ConfigureAwait(false);

        var result = status is null
            ? null
            : new AgentResult(status.Branch, status.Head, status.CommitsAhead, status.DirtyFiles);

        var final = askedToStop
            ? AgentState.Stopped
            : exit is 0 or null ? AgentState.Finished : AgentState.Failed;

        AgentRegistry.Save(directory, record with
        {
            State = final,
            ExitCode = exit,
            Result = result,
            EndedAt = DateTimeOffset.UtcNow,
        });

        AgentRegistry.ClearStop(directory, session);

        Write(result is { CommitsAhead: > 0 }
            ? $"{Stamp()}  {final}: {result.CommitsAhead.ToString(CultureInfo.InvariantCulture)} commit(s) on {result.Branch} — git log {result.Branch}"
            : $"{Stamp()}  {final}: nothing committed");

        return 0;

        static string Stamp() => DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture);
    }
}
