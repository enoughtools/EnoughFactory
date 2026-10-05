using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;

using Envmux.Config;

namespace Envmux.Host;

/// <summary>
/// Where the IncusOS host is, what range it hands out, and how to prove who we
/// are to it.
/// </summary>
/// <remarks>
/// <para>
/// One file, per workstation, outside any repository: it describes the machine
/// envmux talks to rather than the project it is run in. Every project on this
/// host shares it, which is the point — one VM, one range, one certificate.
/// </para>
/// <para>
/// The range lives here and in exactly one other place, the <c>envmux0</c>
/// network object inside Incus, and it is written into that object from this
/// file at seed time. Nothing on the workstation is derived from it any more:
/// a session is reached through its browser proxy and its ssh alias, both over
/// the host's API, so the range is the instances' business and not this
/// machine's routing table's.
/// </para>
/// <para>
/// JSON setters preserve field initializers when an older file omits fields.
/// The .NET 10 source generator assigns default values to missing init-only
/// properties, which erased the network and stranded legacy host records.
/// </para>
/// </remarks>
internal sealed record HostConfig
{

    /// <summary>The bridge's own address and prefix — <c>10.100.0.1/24</c>.</summary>
    public string Cidr { get; set; } = DefaultCidr;

    /// <summary>What dnsmasq hands out, leaving headroom below it for pinned addresses.</summary>
    public string DhcpRange { get; set; } = DefaultDhcpRange;

    /// <summary>The zone instance names are resolvable under.</summary>
    public string DnsDomain { get; set; } = DefaultDnsDomain;

    /// <summary>The Hyper-V VM's name.</summary>
    public string VmName { get; set; } = DefaultVmName;

    /// <summary>The Hyper-V virtual switch the VM's one adapter sits on.</summary>
    public string Switch { get; set; } = DefaultSwitch;

    /// <summary>
    /// The VM's MAC, fixed before the VM exists.
    /// </summary>
    /// <remarks>
    /// <c>network.json</c> has to name the interface's MAC, and Hyper-V assigns
    /// one at creation — so the ordering only works one way round. Deciding it
    /// here, once, is what makes the build repeatable: the seed is authored
    /// before the VM exists and the two agree because both read this.
    /// </remarks>
    public string Mac { get; set; } = DefaultMac;

    /// <summary>Where incusd answers, as <c>host:port</c>. Empty until the VM has an address.</summary>
    public string Api { get; set; } = "";

    /// <summary>
    /// The SHA-256 fingerprint of the certificate incusd presents.
    /// </summary>
    /// <remarks>
    /// incusd signs its own server certificate, so there is no chain to
    /// validate and pinning is the whole of the trust decision. Empty means it
    /// has not been learned yet, and every call refuses rather than falling back
    /// to trusting anything — a client that quietly accepts an unknown
    /// certificate is a client with no authentication at all.
    /// </remarks>
    public string Fingerprint { get; set; } = "";

    /// <summary>The image instances are created from when a session does not name one.</summary>
    public string Image { get; set; } = DefaultImage;

    /// <summary>The remote <see cref="Image"/> is pulled from.</summary>
    public string ImageServer { get; set; } = DefaultImageServer;

    /// <summary>
    /// Which backend the incusd this talks to lives on.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="HyperV"/> — the default — means envmux built and looks after a
    /// Hyper-V VM: the VM name, switch and MAC below are its, and
    /// <c>envmux install</c> seeds, boots and installs it. <see cref="Incus"/>
    /// means the daemon already existed and envmux only attached to it: it
    /// learned the fingerprint, added its certificate, and created the
    /// <c>envmux0</c> network, and the Hyper-V fields are unused.
    /// </para>
    /// <para>
    /// Nothing below the install path reads this. A session, the golden build and
    /// the Incus client are the same either way — the whole difference is in how
    /// the host came to exist, which is exactly the seam <c>envmux install</c>
    /// stands on.
    /// </para>
    /// </remarks>
    public string Provider { get; set; } = DefaultProvider;

    /// <summary>
    /// The Incus network every session's instance is attached to.
    /// </summary>
    /// <remarks>
    /// <see cref="DefaultNetwork"/> unless the Incus provider was pointed at a
    /// subnet the daemon already had (<c>envmux install --network</c>). An
    /// adopted network is attached to and never reconfigured or deleted: its
    /// range and its zone are read from it, not written to it.
    /// </remarks>
    public string Network { get; set; } = DefaultNetwork;

    /// <summary>
    /// Written by an older envmux: the next hop of the route it added for
    /// <see cref="Cidr"/>. Read so that file still parses; nothing uses it.
    /// </summary>
    /// <remarks>
    /// The reader refuses a key it does not know, so dropping the property
    /// would turn every <c>host.json</c> that version wrote into a file that
    /// cannot be read. It is not validated and not written by anything current;
    /// <c>host reset</c> and a swap clear it. <c>archive/zone/</c> is what it
    /// was for.
    /// </remarks>
    public string Gateway { get; set; } = "";

    /// <summary>
    /// Written by an older envmux: the address of the <c>envmux-util</c>
    /// instance its NRPT rule sent the zone to. Read so that file still parses;
    /// nothing uses it.
    /// </summary>
    /// <remarks>Kept for the reason <see cref="Gateway"/> is.</remarks>
    public string Resolver { get; set; } = "";

    public const string DefaultCidr = "10.100.0.1/24";
    /// <summary>
    /// Where DHCP starts, and so where the pinned band ends.
    /// </summary>
    /// <remarks>
    /// It starts at .100 rather than .10 because pinning is the normal path and
    /// DHCP is the fallback, and the first version of this had that backwards:
    /// eight pinned addresses against a hundred and ninety-one leased. A session
    /// with one service takes two, so four of them exhausted it — which happened
    /// in an afternoon's use, and every session after that had to boot, wait, and
    /// be asked what address it got.
    /// </remarks>
    public const string DefaultDhcpRange = "10.100.0.100-10.100.0.200";
    public const string DefaultDnsDomain = "envmux";
    public const string DefaultVmName = "envmux-host";
    public const string DefaultSwitch = "External";

    /// <summary>
    /// A MAC in Hyper-V's own range, so the switch is not being lied to.
    /// </summary>
    /// <remarks>
    /// <c>00:15:5d</c> is the Hyper-V OUI. The last three octets are arbitrary
    /// and fixed: one workstation, one VM, one address, and a collision would
    /// take a second envmux VM on the same switch.
    /// </remarks>
    public const string DefaultMac = "00:15:5D:E5:60:01";

    /// <summary>
    /// The one bridge every session's instance is attached to.
    /// </summary>
    /// <remarks>
    /// Not <c>incusbr0</c>. <c>apply_defaults</c> creates that one and this
    /// design does not use it: the whole point is a bridge whose dnsmasq serves
    /// <see cref="DnsDomain"/>, and renaming the default would be fighting the
    /// seed for no gain.
    /// </remarks>
    public const string DefaultNetwork = "envmux0";

    /// <summary>
    /// The ZFS pool <c>apply_defaults</c> makes on a host envmux builds, which
    /// the seeded default profile takes its root from.
    /// </summary>
    /// <remarks>
    /// The seed's, and nobody else's. It is <c>local</c> because that is what
    /// IncusOS calls the pool it creates; on a daemon that already existed the
    /// pool is whatever its owner made — <c>default</c>, on btrfs, on the one
    /// this was first pointed at. So nothing on the session path names a pool:
    /// an instance takes its root disk from the daemon's default profile, and
    /// a creation request that said <c>local</c> would be refused by every host
    /// envmux did not build. Anything that finds itself wanting this constant
    /// outside the seed wants the profile instead.
    /// </remarks>
    public const string Pool = "local";

    public const string DefaultImage = "debian/13/cloud";

    /// <summary>
    /// The official image remote, and deliberately the only one.
    /// </summary>
    /// <remarks>
    /// Incus 7.x has had repeated critical vulnerabilities in image handling —
    /// arbitrary host file read and write through a crafted <c>metadata.yaml</c>
    /// template, path traversal on backup import and on image fingerprints.
    /// Pulling from anywhere else is trusting a stranger with the host, and
    /// there is no shell on that host to clean up with afterwards.
    /// </remarks>
    public const string DefaultImageServer = "https://images.linuxcontainers.org";

    /// <summary>envmux builds and owns a Hyper-V VM.</summary>
    public const string HyperV = "hyperv";

    /// <summary>envmux attaches to an Incus daemon that already existed.</summary>
    public const string Incus = "incus";

    public const string DefaultProvider = HyperV;

    /// <summary>Whether the host is a VM envmux built, as opposed to one it was pointed at.</summary>
    [JsonIgnore]
    public bool IsHyperV => Provider.Equals(HyperV, StringComparison.OrdinalIgnoreCase);

    public const string FileName = "host.json";

    /// <summary>The client certificate and its key, beside this file.</summary>
    public const string CertificateFileName = "envmux-cli.crt";

    public const string KeyFileName = "envmux-cli.key";

    private static readonly JsonSerializerOptions Json = new()
    {
        TypeInfoResolver = WireJsonContext.Default,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    /// <summary>
    /// Where per-workstation state lives: <c>~/.envmux</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The home directory rather than a platform application-data folder, and
    /// the same path on every platform. Everything in here is something a person
    /// has reason to look at, edit, copy to another machine or delete —
    /// <c>host.json</c>, a certificate, downloaded images, the VM's disks — and
    /// none of that belongs somewhere you need a file manager's address bar to
    /// reach.
    /// </para>
    /// <para>
    /// It shares a name with the per-project state directory, which is
    /// deliberate: one name for "envmux's things", whichever tree you are
    /// standing in. They never hold the same filenames, so a session run in your
    /// home directory is not a collision.
    /// </para>
    /// <para>
    /// <c>ENVMUX_HOME</c> overrides it, so a test — or a second host — can have
    /// one of its own without touching the real one.
    /// </para>
    /// </remarks>
    public static string Directory =>
        Environment.GetEnvironmentVariable("ENVMUX_HOME") is { Length: > 0 } home
            ? home
            : System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                Config.SessionConfig.StateDirectory);

    /// <summary>The VM's disks, and the seeded media they were built from.</summary>
    public static string VmDirectory => System.IO.Path.Combine(Directory, "vm");

    /// <summary>The file itself.</summary>
    public static string Location => System.IO.Path.Combine(Directory, FileName);

    public static string CertificatePath => System.IO.Path.Combine(Directory, CertificateFileName);

    public static string KeyPath => System.IO.Path.Combine(Directory, KeyFileName);

    /// <summary>Read the file, or hand back the defaults when there is none.</summary>
    public static HostConfig Load()
    {
        if (!File.Exists(Location))
        {
            return new HostConfig();
        }

        try
        {
            return WireJson.Deserialize<HostConfig>(File.ReadAllText(Location), Json) ?? new HostConfig();
        }
        catch (JsonException e)
        {
            throw new ConfigException($"{Location}: {e.Explain()}", e);
        }
    }

    /// <summary>
    /// Write the file, all at once or not at all.
    /// </summary>
    /// <remarks>
    /// Through a temporary file and a move, rather than in place. Every session
    /// on this workstation reads this file, and a reader that arrives during a
    /// partial write gets either a parse error or a half-configured host — and
    /// the half it would be missing is the fingerprint, which is the whole of
    /// the trust decision.
    /// </remarks>
    public void Save()
    {
        System.IO.Directory.CreateDirectory(Directory);

        var temporary = Location + ".new";
        File.WriteAllText(temporary, WireJson.Serialize(this, Json) + Environment.NewLine);
        File.Move(temporary, Location, overwrite: true);
    }

    /// <summary>The bridge's own address, which is also what answers names inside the instances.</summary>
    [JsonIgnore]
    public IPAddress BridgeAddress => IPAddress.Parse(Cidr.Split('/')[0]);

    /// <summary>The range as a network address and a prefix length.</summary>
    [JsonIgnore]
    public IPNetwork Range
    {
        get
        {
            var parts = Cidr.Split('/');
            var prefix = int.Parse(parts[1], CultureInfo.InvariantCulture);
            return new IPNetwork(Mask(IPAddress.Parse(parts[0]), prefix), prefix);
        }
    }

    /// <summary>
    /// Everything wrong with this file, in the order it is worth fixing.
    /// </summary>
    /// <remarks>
    /// Checked rather than trusted, because these values are copied into a disk
    /// image that is then installed unattended. A malformed CIDR becomes a VM
    /// that boots to a network nobody can reach, and there is no shell on it to
    /// find that out from.
    /// </remarks>
    public IReadOnlyList<string> Problems()
    {
        var problems = new List<string>();

        var parts = Cidr.Split('/');
        if (parts.Length != 2 ||
            !IPAddress.TryParse(parts[0], out var bridge) ||
            bridge.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork ||
            !int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var prefix))
        {
            problems.Add($"cidr '{Cidr}' is not an IPv4 address and prefix, like {DefaultCidr}");
            return problems;
        }

        if (prefix is < 8 or > 30)
        {
            problems.Add($"cidr '{Cidr}' has a /{prefix.ToString(CultureInfo.InvariantCulture)}, which is " +
                         "either too big to route to one VM or too small to hold a session");
            return problems;
        }

        var range = new IPNetwork(Mask(bridge, prefix), prefix);

        // Empty is a range nobody set, which is what an adopted network often
        // has: dnsmasq then leases from the whole subnet, and pinning has to
        // look at the leases rather than rely on a band of its own.
        if (DhcpRanges() is not { } ranges)
        {
            problems.Add(
                $"dhcpRange '{DhcpRange}' is not two addresses separated by a hyphen, like {DefaultDhcpRange}");
        }
        else
        {
            foreach (var (first, last) in ranges)
            {
                var text = ranges.Count == 1 ? DhcpRange : $"{first}-{last}";

                if (!range.Contains(first) || !range.Contains(last))
                {
                    problems.Add($"dhcpRange '{text}' is not inside cidr '{Cidr}'");
                }

                if (Compare(first, last) > 0)
                {
                    problems.Add($"dhcpRange '{text}' starts after it ends");
                }

                if (Compare(bridge, first) >= 0)
                {
                    problems.Add(
                        $"dhcpRange '{text}' starts at or below the bridge itself ({bridge}) — " +
                        "leave headroom above it for pinned addresses");
                }
            }
        }

        var domain = DnsDomain.Trim().ToLowerInvariant();
        if (domain.Length == 0 || Slug.From(domain) != domain)
        {
            problems.Add($"dnsDomain '{DnsDomain}' is not a DNS label");
        }

        // The name goes into a URL and onto a Linux interface, and Incus holds
        // it to the rules of the second: fifteen characters, and nothing a path
        // would read as anything but a name.
        if (Network.Length is 0 or > 15 ||
            Network is "." or ".." ||
            !Network.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.'))
        {
            problems.Add(
                $"network '{Network}' is not an Incus network name — up to 15 letters, digits, " +
                $"'-', '_' or '.', like {DefaultNetwork}");
        }

        // gateway and resolver are not checked: nothing reads them, and a value
        // an older envmux wrote must not stop a host that works from working.

        // The Hyper-V fields only have to be sound when Hyper-V is the backend.
        // Under the Incus provider they are unused, so a placeholder MAC is not
        // a problem to report.
        if (IsHyperV)
        {
            var octets = Mac.Split(':', '-');
            if (octets.Length != 6 || !octets.All(o =>
                    o.Length == 2 && int.TryParse(o, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out _)))
            {
                problems.Add($"mac '{Mac}' is not six hex octets");
            }

            // The seed makes one bridge, by that name, on a VM that has no
            // other to adopt. Any other name here is every session attaching to
            // a network the host was never given.
            if (!Network.Equals(DefaultNetwork, StringComparison.Ordinal))
            {
                problems.Add(
                    $"network '{Network}' is not what a '{HyperV}' host has — the seed creates {DefaultNetwork}, " +
                    $"and adopting another is the '{Incus}' provider's");
            }
        }

        if (!Provider.Equals(HyperV, StringComparison.OrdinalIgnoreCase) &&
            !Provider.Equals(Incus, StringComparison.OrdinalIgnoreCase))
        {
            problems.Add($"provider '{Provider}' is not one envmux knows — it is '{HyperV}' or '{Incus}'");
        }

        return problems;
    }

    /// <summary>
    /// The address to pin an instance at, counting up from the bridge.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Pinned addresses live above the bridge and below the DHCP range, which is
    /// what the headroom in the default range is for. Pinning is what makes a
    /// connection string writable before the instance has booted — the
    /// alternative is creating it, starting it, and polling its state for an
    /// address that DHCP has not handed out yet.
    /// </para>
    /// <para>
    /// An adopted network may have no DHCP range at all, and then there is no
    /// band to stay inside: dnsmasq leases from the whole subnet, so the whole
    /// subnet above the bridge is where a pinned address goes too. What keeps
    /// the two apart then is <see cref="FirstFreePinned"/> being told what is
    /// leased, not the arithmetic here.
    /// </para>
    /// </remarks>
    public IPAddress? Pinned(int index) =>
        index >= 0 && index < PinnedCapacity ? Add(BridgeAddress, index + 1) : null;

    /// <summary>How many addresses there are between the bridge and the DHCP range.</summary>
    /// <remarks>
    /// Worked out rather than counted. It was a loop over <see cref="Pinned"/>
    /// while the band was always a few dozen addresses; with no DHCP range on a
    /// <c>/16</c> it is sixty-five thousand, and <c>envmux host status</c> asks.
    /// </remarks>
    [JsonIgnore]
    public int PinnedCapacity
    {
        get
        {
            if (DhcpRanges() is not { } ranges)
            {
                return 0;
            }

            var prefix = int.Parse(Cidr.Split('/')[1], CultureInfo.InvariantCulture);
            var bridge = Number(BridgeAddress);

            // The broadcast address is never an instance's, whatever the range
            // says. Below that, the lowest address DHCP may hand out is the
            // ceiling.
            var hostBits = prefix == 0 ? uint.MaxValue : ~(uint.MaxValue << (32 - prefix));
            var ceiling = bridge | hostBits;

            foreach (var (first, _) in ranges)
            {
                ceiling = Math.Min(ceiling, Number(first));
            }

            return ceiling > bridge + 1 ? (int)Math.Min(ceiling - bridge - 1, int.MaxValue) : 0;
        }
    }

    /// <summary>
    /// The first pinned address nothing else has, or null when there is none.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The choice, separated from the asking. What is taken comes from two
    /// places on a live host — every instance's pinned <c>eth0</c> address, and
    /// the network's leases — and neither is this file's business. Given them,
    /// which address to use is arithmetic, and arithmetic can be tested without
    /// a daemon.
    /// </para>
    /// <para>
    /// Null means the band is full, which is DHCP and one extra round trip
    /// rather than a failure.
    /// </para>
    /// </remarks>
    /// <param name="taken">
    /// Addresses already in use, as text. Anything that is not an IPv4 address —
    /// an IPv6 lease, an empty string — is passed over rather than refused,
    /// because the lease table has both families in it.
    /// </param>
    public IPAddress? FirstFreePinned(IEnumerable<string> taken)
    {
        var used = new HashSet<uint>();

        foreach (var text in taken)
        {
            if (IsIPv4(text, out var address))
            {
                used.Add(Number(address));
            }
        }

        // Bounded by what is taken, not by the size of the band: every address
        // passed over is one out of the set, so a /16 with three instances on
        // it is four steps.
        var capacity = PinnedCapacity;
        for (var i = 0; i < capacity; i++)
        {
            var candidate = Add(BridgeAddress, i + 1);
            if (!used.Contains(Number(candidate)))
            {
                return candidate;
            }
        }

        return null;
    }

    /// <summary>
    /// <see cref="DhcpRange"/> as addresses: none when it is empty, null when it does not parse.
    /// </summary>
    /// <remarks>
    /// A list, because <c>ipv4.dhcp.ranges</c> is one. envmux only ever writes a
    /// single range, but an adopted network's is read from the daemon as it
    /// stands, and refusing a host over a second range somebody else configured
    /// would be refusing it over nothing: all that matters here is where the
    /// lowest one starts.
    /// </remarks>
    private List<(IPAddress First, IPAddress Last)>? DhcpRanges()
    {
        var ranges = new List<(IPAddress, IPAddress)>();

        if (DhcpRange.Trim().Length == 0)
        {
            return ranges;
        }

        foreach (var range in DhcpRange.Split(','))
        {
            var dash = range.IndexOf('-', StringComparison.Ordinal);
            if (dash < 0 ||
                !IsIPv4(range[..dash].Trim(), out var first) ||
                !IsIPv4(range[(dash + 1)..].Trim(), out var last))
            {
                return null;
            }

            ranges.Add((first, last));
        }

        return ranges;
    }

    /// <summary>Whether this is an IPv4 address written the way anybody would write one.</summary>
    /// <remarks>
    /// Four parts, counted, because the parser is more generous than that:
    /// <c>10.100.2</c> is an address to it — <c>10.100.0.2</c>, by a rule from
    /// the 1980s — and a typo that parses is worse than one that does not.
    /// </remarks>
    private static bool IsIPv4(string text, out IPAddress address) =>
        IPAddress.TryParse(text, out address!) &&
        address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork &&
        text.Count(c => c == '.') == 3;

    private static uint Number(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        return ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) | ((uint)bytes[2] << 8) | bytes[3];
    }

    private static IPAddress Add(IPAddress address, int offset)
    {
        var bytes = address.GetAddressBytes();
        var value = ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) | ((uint)bytes[2] << 8) | bytes[3];
        value += (uint)offset;

        return new IPAddress(new[]
        {
            (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value,
        });
    }

    private static IPAddress Mask(IPAddress address, int prefix)
    {
        var bytes = address.GetAddressBytes();
        var value = ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) | ((uint)bytes[2] << 8) | bytes[3];
        var mask = prefix == 0 ? 0u : uint.MaxValue << (32 - prefix);
        value &= mask;

        return new IPAddress(new[]
        {
            (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value,
        });
    }

    private static int Compare(IPAddress a, IPAddress b)
    {
        var x = a.GetAddressBytes();
        var y = b.GetAddressBytes();

        for (var i = 0; i < Math.Min(x.Length, y.Length); i++)
        {
            if (x[i] != y[i])
            {
                return x[i].CompareTo(y[i]);
            }
        }

        return 0;
    }

    /// <summary>Whether there is enough here to talk to a host at all.</summary>
    [JsonIgnore]
    public bool IsProvisioned =>
        Api.Length > 0 && Fingerprint.Length > 0 && File.Exists(CertificatePath) && File.Exists(KeyPath);
}
