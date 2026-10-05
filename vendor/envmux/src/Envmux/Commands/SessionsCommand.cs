using System.Text.Json;

using Envmux.Backends;
using Envmux.Config;
using Envmux.Host;
using Envmux.Incus;

namespace Envmux.Commands;

/// <summary>List retained session instances without starting or pruning them.</summary>
internal static class SessionsCommand
{
    public static async Task<int> RunAsync(string directory, BackendKind? requested)
    {
        await using var backend = BackendCatalog.Open(requested, HostConfig.Load());
        var here = PhysicalPath.Of(directory);
        var sessions = (await backend.Instances.ListAsync().ConfigureAwait(false))
            .Where(InstanceSpec.IsOurs)
            .Where(i => !InstanceSpec.IsImage(i))
            .Where(i => InstanceSpec.Label(i, InstanceSpec.Keys.Service).Length == 0)
            .Where(i => InstanceSpec.Label(i, InstanceSpec.Keys.Directory).Length > 0)
            .Where(i => PhysicalPath.Same(InstanceSpec.Label(i, InstanceSpec.Keys.Directory), here))
            .Select(i => new DiscoveredSession(
                InstanceSpec.Label(i, InstanceSpec.Keys.Project),
                InstanceSpec.Label(i, InstanceSpec.Keys.Session),
                InstanceSpec.Label(i, InstanceSpec.Keys.Directory),
                InstanceSpec.Label(i, InstanceSpec.Keys.Branch),
                i.Name, i.IsRunning))
            .OrderBy(i => i.Session, StringComparer.Ordinal)
            .ToList();
        Console.WriteLine(JsonSerializer.Serialize(sessions, MachineJsonContext.Default.ListDiscoveredSession));
        return 0;
    }
}

/// <summary>Persistent metadata read from the backend's existing labels.</summary>
internal sealed record DiscoveredSession(string Project, string Session, string Directory,
    string Branch, string Instance, bool Running);
