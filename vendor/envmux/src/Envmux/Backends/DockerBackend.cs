using System.Globalization;
using System.Net;

using Envmux.Backends.DockerEngine;
using Envmux.Host;
using Envmux.Incus;
using Envmux.Session;

namespace Envmux.Backends;

/// <summary>
/// The Docker engine on this machine, as a place for sessions to run.
/// </summary>
/// <remarks>
/// <para>
/// A session is a container from the golden image, with a volume for
/// <c>/home</c> and one for the workdir, on one shared network with its
/// services. Nothing is published: a session is looked at through its browser
/// proxy, whose connections are Docker execs relaying to the container's own
/// loopback (<see cref="EngineRelay"/>). So there is no port to allocate, no
/// loopback address to claim and no name to resolve on this machine, which is
/// every problem the earlier Docker versions of envmux had with web
/// development.
/// </para>
/// <para>
/// One network for every session rather than one each: Docker's default
/// address pools allow only about thirty bridge networks engine-wide, and a
/// session needs no isolation from another that a network would give — the
/// Incus sessions share their bridge too. Services are reached by the name
/// they have under the session's domain, as a network alias.
/// </para>
/// <para>
/// The specs are Incus' wire models, built by <see cref="InstanceSpec"/> exactly
/// as for an Incus session and translated by <see cref="DockerSpec"/>, so a
/// session means the same thing on either backend.
/// </para>
/// </remarks>
internal sealed class DockerBackend : IBackend
{
    /// <summary>The network every session and service is on.</summary>
    public const string Network = "envmux";

    private readonly IDockerEngine _engine;
    private bool _disposed;

    public DockerBackend(IDockerEngine engine, DockerBackendConfig config)
    {
        _engine = engine;
        ManagedGoldenImage = config.ManagedGoldenImage;

        var exec = new EngineExec(engine);

        Instances = new DockerInstances(engine, config);
        Exec = new DockerExec(engine, exec);
        Files = new DockerFilesSeam(new DockerFiles(engine));
        Images = new DockerImagesSeam(new DockerImages(engine, config, exec));
    }

    /// <summary>The explicit managed engine, or ordinary Docker resolution when no supervisor owns it.</summary>
    public static DockerBackend Connect(DockerBackendConfig? config = null)
    {
        config = (config ?? new DockerBackendConfig()).ResolveManaged(Environment.GetEnvironmentVariable);
        return new DockerBackend(DockerEngineClient.Connect(config.Endpoint), config);
    }

    public string Name => _engine.Endpoint;

    /// <summary>The immutable manager-selected base, checked before creating or adopting a session.</summary>
    public string? ManagedGoldenImage { get; }

    public BackendKind Kind => BackendKind.Docker;

    public IInstances Instances { get; }

    public IExec Exec { get; }

    public IFiles Files { get; }

    public IImages Images { get; }

    /// <summary>
    /// Loopback: <c>host.docker.internal</c> reaches this machine's own, so the
    /// portal's bridge needs no address facing anything else.
    /// </summary>
    public IPAddress? BridgeAddress => IPAddress.Loopback;

    public InstancesPost SessionSpec(SessionPlan plan, ImageChoice image)
    {
        var spec = InstanceSpec.ForSession(
            plan, HostFor(plan), image.Golden, DateTimeOffset.UtcNow, address: null, copyFrom: image.Source);

        return With(spec, new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [DockerSpec.Keys.Workdir] = plan.Workdir,
            [DockerSpec.Keys.Host] = plan.Hostname,
        });
    }

    public InstancesPost ServiceSpec(ServicePlan service, SessionPlan plan)
    {
        var spec = InstanceSpec.ForService(service, plan, HostFor(plan), DateTimeOffset.UtcNow, address: null);
        var keys = new Dictionary<string, string>(StringComparer.Ordinal) { [DockerSpec.Keys.Host] = service.Host };

        if (service.DataPath is { } data)
        {
            keys[DockerSpec.Keys.Data] = data;
        }

        return With(spec, keys);
    }

    public async Task PreflightAsync(CancellationToken ct = default)
    {
        EngineVersion version;

        try
        {
            version = await _engine.VersionAsync(ct).ConfigureAwait(false);
        }
        catch (BackendException e)
        {
            throw new BackendException(
                $"Docker is not answering at {Name}: {e.Message} Start Docker Desktop, or run on Incus " +
                "with `--backend incus`.", e);
        }

        if (!version.Os.Equals("linux", StringComparison.OrdinalIgnoreCase))
        {
            throw new BackendException(
                $"the engine at {Name} runs {version.Os} containers; a session needs Linux ones. " +
                "Switch Docker Desktop to Linux containers.");
        }
    }

    /// <summary>
    /// A socat inside the container, from its <c>127.0.0.1:<paramref name="insidePort"/></c>
    /// to <c>host.docker.internal</c>, which lands on this machine's loopback.
    /// </summary>
    /// <remarks>
    /// Detached with <c>setsid</c> so it outlives the exec that started it, and
    /// started again by the next session to adopt the container: a stopped
    /// container keeps no processes. The golden image carries socat for this.
    /// </remarks>
    public async Task<bool> TryWireLoopbackAsync(
        string instance,
        string name,
        int insidePort,
        IPEndPoint connectTo,
        CancellationToken ct = default)
    {
        var inside = insidePort.ToString(CultureInfo.InvariantCulture);
        var outside = connectTo.Port.ToString(CultureInfo.InvariantCulture);

        var script =
            $"pkill -f '^socat TCP-LISTEN:{inside},' 2>/dev/null; " +
            $"setsid nohup socat TCP-LISTEN:{inside},bind=127.0.0.1,fork,reuseaddr " +
            $"TCP:host.docker.internal:{outside} >/dev/null 2>&1 < /dev/null & " +
            "sleep 0.3; " +
            $"pgrep -f '^socat TCP-LISTEN:{inside},' >/dev/null";

        var result = await Command.ShellAsync(Exec, instance, script, null, null, ct).ConfigureAwait(false);
        return result.Ok;
    }

    public async ValueTask DisposeAsync()
    {
        if (!_disposed)
        {
            _disposed = true;
            await _engine.DisposeAsync().ConfigureAwait(false);
        }
    }

    /// <summary>
    /// What <see cref="InstanceSpec"/> reads from a host, for a backend that has none.
    /// </summary>
    /// <remarks>
    /// The domain is the only part that matters here: it is what a service's
    /// name sits under, which the spec carries into the network aliases. The
    /// rest are Incus' own — profiles, the bridge — and the translation drops them.
    /// </remarks>
    private static HostConfig HostFor(SessionPlan plan) => new() { DnsDomain = plan.Domain };

    private static InstancesPost With(InstancesPost spec, IReadOnlyDictionary<string, string> keys)
    {
        var config = new Dictionary<string, string>(spec.Config ?? new Dictionary<string, string>(), StringComparer.Ordinal);

        foreach (var (key, value) in keys)
        {
            config[key] = value;
        }

        return spec with { Config = config };
    }

    private sealed class DockerInstances(IDockerEngine engine, DockerBackendConfig config) : IInstances
    {
        private static readonly Dictionary<string, string> Ours =
            new(StringComparer.Ordinal) { [DockerSpec.Labels.Schema] = "" };

        public async Task<IReadOnlyList<Instance>> ListAsync(CancellationToken ct = default) =>
            [.. (await engine.ContainersAsync(Ours, all: true, ct).ConfigureAwait(false))
                .Select(c => AsInstance(c.Names.Count > 0 ? c.Names[0].TrimStart('/') : c.Id, c.State == "running", c.Labels))];

        /// <exception cref="BackendException">A container by that name exists and is not envmux's.</exception>
        public async Task<Instance?> GetAsync(string name, CancellationToken ct = default)
        {
            if (await engine.InspectAsync(name, ct).ConfigureAwait(false) is not { } container)
            {
                return null;
            }

            if (!container.Labels.ContainsKey(DockerSpec.Labels.Schema))
            {
                throw new BackendException(
                    $"there is a container called {name} on this engine that envmux did not make. " +
                    "Rename or remove it, or name the session something else.");
            }

            if (config.ManagedGoldenImage is { } golden &&
                string.Equals(container.Labels.GetValueOrDefault(DockerSpec.Labels.Kind), DockerSpec.SessionKind, StringComparison.Ordinal) &&
                !string.Equals(container.Labels.GetValueOrDefault(DockerImages.Labels.GoldenImage), golden, StringComparison.Ordinal))
            {
                throw new BackendException(
                    $"{name} was created with another managed golden image. Name a new session to use the prepared toolchain; the existing work is retained.");
            }

            return AsInstance(name, container.Running, container.Labels);
        }

        public async Task CreateAsync(InstancesPost spec, Action<string>? report = null, CancellationToken ct = default)
        {
            // Idempotent, and false when it was already there: every session
            // shares it, and the first one makes it.
            await engine.CreateNetworkAsync(
                Network,
                new Dictionary<string, string>(StringComparer.Ordinal) { [DockerSpec.Labels.Schema] = "1" },
                ct).ConfigureAwait(false);

            var existing = (await engine.VolumesAsync(ct: ct).ConfigureAwait(false))
                .Select(v => v.Name)
                .ToHashSet(StringComparer.Ordinal);

            if (MachineWorkspaceBinding.ForSpec(spec) is { } workspace && !existing.Contains(workspace.StateVolume))
            {
                throw new BackendException("the ArtifactFS manager's state volume is missing; prepare the workspace before starting envmux");
            }

            foreach (var volume in DockerSpec.VolumesFor(spec).Where(v => !existing.Contains(v)))
            {
                await engine.CreateVolumeAsync(volume, DockerSpec.VolumeLabels(spec, volume), ct).ConfigureAwait(false);
            }

            // A service's image is somebody else's and may not be here yet. The
            // session's own — golden or the project's — was made by the images
            // step before this was asked.
            var image = DockerSpec.ImageFor(spec, config);

            if (await engine.ImageAsync(image, ct).ConfigureAwait(false) is null)
            {
                if (config.ManagedGoldenImage is not null && !DockerSpec.IsService(spec))
                {
                    throw new BackendException($"the prepared managed image {image} is unavailable; prepare it before starting the session");
                }

                report?.Invoke($"pulling {image}");
                await engine.PullAsync(image, report, ct).ConfigureAwait(false);
            }

            await engine.CreateContainerAsync(spec.Name, DockerSpec.ForInstance(spec, Network, config), ct)
                .ConfigureAwait(false);
        }

        public Task StartAsync(string name, CancellationToken ct = default) => engine.StartAsync(name, ct);

        public Task StopAsync(string name, int timeoutSeconds = 10, CancellationToken ct = default) =>
            engine.StopAsync(name, timeoutSeconds, ct);

        /// <remarks>The container, and the volumes labelled as its: its home and its workdir, or a service's data.</remarks>
        public async Task<bool> DeleteAsync(string name, CancellationToken ct = default)
        {
            var removed = await engine.RemoveAsync(name, force: true, volumes: false, ct).ConfigureAwait(false);

            var volumes = await engine.VolumesAsync(
                new Dictionary<string, string>(StringComparer.Ordinal) { [DockerSpec.Labels.Instance] = name },
                ct).ConfigureAwait(false);

            foreach (var volume in volumes)
            {
                await engine.RemoveVolumeAsync(volume.Name, ct).ConfigureAwait(false);
            }

            return removed;
        }

        public async Task<string?> AwaitAddressAsync(string name, TimeSpan timeout, CancellationToken ct = default)
        {
            var deadline = DateTime.UtcNow + timeout;

            while (DateTime.UtcNow < deadline)
            {
                if (await engine.InspectAsync(name, ct).ConfigureAwait(false) is { Running: true } container &&
                    container.NetworkAddresses.TryGetValue(Network, out var address) && address.Length > 0)
                {
                    return address;
                }

                await Task.Delay(TimeSpan.FromMilliseconds(250), ct).ConfigureAwait(false);
            }

            return null;
        }

        /// <remarks>
        /// Nothing to do: a container's environment is fixed when it is made, and
        /// the environment file the session writes is what shells and tasks read.
        /// </remarks>
        public Task SetEnvironmentAsync(
            string name,
            IReadOnlyDictionary<string, string> environment,
            CancellationToken ct = default) =>
            Task.CompletedTask;

        /// <summary>A container as the session reads an instance: its state, and the config it was made with.</summary>
        private static Instance AsInstance(string name, bool running, IReadOnlyDictionary<string, string> labels) =>
            new()
            {
                Name = name,
                Status = running ? "Running" : "Stopped",
                StatusCode = running ? IncusStatus.Running : IncusStatus.Stopped,
                Config = DockerSpec.SpecOf(labels)?.Config ?? new Dictionary<string, string>(),
            };
    }

    private sealed class DockerExec(IDockerEngine engine, EngineExec exec) : IExec
    {
        public async Task<IInteractiveExec> InteractiveAsync(
            string instance,
            ExecRequest request,
            CancellationToken ct = default) =>
            await exec.InteractiveAsync(
                instance, request.Command, request.Cwd, request.Environment, request.Width, request.Height, ct)
                .ConfigureAwait(false);

        public Task<RunResult> CapturedAsync(string instance, ExecRequest request, CancellationToken ct = default) =>
            exec.CapturedAsync(instance, request.Command, request.Cwd, request.Environment, ct);

        public Task<Stream?> DialAsync(
            string instance,
            string user,
            IReadOnlyList<string> hosts,
            int port,
            CancellationToken ct = default) =>
            EngineRelay.DialAsync(engine, instance, user, hosts, port, ct);
    }

    private sealed class DockerFilesSeam(DockerFiles files) : IFiles
    {
        public Task PushAsync(
            string instance,
            string path,
            ReadOnlyMemory<byte> content,
            string mode = "0644",
            CancellationToken ct = default) =>
            files.PushAsync(instance, path, content, mode, ct);

        public Task<byte[]?> PullAsync(string instance, string path, CancellationToken ct = default) =>
            files.PullAsync(instance, path, ct);
    }

    /// <summary>The golden image, built here the first time it is needed, and a project's image on top.</summary>
    private sealed class DockerImagesSeam(DockerImages images) : IImages
    {
        public async Task<ImageChoice> ChooseAsync(
            SessionPlan plan,
            string user,
            Action<string> report,
            CancellationToken ct = default)
        {
            // Built rather than warned about, unlike Incus' golden snapshot: the
            // context is in this binary, the engine is on this machine, and the
            // build is a couple of minutes once — there is no host command a
            // person would otherwise have to go and run.
            if (!await images.HasGoldenAsync(ct).ConfigureAwait(false))
            {
                report("building the golden image, once — a few minutes");
                await images.BuildGoldenAsync(report, ct).ConfigureAwait(false);
            }

            if (!plan.HasProjectImage)
            {
                return new ImageChoice(null, Golden: true, images.GoldenImage);
            }

            var fingerprint = plan.ImageFingerprint;

            if (!await images.HasProjectAsync(plan.Project, fingerprint, ct).ConfigureAwait(false))
            {
                report(
                    $"{plan.Project} needs {Incus.Features.Count(plan.Features.Count)} " +
                    $"({Incus.Features.Describe(plan.Features)}) — building its image once, " +
                    "which every session after this one starts from");

                await images.BuildProjectAsync(
                    plan.Project, plan.Directory, plan.ImageFingerprintBase, plan.Features, user, report, ct).ConfigureAwait(false);
            }

            return new ImageChoice(
                ProjectImage.Source(plan.Project, fingerprint),
                Golden: false,
                DockerImages.ProjectReference(plan.Project, fingerprint));
        }
    }
}
