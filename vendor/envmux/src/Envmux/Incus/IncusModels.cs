using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Incus;

/// <summary>
/// The status codes Incus uses for operations and instances alike.
/// </summary>
/// <remarks>
/// Control flow reads these and never the <c>status</c> string beside them. The
/// string is a human label — it has been reworded between releases, and it is
/// localised nowhere but reads as though it might be. The integer is the
/// contract.
/// </remarks>
internal static class IncusStatus
{
    public const int OperationCreated = 100;
    public const int Started = 101;
    public const int Stopped = 102;
    public const int Running = 103;
    public const int Cancelling = 104;
    public const int Pending = 105;
    public const int Starting = 106;
    public const int Stopping = 107;
    public const int Aborting = 108;
    public const int Freezing = 109;
    public const int Frozen = 110;
    public const int Thawed = 111;
    public const int Error = 112;
    public const int Ready = 113;

    public const int Success = 200;
    public const int Failure = 400;
    public const int Cancelled = 401;

    /// <summary>Whether an operation has stopped moving, whichever way it went.</summary>
    public static bool IsFinished(int code) => code is >= Success;

    /// <summary>Whether an instance is up.</summary>
    public static bool IsUp(int code) => code is Running or Started or Ready;
}

/// <summary>What <c>GET /1.0</c> says about the host and about us.</summary>
internal sealed record ServerInfo
{
    /// <summary>"trusted" once the seeded certificate is presented, "untrusted" otherwise.</summary>
    public string Auth { get; set; } = "";

    /// <summary>Every optional feature this daemon has. Feature detection reads this and not the version.</summary>
    public IReadOnlyList<string> ApiExtensions { get; set; } = [];

    public ServerEnvironment Environment { get; set; } = new();

    public bool IsTrusted => Auth.Equals("trusted", StringComparison.Ordinal);

    public bool Has(string extension) => ApiExtensions.Contains(extension, StringComparer.Ordinal);
}

internal sealed record ServerEnvironment
{
    public string ServerVersion { get; set; } = "";

    public string ServerName { get; set; } = "";

    public string Kernel { get; set; } = "";

    public string KernelArchitecture { get; set; } = "";

    /// <summary>
    /// What kinds of instance this daemon can run, as it spells them: <c>lxc</c>,
    /// <c>qemu</c>, or <c>lxc | qemu</c>.
    /// </summary>
    /// <remarks>
    /// One string with a separator in it, not a list. It is read for whether
    /// <c>qemu</c> is in it — whether a virtual machine can be asked for at
    /// all — and a daemon inside a container, or on a host without KVM, says
    /// only <c>lxc</c>.
    /// </remarks>
    public string Driver { get; set; } = "";

    /// <summary>Every storage driver this daemon was built with.</summary>
    /// <remarks>
    /// Objects, not strings. Older daemons sent a list of names and it is an
    /// easy thing to assume, but incus 7.3 sends
    /// <c>{"Name":"zfs","Version":"2.3.4","Remote":false}</c> per entry — and
    /// deserialising that into a string throws, which took out `host trust`
    /// after it had already pinned the fingerprint and printed success.
    /// </remarks>
    public IReadOnlyList<StorageDriver> StorageSupportedDrivers { get; set; } = [];

    public string Storage { get; set; } = "";
}

/// <summary>One of the storage drivers incusd was built with.</summary>
/// <remarks>
/// The daemon capitalises these keys where it spells the rest of its API in
/// snake_case, which the case-insensitive matching absorbs.
/// </remarks>
internal sealed record StorageDriver
{
    public string Name { get; set; } = "";

    public string Version { get; set; } = "";

    /// <summary>Whether it is a driver for storage that lives somewhere else.</summary>
    public bool Remote { get; set; }
}

/// <summary>An async operation, as <c>/wait</c> hands it back.</summary>
internal sealed record IncusOperation
{
    public string Id { get; set; } = "";

    /// <summary>"task", "websocket" or "token".</summary>
    public string Class { get; set; } = "";

    public string Description { get; set; } = "";

    public string Status { get; set; } = "";

    public int StatusCode { get; set; }

    /// <summary>Why it failed, when it did.</summary>
    public string Err { get; set; } = "";

    /// <summary>Whatever the operation carries — for an exec, the one-time socket secrets.</summary>
    public JsonElement Metadata { get; set; }

    public bool Succeeded => StatusCode == IncusStatus.Success;

    /// <summary>
    /// The one-time secrets for an interactive exec's sockets.
    /// </summary>
    /// <remarks>
    /// <c>"0"</c> is the PTY, in both directions, because an interactive exec
    /// has one terminal rather than three streams. <c>"control"</c> carries
    /// signals and window sizes. Each secret is good for exactly one connection.
    /// </remarks>
    public IReadOnlyDictionary<string, string> Fds()
    {
        if (Metadata.ValueKind != JsonValueKind.Object ||
            !Metadata.TryGetProperty("fds", out var fds) ||
            fds.ValueKind != JsonValueKind.Object)
        {
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }

        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var property in fds.EnumerateObject())
        {
            if (property.Value.ValueKind == JsonValueKind.String)
            {
                map[property.Name] = property.Value.GetString()!;
            }
        }

        return map;
    }

    /// <summary>
    /// Where a recorded exec put its two streams.
    /// </summary>
    /// <remarks>
    /// Keyed <c>"1"</c> and <c>"2"</c>, being the descriptors, and each value is
    /// a path under the instance's logs that has to be fetched separately — the
    /// operation carries where the output is, never the output.
    /// </remarks>
    public IReadOnlyDictionary<string, string> Output()
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);

        if (Metadata.ValueKind != JsonValueKind.Object ||
            !Metadata.TryGetProperty("output", out var output) ||
            output.ValueKind != JsonValueKind.Object)
        {
            return map;
        }

        foreach (var property in output.EnumerateObject())
        {
            if (property.Value.ValueKind == JsonValueKind.String)
            {
                map[property.Name] = property.Value.GetString() ?? "";
            }
        }

        return map;
    }

    /// <summary>What the command exited with, once a non-interactive exec has finished.</summary>
    public int? ReturnCode =>
        Metadata.ValueKind == JsonValueKind.Object &&
        Metadata.TryGetProperty("return", out var value) &&
        value.ValueKind == JsonValueKind.Number
            ? value.GetInt32()
            : null;
}

/// <summary>An instance, as the API lists it.</summary>
internal sealed record Instance
{
    public string Name { get; set; } = "";

    public string Status { get; set; } = "";

    public int StatusCode { get; set; }

    /// <summary>"container" or "virtual-machine". v1 only ever makes the former.</summary>
    public string Type { get; set; } = "container";

    public string Description { get; set; } = "";

    public IReadOnlyDictionary<string, string> Config { get; set; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public IReadOnlyDictionary<string, Dictionary<string, string>> Devices { get; set; } =
        new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);

    public IReadOnlyList<string> Profiles { get; set; } = [];

    public bool IsRunning => IncusStatus.IsUp(StatusCode);
}

/// <summary>What an instance is doing right now, including the address it took.</summary>
internal sealed record InstanceState
{
    public string Status { get; set; } = "";

    public int StatusCode { get; set; }

    public IReadOnlyDictionary<string, InstanceNetwork> Network { get; set; } =
        new Dictionary<string, InstanceNetwork>(StringComparer.Ordinal);

    public bool IsRunning => IncusStatus.IsUp(StatusCode);

    /// <summary>
    /// The instance's own IPv4 address on <c>eth0</c>, or null while it has none.
    /// </summary>
    /// <remarks>
    /// Loopback is skipped and so is every interface but <c>eth0</c>: an
    /// instance running Docker inside it has a bridge of its own, and that
    /// bridge's address is not one anything outside can reach.
    /// </remarks>
    public string? Address =>
        Network.TryGetValue("eth0", out var eth0)
            ? eth0.Addresses
                .FirstOrDefault(a => a.Family.Equals("inet", StringComparison.Ordinal) &&
                                     a.Scope.Equals("global", StringComparison.Ordinal))?.Address
            : null;
}

internal sealed record InstanceNetwork
{
    public IReadOnlyList<InstanceAddress> Addresses { get; set; } = [];

    public string Hwaddr { get; set; } = "";
}

internal sealed record InstanceAddress
{
    /// <summary>"inet" or "inet6".</summary>
    public string Family { get; set; } = "";

    public string Address { get; set; } = "";

    public string Netmask { get; set; } = "";

    /// <summary>"global", "link" or "local".</summary>
    public string Scope { get; set; } = "";
}

/// <summary>
/// One address a network's DHCP server knows about, from <c>GET /1.0/networks/{name}/leases</c>.
/// </summary>
/// <remarks>
/// Only the fields that say whose it is and what it is. The rest — the MAC, the
/// cluster member, the project — are there on the wire and deliberately not
/// modelled: all this is read for is which addresses not to pin.
/// </remarks>
internal sealed record NetworkLease
{
    /// <summary>Whose it is: usually an instance's name.</summary>
    public string Hostname { get; set; } = "";

    /// <summary>IPv4 or IPv6, as text. The table carries both families.</summary>
    public string Address { get; set; } = "";

    /// <summary>
    /// "dynamic" for one dnsmasq handed out, "static" for one an instance's nic pins.
    /// </summary>
    /// <remarks>
    /// Carried for whoever prints the table, and deliberately not read when
    /// choosing an address: the API documents those two values, and whatever
    /// else a daemon puts here is still an address something is using.
    /// </remarks>
    public string Type { get; set; } = "";
}

/// <summary>
/// A managed network: <c>envmux0</c>, or the one a host was pointed at instead.
/// </summary>
internal sealed record IncusNetworkInfo
{
    public string Name { get; set; } = "";

    public string Type { get; set; } = "";

    public string Description { get; set; } = "";

    public IReadOnlyDictionary<string, string> Config { get; set; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>Instances and profiles currently attached, which is what makes a change disruptive.</summary>
    public IReadOnlyList<string> UsedBy { get; set; } = [];
}

/// <summary>Where a new instance comes from.</summary>
internal sealed record InstanceSource
{
    /// <summary>"image" or "copy".</summary>
    public required string Type { get; set; }

    /// <summary>The image's alias, when this is a pull.</summary>
    public string? Alias { get; set; }

    /// <summary>"simplestreams" for the official remote, "oci" for a registry of application images.</summary>
    public string? Protocol { get; set; }

    public string? Server { get; set; }

    /// <summary>"pull" for a remote image, absent for a local copy.</summary>
    public string? Mode { get; set; }

    /// <summary>The instance or snapshot to copy, as <c>name</c> or <c>name/snapshot</c>.</summary>
    public string? Source { get; set; }

    /// <summary>Whether the copy is a lightweight one that shares the parent's storage.</summary>
    [JsonPropertyName("instance_only")]
    public bool? InstanceOnly { get; set; }
}

/// <summary>The body of <c>POST /1.0/instances</c>.</summary>
internal sealed record InstancesPost
{
    public required string Name { get; set; }

    public required InstanceSource Source { get; set; }

    public string Type { get; set; } = "container";

    public string? Description { get; set; }

    public IReadOnlyDictionary<string, string>? Config { get; set; }

    public IReadOnlyDictionary<string, Dictionary<string, string>>? Devices { get; set; }

    public IReadOnlyList<string>? Profiles { get; set; }

    /// <summary>Whether to start it as part of creating it, which saves a round trip.</summary>
    public bool Start { get; set; }
}

/// <summary>The body of <c>PUT /1.0/instances/{name}/state</c>.</summary>
internal sealed record InstanceStatePut
{
    /// <summary>"start", "stop", "restart", "freeze" or "unfreeze".</summary>
    public required string Action { get; set; }

    /// <summary>Seconds to wait for a clean stop before the force flag decides.</summary>
    public int Timeout { get; set; } = 30;

    public bool Force { get; set; }

    public bool Stateful { get; set; }
}

/// <summary>The body of <c>POST /1.0/instances/{name}/exec</c>.</summary>
/// <remarks>
/// Three of these keys are hyphenated on the wire rather than snake cased, which
/// no naming policy produces — so they are named explicitly. A key that is
/// silently wrong here is an exec that answers with three sockets instead of
/// one, and the symptom is a terminal that never draws.
/// </remarks>
internal sealed record ExecPost
{
    public required IReadOnlyList<string> Command { get; set; }

    public IReadOnlyDictionary<string, string>? Environment { get; set; }

    [JsonPropertyName("wait-for-websocket")]
    public bool WaitForWebsocket { get; set; } = true;

    public bool Interactive { get; set; } = true;

    [JsonPropertyName("record-output")]
    public bool RecordOutput { get; set; }

    public int Width { get; set; } = 120;

    public int Height { get; set; } = 40;

    /// <summary>Which account to run as, by id.</summary>
    /// <remarks>
    /// A number, and this is worth stating because the obvious thing to send is
    /// a name. incus declares this field as a <c>uint32</c>, so a username is
    /// rejected during JSON decoding with
    /// <c>cannot unmarshal string into Go struct field InstanceExecPost.user of
    /// type uint32</c> — a message that names a Go type and no account. Callers
    /// Nothing sets this any more: envmux drops to an account with
    /// <c>runuser</c> instead, because a uid on its own gets the right user with
    /// the <em>root</em> primary group and none of their own. See
    /// <see cref="Command.AsUser"/>. The type stays correct so that anyone who
    /// does set it sends what the API asks for.
    /// </remarks>
    public int? User { get; set; }

    /// <summary>Which group to run as, by id. A number, for the same reason.</summary>
    public int? Group { get; set; }

    public string? Cwd { get; set; }
}

/// <summary>The body of <c>POST /1.0/instances/{name}/snapshots</c>.</summary>
internal sealed record SnapshotsPost
{
    public required string Name { get; set; }

    /// <summary>Whether the snapshot carries running memory. Never, here: containers are restarted, not resumed.</summary>
    public bool Stateful { get; set; }

    public string? ExpiresAt { get; set; }
}

/// <summary>The body of <c>POST /1.0/networks</c>: create a bridge.</summary>
internal sealed record NetworksPost
{
    public required string Name { get; set; }

    public required string Type { get; set; }

    public string? Description { get; set; }

    public required IReadOnlyDictionary<string, string> Config { get; set; }
}

/// <summary>
/// The body of <c>POST /1.0/certificates</c>: add a client to the trust store.
/// </summary>
/// <remarks>
/// <para>
/// This is how an existing Incus comes to trust envmux, where a Hyper-V host is
/// told at seed time. The daemon's owner mints a token — <c>incus config trust
/// add envmux</c> — and it goes in <see cref="TrustToken"/>, which is what
/// authorises the add on a connection the daemon does not yet trust.
/// </para>
/// <para>
/// <see cref="Certificate"/> is left null on purpose. With no certificate in the
/// body, Incus records the one presented on the TLS connection — which is exactly
/// the certificate envmux is already authenticating with, so there is nothing to
/// encode and no chance of adding the wrong one.
/// </para>
/// </remarks>
internal sealed record CertificatesPost
{
    /// <summary>"client", for a certificate that may drive the API.</summary>
    public required string Type { get; set; }

    /// <summary>A label the daemon's owner sees in <c>incus config trust list</c>.</summary>
    public string? Name { get; set; }

    /// <summary>The one-time token the daemon's owner minted to authorise this.</summary>
    [JsonPropertyName("trust_token")]
    public string? TrustToken { get; set; }

    /// <summary>Left null, so the daemon trusts the certificate presented on the wire.</summary>
    public string? Certificate { get; set; }
}
