using System.Reflection;
using Envmux.Commands;
using Envmux.Config;
using Envmux.Git;
using Envmux.Lean;
using Envmux.Routing;
using Envmux.Session;
using Envmux.Ui;

namespace Envmux;

internal static class Program
{
    private const string Usage = """
        envmux — one process, one instance, one address.

        usage:
          envmux [<session>] [options]
          claude "$(envmux autoconfigure)"
          envmux agent <command>
          envmux code [<session>] [--print]
          envmux docker [--print]
          envmux config [validate|show|schema]
          envmux host <command>
          envmux init [options]
          envmux install [options]
          envmux logs [<session>] [<task>] [--follow]
          envmux prune [options]
          envmux ssh [--print]

        arguments:
          <session>                Name this session — its branch, its instance, and
                                   the name that instance answers on. Generated when
                                   you do not give one.

        commands:
          autoconfigure            Print a prompt that gets an agent to write — or
                                   update — this repository's .envmux.json. Give it to
                                   claude as an argument so it opens interactively, or
                                   pipe it to codex, gemini, opencode.
          agent                    Remote agents: a headless session on a branch with
                                   Claude Code in it on a task you hand over, talking
                                   through the .context/chatroom/ room. start, ls, say,
                                   read, stop, logs; `envmux agent` lists them. `agent
                                   prompt` briefs the agent on this side.
          code                     Attach VS Code to a session running here, over SSH
                                   — the same thing the `e` key does, from another
                                   terminal. --print writes the link instead.
          docker                   Serve the Docker-compatible endpoint VS Code's Dev
                                   Containers extension attaches to — a session's
                                   instance, presented as a container. Runs until
                                   interrupted; --print writes what to point the
                                   editor at and exits. Windows, macOS and Linux. Clients
                                   start this on demand and hold it open with a lease,
                                   so it is rarely run by hand; it closes itself once
                                   nothing needs it.
          config validate          Check .envmux.json and say what is wrong. Exit 2 if so.
          config show              The resolved config, with defaults applied.
          config schema            Every field envmux accepts.
          host                     Build and inspect the IncusOS machine sessions
                                   run on, one step at a time: the seed, the VM,
                                   trust, and the golden instance. `envmux host`
                                   lists them.
          install                  Install the native executable onto your user
                                   PATH and check Git and the Linux Docker engine.
                                   --check writes nothing; --no-path only copies.
                                   --provider incus|hyperv sets up a remote host.
          init                     Write a .envmux.json that fits this repository,
                                   with the coding tools found on this host filled in.
          logs                     What a task said, read out of its instance. Tasks
                                   are latched and tee their output to a file, so this
                                   works for a build that ran with nothing watching.
                                   No task named lists what is latchable.
          prune                    Remove the instances sessions leave behind. They are
                                   kept on purpose — starting a session again picks one
                                   up where you left it — so they accumulate.
          ssh                      Make the one key sessions let in, and point
                                   ~/.ssh/config at it for the zone — what makes the
                                   editor attach with nothing copied by hand. Part of
                                   install; here for when it needs doing again. Not a
                                   shell into a session: that is `c` in the window.

        options:
          -C, --directory <path>   Run against this directory instead of the current one
              --dry-run            Report what would happen; change nothing
              --headless           Run the session with no UI, until interrupted
              --backend <name>     What the session runs on: docker (the default,
                                   this machine's engine) or incus
              --print              code: write the link instead of opening it
                                   ssh: write the config block instead of applying it
              --follow             logs: keep reading as more arrives
              --force              prune: also remove instances with uncommitted work
                                   init: overwrite an existing .envmux.json
              --skills <agent>     init: install project skills (claude, codex, both)
              --all                prune: also take down instances that are running
          -h, --help               This
              --version            Print the version

        Sessions use the local Linux Docker engine by default. Incus is optional.
        Press b for the session browser: its localhost reaches the instance.
        With no .envmux.json, envmux offers to write one.
        """;

    private static async Task<int> Main(string[] args)
    {
        try
        {
            var result = await RunAsync(args).ConfigureAwait(false);
            MachineBridge.Emit(new MachineEvent("exit", ExitCode: result));
            return result;
        }
        catch (ConfigException e)
        {
            MachineBridge.Emit(new MachineEvent("error", Error: e.Message, ExitCode: 2));
            Console.Error.WriteLine($"envmux: {e.Message}");
            return 2;
        }
        catch (Exception e) when (e is SessionException or GitException or Backends.BackendException
                                      or Host.CertificateException or Editor.EditorException
                                      or Editor.SshConfigException or Docker.ShimException)
        {
            MachineBridge.Emit(new MachineEvent("error", Error: e.Message, ExitCode: 1));
            Console.Error.WriteLine($"envmux: {e.Message}");
            return 1;
        }
        catch (UiException e)
        {
            // Said in full, because a UI that failed to start is the one failure
            // nobody can read off the screen — the screen is the thing that did
            // not happen. The terminal has already been handed back by the time
            // this runs.
            Console.Error.WriteLine($"envmux: {e.Message}");
            Console.Error.WriteLine();
            Console.Error.WriteLine(e.InnerException?.ToString() ?? "no further detail");
            Console.Error.WriteLine();
            Console.Error.WriteLine("envmux: --headless runs the session without a window.");
            return 1;
        }
    }

    private static async Task<int> RunAsync(string[] args)
    {
        // `host` and `install` take grammars of their own — subcommands, their
        // own options — and both are about the machine rather than about this
        // directory, so each is handed the rest of the line untouched rather
        // than being squeezed through the session parser below.
        if (Array.IndexOf(args, "host") is var host and >= 0 && NothingBefore(args, host))
        {
            return await HostCommand.RunAsync(args[(host + 1)..]).ConfigureAwait(false);
        }

        if (Array.IndexOf(args, "install") is var install and >= 0 && NothingBefore(args, install))
        {
            return await InstallCommand.RunAsync([.. args[(install + 1)..]]).ConfigureAwait(false);
        }

        // `relay` is what ssh runs, from the ProxyCommand `envmux ssh` writes.
        // Its stdout is the ssh channel, so it goes nowhere near the session
        // parser and its usage: nothing may print but the relay itself.
        if (Array.IndexOf(args, "relay") is var relay and >= 0 && NothingBefore(args, relay))
        {
            return await RelayCommand.RunAsync(args[(relay + 1)..]).ConfigureAwait(false);
        }

        // `agent` too — but about this directory, so the one option that may
        // come before it is -C, and it is honoured.
        if (Array.IndexOf(args, "agent") is var agent and >= 0 && NothingBefore(args, agent))
        {
            var where = DirectoryBefore(args, agent) ?? Environment.CurrentDirectory;

            if (!Directory.Exists(where))
            {
                Console.Error.WriteLine($"envmux: no such directory: {where}");
                return 2;
            }

            return await AgentCommand.RunAsync(PhysicalPath.Of(where), [.. args[(agent + 1)..]]).ConfigureAwait(false);
        }

        var directory = Environment.CurrentDirectory;
        var dryRun = false;
        var force = false;
        var headless = false;
        var all = false;
        var print = false;
        var auto = false;
        var follow = false;
        string? skills = null;
        Backends.BackendKind? backend = null;
        string? command = null;
        string? session = null;

        // `logs` is the one command that takes a second positional, and it is
        // optional, so it cannot go through the "one session name, not two" rule
        // below.
        string? task = null;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "-h" or "--help":
                    Console.WriteLine(Usage);
                    return 0;

                case "--version":
                    Console.WriteLine(ThisAssembly.Version);
                    return 0;

                case "--dry-run":
                    dryRun = true;
                    break;

                case "--all":
                    all = true;
                    break;

                case "--force":
                    force = true;
                    break;

                case "--skills":
                    if (i + 1 >= args.Length || !Agents.ProjectSkills.IsSelection(args[i + 1]))
                    {
                        Console.Error.WriteLine("envmux: --skills is claude, codex, or both");
                        return 2;
                    }

                    skills = args[++i];
                    break;

                case "--headless":
                    headless = true;
                    break;

                case "--print":
                    print = true;
                    break;

                // `docker` only: serve the auto-launched, self-closing endpoint
                // rather than the manual one. Set by clients, not by hand.
                case "--auto":
                    auto = true;
                    break;

                case "-f" or "--follow":
                    follow = true;
                    break;

                // Wins over "backend" in .envmux.json, for a run that wants the
                // other one without editing a committed file.
                case "--backend":
                    if (i + 1 >= args.Length || Backends.BackendCatalog.Parse(args[i + 1]) is not { } chosen)
                    {
                        Console.Error.WriteLine($"envmux: --backend is incus or docker");
                        return 2;
                    }

                    backend = chosen;
                    i++;
                    break;

                case "-C" or "--directory":
                    if (i + 1 >= args.Length)
                    {
                        Console.Error.WriteLine($"envmux: {args[i]} needs a path");
                        return 2;
                    }

                    directory = args[++i];
                    break;

                case "init" or "prune" or "autoconfigure" or "config" or "code" or "docker" or "logs" or "ssh" or "sessions"
                    when command is null && session is null:
                    command = args[i];
                    break;

                default:
                    if (args[i].StartsWith('-'))
                    {
                        Console.Error.WriteLine($"envmux: unknown option '{args[i]}'");
                        Console.Error.WriteLine(Usage);
                        return 2;
                    }

                    if (session is not null && command == "logs" && task is null)
                    {
                        task = args[i];
                        break;
                    }

                    if (session is not null)
                    {
                        Console.Error.WriteLine($"envmux: one session name, not two ('{session}' and '{args[i]}')");
                        return 2;
                    }

                    session = args[i];
                    break;
            }
        }

        if (!Directory.Exists(directory))
        {
            Console.Error.WriteLine($"envmux: no such directory: {directory}");
            return 2;
        }

        // Physical rather than merely absolute: this one string becomes the
        // label an instance carries, and git reports paths with their links
        // resolved. Settling the spelling once, here, is what lets `code` and
        // `prune` recognise an instance as belonging to this directory.
        directory = PhysicalPath.Of(directory);

        if (skills is not null && command != "init")
        {
            Console.Error.WriteLine("envmux: --skills belongs to init");
            return 2;
        }

        return command switch
        {
            "autoconfigure" => AutoconfigureCommand.Run(directory),

            // `envmux config validate` — the word after `config` lands in the
            // same slot a session name would, which is fine because a config
            // command never takes one.
            "config" => await ConfigCommand.RunAsync(directory, session).ConfigureAwait(false),

            "code" => await CodeCommand.RunAsync(directory, session, print, backend).ConfigureAwait(false),

            // The Docker endpoint VS Code's Dev Containers extension attaches
            // to. About this workstation, not this session: it takes the
            // directory only for the folder `--print` writes a URI for.
            "docker" => await DockerCommand.RunAsync(directory, print, auto).ConfigureAwait(false),

            // Takes the directory for the zone a repository may name of its own,
            // and nothing else from it: this is a command about this
            // workstation, and it is worth running outside a project.
            "ssh" => await SshCommand.RunAsync(directory, session, print, backend).ConfigureAwait(false),
            "init" => await InitCommand.RunAsync(directory, force, skills).ConfigureAwait(false),
            "logs" => await LogsCommand.RunAsync(directory, session, task, follow, requested: backend).ConfigureAwait(false),
            "prune" => await PruneCommand.RunAsync(directory, force, dryRun, all, backend).ConfigureAwait(false),
            "sessions" => await SessionsCommand.RunAsync(directory, backend).ConfigureAwait(false),
            _ => await SessionAsync(directory, session, dryRun, headless, backend).ConfigureAwait(false),
        };
    }

    /// <summary>
    /// Whether a word is the command rather than an argument to another one.
    /// </summary>
    /// <remarks>
    /// A session could legitimately be called <c>install</c>, and
    /// <c>envmux code install</c> should mean the session. So a word only takes
    /// the line when nothing before it has already claimed it.
    /// </remarks>
    private static bool NothingBefore(string[] args, int index) =>
        args.Take(index).All(a =>
            a is not ("init" or "prune" or "autoconfigure" or "config" or "code" or "docker" or "logs" or "ssh" or "agent" or "relay"));

    /// <summary>A <c>-C</c> given before the command word, if there was one.</summary>
    private static string? DirectoryBefore(string[] args, int index)
    {
        for (var i = 0; i < index - 1; i++)
        {
            if (args[i] is "-C" or "--directory")
            {
                return args[i + 1];
            }
        }

        return null;
    }

    private static async Task<int> SessionAsync(
        string directory,
        string? name,
        bool dryRun,
        bool headless,
        Backends.BackendKind? backend)
    {
        SessionPlan Resolve()
        {
            var plan = SessionPlan.Resolve(SessionConfig.Load(directory), directory, name);
            return backend is { } chosen ? plan with { Backend = chosen } : plan;
        }

        if (dryRun)
        {
            PrintPlan(Resolve());
            return 0;
        }

        // Drawing a TUI into a pipe would be worse than not starting. Say so,
        // and point at the mode that does work without a terminal.
        if (Console.IsOutputRedirected && !headless)
        {
            Console.Error.WriteLine(
                "envmux: not a terminal. Use --headless to run a session without the UI, or --dry-run to see the plan.");
            PrintPlan(Resolve());
            return 0;
        }

        // Asked before anything is created, because the answer changes what
        // gets created. A session with no config still works — it just does
        // nothing but hold a container open, which is rarely what was wanted.
        switch (await OfferToConfigureAsync(directory, headless).ConfigureAwait(false))
        {
            case ConfigureChoice.Quit:
                return 0;

            default:
                break;
        }

        var plan = Resolve();

        await using var session = new Session.Session(plan);
        MachineBridge.Observe(session);

        // Ctrl-C, a closed terminal, or a kill signal all end the same way: the
        // commits come back, the port is released, and the instance is stopped.
        using var shutdown = new CancellationTokenSource();
        ConsoleCancelEventHandler onCancel = (_, e) =>
        {
            e.Cancel = true;
            shutdown.Cancel();
        };

        Console.CancelKeyPress += onCancel;
        session.StopRequested += shutdown.Cancel;
        AppDomain.CurrentDomain.ProcessExit += OnProcessExit;

        try
        {
            // Fast checks first, as a plain console error. A host that is not
            // answering should not be a message inside a terminal UI you then
            // have to quit out of.
            await session.PreflightAsync().ConfigureAwait(false);

            if (headless)
            {
                // Every log line straight to the console, since there is no
                // pane to put them in. Task output is interleaved with it and
                // labelled, which is the whole of what a headless run can do
                // about several things talking at once.
                session.Log.Appended += entry => Console.WriteLine(entry.ToString());
                session.TaskOutput += (task, line) => Console.WriteLine($"{task,10} | {line}");

                // And the phase whenever it changes. Without this a first-run
                // image pull is several silent minutes here too — the TUI shows
                // a live status line, and a pipe has to be told.
                Narrate(session);

                await session.StartAsync(shutdown.Token).ConfigureAwait(false);
                MachineBridge.Emit(new MachineEvent("ready",
                    Endpoint: $"http://127.0.0.1:{session.Port}", Token: plan.Portal.Token,
                    Proxy: session.BrowserProxyUrl, Project: plan.Project, Session: plan.Session,
                    Instance: plan.InstanceName, Workdir: plan.Workdir, User: session.ContainerUser,
                    Branch: plan.Branch));
                Console.WriteLine("running — interrupt to stop");
                await WaitForShutdownAsync(shutdown.Token).ConfigureAwait(false);
            }
            else
            {
                // The window goes up FIRST and the session comes up behind it,
                // so a first-run image pull narrates itself instead of leaving
                // a blank terminal for two minutes.
                var starting = session.StartInBackgroundAsync(shutdown.Token);

                await LeanHost.RunAsync(session).ConfigureAwait(false);

                // From here on the window is gone and the console is ours again,
                // so everything that used to happen behind it has to say so. The
                // measured cost of quitting is nearly all below this line, and
                // until now none of it printed anything: the screen cleared and
                // the shell prompt came back seconds later, which reads as a
                // program that has hung rather than one that is tidying up.
                Narrate(session);

                Console.WriteLine();
                Console.WriteLine($"envmux: stopping {plan.Session}…");

                // Quitting cancels the startup rather than waiting for it. The
                // window has gone by now, so a session still part-way through a
                // first-run image pull has nobody watching it — and waiting for
                // that pull to finish before exiting is a program that appears
                // not to have quit at all.
                await shutdown.CancelAsync().ConfigureAwait(false);

                try
                {
                    // Only when there is something to wait for, and said out
                    // loud when there is. A quit landing on an image pull waits
                    // for the operation to notice — which is the longest single
                    // thing quitting can do, and was the one part of it that
                    // never explained itself.
                    if (!starting.IsCompleted)
                    {
                        Console.WriteLine("          waiting for startup to unwind…");
                        await starting.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false);
                    }
                }
                catch (Exception e) when (e is TimeoutException or OperationCanceledException)
                {
                    // It did not unwind in time. Teardown below removes what it
                    // managed to create, which is the part that matters.
                    Console.WriteLine("          startup did not stop in ten seconds; taking down what it made");
                }
            }
        }
        finally
        {
            session.StopRequested -= shutdown.Cancel;
            Console.CancelKeyPress -= onCancel;
            AppDomain.CurrentDomain.ProcessExit -= OnProcessExit;
        }

        var status = await session.StopAsync().ConfigureAwait(false);
        if (status is not null)
        {
            MachineBridge.Emit(new MachineEvent("stopped", Branch: status.Branch, Head: status.Head,
                CommitsAhead: status.CommitsAhead, DirtyFiles: status.DirtyFiles));
        }
        Report(plan, status);
        return 0;

        void OnProcessExit(object? sender, EventArgs e) => session.StopAsync().GetAwaiter().GetResult();
    }

    /// <summary>
    /// Say what the session is doing, on the console, as it changes.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The phase is a current state rather than an event — "pulling — 4/17
    /// layers" replaces itself — so this prints only when it actually changes,
    /// and never the empty one, which is the session saying it has nothing to
    /// report.
    /// </para>
    /// <para>
    /// A headless run subscribes before startup and narrates the whole life of
    /// the session. A windowed one subscribes after the window has gone, and so
    /// narrates exactly the part the window could not: teardown.
    /// </para>
    /// </remarks>
    private static void Narrate(Session.Session session)
    {
        var gate = new Lock();
        var last = "";

        session.Changed += () =>
        {
            var phase = session.Phase;

            // Over the comparison and the write together, because Changed is
            // raised from whichever background task moved the session on and two
            // of them arrive at once often enough. Without it a phase is
            // announced twice, or two lines are written through each other.
            lock (gate)
            {
                if (phase.Length == 0 || phase == last)
                {
                    return;
                }

                last = phase;
                Console.WriteLine($"          {phase}…");
            }
        };
    }

    /// <summary>What the person said when told there was no config.</summary>
    private enum ConfigureChoice
    {
        /// <summary>There was one already, or there was nobody to ask.</summary>
        NothingToDo,

        /// <summary>One was written; carry on with it.</summary>
        Written,

        /// <summary>Carry on without one.</summary>
        Skipped,

        Quit,
    }

    /// <summary>
    /// Offer to write a config when there is none, before the session starts.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A session with no <c>.envmux.json</c> is legal and always has been —
    /// the directory name and a default image are enough to produce one. But it
    /// routes nothing and runs nothing, so what you get is a container held open
    /// and a window with two empty panes, which reads as a broken tool rather
    /// than as a tool that was not told anything.
    /// </para>
    /// <para>
    /// Only when someone is there to answer. Piped, redirected, or headless, it
    /// carries on silently — a prompt nobody can see is a hang.
    /// </para>
    /// </remarks>
    private static async Task<ConfigureChoice> OfferToConfigureAsync(string directory, bool headless)
    {
        if (File.Exists(Path.Combine(directory, SessionConfig.FileName)))
        {
            return ConfigureChoice.NothingToDo;
        }

        if (headless || Console.IsInputRedirected || Console.IsOutputRedirected)
        {
            return ConfigureChoice.NothingToDo;
        }

        var command = CommandName.Current;

        Console.WriteLine();
        Console.WriteLine($"There is no {SessionConfig.FileName} here.");
        Console.WriteLine();
        Console.WriteLine("  A session will still start — but with no routes and no tasks, it will");
        Console.WriteLine("  only hold a container open. Declaring them is what makes it useful.");
        Console.WriteLine();
        Console.WriteLine($"  [w]  write one now       {command} init — detects the stack, leaves comments");
        Console.WriteLine($"  [a]  let an agent do it  the prompt, and how to hand it to one");
        Console.WriteLine("  [c]  carry on without one");
        Console.WriteLine("  [q]  quit");
        Console.WriteLine();
        Console.Write("  > ");

        char choice;
        try
        {
            choice = char.ToLowerInvariant(Console.ReadKey(intercept: true).KeyChar);
        }
        catch (InvalidOperationException)
        {
            // No console to read from after all. Carrying on is the behaviour
            // this had before it asked anything.
            Console.WriteLine();
            return ConfigureChoice.NothingToDo;
        }

        Console.WriteLine(choice);
        Console.WriteLine();

        switch (choice)
        {
            case 'w':
                await InitCommand.RunAsync(directory, force: false).ConfigureAwait(false);
                Console.WriteLine();
                return ConfigureChoice.Written;

            case 'a':
                // Not run for them: which agent, and whether it may edit files,
                // is not envmux's call to make on someone's behalf.
                Console.WriteLine("Run one of these, then start a session again:");
                Console.WriteLine();
                Console.Write(AutoconfigureCommand.Invocations(command));
                Console.WriteLine();
                return ConfigureChoice.Quit;

            // Escape quits too: it is what people press at a prompt they
            // were not expecting.
            case 'q' or '\u001b':
                return ConfigureChoice.Quit;

            default:
                return ConfigureChoice.Skipped;
        }
    }

    /// <summary>Block until interrupted, without burning a core doing it.</summary>
    private static async Task WaitForShutdownAsync(CancellationToken ct)
    {
        try
        {
            await Task.Delay(Timeout.Infinite, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // The only way out, and it is the expected one.
        }
    }

    /// <summary>
    /// What the session leaves you with.
    /// </summary>
    /// <remarks>
    /// Printed after the UI is gone, because it is the thing you actually want
    /// off the screen: where the work went, and how to get at it.
    /// </remarks>
    private static void Report(SessionPlan plan, WorkspaceStatus? status)
    {
        if (status is null)
        {
            return;
        }

        Console.WriteLine();
        Console.WriteLine($"{plan.Session} — {status.Branch} at {status.Head}");

        if (status.CommitsAhead > 0)
        {
            // The promise that survived the machine boundary: the commits came
            // back through a bundle and are in this repository, on a branch,
            // reachable with git log.
            Console.WriteLine(
                $"  {status.CommitsAhead} commit(s) ahead of {plan.Base}, fetched into this repository:");
            Console.WriteLine($"    git log {status.Branch}");
        }

        if (!status.IsClean)
        {
            // And the part that did not: uncommitted changes exist only inside
            // the instance, which is why it is kept.
            Console.WriteLine($"  {status.DirtyFiles} uncommitted change(s), still in {plan.InstanceName}:");
            Console.WriteLine($"    {CommandName.Current} {plan.Session}   — to get back to them");
        }

        if (status is { CommitsAhead: 0, IsClean: true })
        {
            Console.WriteLine("  nothing changed");
        }
    }

    /// <summary>
    /// Report what a session would be, without being one.
    /// </summary>
    private static void PrintPlan(SessionPlan plan)
    {
        var port = PortFinder.FirstFree(plan.Port);
        var tools = ToolMounts.Resolve(plan.Tools);

        var host = Host.HostConfig.Load();

        Console.WriteLine($"directory  {plan.Directory}");
        Console.WriteLine($"project    {plan.Project}");
        Console.WriteLine($"session    {plan.Session}");
        Console.WriteLine($"branch     {plan.Branch}  (from {plan.Base}, in this repository)");
        var docker = (plan.Backend ?? Backends.BackendCatalog.Default) == Backends.BackendKind.Docker;
        Console.WriteLine($"instance   {plan.InstanceName}  on {(docker ? "Docker network envmux" : host.Network)}");
        Console.WriteLine($"hostname   {plan.Hostname}  (an address of its own)");
        Console.WriteLine((plan.Backend ?? Backends.BackendCatalog.Default) switch
        {
            Backends.BackendKind.Incus when host.IsProvisioned => $"backend    incus at {host.Api}",
            Backends.BackendKind.Incus => "backend    incus, but none is configured — run `envmux host`",
            _ => "backend    docker, the engine on this machine",
        });
        Console.WriteLine(docker
            ? "image      embedded Docker golden build context, cached by content hash"
            : $"image      {plan.Image}  (or a copy of {Incus.Golden.Source}, when there is one)");
        if (plan.Chef)
        {
            Console.WriteLine("chef       guest dispatch enabled for this repository; maximum three active workers");
        }
        Console.WriteLine($"workdir    {plan.Workdir}  (cloned from a bundle of {plan.Branch})");
        Console.WriteLine($"shell      {plan.Shell}");
        Console.WriteLine(plan.KeepOnExit
            ? "on exit    the instance is kept, so starting this session again picks it up"
            : "on exit    the instance is removed — unless it has uncommitted work in it");

        foreach (var task in plan.Tasks)
        {
            // Listed in the order they will start, which is the whole point of
            // resolving the tree before anything runs.
            var notes = new List<string>();

            if (task.Kind == Config.TaskKind.Once)
            {
                notes.Add("once");
            }

            if (task.DependsOn.Count > 0)
            {
                notes.Add($"after {string.Join(", ", task.DependsOn.Select(d => d.ToString()))}");
            }

            if (task.ReadyPort is { } ready)
            {
                notes.Add($"ready on {ready}");
            }

            if (task.UrlPattern is not null &&
                plan.Routes.FirstOrDefault(r => task.Name.Equals(r.PinnedBy, StringComparison.Ordinal)) is { } pins)
            {
                notes.Add($"prints the URL for route '{pins.Name}'");
            }

            if (!task.Autostart)
            {
                notes.Add("autostart off");
            }

            if (task.Restart != Config.RestartPolicy.Never)
            {
                notes.Add($"restart {task.Restart.ToString().ToLowerInvariant()}");
            }

            var detail = notes.Count > 0 ? $"  ({string.Join("; ", notes)})" : "";
            Console.WriteLine($"task       {task.Name,-12} {task.Display}{detail}");
        }

        // The only port envmux still allocates, and it is the portal's. A route
        // is a port on the instance, and nothing arbitrates those because
        // nothing has to.
        Console.WriteLine(plan.Portal switch
        {
            { Enabled: false } => "portal     off",
            _ when port is null => $"portal     no free port in {plan.Port}",
            { WantsToken: false } =>
                $"portal     {Portal.PortalPlan.Loopback}:{port}  (no token — anything on this machine can reach it)",
            _ => $"portal     {Portal.PortalPlan.Loopback}:{port}  (token minted per session)",
        });

        var socks = plan.Browser.Enabled ? Routing.PortFinder.FirstFree(plan.Browser.Port) : null;
        var egress = plan.Browser.Egress == Socks.Egress.Local ? "the rest from here" : "the rest from the instance too";

        Console.WriteLine(plan.Browser switch
        {
            { Enabled: false } => "browser    off",
            _ when socks is null => $"browser    no free port in {plan.Browser.Port}",
            _ => $"browser    socks5 on {Portal.PortalPlan.Loopback}:{socks}  (localhost is the instance; {egress})",
        });

        foreach (var service in plan.Services)
        {
            var persist = service.Persist ? ", kept between sessions" : "";
            Console.WriteLine(
                $"service    {service.Name,-10} {service.Image}  →  {service.Host}:{service.Port}{persist}");
        }

        foreach (var tool in tools)
        {
            Console.WriteLine($"tool       {tool.Name}  {tool.HostPath} → ~/{tool.ContainerRelativePath}");
        }

        // Secrets are shown, because --dry-run is where you check that the
        // password the database got is the password the session will read. They
        // are generated per run and never written down, so nothing here outlives
        // the command.
        foreach (var (key, value) in plan.Env.OrderBy(e => e.Key, StringComparer.Ordinal))
        {
            Console.WriteLine($"env        {key}={value}");
        }

        if (plan.Routes.Count == 0)
        {
            Console.WriteLine("routes     none declared");
            return;
        }

        Console.WriteLine();
        foreach (var route in plan.Routes)
        {
            Console.WriteLine($"  {route.Name,-12} {route.Port,5}  {route.Url}");
        }
    }
}

/// <summary>The version, so it is stated in exactly one place.</summary>
/// <remarks>
/// The informational version first, because that is the only one that survives
/// intact: a canary is stamped <c>2026.08.16.0025</c>, and the assembly version
/// it is parsed into remembers that as <c>2026.8.16.25</c> — the same build, in
/// a spelling nobody can match against a release.
/// </remarks>
internal static class ThisAssembly
{
    public static string Version
    {
        get
        {
            var assembly = typeof(Program).Assembly;
            var informational = assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;

            return Clean(informational)
                ?? assembly.GetName().Version?.ToString(3)
                ?? "0.0.0";
        }
    }

    /// <summary>
    /// The version as it was written down, or null if there is nothing there.
    /// </summary>
    /// <remarks>
    /// The build appends <c>+&lt;commit&gt;</c> to the informational version
    /// when the repository is one it can read, and that belongs in the release
    /// notes rather than in the answer to <c>--version</c>.
    /// </remarks>
    internal static string? Clean(string? informational)
    {
        if (string.IsNullOrWhiteSpace(informational))
        {
            return null;
        }

        var version = informational.Trim();
        var plus = version.IndexOf('+', StringComparison.Ordinal);
        version = plus < 0 ? version : version[..plus];

        return version.Length > 0 ? version : null;
    }
}
