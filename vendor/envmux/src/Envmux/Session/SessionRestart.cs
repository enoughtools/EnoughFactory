using Envmux.Backends;
using Envmux.Config;
using Envmux.Incus;

namespace Envmux.Session;

/// <summary>Reload tasks while keeping the authenticated endpoint and retained source instance.</summary>
internal static class SessionRestart
{
    public static SessionPlan Resolve(SessionPlan current, SessionConfig config)
    {
        var next = SessionPlan.Resolve(config, current.Directory, current.Session);
        if (next.Portal.Enabled != current.Portal.Enabled || next.Portal.WantsToken != current.Portal.WantsToken)
        {
            throw new SessionException("portal authentication changes require stopping this session and starting it again; the current endpoint is unchanged");
        }

        if (!string.Equals(next.InstanceName, current.InstanceName, StringComparison.Ordinal) ||
            !string.Equals(next.Branch, current.Branch, StringComparison.Ordinal) ||
            !string.Equals(next.Workdir, current.Workdir, StringComparison.Ordinal))
        {
            throw new SessionException("the session name, branch or work directory changed; stop this session and start a new one to preserve its retained work");
        }

        // The listener follows Plan on every request. Re-resolving its tokens
        // would invalidate the supervisor and existing browser cookies.
        return next with
        {
            ManagedGoldenImage = current.ManagedGoldenImage,
            Portal = next.Portal with { Token = current.Portal.Token, RoomToken = current.Portal.RoomToken },
        };
    }

    public static async Task<string> EnsureInstanceAsync(IBackend backend, SessionPlan plan, Instance retained, CancellationToken ct = default)
    {
        var instance = await backend.Instances.GetAsync(plan.InstanceName, ct).ConfigureAwait(false)
            ?? throw new SessionException("the retained session instance is missing; inspect its saved work before starting a replacement");
        RequireRetained(instance, retained, plan);

        if (!instance.IsRunning)
        {
            // Docker accepts its immutable ID as well as the name. A name
            // reused between inspect and start must never start a replacement.
            await backend.Instances.StartAsync(instance.BackendId ?? instance.Name, ct).ConfigureAwait(false);
        }

        var address = await backend.Instances.AwaitAddressAsync(plan.InstanceName, TimeSpan.FromSeconds(60), ct).ConfigureAwait(false)
            ?? throw new SessionException("the retained session instance did not become ready; its work is kept for recovery");
        var ready = await backend.Instances.GetAsync(plan.InstanceName, ct).ConfigureAwait(false)
            ?? throw new SessionException("the retained session instance disappeared while restarting; its state is unknown");
        RequireRetained(ready, retained, plan);
        if (!ready.IsRunning)
        {
            throw new SessionException("the retained session instance stopped during restart; inspect it before retrying");
        }

        return address;
    }

    private static void RequireRetained(Instance actual, Instance retained, SessionPlan plan)
    {
        var directory = InstanceSpec.Label(actual, InstanceSpec.Keys.Directory);
        var created = InstanceSpec.Label(actual, InstanceSpec.Keys.Created);
        if (!InstanceSpec.IsOurs(actual) || InstanceSpec.IsImage(actual) ||
            !string.Equals(actual.BackendId, retained.BackendId, StringComparison.Ordinal) ||
            !string.Equals(actual.Name, plan.InstanceName, StringComparison.Ordinal) ||
            !string.Equals(InstanceSpec.Label(actual, InstanceSpec.Keys.Project), plan.Project, StringComparison.Ordinal) ||
            !string.Equals(InstanceSpec.Label(actual, InstanceSpec.Keys.Session), plan.Session, StringComparison.Ordinal) ||
            !string.Equals(InstanceSpec.Label(actual, InstanceSpec.Keys.Branch), plan.Branch, StringComparison.Ordinal) ||
            created.Length == 0 || !string.Equals(created, InstanceSpec.Label(retained, InstanceSpec.Keys.Created), StringComparison.Ordinal) ||
            directory.Length == 0 || !PhysicalPath.Same(directory, plan.Directory) ||
            InstanceSpec.Label(actual, InstanceSpec.Keys.Service).Length != 0)
        {
            throw new SessionException("the retained session instance identity changed; no replacement was started and the saved work is retained");
        }
    }
}
