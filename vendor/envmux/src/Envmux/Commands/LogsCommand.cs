using Envmux.Backends;
using System.Text;

using Envmux.Config;
using Envmux.Host;
using Envmux.Incus;
using Envmux.Session;

namespace Envmux.Commands;

/// <summary>
/// What a task said, read out of the instance rather than out of a process.
/// </summary>
/// <remarks>
/// <para>
/// This is what latching a task buys, made reachable. A task is started detached
/// inside a multiplexer session and tees its output to a file, so the output
/// exists whether or not envmux was watching — a build that ran overnight with
/// nothing attached to it wrote every line, and this reads them.
/// </para>
/// <para>
/// It needs no session running. The instance is kept when a session ends, the
/// file is in it, and the files API is how it comes back.
/// </para>
/// <para>
/// It is what replaces Incus' <c>record-output</c>, which this design
/// deliberately does not use, and it differs in one way worth knowing: these
/// files do not expire on their own. Retention belongs to envmux, which is the
/// right place for it — envmux is what knows when a session ended.
/// </para>
/// </remarks>
internal static class LogsCommand
{
    public static async Task<int> RunAsync(
        string directory,
        string? session,
        string? task,
        bool follow,
        BackendKind? requested = null,
        CancellationToken ct = default)
    {
        var host = HostConfig.Load();

        var plan = SessionPlan.Resolve(SessionConfig.Load(directory), directory, session ?? "unnamed");

        await using var backend = BackendCatalog.Open(requested ?? SessionPlan.Resolve(
            SessionConfig.Load(directory), directory, "unnamed").Backend, host);

        List<Instance> ours;

        try
        {
            ours =
            [
                .. (await backend.Instances.ListAsync(ct).ConfigureAwait(false))
                    .Where(InstanceSpec.IsOurs)
                    .Where(i => InstanceSpec.Label(i, InstanceSpec.Keys.Service).Length == 0)
                    .Where(i => PhysicalPath.Same(
                        InstanceSpec.Label(i, InstanceSpec.Keys.Directory), plan.Directory))
                    .OrderBy(i => i.Name, StringComparer.Ordinal),
            ];
        }
        catch (BackendException e)
        {
            Console.Error.WriteLine($"envmux: {e.Message}");
            return 1;
        }

        var chosen = session is null
            ? ours
            : ours.Where(i => InstanceSpec.Label(i, InstanceSpec.Keys.Session) == plan.Session).ToList();

        if (chosen.Count == 0)
        {
            Console.Error.WriteLine(session is null
                ? $"envmux: no session of this repository has an instance on {backend.Name}"
                : $"envmux: there is no instance for a session called '{plan.Session}'");

            foreach (var instance in ours)
            {
                Console.Error.WriteLine(
                    $"          {CommandName.Current} logs {InstanceSpec.Label(instance, InstanceSpec.Keys.Session)}");
            }

            return 1;
        }

        if (chosen.Count > 1)
        {
            Console.Error.WriteLine($"envmux: {chosen.Count} sessions here. Name the one you want:");

            foreach (var instance in chosen)
            {
                Console.Error.WriteLine(
                    $"          {CommandName.Current} logs {InstanceSpec.Label(instance, InstanceSpec.Keys.Session)}");
            }

            return 2;
        }

        var target = chosen[0];
        var wanted = InstanceSpec.Label(target, InstanceSpec.Keys.Session);

        // A stopped instance has the files but cannot be read from, and starting
        // one to read a log is a surprise nobody asked for. Said rather than done.
        if (!target.IsRunning)
        {
            Console.Error.WriteLine(
                $"envmux: {target.Name} is {target.Status.ToLowerInvariant()}. " +
                $"Start the session again — `{CommandName.Current} {wanted}` — and its logs come with it.");

            return 1;
        }

        if (task is null)
        {
            return await ListAsync(backend.Exec, target.Name, plan, wanted, ct).ConfigureAwait(false);
        }

        var latch = Latch.Id(plan.Project, wanted, task);
        var path = Latch.LogPath(latch);

        if (follow)
        {
            var result = await Command.RunAsync(
                backend.Exec, target.Name, ["tail", "-n", "+1", "-F", path], null, null, null,
                Console.WriteLine, ct).ConfigureAwait(false);

            return result.ExitCode;
        }

        if (await backend.Files.PullAsync(target.Name, path, ct).ConfigureAwait(false) is not { } bytes)
        {
            Console.Error.WriteLine($"envmux: there is no log at {path} — has '{task}' run?");
            return 1;
        }

        // Straight to stdout, unmodified, so it can be piped into anything.
        await using var output = Console.OpenStandardOutput();
        await output.WriteAsync(bytes, ct).ConfigureAwait(false);
        return 0;
    }

    /// <summary>
    /// What is latchable in there, which is not quite the same as what was declared.
    /// </summary>
    /// <remarks>
    /// The multiplexer is asked rather than the config, because the two can
    /// differ in both directions: a task removed from the file may still be
    /// running, and a session somebody opened by hand is latched too.
    /// </remarks>
    private static async Task<int> ListAsync(
        IExec exec,
        string instance,
        SessionPlan plan,
        string session,
        CancellationToken ct)
    {
        // As the session's account, because a tmux socket belongs to whoever
        // started it. Listed as root this asks about root's tmux, which has
        // never been started — `error connecting to /tmp/tmux-0/default` — so it
        // answered "latched: nothing" for a session with tasks visibly running
        // in it.
        var user = (await Session.HostUser.DetectAsync(ct).ConfigureAwait(false)).Name;

        var listed = await Command.CaptureAsync(exec, instance, Latch.List(), user, ct: ct)
            .ConfigureAwait(false);
        var latched = Latch.Parse(listed.Text);

        var lines = new StringBuilder();
        lines.AppendLine($"{instance} — latched:");

        foreach (var name in latched)
        {
            lines.AppendLine($"  {name}");
        }

        if (latched.Count == 0)
        {
            lines.AppendLine("  nothing");
        }

        lines.AppendLine();
        lines.AppendLine("declared:");

        foreach (var declared in plan.Tasks)
        {
            var latch = Latch.Id(plan.Project, session, declared.Name);
            var running = latched.Contains(latch, StringComparer.Ordinal) ? "running" : "";

            lines.AppendLine($"  {declared.Name,-16} {running,-8} {CommandName.Current} logs {session} {declared.Name}");
        }

        Console.Write(lines.ToString());
        return 0;
    }
}
