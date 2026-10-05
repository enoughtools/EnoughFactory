using System.Formats.Tar;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Host;

/// <summary>One file in the install seed: its name in the tar, and its bytes.</summary>
internal sealed record SeedFile(string Name, string Contents);

/// <summary>
/// The install seed: everything IncusOS needs to know before it has ever booted.
/// </summary>
/// <remarks>
/// <para>
/// A tar of JSON files written to the start of the install image's second
/// partition. JSON rather than YAML because the installer accepts either and
/// .NET can write one without a dependency — the seed is a machine-authored
/// artefact, so the readability argument for YAML does not apply.
/// </para>
/// <para>
/// Field names are checked against <c>incus-osd/api/seed</c> in the
/// <c>lxc/incus-os</c> repository rather than against the prose documentation.
/// The schema is young — IncusOS reached GA in November 2025 — and the two have
/// been out of step: the certificate list, in particular, is documented in
/// places as a top-level key of <c>incus.yaml</c> and is in fact part of Incus'
/// own <c>InitPreseed</c>, nested under <c>preseed</c>. Seeding it at the top
/// level is accepted silently and installs nothing, which surfaces much later
/// as a host that answers <c>auth: untrusted</c> for no visible reason.
/// </para>
/// </remarks>
internal static class Seed
{
    /// <summary>The schema version every seed file carries.</summary>
    public const string Version = "1";

    /// <summary>
    /// The interface name IncusOS gives the one Hyper-V adapter.
    /// </summary>
    /// <remarks>
    /// Only a label: the interface is matched by <c>hwaddr</c>, which is why
    /// the MAC is decided before the VM is created rather than read back after.
    /// </remarks>
    public const string InterfaceName = "enp0s3";

    private static readonly JsonSerializerOptions Options = new()
    {
        TypeInfoResolver = WireJsonContext.Default,
        // The seed structs are Go, and Go's tags are snake case. Dictionary
        // keys are deliberately left alone: `core.https_address` and
        // `ipv4.dhcp.ranges` are Incus config keys, not property names, and a
        // policy applied to them would rewrite them into nonsense.
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    /// <summary>Every file the seed contains, for this host configuration.</summary>
    public static IReadOnlyList<SeedFile> Files(HostConfig config, string certificatePem) =>
    [
        new SeedFile("install.json", Write(Install())),
        new SeedFile("network.json", Write(Network(config))),
        new SeedFile("kernel.json", Write(Kernel())),
        new SeedFile("incus.json", Write(Incus(config, certificatePem))),
    ];

    /// <summary>
    /// The file whose presence triggers an install at all.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>missing_secure_boot</c> is not optional on Hyper-V. Hyper-V's UEFI
    /// cannot enrol IncusOS' custom Secure Boot keys, so IncusOS must run with
    /// Secure Boot off — and it refuses to run with Secure Boot off unless it is
    /// told that is deliberate. The consequence is that boot integrity binds to
    /// PCR 4 rather than PCR 7, which is expected and is documented as a risk
    /// rather than hidden as an implementation detail.
    /// </para>
    /// <para>
    /// <c>missing_tpm</c> stays false, and there is no configuration in which it
    /// should be set here: IncusOS will not run with Secure Boot disabled *and*
    /// a software TPM, so a Hyper-V VM without <c>Enable-VMTPM</c> has no
    /// working combination at all. It fails at install rather than later.
    /// </para>
    /// <para>
    /// <c>target</c> is omitted so the installer picks the only suitable disk
    /// itself. The VM is built with exactly two — a blank system disk and the
    /// install media — and the media is not a candidate, so "the only suitable
    /// disk" is unambiguous. Naming <c>/dev/sda</c> here would be asserting a
    /// device order that nothing guarantees.
    /// </para>
    /// </remarks>
    private static InstallSeed Install() => new()
    {
        Version = Version,
        ForceInstall = false,
        ForceReboot = false,
        Security = new InstallSecurity { MissingSecureBoot = true, MissingTpm = false },
    };

    /// <summary>
    /// The one interface, pinned to IPv4.
    /// </summary>
    /// <remarks>
    /// IncusOS prefers IPv6 and, left alone, comes up with a management endpoint
    /// only on its IPv6 address. From a Windows client that is a host which
    /// installed perfectly and cannot be reached, with nothing in the symptom
    /// pointing at the cause. Asking for <c>dhcp4</c> explicitly is the whole
    /// fix, and <c>required_for_online: both</c> makes the boot wait for the
    /// address rather than racing incusd against it.
    /// </remarks>
    private static NetworkSeed Network(HostConfig config) => new()
    {
        Version = Version,
        Interfaces =
        [
            new NetworkInterface
            {
                Name = InterfaceName,
                Hwaddr = config.Mac.Replace('-', ':').ToLowerInvariant(),
                RequiredForOnline = "both",
                Addresses = ["dhcp4"],
            },
        ],
    };

    /// <summary>
    /// The kernel seed, which declares no console — deliberately.
    /// </summary>
    /// <remarks>
    /// <para>
    /// It was tempting to name <c>ttyS0</c> here so the installer's log, which
    /// otherwise exists only as pixels on a framebuffer, could be read as text
    /// off the COM1 pipe Hyper-V exposes. The comment that used to sit here said
    /// it "costs nothing when it does not work." That was wrong, and expensively.
    /// </para>
    /// <para>
    /// IncusOS <c>202608201218</c> on a Generation 2 VM does not enumerate that
    /// port as <c>/dev/ttyS0</c>. Told to configure a console there, its startup
    /// runs <c>stty -F ttyS0 115200</c>, the device does not exist, and the whole
    /// boot stops with <c>!! IncusOS critical startup error !!</c> — a host that
    /// installs perfectly and then refuses to come up. A declared console is not
    /// free on this image; it is fatal.
    /// </para>
    /// <para>
    /// So the seed declares none. The COM1 pipe still exists and does no harm,
    /// and the installer is still followed from outside — by the framebuffer
    /// heuristic that was always the fallback. If a platform is ever found that
    /// presents the port to this OS, the console goes back, behind evidence that
    /// the device is actually there.
    /// </para>
    /// </remarks>
    private static KernelSeed Kernel() => new()
    {
        Version = Version,
        Console = [],
    };

    /// <summary>
    /// The Incus application seed: the bridge, the profile, and the trust.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>apply_defaults</c> creates the ZFS pool <c>local</c> out of the
    /// remaining free space, creates <c>incusbr0</c>, and listens on 8443 —
    /// three things that would otherwise each need spelling out, and one of
    /// which, the pool, is what makes copying a golden instance nearly free.
    /// </para>
    /// <para>
    /// <c>incusbr0</c> is created and then unused. It is left alone
    /// deliberately: composing <c>apply_defaults</c> with an explicit network is
    /// additive rather than exclusive, so the alternative is dropping the
    /// defaults and spelling out the storage pool too, which trades a harmless
    /// unused bridge for the one piece of the seed there is no second chance to
    /// get right.
    /// </para>
    /// </remarks>
    private static IncusSeed Incus(HostConfig config, string certificatePem)
    {
        return new IncusSeed
        {
            Version = Version,
            ApplyDefaults = true,
            Preseed = new IncusPreseed
            {
                Config = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    // All interfaces, both families: the address the VM gets
                    // from the LAN's DHCP is not known when this is written.
                    ["core.https_address"] = "[::]:8443",
                },

                Certificates =
                [
                    new IncusCertificate
                    {
                        Name = ClientCertificate.SubjectName,
                        Type = "client",
                        Certificate = certificatePem,
                        Description = "envmux CLI, seeded offline",
                    },
                ],

                // envmux0 by name, and not config.Network. The seed builds a VM
                // that has no networks yet, so there is nothing to adopt and the
                // one it makes is envmux's own.
                Networks =
                [
                    new IncusNetwork
                    {
                        Name = HostConfig.DefaultNetwork,
                        Type = "bridge",
                        Description = NetworkDescription,
                        Config = new Dictionary<string, string>(NetworkConfig(config), StringComparer.Ordinal),
                    },
                ],

                Profiles =
                [
                    new IncusProfile
                    {
                        Name = "default",
                        Description = "envmux: one address per instance, root on the local pool",
                        Devices = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal)
                        {
                            ["eth0"] = new(StringComparer.Ordinal)
                            {
                                ["type"] = "nic",
                                ["network"] = HostConfig.DefaultNetwork,
                                ["name"] = "eth0",
                            },
                            ["root"] = new(StringComparer.Ordinal)
                            {
                                ["type"] = "disk",
                                ["path"] = "/",
                                ["pool"] = HostConfig.Pool,
                            },
                        },
                    },
                ],
            },
        };
    }

    /// <summary>
    /// How a bridge envmux made is described — and so how one is told from a
    /// bridge it was only pointed at.
    /// </summary>
    public const string NetworkDescription = "envmux sessions";

    /// <summary>
    /// Whether a network is one envmux created, as opposed to one it adopted.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The description, and nothing cleverer. It is the one thing envmux writes
    /// on a network that nobody else would, it survives a range change, and it
    /// is on the object itself rather than in a file on one workstation — so a
    /// second workstation, or this one after <c>host.json</c> is lost, comes to
    /// the same answer.
    /// </para>
    /// <para>
    /// Not the name. <c>envmux0</c> is only the default, and a bridge somebody
    /// else called that is still somebody else's. Everything that would change
    /// or remove a network asks this first: an adopted network is read and
    /// attached to, never reconfigured and never deleted.
    /// </para>
    /// </remarks>
    public static bool IsOurs(Envmux.Incus.IncusNetworkInfo network) =>
        network.Description.Equals(NetworkDescription, StringComparison.Ordinal);

    /// <summary>
    /// The config a bridge of envmux's own is created with.
    /// </summary>
    /// <remarks>
    /// One source of truth for the two places it is created: the seed, offline,
    /// on a Hyper-V host envmux builds; and the existing-Incus provider, online,
    /// on an Incus daemon that already existed. A range that differed
    /// between them would be a host that resolves and does not route, or routes
    /// and does not resolve, depending which built it. An adopted network never
    /// passes through here: its config is read from the daemon, not written to it.
    /// </remarks>
    /// <param name="config">The host configuration the range and zone come from.</param>
    public static IReadOnlyDictionary<string, string> NetworkConfig(HostConfig config)
    {
        var prefix = config.Cidr.Split('/')[1];

        var network = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["ipv4.address"] = $"{config.BridgeAddress}/{prefix}",
            ["ipv4.nat"] = "true",
            ["ipv4.dhcp"] = "true",
        };

        // Left out rather than written empty. No range is a legal host.json —
        // it is what an adopted network often has — and on a bridge envmux
        // makes it means what Incus means by it: lease from the whole subnet.
        // Added here, in the place it always had, because the seed is compared
        // byte for byte with the one before it.
        if (config.DhcpRange.Trim().Length > 0)
        {
            network["ipv4.dhcp.ranges"] = config.DhcpRange;
        }

        // Off, not merely unrouted. The point of the whole design is one
        // address per environment that a Windows client can reach, and a
        // dual-stack instance is one where half the traffic takes a path the
        // static route does not cover.
        network["ipv6.address"] = "none";

        // What makes `dev-01.envmux` resolve. dnsmasq on this bridge is the
        // only DNS server involved; adding a second one would duplicate lease
        // state and produce two answers for one name.
        network["dns.domain"] = config.DnsDomain;

        return network;
    }

    /// <summary>
    /// The seed as a tar archive, byte for byte what goes on partition 2.
    /// </summary>
    /// <remarks>
    /// Deterministic: fixed modification times, fixed ownership, files in a
    /// fixed order. The same configuration produces the same bytes, which is
    /// what lets a build be checked against the one before it rather than merely
    /// repeated.
    /// </remarks>
    public static byte[] Archive(IReadOnlyList<SeedFile> files)
    {
        using var buffer = new MemoryStream();

        using (var writer = new TarWriter(buffer, TarEntryFormat.Ustar, leaveOpen: true))
        {
            foreach (var file in files)
            {
                var bytes = Encoding.UTF8.GetBytes(file.Contents);

                var entry = new UstarTarEntry(TarEntryType.RegularFile, file.Name)
                {
                    DataStream = new MemoryStream(bytes),
                    Mode = UnixFileMode.UserRead | UnixFileMode.UserWrite |
                           UnixFileMode.GroupRead | UnixFileMode.OtherRead,
                    ModificationTime = DateTimeOffset.UnixEpoch,
                };

                writer.WriteEntry(entry);
            }
        }

        return buffer.ToArray();
    }

    private static string Write<T>(T document) =>
        WireJson.Serialize(document, Options) + "\n";

    /// <summary>A one-line summary of what a seed will do, for the console.</summary>
    public static IEnumerable<string> Describe(HostConfig config)
    {
        yield return $"secure boot   off, declared — vTPM is mandatory in this configuration";
        yield return $"network       {InterfaceName} at {config.Mac.ToLowerInvariant()}, dhcp4, IPv6 off";
        yield return $"api           [::]:8443, trusting {ClientCertificate.SubjectName}";
        yield return $"bridge        {HostConfig.DefaultNetwork} {config.Cidr}, nat, dns zone .{config.DnsDomain}";
        yield return config.DhcpRange.Trim().Length > 0
            ? $"dhcp          {config.DhcpRange} " +
              $"({config.PinnedCapacity.ToString(CultureInfo.InvariantCulture)} pinned addresses below it)"
            : "dhcp          no range of its own — leases and " +
              $"{config.PinnedCapacity.ToString(CultureInfo.InvariantCulture)} pinnable addresses share the subnet";
        yield return $"storage       zfs pool '{HostConfig.Pool}' over the remaining space";
    }
}

// The shapes below mirror the Go structs they are unmarshalled into. They are
// deliberately not a general model of the Incus API: only the fields this seed
// sets exist here, because a field written with the wrong name is accepted and
// ignored, and the failure surfaces as behaviour rather than as an error.

internal sealed record InstallSeed
{
    public required string Version { get; init; }

    public required bool ForceInstall { get; init; }

    public required bool ForceReboot { get; init; }

    public InstallSecurity? Security { get; init; }
}

internal sealed record InstallSecurity
{
    [JsonPropertyName("missing_tpm")]
    public required bool MissingTpm { get; init; }

    public required bool MissingSecureBoot { get; init; }
}

/// <summary>
/// The kernel seed, which is the command line the guest boots with.
/// </summary>
/// <remarks>
/// The Go struct is <c>Console []api.SystemKernelConfigConsole</c> and a
/// version, and nothing else this needs.
/// </remarks>
internal sealed record KernelSeed
{
    public required string Version { get; init; }

    public required IReadOnlyList<KernelConsole> Console { get; init; }
}

internal sealed record KernelConsole
{
    public required string Device { get; init; }

    public required int BaudRate { get; init; }
}

internal sealed record NetworkSeed
{
    public required string Version { get; init; }

    public required IReadOnlyList<NetworkInterface> Interfaces { get; init; }
}

internal sealed record NetworkInterface
{
    public required string Name { get; init; }

    /// <summary>Not <c>hw_addr</c>. The Go tag is one word, so the policy must not split it.</summary>
    [JsonPropertyName("hwaddr")]
    public required string Hwaddr { get; init; }

    public required string RequiredForOnline { get; init; }

    public required IReadOnlyList<string> Addresses { get; init; }
}

internal sealed record IncusSeed
{
    public required string Version { get; init; }

    public required bool ApplyDefaults { get; init; }

    public required IncusPreseed Preseed { get; init; }
}

/// <summary>
/// Incus' own <c>InitPreseed</c>, inlined as the Go struct inlines it.
/// </summary>
/// <remarks>
/// <c>ServerPut</c> is embedded with <c>yaml:",inline"</c>, so <c>config</c> is
/// a sibling of <c>networks</c> and <c>certificates</c> rather than nested
/// under a server key.
/// </remarks>
internal sealed record IncusPreseed
{
    public required IReadOnlyDictionary<string, string> Config { get; init; }

    public required IReadOnlyList<IncusCertificate> Certificates { get; init; }

    public required IReadOnlyList<IncusNetwork> Networks { get; init; }

    public required IReadOnlyList<IncusProfile> Profiles { get; init; }
}

internal sealed record IncusCertificate
{
    public required string Name { get; init; }

    public required string Type { get; init; }

    /// <summary>PEM, which is what the field takes outside of a <c>POST</c>.</summary>
    public required string Certificate { get; init; }

    public string? Description { get; init; }
}

internal sealed record IncusNetwork
{
    public required string Name { get; init; }

    public required string Type { get; init; }

    public string? Description { get; init; }

    public required IReadOnlyDictionary<string, string> Config { get; init; }
}

internal sealed record IncusProfile
{
    public required string Name { get; init; }

    public string? Description { get; init; }

    public required IReadOnlyDictionary<string, Dictionary<string, string>> Devices { get; init; }
}
