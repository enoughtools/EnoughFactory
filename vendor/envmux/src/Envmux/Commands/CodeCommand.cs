using Envmux.Backends;
using Envmux.Config;
using Envmux.Editor;
using Envmux.Host;
using Envmux.Incus;
using Envmux.Session;

namespace Envmux.Commands;

/// <summary>
/// Attach an editor to a session that is already running here.
/// </summary>
/// <remarks>
/// <para>
/// The same thing the <c>e</c> key does, from another terminal. Sessions are
/// long-lived and the window is not the only way to reach one — somebody who
/// started a session this morning and wants an editor on it this afternoon
/// should not have to go and find that window.
/// </para>
/// <para>
/// It needs nothing from the session process. The link is derived from the
/// instance's name, which is derived from the project and the session name, so
/// this and the running session agree without talking to each other.
/// </para>
/// </remarks>
internal static class CodeCommand
{
    public static async Task<int> RunAsync(string directory, string? session, bool print, BackendKind? requested = null)
    {
        var plan = SessionPlan.Resolve(SessionConfig.Load(directory), directory, session ?? "unnamed");
        var host = HostConfig.Load();

        await using var backend = BackendCatalog.Open(requested ?? SessionPlan.Resolve(
            SessionConfig.Load(directory), directory, "unnamed").Backend, host);

        List<Instance> running;

        try
        {
            running =
            [
                .. (await backend.Instances.ListAsync().ConfigureAwait(false))
                    .Where(i => i.IsRunning && InstanceSpec.IsOurs(i))
                    .Where(i => InstanceSpec.Label(i, InstanceSpec.Keys.Service).Length == 0)
                    .Where(i => PhysicalPath.Same(
                        InstanceSpec.Label(i, InstanceSpec.Keys.Directory), plan.Directory)),
            ];
        }
        catch (BackendException e)
        {
            Console.Error.WriteLine($"envmux: {e.Message}");
            return 1;
        }

        if (running.Count == 0)
        {
            Console.Error.WriteLine($"envmux: no session running in {plan.Directory}");
            Console.Error.WriteLine($"        start one with `{CommandName.Current}`");
            return 1;
        }

        var chosen = session is null
            ? running
            : running.Where(i => InstanceSpec.Label(i, InstanceSpec.Keys.Session) == plan.Session).ToList();

        if (chosen.Count == 0)
        {
            Console.Error.WriteLine($"envmux: no session called '{plan.Session}' is running here");
            Report(running);
            return 1;
        }

        if (chosen.Count > 1)
        {
            // Picking one would be picking somebody's afternoon for them.
            Console.Error.WriteLine($"envmux: {chosen.Count} sessions are running here. Name the one you want:");
            Report(chosen);
            return 2;
        }

        var instance = chosen[0];
        var hostname = $"{instance.Name}.{plan.Domain}";

        // The session-named link the bootstrap made, not the workdir — the same
        // resolution the running session does, so this command and the `e` key
        // hand out the same link. Derived from the plan alone, like everything
        // else here: nothing is asked of the instance to know where to open.
        var folder = plan.EditorFolder;

        string uri;
        Docker.DockerLease? lease = null;

        if (plan.Editor.IsDevContainer)
        {
            // Attach to the instance as a running container (§8.3), through the
            // Docker endpoint. The URI carries the endpoint's address, so VS Code
            // reaches it with nothing set in settings.json. No SSH user lookup —
            // the extension execs as the container's own user.
            uri = Editor.DockerUri.AttachedContainerUri(instance.Name, folder, backend.Kind == BackendKind.Docker ? null : Docker.ShimEndpoint.DockerHost);

            if (!print && backend.Kind == BackendKind.Incus)
            {
                // Bring the endpoint up if nothing is serving it, and hold a
                // lease. This is a short-lived command, so the lease lingers
                // rather than being released on exit — long enough for VS Code
                // to connect and hold the endpoint open itself.
                try
                {
                    lease = await Docker.DockerEndpoint.EnsureAsync(
                        line => Console.Error.WriteLine($"envmux: {line}")).ConfigureAwait(false);
                }
                catch (Docker.ShimException e)
                {
                    Console.Error.WriteLine($"envmux: {e.Message}");
                }
            }
        }
        else
        {
            // Whoever the session bootstrapped, which is the account the
            // repository in it belongs to. Asked rather than assumed: the host
            // username can differ from the one that ended up inside.
            var user = await UserAsync(backend.Exec, instance.Name).ConfigureAwait(false);
            uri = VsCodeUri.SshFolderUri(user, hostname, folder);
        }

        if (print)
        {
            // Just the link, so it can be piped or pasted. Everything else this
            // command says goes to stderr for exactly this reason.
            Console.WriteLine(uri);
            return 0;
        }

        var editor = EditorDiscovery.Find(plan.Editor.Path);

        if (editor.Hint is { } hint)
        {
            Console.Error.WriteLine($"envmux: {hint}");
        }

        var finished = new TaskCompletionSource();

        EditorLaunch.Start(
            new LaunchPlan(editor.Path, uri, plan.Editor.NewWindow ?? false, null),
            warning =>
            {
                Console.Error.WriteLine($"envmux: {warning}");
                finished.TrySetResult();
            });

        Console.WriteLine(plan.Editor.IsDevContainer
            ? $"opened {Path.GetFileName(editor.Path)} on {instance.Name} (dev container)"
            : $"opened {Path.GetFileName(editor.Path)} on {hostname}");

        // Long enough to hear about an editor that refused, short enough that a
        // successful hand-off is not something you wait for.
        await Task.WhenAny(finished.Task, Task.Delay(TimeSpan.FromSeconds(2))).ConfigureAwait(false);

        // Hand the lease off rather than releasing it: this command is leaving,
        // but VS Code is only just connecting. The lingering lease keeps the
        // endpoint up until the editor holds a connection of its own.
        if (lease is not null)
        {
            lease.Linger();
            await lease.DisposeAsync().ConfigureAwait(false);
        }

        return 0;
    }

    /// <summary>Who owns the workspace inside an instance, or a sensible guess.</summary>
    private static async Task<string> UserAsync(IExec exec, string instance)
    {
        try
        {
            var result = await Command.ShellAsync(
                exec,
                instance,
                $"stat -c %U {Session.Workspace.Quote(SessionConfig.DefaultWorkdir)} 2>/dev/null || true")
                .ConfigureAwait(false);

            var owner = result.Text.Trim();

            return owner.Length > 0 && owner != "root" ? owner : HostUser.FallbackName;
        }
        catch (BackendException)
        {
            return HostUser.FallbackName;
        }
    }

    private static void Report(IReadOnlyList<Instance> instances)
    {
        foreach (var instance in instances)
        {
            Console.Error.WriteLine(
                $"          {CommandName.Current} code {InstanceSpec.Label(instance, InstanceSpec.Keys.Session)}");
        }
    }
}
