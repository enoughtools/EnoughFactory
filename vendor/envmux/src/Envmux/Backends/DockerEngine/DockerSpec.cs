using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

using Envmux.Config;
using Envmux.Incus;

namespace Envmux.Backends.DockerEngine;

/// <summary>
/// What a session asks for, as the container a Docker engine is told to create.
/// </summary>
/// <remarks>
/// <para>
/// The seam speaks the Incus creation body, so that is what arrives: a name,
/// where it is copied from, and the <c>user.envmux.*</c> keys. What comes out
/// is a container that <em>publishes nothing</em>. An Incus instance has an
/// address of its own and everything it binds is reachable on it; a container
/// here is reached the one way a browser reaches a session anyway, over the
/// SOCKS relay (<see cref="EngineRelay"/>), which dials from inside and sees the
/// container's own <c>127.0.0.1</c>. So there are no published ports, no
/// per-session address block, and nothing wired on the workstation.
/// </para>
/// <para>
/// <b>The isolation is the point.</b> No capability is added, nothing of the
/// host's is mounted except an explicitly supplied manager-owned ArtifactFS
/// workspace — other state is named volumes — and the only network is the
/// session's own user-defined one, where a service answers to its name.
/// <see cref="Problems"/> says all of that as a check, and
/// <see cref="ForInstance"/> will not hand back a container that fails it.
/// </para>
/// <para>
/// Pure, so a plan can be turned into a container and looked at without an engine.
/// </para>
/// </remarks>
internal static class DockerSpec
{
    /// <summary>
    /// The labels everything envmux makes on an engine carries: containers,
    /// volumes, images, the session's network.
    /// </summary>
    /// <remarks>
    /// <see cref="InstanceSpec.Keys"/> with Incus' <c>user.</c> taken off —
    /// <c>user.envmux.project</c> is <c>envmux.project</c> — because a Docker
    /// label is any string and there is no reason for a second vocabulary. They
    /// are a wire format: changing one orphans everything already on an engine.
    /// The rest are Docker's alone: what kind of thing it is, the instance a
    /// volume belongs to, and the creation body kept whole.
    /// </remarks>
    public static class Labels
    {
        private const string Prefix = "envmux";

        public const string Schema = $"{Prefix}.schema";
        public const string Project = $"{Prefix}.project";
        public const string Session = $"{Prefix}.session";
        public const string Service = $"{Prefix}.service";
        public const string Directory = $"{Prefix}.directory";
        public const string Branch = $"{Prefix}.branch";
        public const string Created = $"{Prefix}.created";
        public const string Image = $"{Prefix}.image";
        public const string Workdir = $"{Prefix}.workdir";
        public const string Data = $"{Prefix}.data";
        public const string Host = $"{Prefix}.host";

        /// <summary>The instance a container is, and the instance a volume belongs to.</summary>
        public const string Instance = $"{Prefix}.instance";

        /// <summary>Which of an instance's volumes this is: <c>home</c>, <c>work</c> or <c>data</c>.</summary>
        public const string Volume = $"{Prefix}.volume";

        /// <summary>What a container is: <see cref="SessionKind"/> or <see cref="ServiceKind"/>.</summary>
        /// <remarks>
        /// Said on every container because a container inherits its image's
        /// labels, and <see cref="DockerImages.Labels"/> marks a golden image
        /// <c>golden</c> and a project's <c>image</c> under this same key: left
        /// alone, every session would say it was an image.
        /// </remarks>
        public const string Kind = $"{Prefix}.kind";

        /// <summary>The creation body, whole, as JSON.</summary>
        /// <remarks>
        /// The container is cattle — removed and made again from the same
        /// volumes when the plan moves on — and this is what it is made again
        /// from, a week after the plan that described it has gone.
        /// </remarks>
        public const string Spec = $"{Prefix}.spec";
    }

    /// <summary>
    /// Creation-body keys this backend reads that <see cref="InstanceSpec"/> does not write yet.
    /// </summary>
    /// <remarks>
    /// Kept here rather than added to <see cref="InstanceSpec.Keys"/>, which is
    /// the seam's to change. A body without them is still a container: the
    /// workdir is <see cref="SessionConfig.DefaultWorkdir"/>, a service has no
    /// data volume, and the zone name is not among the aliases. When the seam
    /// writes them, nothing here moves.
    /// </remarks>
    public static class Keys
    {
        /// <summary>The session's working directory, which is where its <c>work</c> volume is mounted.</summary>
        public const string Workdir = $"{UserPrefix}{Labels.Workdir}";

        /// <summary>Where a service's image keeps its data, which is where its <c>data</c> volume is mounted.</summary>
        public const string Data = $"{UserPrefix}{Labels.Data}";

        /// <summary>The full name the zone would have given the instance on Incus: <c>proj-sess-db.envmux</c>.</summary>
        public const string Host = $"{UserPrefix}{Labels.Host}";
    }

    /// <summary>What Incus puts in front of a key that is a note rather than a setting.</summary>
    private const string UserPrefix = "user.";

    /// <summary>What Incus puts in front of a variable the instance's first process is given.</summary>
    private const string EnvironmentPrefix = "environment.";

    /// <summary>The name a session's own container answers to on its network, whatever the session is called.</summary>
    public const string SessionAlias = "session";

    /// <summary>What <see cref="Labels.Kind"/> says of a session's own container.</summary>
    public const string SessionKind = "session";

    /// <summary>What <see cref="Labels.Kind"/> says of a service's container.</summary>
    public const string ServiceKind = "service";

    /// <summary>
    /// How a container reaches the machine the engine is on.
    /// </summary>
    /// <remarks>
    /// Docker Desktop resolves the name by itself. A native Linux engine does
    /// not, and <c>host-gateway</c> is how it is asked to; on Desktop the line
    /// is harmless. Measured on Desktop: it is the workstation's own
    /// <c>127.0.0.1</c> exactly, portal included — the portal's token is what
    /// keeps a container out of it.
    /// </remarks>
    public const string HostGateway = "host.docker.internal:host-gateway";

    private static readonly JsonSerializerOptions Json = new()
    {
        TypeInfoResolver = WireJsonContext.Default,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>An Incus config key as the label it becomes: <c>user.envmux.project</c> is <c>envmux.project</c>.</summary>
    public static string LabelOf(string key) =>
        key.StartsWith(UserPrefix, StringComparison.Ordinal) ? key[UserPrefix.Length..] : key;

    /// <summary>Whether a creation body is a service's rather than a session's own.</summary>
    public static bool IsService(InstancesPost spec) =>
        Key(spec, InstanceSpec.Keys.Service).Length > 0;

    /// <summary>
    /// The container for one instance, on the session's network.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A session</b> runs the golden image — or the project's own, when the
    /// body is a copy of one — as the image says to run it: no command and no
    /// entrypoint are given. What the image runs is <c>images/golden/envmux-init</c>,
    /// which starts sshd and waits; Docker's init is PID 1 either way, so a stop
    /// is half a second. It runs as root, because the image has no account in it:
    /// the session's bootstrap makes one over exec, as root, and every task and
    /// shell then drops to it with <c>runuser</c>.
    /// </para>
    /// <para>
    /// <b>A service</b> runs its image as published, entrypoint and all, with the
    /// body's <c>environment.*</c> keys as its environment and a named volume
    /// where the image keeps its data — named rather than left to the image's
    /// <c>VOLUME</c> line, which would make an anonymous one nothing can find
    /// again. It answers on the session's network as the service's name, so the
    /// session reaches <c>db:5432</c>.
    /// </para>
    /// <para>
    /// <c>security.nesting</c> is not honoured. On Incus it lets a session run
    /// containers of its own; here the only ways to the same thing are a
    /// privileged container or the host's socket, and either is the end of the
    /// isolation. <see cref="Notes"/> says so for the caller to pass on.
    /// </para>
    /// </remarks>
    /// <param name="spec">The creation body, from <see cref="InstanceSpec"/>.</param>
    /// <param name="network">The session's own network, which the caller has made. Every container of a session joins it.</param>
    /// <param name="config">The backend's record, for the golden image's tag.</param>
    /// <exception cref="BackendException">The container would break the isolation; the message is <see cref="Problems"/>' sentences.</exception>
    public static ContainerCreate ForInstance(InstancesPost spec, string network, DockerBackendConfig config)
    {
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(config);

        var (memory, cpus) = Limits(spec);
        var workspace = MachineWorkspaceBinding.ForSpec(spec);

        var container = new ContainerCreate
        {
            Image = ImageFor(spec, config),
            Hostname = spec.Name,
            Init = true,
            Env = EnvironmentOf(spec),
            Labels = LabelsFor(spec),
            Mounts = [.. Volumes(spec).Select(v => new MountSpec("volume", v.Name, v.Path)),
                .. workspace?.BindMounts ?? Array.Empty<MountSpec>()],
            Network = network,
            NetworkAliases = AliasesFor(spec),
            ExtraHosts = [HostGateway],
            MemoryBytes = memory,
            NanoCpus = cpus,
        };

        var problems = Problems(container, workspace);

        if (problems.Count > 0)
        {
            throw new BackendException(
                $"{spec.Name} would not be isolated, so it was not created: {string.Join("; ", problems)}");
        }

        return container;
    }

    /// <summary>
    /// The named volumes an instance's state is in, to make before the container.
    /// </summary>
    /// <remarks>
    /// <c>&lt;instance&gt;-home</c> and <c>&lt;instance&gt;-work</c> for a session,
    /// <c>&lt;instance&gt;-data</c> for a service whose image keeps data. Named for
    /// the instance so the three kinds of object are found by one word, and
    /// stable, so a container made again finds the same state. An instance name
    /// is a slug — lowercase letters, digits, hyphens — which is inside what the
    /// engine takes as a volume's name.
    /// </remarks>
    public static IReadOnlyList<string> VolumesFor(InstancesPost spec) =>
        [.. Volumes(spec).Select(v => v.Name)];

    /// <summary>The labels one of <see cref="VolumesFor"/>'s volumes carries, so <c>prune</c> finds it by project and session.</summary>
    /// <exception cref="ArgumentException">The volume is not one of this instance's.</exception>
    public static IReadOnlyDictionary<string, string> VolumeLabels(InstancesPost spec, string volume)
    {
        var role = Volumes(spec).FirstOrDefault(v => v.Name.Equals(volume, StringComparison.Ordinal)).Role
            ?? throw new ArgumentException($"'{volume}' is not one of {spec.Name}'s volumes", nameof(volume));

        var labels = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [Labels.Instance] = spec.Name,
            [Labels.Volume] = role,
        };

        foreach (var key in new[]
        {
            InstanceSpec.Keys.Schema,
            InstanceSpec.Keys.Project,
            InstanceSpec.Keys.Session,
            InstanceSpec.Keys.Service,
            InstanceSpec.Keys.Directory,
            InstanceSpec.Keys.Branch,
            InstanceSpec.Keys.Created,
        })
        {
            if (Key(spec, key) is { Length: > 0 } value)
            {
                labels[LabelOf(key)] = value;
            }
        }

        return labels;
    }

    /// <summary>
    /// The image a container is made from, as the engine is asked for it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A service names its own, and it is said in full: a registry that is not
    /// Docker Hub goes on the front, and a reference with no tag gets
    /// <c>:latest</c> — because a pull of a bare name through the API is a pull
    /// of <em>every</em> tag of it, which for <c>postgres</c> is an afternoon.
    /// </para>
    /// <para>
    /// A session's is the golden image, unless the body is a copy of a project
    /// image: Incus' <c>envmux-image-proj-1a2b3c4d/base</c> is this engine's
    /// <c>envmux-image-proj-1a2b3c4d:base</c>, the snapshot's name as the tag.
    /// A body that would have pulled a system-container image — no golden
    /// snapshot, on Incus — is the golden tag too: <c>debian/13/cloud</c> names
    /// nothing a Docker engine can run.
    /// </para>
    /// </remarks>
    public static string ImageFor(InstancesPost spec, DockerBackendConfig config)
    {
        if (IsService(spec))
        {
            return Normalise(spec.Source.Alias ?? "", spec.Source.Server);
        }

        if (spec.Source is { Type: "copy", Source: { Length: > 0 } source } &&
            !source.Equals(Golden.Source, StringComparison.Ordinal) &&
            source.StartsWith("envmux-image-", StringComparison.Ordinal))
        {
            var slash = source.IndexOf('/', StringComparison.Ordinal);

            return slash < 0 ? $"{source}:{ProjectImage.SnapshotName}" : $"{source[..slash]}:{source[(slash + 1)..]}";
        }

        return DockerImages.GoldenReference(config);
    }

    /// <summary>
    /// Everything about a container that would break a session's isolation, as sentences. Empty is the guarantee.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Nothing is published: a session is reached over the relay, and a
    /// published port would be a door on the workstation that every process
    /// and every other container on the engine can reach (measured: the engine's
    /// own rules accept another bridge's traffic to a published port). The
    /// network is a user-defined one: not the host's, not another container's,
    /// not the default bridge every other container on the engine shares.
    /// The private machine bridge may authorize one manager-owned workspace
    /// bind with its matched ArtifactFS state volume. Every other bind and the
    /// engine's socket remain refused. No capability is added and no confinement is
    /// switched off.
    /// </para>
    /// <para>
    /// <see cref="ContainerCreate"/> has no field for <c>privileged</c>, or for
    /// the host's pid or ipc namespace, so those cannot be asked for at all. A
    /// test holds the list of its fields, so that adding one is a decision made
    /// here too.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<string> Problems(ContainerCreate container, MachineWorkspaceBinding? workspace = null)
    {
        ArgumentNullException.ThrowIfNull(container);

        var problems = new List<string>();

        foreach (var port in container.Ports)
        {
            problems.Add(
                $"port {Number(port.ContainerPort)} is published on {port.HostIp}:{Number(port.HostPort)} — a session " +
                "publishes nothing; it is reached through the browser's relay");
        }

        var network = container.Network ?? "";

        if (network.Length == 0 ||
            network is "host" or "none" or "bridge" or "default" ||
            network.StartsWith("container:", StringComparison.Ordinal))
        {
            problems.Add($"the network is '{network}', and a session's containers are only ever on the session's own network");
        }

        if (container.NetworkMode is { Length: > 0 } mode)
        {
            problems.Add($"the network mode is '{mode}', which is somebody else's network stack");
        }

        foreach (var mount in container.Mounts)
        {
            var socket =
                mount.Source.Contains("docker.sock", StringComparison.OrdinalIgnoreCase) ||
                mount.Target.Contains("docker.sock", StringComparison.OrdinalIgnoreCase) ||
                mount.Source.Contains("docker_engine", StringComparison.OrdinalIgnoreCase);

            if (socket)
            {
                problems.Add(
                    $"{mount.Source} is mounted at {mount.Target} — that is the engine's own socket, and whatever " +
                    "holds it is root on this machine");
            }
            else if (mount.Type is not ("volume" or "tmpfs") && workspace?.Allows(container, mount) != true)
            {
                problems.Add(
                    $"{mount.Source} is a {mount.Type} mount at {mount.Target} — a session's state is named volumes, " +
                    "and nothing of this machine's is mounted into it");
            }
        }

        foreach (var capability in container.CapAdd)
        {
            problems.Add($"the capability {capability} is added, and a session is given none");
        }

        foreach (var option in container.SecurityOpt.Where(o => !IsHardening(o)))
        {
            problems.Add($"the security option '{option}' switches a confinement off");
        }

        return problems;
    }

    /// <summary>
    /// What the creation body asked for that this backend does not do, as sentences for the person.
    /// </summary>
    public static IReadOnlyList<string> Notes(InstancesPost spec) =>
        Key(spec, InstanceSpec.Nesting).Equals("true", StringComparison.Ordinal)
            ?
            [
                $"{spec.Name} asks to run containers of its own, and on a Docker engine that means a privileged " +
                "container or the engine's socket — either is the end of the session's isolation, so it gets neither. " +
                "Docker is installed in it and will not start.",
            ]
            : [];

    /// <summary>The creation body a container was made from, or null for one envmux did not make.</summary>
    public static InstancesPost? SpecOf(IReadOnlyDictionary<string, string> labels)
    {
        if (!labels.TryGetValue(Labels.Spec, out var json) || json.Length == 0)
        {
            return null;
        }

        try
        {
            return WireJson.Deserialize<InstancesPost>(json, Json);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// The names a container answers to on the session's network.
    /// </summary>
    /// <remarks>
    /// Its instance name always. Then the short one: <see cref="SessionAlias"/>
    /// for the session's own container, the service's name for a service — as a
    /// slug, and as it was written when that is a name at all, because <c>Db</c>
    /// slugs to <c>db</c> and somebody will type the one they wrote. Then the
    /// full name the zone would have given it on Incus (<see cref="Keys.Host"/>,
    /// when the body carries it), because that, not <c>db</c>, is what the
    /// session's connection strings say.
    /// </remarks>
    public static IReadOnlyList<string> AliasesFor(InstancesPost spec)
    {
        var aliases = new List<string> { spec.Name };

        if (Key(spec, InstanceSpec.Keys.Service) is { Length: > 0 } service)
        {
            aliases.Add(Slug.From(service));

            if (service.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.'))
            {
                aliases.Add(service);
            }
        }
        else
        {
            aliases.Add(SessionAlias);
        }

        if (Key(spec, Keys.Host) is { Length: > 0 } host)
        {
            aliases.Add(host);
        }

        return [.. aliases.Where(a => a.Length > 0).Distinct(StringComparer.Ordinal)];
    }

    /// <summary>
    /// A service's image reference, in full.
    /// </summary>
    internal static string Normalise(string alias, string? server)
    {
        var reference = alias.Trim();

        if (reference.Length == 0)
        {
            return reference;
        }

        // Whether the first segment is already a registry is Docker's own rule:
        // it has a dot or a port in it, or it is localhost.
        var slash = reference.IndexOf('/', StringComparison.Ordinal);
        var first = slash < 0 ? "" : reference[..slash];
        var hasRegistry = first.Contains('.', StringComparison.Ordinal) ||
                          first.Contains(':', StringComparison.Ordinal) ||
                          first.Equals("localhost", StringComparison.Ordinal);

        if (hasRegistry)
        {
            // docker.io/library/postgres:17 and postgres:17 are one image; the
            // engine stores it under the short name, so that is what is asked for.
            foreach (var hub in new[] { "docker.io/library/", "docker.io/", "index.docker.io/library/", "index.docker.io/" })
            {
                if (reference.StartsWith(hub, StringComparison.Ordinal))
                {
                    reference = reference[hub.Length..];
                    break;
                }
            }
        }
        else if (RegistryHost(server) is { } registry)
        {
            reference = $"{registry}/{reference}";
        }

        // A tag or a digest, looked for after the last slash so that a
        // registry's port is not mistaken for one.
        var name = reference[(reference.LastIndexOf('/') + 1)..];

        return name.Contains(':', StringComparison.Ordinal) || name.Contains('@', StringComparison.Ordinal)
            ? reference
            : $"{reference}:latest";
    }

    /// <summary>Incus' sizes: <c>2GiB</c>, <c>512MB</c>, or a bare number of bytes.</summary>
    internal static long? Bytes(string size)
    {
        var text = size.Trim();
        var digits = text.TakeWhile(char.IsAsciiDigit).Count();

        if (digits == 0 || !long.TryParse(text[..digits], NumberStyles.None, CultureInfo.InvariantCulture, out var number) || number <= 0)
        {
            return null;
        }

        long? unit = text[digits..].Trim() switch
        {
            "" or "B" => 1,
            "kB" or "KB" => 1_000,
            "MB" => 1_000_000,
            "GB" => 1_000_000_000,
            "TB" => 1_000_000_000_000,
            "KiB" => 1L << 10,
            "MiB" => 1L << 20,
            "GiB" => 1L << 30,
            "TiB" => 1L << 40,
            _ => null,
        };

        return unit is { } by ? number * by : null;
    }

    private static Dictionary<string, string> LabelsFor(InstancesPost spec)
    {
        var labels = new Dictionary<string, string>(StringComparer.Ordinal);

        // Every user.envmux.* key, under the same name without Incus' prefix —
        // by rule rather than by list, so a key InstanceSpec gains later is
        // here without anybody remembering to add it. The environment is not a
        // label: it is the container's Env, and it is in the body below.
        foreach (var (key, value) in spec.Config ?? new Dictionary<string, string>(StringComparer.Ordinal))
        {
            if (key.StartsWith($"{UserPrefix}envmux.", StringComparison.Ordinal))
            {
                labels[LabelOf(key)] = value;
            }
        }

        labels[Labels.Kind] = IsService(spec) ? ServiceKind : SessionKind;
        labels[Labels.Instance] = spec.Name;
        labels[Labels.Spec] = WireJson.Serialize(spec, Json);

        return labels;
    }

    private static Dictionary<string, string> EnvironmentOf(InstancesPost spec) =>
        (spec.Config ?? new Dictionary<string, string>(StringComparer.Ordinal))
            .Where(c => c.Key.StartsWith(EnvironmentPrefix, StringComparison.Ordinal) && c.Key.Length > EnvironmentPrefix.Length)
            .ToDictionary(c => c.Key[EnvironmentPrefix.Length..], c => c.Value, StringComparer.Ordinal);

    private static IEnumerable<(string Name, string Path, string? Role)> Volumes(InstancesPost spec)
    {
        if (IsService(spec))
        {
            if (Key(spec, Keys.Data) is { Length: > 0 } data)
            {
                yield return ($"{spec.Name}-data", data, "data");
            }

            yield break;
        }

        var workdir = Key(spec, Keys.Workdir) is { Length: > 0 } declared
            ? declared
            : SessionConfig.DefaultWorkdir;

        // All of /home rather than one account's directory: the account does
        // not exist until the bootstrap makes it, and its name is this
        // machine's user's, which the creation body does not know. A new volume
        // starts as a copy of what the image has there, so whatever a project
        // image's features installed per-user comes along.
        yield return ($"{spec.Name}-home", "/home", "home");
        var workspace = MachineWorkspaceBinding.ForSpec(spec);
        if (workspace is null)
        {
            yield return ($"{spec.Name}-work", workdir, "work");
        }
        else
        {
            // The provider owns this existing volume; it is not relabelled as
            // envmux-owned and is not removed by envmux session cleanup.
            yield return (workspace.StateVolume, MachineWorkspaceBinding.StateTarget, "artifact-state");
        }
    }

    /// <summary>
    /// <c>limits.memory</c> and <c>limits.cpu</c>, when the body carries them.
    /// </summary>
    /// <remarks>
    /// Nothing sets either today. Read so that the day something does, a session
    /// on this backend is held to it as one on Incus would be. Incus' forms that
    /// have no Docker equivalent — a percentage of the host's memory, a set of
    /// pinned cores — are left alone rather than guessed at.
    /// </remarks>
    private static (long? MemoryBytes, long? NanoCpus) Limits(InstancesPost spec)
    {
        long? cpus = int.TryParse(Key(spec, "limits.cpu"), NumberStyles.None, CultureInfo.InvariantCulture, out var count) && count > 0
            ? count * 1_000_000_000L
            : null;

        return (Bytes(Key(spec, "limits.memory")), cpus);
    }

    /// <summary>The registry a creation body's <c>server</c> names, or null for Docker Hub, which needs no naming.</summary>
    private static string? RegistryHost(string? server)
    {
        if (string.IsNullOrWhiteSpace(server))
        {
            return null;
        }

        var host = Uri.TryCreate(server, UriKind.Absolute, out var uri) && uri.Host.Length > 0
            ? uri.IsDefaultPort ? uri.Host : $"{uri.Host}:{uri.Port.ToString(CultureInfo.InvariantCulture)}"
            : server.Trim().TrimEnd('/');

        return host is "docker.io" or "index.docker.io" or "registry-1.docker.io" ? null : host;
    }

    /// <summary>The one kind of security option that takes something away rather than giving it.</summary>
    private static bool IsHardening(string option) =>
        option is "no-new-privileges" or "no-new-privileges:true" or "no-new-privileges=true";

    private static string Key(InstancesPost spec, string key) =>
        spec.Config is { } config && config.TryGetValue(key, out var value) ? value : "";

    private static string Number(int port) => port.ToString(CultureInfo.InvariantCulture);
}
