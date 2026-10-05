using System.Formats.Tar;
using System.Text;
using System.Text.Json;

using Envmux.Host;

namespace Envmux.Tests;

/// <summary>
/// The seed is authored once, injected into an image, and installed unattended
/// on a machine with no shell. Every one of these checks a thing that would
/// otherwise only be discovered by a VM that boots to nothing.
/// </summary>
public class HostSeedTests
{
    private static JsonDocument File(HostConfig config, string name)
    {
        var file = Seed.Files(config, Certificate()).Single(f => f.Name == name);
        return JsonDocument.Parse(file.Contents);
    }

    /// <summary>A PEM-shaped string. Nothing here parses it; it only has to survive.</summary>
    private static string Certificate() =>
        "-----BEGIN CERTIFICATE-----\nMIIBhTCCASugAwIBAgI=\n-----END CERTIFICATE-----";

    [Fact]
    public void TheSeedIsThreeFilesAndInstallIsOneOfThem()
    {
        var names = Seed.Files(new HostConfig(), Certificate()).Select(f => f.Name).ToList();

        // install.json is what triggers an install at all. Without it the image
        // boots as live media and does nothing.
        Assert.Contains("install.json", names);
        Assert.Contains("network.json", names);
        Assert.Contains("incus.json", names);
    }

    [Fact]
    public void SecureBootIsDeclaredMissingAndTheTpmIsNot()
    {
        // Hyper-V's UEFI cannot enroll IncusOS's own keys, so Secure Boot has to
        // be off and IncusOS has to be told that is deliberate. The TPM half is
        // the opposite: there is no supported configuration with both off, so
        // saying the TPM is missing would produce an install that cannot work.
        var security = File(new HostConfig(), "install.json").RootElement.GetProperty("security");

        Assert.True(security.GetProperty("missing_secure_boot").GetBoolean());
        Assert.False(security.GetProperty("missing_tpm").GetBoolean());
    }

    [Fact]
    public void NoInstallTargetIsNamed()
    {
        // The VM has a blank system disk and the install media, and the media is
        // not a candidate — so the installer's own choice is unambiguous.
        // Naming /dev/sda would be asserting a device order nothing guarantees.
        Assert.False(File(new HostConfig(), "install.json").RootElement.TryGetProperty("target", out _));
    }

    [Fact]
    public void TheInterfaceIsPinnedToIpv4()
    {
        // Left alone, IncusOS comes up with a management endpoint only on IPv6,
        // and from Windows that is a host which installed perfectly and cannot
        // be reached.
        var iface = File(new HostConfig(), "network.json")
            .RootElement.GetProperty("interfaces")[0];

        Assert.Equal(["dhcp4"], iface.GetProperty("addresses").EnumerateArray().Select(a => a.GetString()));
        Assert.Equal("both", iface.GetProperty("required_for_online").GetString());
    }

    [Fact]
    public void TheInterfaceIsMatchedByTheMacDecidedBeforeTheVmExists()
    {
        var config = new HostConfig { Mac = "00-15-5D-AB-CD-EF" };

        var iface = File(config, "network.json").RootElement.GetProperty("interfaces")[0];

        // Colons and lowercase, whichever way it was written down: the seed is
        // compared against what the kernel reports, not against host.json.
        Assert.Equal("00:15:5d:ab:cd:ef", iface.GetProperty("hwaddr").GetString());
    }

    [Fact]
    public void TheHardwareAddressFieldIsOneWord()
    {
        // The Go tag is `hwaddr`. A snake-case policy applied naively turns the
        // property into `hw_addr`, which is accepted, ignored, and produces an
        // interface that never matches.
        var raw = Seed.Files(new HostConfig(), Certificate()).Single(f => f.Name == "network.json").Contents;

        Assert.Contains("\"hwaddr\"", raw, StringComparison.Ordinal);
        Assert.DoesNotContain("hw_addr", raw, StringComparison.Ordinal);
    }

    [Fact]
    public void TheClientCertificateIsNestedUnderPreseed()
    {
        // The correction that matters most in the whole seed. `incus.yaml` is
        // documented in places with a top-level `certificates:` key; the Go
        // struct has only `version`, `apply_defaults` and `preseed`, and the
        // certificate list belongs to Incus' own InitPreseed inside it. Seeded
        // at the top level it is accepted silently and installs nothing, and
        // the symptom arrives much later as `auth: untrusted`.
        var root = File(new HostConfig(), "incus.json").RootElement;

        Assert.False(root.TryGetProperty("certificates", out _));

        var certificates = root.GetProperty("preseed").GetProperty("certificates");
        Assert.Equal(1, certificates.GetArrayLength());
        Assert.Equal("client", certificates[0].GetProperty("type").GetString());
        Assert.Contains("BEGIN CERTIFICATE", certificates[0].GetProperty("certificate").GetString()!, StringComparison.Ordinal);
    }

    [Fact]
    public void ConfigKeysAreNotRewrittenByTheNamingPolicy()
    {
        // `core.https_address` and `ipv4.dhcp.ranges` are Incus config keys, not
        // property names. A naming policy that reached dictionary keys would
        // turn them into something the daemon has never heard of.
        var preseed = File(new HostConfig(), "incus.json").RootElement.GetProperty("preseed");

        Assert.Equal("[::]:8443", preseed.GetProperty("config").GetProperty("core.https_address").GetString());

        var network = preseed.GetProperty("networks")[0].GetProperty("config");
        Assert.Equal(HostConfig.DefaultDhcpRange, network.GetProperty("ipv4.dhcp.ranges").GetString());
        Assert.Equal("none", network.GetProperty("ipv6.address").GetString());
    }

    [Fact]
    public void TheRangeAndTheZoneComeFromTheConfiguration()
    {
        var config = new HostConfig
        {
            Cidr = "10.42.7.1/24",
            DhcpRange = "10.42.7.50-10.42.7.99",
            DnsDomain = "lab",
        };

        var network = File(config, "incus.json")
            .RootElement.GetProperty("preseed").GetProperty("networks")[0].GetProperty("config");

        Assert.Equal("10.42.7.1/24", network.GetProperty("ipv4.address").GetString());
        Assert.Equal("10.42.7.50-10.42.7.99", network.GetProperty("ipv4.dhcp.ranges").GetString());
        Assert.Equal("lab", network.GetProperty("dns.domain").GetString());
    }

    [Fact]
    public void TheSeedEmbedsTheSharedNetworkConfig()
    {
        // The seed and the existing-Incus provider create the same bridge from
        // one source, Seed.NetworkConfig. The seed must actually embed that, or a
        // host built each way would differ in the one thing that has to match.
        var config = new HostConfig { Cidr = "10.42.7.1/24", DhcpRange = "10.42.7.50-10.42.7.99", DnsDomain = "lab" };

        var shared = Seed.NetworkConfig(config);
        var embedded = File(config, "incus.json")
            .RootElement.GetProperty("preseed").GetProperty("networks")[0].GetProperty("config");

        Assert.Equal("10.42.7.1/24", shared["ipv4.address"]);
        Assert.Equal("none", shared["ipv6.address"]);
        Assert.Equal("lab", shared["dns.domain"]);

        foreach (var (key, value) in shared)
        {
            Assert.Equal(value, embedded.GetProperty(key).GetString());
        }
    }

    [Fact]
    public void TheSeededBridgeIsEnvmuxsOwnWhateverTheHostsFileCallsItsNetwork()
    {
        // The seed builds a VM with no networks on it yet. There is nothing to
        // adopt, so the bridge it makes is envmux0 and is described as ours —
        // a `network` left in host.json from a daemon it once pointed at must
        // not rename the one thing the default profile is about to reference.
        var incus = File(new HostConfig { Network = "labbr0" }, "incus.json").RootElement.GetProperty("preseed");

        var network = incus.GetProperty("networks")[0];

        Assert.Equal(HostConfig.DefaultNetwork, network.GetProperty("name").GetString());
        Assert.Equal(Seed.NetworkDescription, network.GetProperty("description").GetString());
        Assert.Equal(
            HostConfig.DefaultNetwork,
            incus.GetProperty("profiles")[0].GetProperty("devices").GetProperty("eth0").GetProperty("network").GetString());
    }

    [Fact]
    public void TheNetworkConfigKeepsItsKeysInTheOrderItAlwaysHad()
    {
        // The archive is compared byte for byte with the one before it, and a
        // dictionary serialises in the order it was filled.
        Assert.Equal(
            ["ipv4.address", "ipv4.nat", "ipv4.dhcp", "ipv4.dhcp.ranges", "ipv6.address", "dns.domain"],
            Seed.NetworkConfig(new HostConfig()).Keys);

        Assert.Equal(HostConfig.DefaultDhcpRange, Seed.NetworkConfig(new HostConfig())["ipv4.dhcp.ranges"]);
    }

    [Fact]
    public void ABridgeWithNoDhcpRangeLeavesTheKeyOutRatherThanEmpty()
    {
        // No range is legal, and means what Incus means by it: lease from the
        // whole subnet. An absent key cannot be misread; an empty string is a
        // value somebody has to interpret.
        var shared = Seed.NetworkConfig(new HostConfig { DhcpRange = "" });

        Assert.False(shared.ContainsKey("ipv4.dhcp.ranges"));
        Assert.Equal("true", shared["ipv4.dhcp"]);

        var embedded = File(new HostConfig { DhcpRange = "" }, "incus.json")
            .RootElement.GetProperty("preseed").GetProperty("networks")[0].GetProperty("config");

        Assert.False(embedded.TryGetProperty("ipv4.dhcp.ranges", out _));

        Assert.Contains(
            Seed.Describe(new HostConfig { DhcpRange = "" }),
            line => line.Contains("no range of its own", StringComparison.Ordinal) &&
                    line.Contains("253", StringComparison.Ordinal));
    }

    [Fact]
    public void ANetworkIsOursByItsDescriptionAndNotByItsName()
    {
        // What stands between `envmux host reset` and somebody else's bridge.
        // The name proves nothing: envmux0 is only a default, and an adopted
        // network called that is still not envmux's to reconfigure or delete.
        Assert.True(Seed.IsOurs(new Envmux.Incus.IncusNetworkInfo
        {
            Name = "envmux0",
            Description = Seed.NetworkDescription,
        }));

        Assert.True(Seed.IsOurs(new Envmux.Incus.IncusNetworkInfo
        {
            Name = "renamed0",
            Description = Seed.NetworkDescription,
        }));

        Assert.False(Seed.IsOurs(new Envmux.Incus.IncusNetworkInfo { Name = "envmux0", Description = "" }));
        Assert.False(Seed.IsOurs(new Envmux.Incus.IncusNetworkInfo { Name = "incusbr0", Description = "the lab bridge" }));
        Assert.False(Seed.IsOurs(new Envmux.Incus.IncusNetworkInfo { Name = "envmux0", Description = "Envmux Sessions" }));
    }

    [Fact]
    public void ABridgeTheDaemonAlreadyHadIsAdoptedAndTheHostFileItGivesIsSound()
    {
        // The shape of the first daemon this was pointed at: one managed
        // bridge, nobody's description on it, no dns.domain and no dhcp ranges.
        // No range is the ordinary case there, not an edge of it — dnsmasq
        // leases from the whole subnet, which is why pinning reads the leases.
        var incusbr0 = new Envmux.Incus.IncusNetworkInfo
        {
            Name = "incusbr0",
            Type = "bridge",
            Config = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["ipv4.address"] = "10.252.20.1/24",
                ["ipv4.nat"] = "true",
            },
        };

        Assert.False(Seed.IsOurs(incusbr0));

        var adopted = new HostConfig
        {
            Provider = HostConfig.Incus,
            Network = incusbr0.Name,
            Cidr = incusbr0.Config["ipv4.address"],
            DhcpRange = "",
            DnsDomain = "incus",
            Gateway = "192.168.19.43",
        };

        Assert.Empty(adopted.Problems());
        Assert.Equal(253, adopted.PinnedCapacity);
        Assert.Equal("10.252.20.2", adopted.FirstFreePinned([])?.ToString());
    }

    [Fact]
    public void TheDefaultProfilePutsEveryInstanceOnTheBridgeAndThePool()
    {
        var devices = File(new HostConfig(), "incus.json")
            .RootElement.GetProperty("preseed").GetProperty("profiles")[0].GetProperty("devices");

        Assert.Equal(HostConfig.DefaultNetwork, devices.GetProperty("eth0").GetProperty("network").GetString());
        Assert.Equal(HostConfig.Pool, devices.GetProperty("root").GetProperty("pool").GetString());
    }

    [Fact]
    public void EverySeedFileCarriesAVersion()
    {
        foreach (var file in Seed.Files(new HostConfig(), Certificate()))
        {
            using var document = JsonDocument.Parse(file.Contents);
            Assert.Equal(Seed.Version, document.RootElement.GetProperty("version").GetString());
        }
    }

    [Fact]
    public void TheArchiveIsATarThatReadsBackAsWhatWentIn()
    {
        var files = Seed.Files(new HostConfig(), Certificate());
        var archive = Seed.Archive(files);

        using var stream = new MemoryStream(archive);
        using var reader = new TarReader(stream);

        var found = new List<string>();

        while (reader.GetNextEntry() is { } entry)
        {
            found.Add(entry.Name);

            using var contents = new MemoryStream();
            entry.DataStream!.CopyTo(contents);

            Assert.Equal(
                files.Single(f => f.Name == entry.Name).Contents,
                Encoding.UTF8.GetString(contents.ToArray()));
        }

        Assert.Equal(files.Select(f => f.Name), found);
    }

    [Fact]
    public void TheArchiveIsTheSameBytesEveryTime()
    {
        // A build that is repeatable is one whose output can be compared with
        // the last one rather than merely produced again.
        var config = new HostConfig();

        Assert.Equal(
            Seed.Archive(Seed.Files(config, Certificate())),
            Seed.Archive(Seed.Files(config, Certificate())));
    }

    [Fact]
    public void TheArchiveFitsTheSeedPartitionSeveralTimesOver()
    {
        // The partition is 100 MiB and this is a few kilobytes of JSON, so this
        // is not a real constraint — it is a tripwire for the day something
        // decides to embed an image in the seed.
        Assert.True(Seed.Archive(Seed.Files(new HostConfig(), Certificate())).Length < DiskImage.SeedPartitionSize);
    }
}
