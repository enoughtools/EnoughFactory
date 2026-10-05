using System.Net;

using Envmux.Host;
using Envmux.Incus;

namespace Envmux.Tests;

/// <summary>
/// What the utility instance is sent, which is everything it ever knows.
/// </summary>
/// <remarks>
/// It is provisioned once, by cloud-init, from a document nobody sees again — so
/// the document is what is tested. A forwarder that came up pointing at the
/// wrong bridge, or bound to every address, is a failure that shows as "names do
/// not resolve" on a workstation two hops away.
/// </remarks>
public class UtilityTests
{
    private static readonly IPAddress Bridge = IPAddress.Parse("10.100.0.1");
    private static readonly IPAddress Pinned = IPAddress.Parse("10.100.0.2");

    private static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeSeconds(1_789_000_000);

    [Fact]
    public void TheForwarderKnowsOneZoneAndOneServer()
    {
        var lines = Utility.DnsmasqConfig("envmux", Bridge, Pinned).Split('\n');

        Assert.Contains("server=/envmux/10.100.0.1", lines);

        // Nothing of its own: not the instance's resolv.conf, not its hosts
        // file. One server line is then the whole of what it can answer.
        Assert.Contains("no-resolv", lines);
        Assert.Contains("no-hosts", lines);
        Assert.Single(lines, l => l.StartsWith("server=", StringComparison.Ordinal));
    }

    [Fact]
    public void ItBindsItsOwnAddressAndNothingElse()
    {
        var lines = Utility.DnsmasqConfig("envmux", Bridge, Pinned).Split('\n');

        // By address, never by interface: the same document goes to a container,
        // where the interface is eth0, and to a VM, where it is enp5s0. And only
        // that address, which is what keeps it off the loopback port 53 that
        // systemd-resolved's stub already holds.
        Assert.Contains("listen-address=10.100.0.2", lines);
        Assert.Contains("bind-interfaces", lines);
        Assert.DoesNotContain(lines, l => l.StartsWith("interface=", StringComparison.Ordinal));
        Assert.DoesNotContain("bind-dynamic", lines);
    }

    [Fact]
    public void ItCachesNothingBecauseSessionsComeBackAtNewAddresses()
    {
        Assert.Contains("cache-size=0", Utility.DnsmasqConfig("envmux", Bridge, Pinned).Split('\n'));
    }

    [Fact]
    public void AnAdoptedNetworksZoneIsForwardedAsItIs()
    {
        // The Incus default, on a bridge nobody gave a dns.domain.
        var config = Utility.DnsmasqConfig("incus", IPAddress.Parse("10.252.20.1"), IPAddress.Parse("10.252.20.2"));

        Assert.Contains("server=/incus/10.252.20.1\n", config, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("")]
    [InlineData("envmux/8.8.8.8\nserver=")]
    [InlineData("en vmux")]
    [InlineData("envmux'; reboot; '")]
    public void AZoneThatIsNotADnsNameIsRefusedRatherThanWritten(string zone)
    {
        // It goes into a YAML block and a shell command, and an adopted
        // network's dns.domain is whatever somebody typed into a daemon.
        Assert.Throws<ArgumentException>(() => Utility.DnsmasqConfig(zone, Bridge, Pinned));
        Assert.Throws<ArgumentException>(() => Utility.Probe(zone, Pinned));
    }

    [Fact]
    public void TheUnitRunsTheBinaryAgainstOurFileAndKeepsTrying()
    {
        var unit = Utility.Unit();

        Assert.Contains($"--conf-file={Utility.ConfigPath}", unit, StringComparison.Ordinal);
        Assert.Contains("--keep-in-foreground", unit, StringComparison.Ordinal);

        // bind-interfaces exits when the address is not up yet, which at boot
        // it is not. Restarting without a limit is what makes that survivable.
        Assert.Contains("Restart=always", unit, StringComparison.Ordinal);
        Assert.Contains("StartLimitIntervalSec=0", unit, StringComparison.Ordinal);
    }

    [Fact]
    public void UserDataIsACloudConfigDocument()
    {
        var data = Utility.UserData("envmux", Bridge, Pinned);

        // Exactly this, first. Anything else and cloud-init ignores the lot
        // without a word.
        Assert.StartsWith("#cloud-config\n", data, StringComparison.Ordinal);

        // Shipped to a Linux machine from a Windows one.
        Assert.DoesNotContain('\r', data);
        Assert.DoesNotContain('\t', data);
    }

    [Fact]
    public void UserDataInstallsTheBinaryWithoutThePackagedService()
    {
        var lines = Utility.UserData("envmux", Bridge, Pinned).Split('\n');

        Assert.Contains("  - dnsmasq-base", lines);
        Assert.DoesNotContain("  - dnsmasq", lines);
        Assert.Contains($"  - [systemctl, enable, --now, {Utility.UnitName}]", lines);
    }

    [Fact]
    public void UserDataCarriesBothFilesAsLiteralBlocks()
    {
        var data = Utility.UserData("envmux", Bridge, Pinned);

        Assert.Contains($"  - path: {Utility.ConfigPath}\n", data, StringComparison.Ordinal);
        Assert.Contains($"  - path: /etc/systemd/system/{Utility.UnitName}\n", data, StringComparison.Ordinal);

        // Every line of each file is in there, indented under `content: |` —
        // six spaces, being deeper than the key that introduces the block.
        foreach (var line in Utility.DnsmasqConfig("envmux", Bridge, Pinned)
                     .Split('\n', StringSplitOptions.RemoveEmptyEntries)
                     .Concat(Utility.Unit().Split('\n', StringSplitOptions.RemoveEmptyEntries)))
        {
            Assert.Contains($"\n      {line}\n", data, StringComparison.Ordinal);
        }

        // The unit's blank lines stay blank. Indented, they are trailing
        // whitespace; unindented, YAML still reads them as part of the block.
        Assert.DoesNotContain(data.Split('\n'), l => l.Length > 0 && l.Trim().Length == 0);
    }

    [Fact]
    public void TheFingerprintMovesWhenWhatItWouldBeToldMoves()
    {
        var one = Utility.Fingerprint(Utility.UserData("envmux", Bridge, Pinned));

        Assert.Equal(one, Utility.Fingerprint(Utility.UserData("envmux", Bridge, Pinned)));
        Assert.NotEqual(one, Utility.Fingerprint(Utility.UserData("incus", Bridge, Pinned)));
        Assert.NotEqual(one, Utility.Fingerprint(Utility.UserData("envmux", IPAddress.Parse("10.100.0.254"), Pinned)));
        Assert.NotEqual(one, Utility.Fingerprint(Utility.UserData("envmux", Bridge, IPAddress.Parse("10.100.0.3"))));
    }

    [Fact]
    public void AContainerIsPinnedOnTheHostsNetworkAndStartsWithTheHost()
    {
        var host = new HostConfig { Network = "incusbr0", Cidr = "10.252.20.1/24", DnsDomain = "incus" };
        var spec = Utility.Spec(host, "10.252.20.2", Utility.Container, Now);

        Assert.Equal(Utility.InstanceName, spec.Name);
        Assert.Equal("container", spec.Type);
        Assert.False(spec.Start);

        var eth0 = spec.Devices!["eth0"];
        Assert.Equal("nic", eth0["type"]);
        Assert.Equal("incusbr0", eth0["network"]);
        Assert.Equal("10.252.20.2", eth0["ipv4.address"]);
        Assert.Equal("eth0", eth0["name"]);

        Assert.Equal("true", spec.Config!["boot.autostart"]);
        Assert.Equal("512MiB", spec.Config["limits.memory"]);
        Assert.Equal("1", spec.Config["limits.cpu"]);
        Assert.False(spec.Config.ContainsKey("security.secureboot"));

        Assert.Contains("server=/incus/10.252.20.1", spec.Config["cloud-init.user-data"], StringComparison.Ordinal);
        Assert.Contains("listen-address=10.252.20.2", spec.Config["cloud-init.user-data"], StringComparison.Ordinal);
    }

    [Fact]
    public void AVirtualMachineIsTheSamePullWithADifferentType()
    {
        var host = new HostConfig();
        var container = Utility.Spec(host, "10.100.0.2", Utility.Container, Now);
        var machine = Utility.Spec(host, "10.100.0.2", Utility.VirtualMachine, Now);

        Assert.Equal("virtual-machine", machine.Type);

        // The alias names both variants; the type on the instance is what makes
        // the daemon ask the remote for the VM one.
        Assert.Equal(container.Source, machine.Source);
        Assert.Equal("image", machine.Source.Type);
        Assert.Equal(HostConfig.DefaultImage, machine.Source.Alias);
        Assert.Equal("simplestreams", machine.Source.Protocol);
        Assert.Equal(HostConfig.DefaultImageServer, machine.Source.Server);
        Assert.Equal("pull", machine.Source.Mode);

        // What a container's interface is called inside it. A VM's firmware
        // decides that for itself, and it does not decide on eth0.
        Assert.False(machine.Devices!["eth0"].ContainsKey("name"));

        Assert.Equal("false", machine.Config!["security.secureboot"]);

        // The same document either way, so the fingerprint says nothing about
        // kind and a container that replaced a VM is still adopted.
        Assert.Equal(container.Config![Utility.ConfigLabel], machine.Config[Utility.ConfigLabel]);
    }

    [Fact]
    public void ItIsOursWithoutBeingASession()
    {
        var spec = Utility.Spec(new HostConfig(), "10.100.0.2", Utility.Container, Now);
        var instance = new Instance { Name = spec.Name, Config = spec.Config! };

        Assert.True(Utility.IsOurs(instance));

        // The schema label is what prune, code and logs take to mean "a
        // session". A prune --all that removed the zone's resolver would take
        // every session's name with it.
        Assert.False(InstanceSpec.IsOurs(instance));
        Assert.False(InstanceSpec.IsImage(instance));
    }

    [Fact]
    public void SomebodyElsesInstanceOfTheSameNameIsNotOurs()
    {
        Assert.False(Utility.IsOurs(new Instance { Name = Utility.InstanceName }));

        Assert.False(Utility.IsOurs(new Instance
        {
            Name = "something-else",
            Config = new Dictionary<string, string> { [Utility.Label] = Utility.LabelValue },
        }));
    }

    [Theory]
    [InlineData("lxc | qemu", true)]
    [InlineData("qemu", true)]
    [InlineData("lxc", false)]
    [InlineData("", false)]
    public void OnlyADaemonWithQemuIsAskedForAVirtualMachine(string driver, bool expected)
    {
        Assert.Equal(expected, Utility.SupportsVirtualMachines(driver));
    }

    [Fact]
    public void TheFirstFreePinnedAddressIsTaken()
    {
        var host = new HostConfig();

        Assert.Equal("10.100.0.2", Utility.ChooseAddress(host, "", []));
        Assert.Equal("10.100.0.4", Utility.ChooseAddress(host, "", ["10.100.0.2", "10.100.0.3", "fd42::2", ""]));
    }

    [Fact]
    public void TheAddressTheWorkstationAlreadyPointsAtIsKeptWhenItIsFree()
    {
        var host = new HostConfig();

        Assert.Equal("10.100.0.7", Utility.ChooseAddress(host, "10.100.0.7", ["10.100.0.2"]));

        // Held by something else now: a session took it while there was no
        // utility instance. Moving is better than colliding.
        Assert.Equal("10.100.0.2", Utility.ChooseAddress(host, "10.100.0.7", ["10.100.0.7"]));
    }

    [Theory]
    [InlineData("10.100.0.1")]   // the bridge
    [InlineData("10.100.0.150")] // inside the DHCP range
    [InlineData("192.168.1.2")]  // not on the network at all
    [InlineData("not-an-address")]
    public void APreferredAddressThatIsNotAPinnedOneIsPassedOver(string preferred)
    {
        Assert.Equal("10.100.0.2", Utility.ChooseAddress(new HostConfig(), preferred, []));
    }

    [Fact]
    public void AFullBandIsNoAddressRatherThanSomebodyElses()
    {
        var host = new HostConfig { DhcpRange = "10.100.0.4-10.100.0.200" };

        Assert.Null(Utility.ChooseAddress(host, "", ["10.100.0.2", "10.100.0.3"]));
    }

    [Fact]
    public void ANetworkWithNoDhcpRangePinsAroundItsLeases()
    {
        // The real remote: incusbr0 as Incus made it, leasing from the whole
        // subnet. What keeps the utility instance off somebody's address is the
        // lease table, not a band.
        var host = new HostConfig { Network = "incusbr0", Cidr = "10.252.20.1/24", DhcpRange = "", DnsDomain = "incus" };

        Assert.Equal("10.252.20.4", Utility.ChooseAddress(host, "", ["10.252.20.2", "10.252.20.3", "10.252.20.117"]));

        // And the address host.json already names is kept, although
        // FirstFreePinned on its own would never hand it out.
        var wired = host with { Resolver = "10.252.20.9" };
        Assert.Equal("10.252.20.9", Utility.ChooseAddress(wired, wired.Resolver, ["10.252.20.2"]));
        Assert.Equal("10.252.20.3", Utility.ChooseAddress(wired, wired.Resolver, ["10.252.20.2", "10.252.20.9"]));
    }

    [Fact]
    public void TheDaemonsDriverListIsReadOffTheServer()
    {
        using var document = System.Text.Json.JsonDocument.Parse(
            """{"auth":"trusted","environment":{"driver":"lxc | qemu","driver_version":"6.0.4 | 10.0.2","server_version":"7.0.1"}}""");

        var server = new IncusResponse("sync", 200, "", document.RootElement.Clone()).As<ServerInfo>()!;

        Assert.Equal("lxc | qemu", server.Environment.Driver);
        Assert.True(Utility.SupportsVirtualMachines(server.Environment.Driver));
    }

    [Fact]
    public void TheProbeAsksThePinnedAddressForTheInstancesOwnName()
    {
        var probe = Utility.Probe("envmux", Pinned);

        // Listening first, so "cloud-init is still working" and "it is up and
        // does not resolve" are different exit codes and different sentences.
        Assert.StartsWith("ss -lun | grep -qF '10.100.0.2:53 ' || exit 53\n", probe, StringComparison.Ordinal);
        Assert.EndsWith($" 10.100.0.2 {Utility.InstanceName}.envmux 54\n", probe, StringComparison.Ordinal);
        Assert.DoesNotContain('\r', probe);

        // The Python travels inside one pair of single quotes, so it cannot
        // contain one: exactly the pair around the grep pattern, and its own.
        Assert.Equal(4, probe.Count(c => c == '\''));
    }
}
