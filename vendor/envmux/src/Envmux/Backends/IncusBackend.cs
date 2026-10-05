using System.Net;

using Envmux.Host;
using Envmux.Incus;
using Envmux.Session;

namespace Envmux.Backends;

/// <summary>
/// An Incus daemon: the VM envmux built under Hyper-V, or one it attached to.
/// </summary>
/// <remarks>
/// A thin wrapper, because everything here already existed: <see cref="IncusApi"/>
/// for the calls, <see cref="ExecSession"/> for terminals, <see cref="Command"/>
/// for captured runs, <see cref="Socks.InstanceRelay"/> for connections. What
/// only Incus has — the golden snapshot, project snapshots, the proxy device —
/// lives here and nowhere above the seam.
/// </remarks>
internal sealed class IncusBackend : IBackend
{
    private readonly IncusClient? _owned;
    private bool _disposed;

    public IncusBackend(IncusApi api, HostConfig host, IncusClient? owned = null)
    {
        Api = api;
        Host = host;
        _owned = owned;

        Instances = new IncusInstances(api);
        Exec = new IncusExec(api);
        Files = new IncusFiles(api);
        Images = new IncusImages(api, host);
    }

    /// <summary>Connect to the daemon <c>host.json</c> names.</summary>
    public static IncusBackend Connect(HostConfig host)
    {
        var client = IncusClient.Connect(host);
        return new IncusBackend(new IncusApi(client), host, client);
    }

    public string Name => Host.Api;

    public BackendKind Kind => BackendKind.Incus;

    /// <summary>The API, for what is Incus' alone: the Docker shim, prune, logs.</summary>
    public IncusApi Api { get; }

    public HostConfig Host { get; }

    public IInstances Instances { get; }

    public IExec Exec { get; }

    public IFiles Files { get; }

    public IImages Images { get; }

    public IPAddress? BridgeAddress => Portal.ApiBridge.FacingAddress(Host.Api);

    /// <remarks>
    /// No pinned address. Pinning kept an instance's name in the zone stable
    /// for this machine's resolver; with no zone there is nothing to keep
    /// stable, and a lease is simpler.
    /// </remarks>
    public InstancesPost SessionSpec(SessionPlan plan, ImageChoice image) =>
        InstanceSpec.ForSession(plan, Host, image.Golden, DateTimeOffset.UtcNow, address: null, copyFrom: image.Source);

    public InstancesPost ServiceSpec(ServicePlan service, SessionPlan plan) =>
        InstanceSpec.ForService(service, plan, Host, DateTimeOffset.UtcNow, address: null);

    public async Task PreflightAsync(CancellationToken ct = default)
    {
        if (!Host.IsProvisioned)
        {
            throw new BackendException(
                $"there is no Incus host configured yet. `{Commands.CommandName.Current} host` lists the steps " +
                $"that build one, or `--backend docker` runs on this machine's Docker instead.");
        }

        ServerInfo server;

        try
        {
            server = await Api.ServerAsync(ct).ConfigureAwait(false);
        }
        catch (IncusException e)
        {
            throw new BackendException($"the host at {Host.Api} is not answering: {e.Message}", e);
        }

        if (!server.IsTrusted)
        {
            throw new BackendException(
                "the host answered, and does not trust this client. The seeded certificate is not the one " +
                $"being sent — `{Commands.CommandName.Current} host status` says more.");
        }

        if (await Api.NetworkAsync(Host.Network, ct).ConfigureAwait(false) is null)
        {
            throw new BackendException(Session.Session.MissingNetwork(Host));
        }
    }

    public async Task<bool> TryWireLoopbackAsync(
        string instance,
        string name,
        int insidePort,
        IPEndPoint connectTo,
        CancellationToken ct = default)
    {
        await Api.SetDeviceAsync(instance, name, Portal.ApiBridge.Device(connectTo), ct).ConfigureAwait(false);
        return true;
    }

    public ValueTask DisposeAsync()
    {
        if (!_disposed)
        {
            _disposed = true;
            _owned?.Dispose();
        }

        return ValueTask.CompletedTask;
    }

    private sealed class IncusInstances(IncusApi api) : IInstances
    {
        public Task<IReadOnlyList<Instance>> ListAsync(CancellationToken ct = default) => api.InstancesAsync(ct);

        public Task<Instance?> GetAsync(string name, CancellationToken ct = default) => api.InstanceAsync(name, ct);

        public Task CreateAsync(InstancesPost spec, Action<string>? report = null, CancellationToken ct = default) =>
            api.CreateAsync(spec, report, ct);

        public Task StartAsync(string name, CancellationToken ct = default) => api.StartAsync(name, ct);

        public Task StopAsync(string name, int timeoutSeconds = 10, CancellationToken ct = default) =>
            api.StopAsync(name, timeoutSeconds, ct);

        public Task<bool> DeleteAsync(string name, CancellationToken ct = default) => api.DeleteAsync(name, ct);

        public Task<string?> AwaitAddressAsync(string name, TimeSpan timeout, CancellationToken ct = default) =>
            api.AwaitAddressAsync(name, timeout, ct);

        /// <remarks>
        /// <para>
        /// As <c>environment.*</c> keys, which Incus hands every exec.
        /// </para>
        /// <para>
        /// A PATCH merges, where the profile is rewritten whole — so a key envmux
        /// set before and no longer would is removed explicitly, or removing a
        /// service from the config leaves its address on the instance forever
        /// and a bare exec keeps seeing a DB_HOST for a database that is gone. A
        /// null removes the key outright; measured, because setting it empty
        /// would leave <c>-h ""</c>, which is its own bug.
        /// </para>
        /// </remarks>
        public async Task SetEnvironmentAsync(
            string name,
            IReadOnlyDictionary<string, string> environment,
            CancellationToken ct = default)
        {
            var config = new Dictionary<string, string?>(StringComparer.Ordinal);

            foreach (var (key, value) in environment)
            {
                config[$"environment.{key}"] = value;
            }

            if (await api.InstanceAsync(name, ct).ConfigureAwait(false) is { } current)
            {
                foreach (var key in current.Config.Keys)
                {
                    if (key.StartsWith("environment.", StringComparison.Ordinal) && !config.ContainsKey(key))
                    {
                        config[key] = null;
                    }
                }
            }

            if (config.Count > 0)
            {
                await api.Client.PatchAsync($"{IncusClient.V1}/instances/{name}", WireJson.Object(Incus.IncusJson.Options, ("config", config)), ct)
                    .ConfigureAwait(false);
            }
        }
    }

    private sealed class IncusExec(IncusApi api) : IExec
    {
        public async Task<IInteractiveExec> InteractiveAsync(
            string instance,
            ExecRequest request,
            CancellationToken ct = default) =>
            await ExecSession.StartAsync(
                api,
                instance,
                new ExecPost
                {
                    Command = request.Command,
                    Cwd = request.Cwd,
                    Environment = request.Environment,
                    Width = request.Width,
                    Height = request.Height,
                },
                ct).ConfigureAwait(false);

        // The command arrives already wrapped for its account, so no user is
        // passed down: wrapping it twice would be a runuser inside a runuser.
        public Task<RunResult> CapturedAsync(string instance, ExecRequest request, CancellationToken ct = default) =>
            Command.CaptureAsync(api, instance, request.Command, null, request.Cwd, request.Environment, ct);

        public Task<Stream?> DialAsync(
            string instance,
            string user,
            IReadOnlyList<string> hosts,
            int port,
            CancellationToken ct = default) =>
            Socks.InstanceRelay.DialAsync(api, instance, user, hosts, port, ct);
    }

    private sealed class IncusFiles(IncusApi api) : IFiles
    {
        public Task PushAsync(
            string instance,
            string path,
            ReadOnlyMemory<byte> content,
            string mode = "0644",
            CancellationToken ct = default) =>
            api.PushAsync(instance, path, content, mode, ct: ct);

        public Task<byte[]?> PullAsync(string instance, string path, CancellationToken ct = default) =>
            api.PullAsync(instance, path, ct);
    }

    /// <summary>The golden snapshot, and a project's snapshot built from it once.</summary>
    private sealed class IncusImages(IncusApi api, HostConfig host) : IImages
    {
        public async Task<ImageChoice> ChooseAsync(
            SessionPlan plan,
            string user,
            Action<string> report,
            CancellationToken ct = default)
        {
            if (plan.HasProjectImage)
            {
                var fingerprint = plan.ImageFingerprint;

                if (!await ProjectImage.ExistsAsync(api, plan.Project, fingerprint, ct).ConfigureAwait(false))
                {
                    report(
                        $"{plan.Project} needs {Incus.Features.Count(plan.Features.Count)} " +
                        $"({Incus.Features.Describe(plan.Features)}) — building its image once, " +
                        "which every session after this one copies");

                    await ProjectImage.BuildAsync(
                        api, host, plan.Project, plan.Directory, plan.Image, plan.Features, user, report, ct)
                        .ConfigureAwait(false);
                }

                var source = ProjectImage.Source(plan.Project, fingerprint);
                return new ImageChoice(source, Golden: false, source);
            }

            return await Golden.ExistsAsync(api, ct).ConfigureAwait(false)
                ? new ImageChoice(null, Golden: true, Golden.Source)
                : new ImageChoice(null, Golden: false, plan.Image);
        }
    }
}
