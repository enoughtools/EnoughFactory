using System.Text.RegularExpressions;

using Envmux.Config;

namespace Envmux.Session;

/// <summary>
/// One task, with every default applied — what will actually be exec'd.
/// </summary>
/// <remarks>
/// A service is a machine of its own; a task is a process in the one you work
/// in. So a task already has the repository, the environment the session was
/// given, and the loopback everything else in that instance is bound to.
/// </remarks>
internal sealed record TaskPlan
{
    /// <summary>Its key in <c>tasks</c>, slugged.</summary>
    public required string Name { get; init; }

    /// <summary>Whether it is expected to finish.</summary>
    public required TaskKind Kind { get; init; }

    /// <summary>What has to be up before it starts.</summary>
    public required IReadOnlyList<TaskDependency> DependsOn { get; init; }

    /// <summary>
    /// The port that, once it accepts, means this task is up.
    /// </summary>
    /// <remarks>
    /// On the instance's own loopback, which is where a dev server binds and
    /// where only something inside that instance can see it.
    /// </remarks>
    public required int? ReadyPort { get; init; }

    /// <summary>
    /// The pattern that finds this task's URL in its output, compiled. Null
    /// for a task whose route is just its port.
    /// </summary>
    /// <remarks>
    /// Compiled once here rather than per line, and here rather than in the
    /// task, because a pattern that does not parse is a fact about the
    /// declaration — <c>config validate</c> should say so, and it never
    /// constructs a task.
    /// </remarks>
    public required Regex? UrlPattern { get; init; }

    /// <summary>The argument list the latch runs.</summary>
    public required IReadOnlyList<string> Command { get; init; }

    /// <summary>What to show for it, which is what was written rather than what it became.</summary>
    public required string Display { get; init; }

    public required string Workdir { get; init; }

    public required IReadOnlyDictionary<string, string> Env { get; init; }

    public required bool Autostart { get; init; }

    public required RestartPolicy Restart { get; init; }

    /// <summary>
    /// Whether envmux declared it rather than the config.
    /// </summary>
    /// <remarks>
    /// Two do: the remote agent's own task, and the client that carries the
    /// room (<see cref="Agents.RoomClient"/>). Both run in the instance, have
    /// output worth watching, and can be restarted, so they are tasks rather
    /// than special cases — marked <c>*</c> in the list so nobody goes looking
    /// for them in <c>.envmux.json</c>.
    /// </remarks>
    public required bool IsInternal { get; init; }

    /// <summary>The shell a task written as a string is given to.</summary>
    /// <remarks>
    /// A login shell, so that whatever a project's profile puts on <c>PATH</c> —
    /// nvm, rbenv, mise, a devcontainer's own setup — is there. A task that
    /// cannot find <c>npm</c> because it ran in a non-login shell is a confusing
    /// half hour.
    /// </remarks>
    public static readonly string[] Shell = ["sh", "-lc"];

    public static TaskPlan Resolve(
        string name,
        TaskConfig config,
        string sessionWorkdir,
        IReadOnlyList<ServicePlan> services)
    {
        var slug = Slug.From(name);

        if (config.Command is not { IsEmpty: false } command)
        {
            throw new ConfigException($"task '{name}' does not say what to run");
        }

        var env = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, value) in config.Env ?? [])
        {
            env[key] = value;
        }

        // The marker every task carries. It used to be load-bearing — the only
        // way to find a task's processes again for signalling — and is now just
        // the answer to "what started this?" from a shell inside the instance.
        env[EnvKeys.Task] = slug;

        var kind = config.Kind ?? TaskKind.Ongoing;

        if (kind == TaskKind.Once && config.Ready is not null)
        {
            throw new ConfigException(
                $"task '{name}' is 'once' and has a 'ready' port — a task that finishes is ready when it has finished");
        }

        return new TaskPlan
        {
            Name = slug,
            Kind = kind,
            DependsOn = [.. (config.DependsOn ?? []).Select(d => Depend(name, d, services))],
            ReadyPort = config.Ready,
            UrlPattern = CompileUrl(name, config.Url),
            Command = command.IsShell ? [.. Shell, command.Arguments[0]] : command.Arguments,
            Display = command.ToString(),
            Workdir = string.IsNullOrWhiteSpace(config.Workdir) ? sessionWorkdir : config.Workdir.Trim(),
            Env = env,
            Autostart = config.Autostart ?? true,
            Restart = config.Restart ?? RestartPolicy.Never,
            IsInternal = false,
        };
    }

    /// <summary>
    /// How long one line of output is given to match a <c>url</c> pattern.
    /// </summary>
    /// <remarks>
    /// The pattern is the person's and the lines are whatever the build
    /// prints, so this is a person's regular expression run against a stack
    /// trace. Generous for a line, and a bound on what a bad one can cost.
    /// </remarks>
    private static readonly TimeSpan UrlMatchTimeout = TimeSpan.FromMilliseconds(250);

    /// <exception cref="ConfigException">The pattern is not a regular expression.</exception>
    private static Regex? CompileUrl(string task, string? pattern)
    {
        if (string.IsNullOrWhiteSpace(pattern))
        {
            return null;
        }

        try
        {
            return new Regex(pattern, RegexOptions.CultureInvariant, UrlMatchTimeout);
        }
        catch (ArgumentException e)
        {
            // RegexParseException is one of these, and its message names the
            // character — which is the whole of what is useful.
            throw new ConfigException(
                $"task '{task}' has a 'url' that is not a regular expression: {e.Message}", e);
        }
    }

    /// <summary>
    /// Turn one <c>dependsOn</c> name into something that can be waited on.
    /// </summary>
    /// <remarks>
    /// A service is resolved here, at plan time, into the endpoint that answers
    /// for it — because that is the only test of a service being up that means
    /// anything. An instance being "running" is minutes away from a Postgres in
    /// it accepting a connection.
    /// </remarks>
    private static TaskDependency Depend(string task, string name, IReadOnlyList<ServicePlan> services)
    {
        var wanted = Slug.From(name);

        if (services.FirstOrDefault(s => Slug.From(s.Name).Equals(wanted, StringComparison.Ordinal)) is { } service)
        {
            return new TaskDependency(wanted, IsService: true, service.Host, service.Port);
        }

        // Not a service, so it has to be a task. Whether it is one is checked by
        // TaskGraph, which is the only thing that can see all of them.
        return new TaskDependency(wanted, IsService: false, null, 0);
    }

    /// <summary>
    /// A task envmux runs on its own account.
    /// </summary>
    public static TaskPlan Internal(string name, IReadOnlyList<string> command, string display) =>
        new()
        {
            Name = name,
            Kind = TaskKind.Ongoing,
            DependsOn = [],
            ReadyPort = null,
            UrlPattern = null,
            Command = command,
            Display = display,
            Workdir = "/",
            Env = new Dictionary<string, string>(StringComparer.Ordinal) { [EnvKeys.Task] = name },
            Autostart = true,
            Restart = RestartPolicy.Never,
            IsInternal = true,
        };
}

/// <summary>Something a task waits for before it starts.</summary>
/// <param name="Name">The task or service it named.</param>
/// <param name="IsService">Whether it is a service, which is waited on by connecting to it.</param>
/// <param name="Host">The service's own name in the zone. Null for a task.</param>
/// <param name="Port">The service's port. Zero for a task.</param>
internal sealed record TaskDependency(string Name, bool IsService, string? Host, int Port)
{
    public override string ToString() => IsService ? $"{Name} ({Host}:{Port})" : Name;
}

/// <summary>
/// The dependency tree between tasks, checked before anything runs.
/// </summary>
/// <remarks>
/// Pure, and checked at config time rather than discovered at runtime. A cycle
/// or a misspelled name would otherwise present as tasks that simply never
/// start, with nothing on screen saying why.
/// </remarks>
internal static class TaskGraph
{
    /// <summary>
    /// Check every dependency and return the tasks in an order that satisfies them.
    /// </summary>
    /// <exception cref="ConfigException">
    /// A name that is not a task or a service, a cycle, or a task that could
    /// never start because what it waits for is never started.
    /// </exception>
    public static IReadOnlyList<TaskPlan> Order(IReadOnlyList<TaskPlan> tasks)
    {
        var byName = tasks.ToDictionary(t => t.Name, StringComparer.Ordinal);

        foreach (var task in tasks)
        {
            foreach (var dependency in task.DependsOn.Where(d => !d.IsService))
            {
                if (!byName.TryGetValue(dependency.Name, out var on))
                {
                    throw new ConfigException(
                        $"task '{task.Name}' depends on '{dependency.Name}', which is not a task or a service here. " +
                        $"There is: {string.Join(", ", tasks.Select(t => t.Name))}");
                }

                if (task.Autostart && !on.Autostart)
                {
                    throw new ConfigException(
                        $"task '{task.Name}' starts on its own but depends on '{on.Name}', which does not — " +
                        $"so it would wait forever. Give '{on.Name}' autostart, or take it off '{task.Name}'.");
                }
            }
        }

        var ordered = new List<TaskPlan>(tasks.Count);
        var done = new HashSet<string>(StringComparer.Ordinal);
        var onPath = new List<string>();

        foreach (var task in tasks)
        {
            Visit(task);
        }

        return ordered;

        void Visit(TaskPlan task)
        {
            if (done.Contains(task.Name))
            {
                return;
            }

            if (onPath.Contains(task.Name, StringComparer.Ordinal))
            {
                var cycle = onPath.SkipWhile(n => !n.Equals(task.Name, StringComparison.Ordinal)).Append(task.Name);
                throw new ConfigException($"tasks depend on each other in a circle: {string.Join(" → ", cycle)}");
            }

            onPath.Add(task.Name);

            foreach (var dependency in task.DependsOn.Where(d => !d.IsService))
            {
                Visit(byName[dependency.Name]);
            }

            onPath.RemoveAt(onPath.Count - 1);
            done.Add(task.Name);
            ordered.Add(task);
        }
    }
}

/// <summary>
/// The variables envmux puts in every task's environment.
/// </summary>
/// <remarks>
/// One, now. It used to be how a task's processes were found again for
/// signalling — every process carried the marker and stopping a task meant
/// walking <c>/proc</c> looking for it — and that is no longer needed, because
/// a task is a named multiplexer session and killing it by name reaches
/// everything in it. It is kept because it is the answer to "what started
/// this?" from inside the instance, which is a question people ask.
/// </remarks>
internal static class EnvKeys
{
    public const string Task = "ENVMUX_TASK";
}
