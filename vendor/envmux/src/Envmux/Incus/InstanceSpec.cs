using System.Globalization;

using Envmux.Host;
using Envmux.Session;

namespace Envmux.Incus;

/// <summary>
/// What a session's instance is, as a creation request.
/// </summary>
/// <remarks>
/// <para>
/// The shape a container took under Docker was mostly a list of concessions to
/// the host port space: published ports, a per-session bridge network, a relay
/// binary copied in to reach servers bound to the container's own loopback.
/// None of that is here. An instance has an address, it is on the one bridge
/// everything is on, and a server binding <c>127.0.0.1</c> inside it is exactly
/// as reachable as it would be on any other machine — which is to say, not, and
/// for the same honest reason.
/// </para>
/// <para>
/// What is left is the interesting part: where it comes from, what address it
/// takes, and what it is called — which is also what it resolves as.
/// </para>
/// </remarks>
internal static class InstanceSpec
{
    /// <summary>Labels envmux puts on everything it makes, so it can find them again.</summary>
    public static class Keys
    {
        private const string Prefix = "user.envmux";

        /// <summary>Marks an instance as ours at all, and says which schema made it.</summary>
        public const string Schema = $"{Prefix}.schema";

        public const string SchemaVersion = "2";

        public const string Project = $"{Prefix}.project";
        public const string Session = $"{Prefix}.session";

        /// <summary>The host directory the session was started in.</summary>
        public const string Directory = $"{Prefix}.directory";

        /// <summary>The branch a session's work lands on.</summary>
        public const string Branch = $"{Prefix}.branch";

        /// <summary>Which service an instance is, when it is one.</summary>
        public const string Service = $"{Prefix}.service";

        /// <summary>When it was made, so prune can tell an old one from a live one.</summary>
        public const string Created = $"{Prefix}.created";

        /// <summary>
        /// The toolchain fingerprint an image was built for.
        /// </summary>
        /// <remarks>
        /// Only on a project image, and it is what makes one recognisable as
        /// superseded: the config produces a fingerprint, and any image carrying
        /// a different one is for a toolchain nothing asks for any more.
        /// </remarks>
        public const string Image = $"{Prefix}.image";
    }

    /// <summary>
    /// The labels a project's image carries.
    /// </summary>
    /// <remarks>
    /// Without these an image is not <see cref="IsOurs"/>, which means
    /// <c>envmux prune</c> cannot see it — and a project whose toolchain changes
    /// leaves one behind every time, forever, with nothing that can name them.
    /// </remarks>
    /// <param name="project">The project it belongs to.</param>
    /// <param name="fingerprint">What it was built from, hashed.</param>
    /// <param name="directory">The repository it was built for.</param>
    /// <param name="now">When.</param>
    /// <param name="nesting">Whether it needs to be able to run containers.</param>
    public static Dictionary<string, string> ForImage(
        string project,
        string fingerprint,
        string directory,
        DateTimeOffset now,
        bool nesting)
    {
        var config = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [Keys.Schema] = Keys.SchemaVersion,
            [Keys.Project] = project,
            [Keys.Directory] = directory,
            [Keys.Image] = fingerprint,
            [Keys.Created] = now.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture),
        };

        if (nesting)
        {
            config[Nesting] = "true";
        }

        return config;
    }

    /// <summary>
    /// The session's own instance.
    /// </summary>
    /// <remarks>
    /// A copy of the golden snapshot when there is one, and a pull when there is
    /// not. The difference is seconds against minutes, so the fallback says so
    /// rather than silently being slow.
    /// </remarks>
    /// <param name="copyFrom">
    /// A snapshot to copy instead of golden — this project's own image, when it
    /// has a toolchain layered on. Null takes the usual path.
    /// </param>
    public static InstancesPost ForSession(
        SessionPlan plan,
        HostConfig host,
        bool fromGolden,
        DateTimeOffset now,
        string? address = null,
        string? copyFrom = null) =>
        new()
        {
            Name = plan.InstanceName,
            Description = $"envmux: {plan.Project} / {plan.Session}",
            Source = copyFrom is not null
                ? new InstanceSource { Type = "copy", Source = copyFrom }
                : fromGolden
                ? new InstanceSource { Type = "copy", Source = Golden.Source }
                : new InstanceSource
                {
                    Type = "image",
                    Alias = plan.Image,
                    Protocol = "simplestreams",
                    Server = host.ImageServer,
                    Mode = "pull",
                },
            Config = Labels(plan, now, service: null),
            Devices = Attached(host, address),
            Start = false,
        };

    /// <summary>
    /// A service's instance: a database, a cache, a queue.
    /// </summary>
    /// <remarks>
    /// <para>
    /// One instance per service, with an address and a name of its own, which is
    /// what removes the last of the port arithmetic. Two sessions each running
    /// Postgres both have it on 5432, because they are two machines.
    /// </para>
    /// <para>
    /// The image is an OCI one — <c>postgres:17</c> from a registry — because
    /// that is what a service is published as and there is no reason to make
    /// people find a system-container equivalent. Incus runs those as
    /// application containers directly.
    /// </para>
    /// </remarks>
    public static InstancesPost ForService(
        ServicePlan service,
        SessionPlan plan,
        HostConfig host,
        DateTimeOffset now,
        string? address = null)
    {
        var config = Labels(plan, now, service.Name);

        // The image's own environment, which is how a service is configured:
        // POSTGRES_PASSWORD and the rest. `environment.` is Incus' prefix for
        // what the container's init sees.
        foreach (var (key, value) in service.ServiceEnvironment())
        {
            config[$"environment.{key}"] = value;
        }

        return new InstancesPost
        {
            Name = service.InstanceName,
            Description = $"envmux: {plan.Project} / {plan.Session} — {service.Name}",
            Source = new InstanceSource
            {
                Type = "image",
                Alias = service.Image,
                Protocol = "oci",
                Server = ServicePlan.Registry,
                Mode = "pull",
            },
            Config = config,
            Devices = Attached(host, address),
            Start = false,
        };
    }

    /// <summary>
    /// Put the instance on the host's network, at a pinned address when there is one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The device is set on every instance, address or not. On the seeded
    /// IncusOS host the default profile's nic already points at
    /// <see cref="HostConfig.DefaultNetwork"/>, so this is belt and braces — but on an
    /// <em>existing</em> Incus the default profile points at <c>incusbr0</c>, and
    /// a session that inherited it would come up on the wrong bridge, unrouted
    /// and unresolvable. Naming the network here is what lets envmux run against
    /// a daemon it did not build without rewriting that daemon's default profile.
    /// </para>
    /// <para>
    /// Which network is <see cref="HostConfig.Network"/>, read from the host's
    /// file and never assumed: <c>envmux0</c> when envmux made the bridge, and
    /// whatever the daemon already had when it was pointed at one. This is the
    /// one place that writes the device for a container, so that everything
    /// envmux creates as one — a session, a service, the golden instance, a dev
    /// container — lands on the subnet the workstation's route covers. The
    /// utility instance writes its own, because it may be a virtual machine,
    /// whose nic is not written the way a container's is.
    /// </para>
    /// <para>
    /// A pinned <c>ipv4.address</c> additionally removes a poll-for-address round
    /// trip and makes a connection string writable before the instance has
    /// booted — which is what lets a session's environment name a database that
    /// does not exist yet. Without one the address is left to DHCP, on the same
    /// bridge.
    /// </para>
    /// </remarks>
    /// <param name="host">The host, for the network's name.</param>
    /// <param name="address">The address to pin, or null to leave it to DHCP.</param>
    public static Dictionary<string, Dictionary<string, string>> Attached(HostConfig host, string? address = null)
    {
        var eth0 = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["type"] = "nic",
            ["network"] = host.Network,
            ["name"] = "eth0",
        };

        if (address is not null)
        {
            eth0["ipv4.address"] = address;
        }

        return new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal)
        {
            ["eth0"] = eth0,
        };
    }

    /// <summary>
    /// The addresses already spoken for: what instances pin, and what the network has leased.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Neither list is enough alone. A pinned nic is the record envmux itself
    /// wrote, and it is there from the moment the instance exists, started or
    /// not — whether the lease table lists it that early is the daemon's
    /// business, and two sessions created back to back is exactly when it would
    /// matter. A lease belongs to something that may not be an instance this
    /// client can see at all: another project's container on an adopted bridge,
    /// which took its address from dnsmasq out of the same subnet pinning now
    /// draws from.
    /// </para>
    /// <para>
    /// Every nic counts, not only <c>eth0</c> and not only ones on the network
    /// in question. An address on some other subnet is outside the pinned band
    /// and costs nothing to carry; leaving out a nic because it was named
    /// <c>eth1</c> is how two machines end up with one address.
    /// </para>
    /// </remarks>
    public static IReadOnlyCollection<string> TakenAddresses(
        IEnumerable<Instance> instances,
        IEnumerable<NetworkLease> leases)
    {
        var taken = new HashSet<string>(StringComparer.Ordinal);

        foreach (var instance in instances)
        {
            foreach (var device in instance.Devices.Values)
            {
                if (device.TryGetValue("ipv4.address", out var pinned) && pinned.Length > 0)
                {
                    taken.Add(pinned);
                }
            }
        }

        foreach (var lease in leases)
        {
            if (lease.Address.Length > 0)
            {
                taken.Add(lease.Address);
            }
        }

        return taken;
    }

    private static Dictionary<string, string> Labels(SessionPlan plan, DateTimeOffset now, string? service)
    {
        var config = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [Keys.Schema] = Keys.SchemaVersion,
            [Keys.Project] = plan.Project,
            [Keys.Session] = plan.Session,
            [Keys.Directory] = plan.Directory,
            [Keys.Branch] = plan.Branch,
            [Keys.Created] = now.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture),
        };

        if (service is not null)
        {
            config[Keys.Service] = service;
        }
        else
        {
            // What toolchain this instance was made with, so that adopting it
            // later can notice the config has moved on since. An instance is
            // kept and reused, and `features` only ever runs when one is
            // created — so without this, adding a feature and starting the same
            // session again silently gets you the old image and a failure
            // several minutes later about a command that is not installed.
            config[Keys.Image] = plan.ImageFingerprint;
        }

        // Only when something asked for it. Nesting relaxes what the container
        // may do to itself, and a session that never runs a container is better
        // without it.
        if (service is null && plan.NeedsNesting)
        {
            config[Nesting] = "true";
        }

        return config;
    }

    /// <summary>
    /// What lets a system container run containers of its own.
    /// </summary>
    /// <remarks>
    /// Without it Docker installs, starts, and then cannot set up cgroups — a
    /// failure that reads from inside as a broken Docker rather than as a
    /// container that was never permitted one.
    /// </remarks>
    public const string Nesting = "security.nesting";

    /// <summary>Whether an instance is one envmux made.</summary>
    public static bool IsOurs(Instance instance) =>
        instance.Config.ContainsKey(Keys.Schema);

    /// <summary>
    /// Whether an instance is a project's toolchain image rather than a session.
    /// </summary>
    /// <remarks>
    /// Both halves are needed, and the second is the one that is easy to miss.
    /// Creating an instance as a copy takes the source's config with it, so
    /// every session copied from an image inherits that image's fingerprint
    /// label — which made prune offer to remove the session somebody was using,
    /// labelled "[toolchain]". A session always carries a session label and an
    /// image never does, so that is what separates them.
    /// </remarks>
    public static bool IsImage(Instance instance) =>
        instance.Config.ContainsKey(Keys.Image) &&
        !instance.Config.ContainsKey(Keys.Session);

    /// <summary>The value of one of our labels, or empty when it is not there.</summary>
    public static string Label(Instance instance, string key) =>
        instance.Config.TryGetValue(key, out var value) ? value : "";
}
