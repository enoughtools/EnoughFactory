using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;

using Envmux.Incus;

namespace Envmux.Host;

/// <summary>What the utility instance is right now, for a status line.</summary>
/// <param name="Exists">Whether there is an <see cref="Utility.InstanceName"/> that envmux made.</param>
/// <param name="IsRunning">Whether it is up — which is not the same as answering.</param>
/// <param name="Address">The address it is pinned at, or empty when it has none.</param>
/// <param name="Kind">"container" or "virtual-machine"; empty when it does not exist.</param>
internal sealed record UtilityStatus(bool Exists, bool IsRunning, string Address, string Kind);

/// <summary>
/// The instance that answers DNS for the session zone, where the bridge cannot be asked directly.
/// </summary>
/// <remarks>
/// <para>
/// Nothing here knows which kind of host it is on. A host envmux built has no
/// firewall in front of its bridge and leaves <see cref="HostConfig.Resolver"/>
/// empty, so it has never needed one of these; a daemon that already existed
/// usually does. The instance is made the same way on either, from what
/// <c>host.json</c> says about the network and nothing else — its root disk is
/// whatever the daemon's default profile gives it, as a session's is.
/// </para>
/// <para>
/// A forwarder and nothing else. The bridge's own dnsmasq already knows every
/// instance on the network — sessions, services, the containers the Docker shim
/// makes — because Incus tells it as each one is created. So there is nothing
/// to register and nothing to go stale: this instance takes a query for the
/// zone and asks the bridge, over the bridge, which Incus always permits.
/// </para>
/// <para>
/// Why it exists at all, when the bridge could be asked directly: a query from
/// the workstation to the bridge address is a packet to the <em>host's</em>
/// INPUT chain on an address that is not its LAN one, and a host firewall — ufw,
/// or the rules Docker installs — commonly drops exactly that. A query to an
/// instance is forwarded rather than delivered, and the FORWARD path for the
/// bridge is one Incus opens itself. Same packet, one hop further, and it takes
/// the road that is already known to be clear because every session uses it.
/// </para>
/// <para>
/// Provisioned by cloud-init rather than by exec, so that neither the exec API
/// nor a VM's agent is on the critical path to it working — and so that it comes
/// back after a host reboot with nothing from envmux involved. Exec is used only
/// to <em>ask</em> whether it is answering yet.
/// </para>
/// <para>
/// Identified by name and by a label of its own, not by
/// <see cref="InstanceSpec.Keys.Schema"/>. That label is what makes something a
/// session to <c>envmux prune</c>, <c>envmux code</c> and <c>envmux logs</c>, and
/// a prune that offered to remove the zone's resolver would be taking every
/// session's name with it. This is the same arrangement as
/// <see cref="Golden.InstanceName"/>, and for the same reason: it is envmux's,
/// and it is nobody's session.
/// </para>
/// </remarks>
internal static class Utility
{
    /// <summary>
    /// What it is called — which is also the name it resolves as, and so the
    /// name install asks for to prove the whole path.
    /// </summary>
    public const string InstanceName = "envmux-util";

    /// <summary>The label that says an instance of this name is the one envmux made.</summary>
    public const string Label = "user.envmux.utility";

    /// <summary>What <see cref="Label"/> holds: the one job it has.</summary>
    public const string LabelValue = "dns";

    /// <summary>
    /// A fingerprint of what it was provisioned with.
    /// </summary>
    /// <remarks>
    /// cloud-init runs once. An instance made for one zone, or one bridge
    /// address, keeps forwarding to that one however <c>host.json</c> changes —
    /// so what it was given is recorded, and an instance whose record does not
    /// match what would be given now is rebuilt rather than adopted. It holds no
    /// state, which is what makes rebuilding the honest fix.
    /// </remarks>
    public const string ConfigLabel = "user.envmux.utility.config";

    /// <summary>Where the forwarder's configuration is written inside the instance.</summary>
    public const string ConfigPath = "/etc/envmux/dnsmasq.conf";

    /// <summary>The unit that runs it.</summary>
    public const string UnitName = "envmux-dns.service";

    public const string Container = "container";
    public const string VirtualMachine = "virtual-machine";

    /// <summary>How long a container gets to install one package and start it.</summary>
    private static readonly TimeSpan ContainerDeadline = TimeSpan.FromMinutes(5);

    /// <summary>How long a VM gets: the same work, after a firmware, a kernel and an agent.</summary>
    private static readonly TimeSpan VirtualMachineDeadline = TimeSpan.FromMinutes(10);

    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(3);

    /// <summary>
    /// Create the utility instance or adopt the one that is there, and wait until it answers the zone.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Idempotent, and the instance is the fact rather than the file: one that
    /// already exists is adopted at the address <em>it</em> has, whatever
    /// <see cref="HostConfig.Resolver"/> said. That is what a second workstation
    /// attaching to the same daemon needs — its <c>host.json</c> has no resolver
    /// yet, and the right answer is the one the first workstation made.
    /// </para>
    /// <para>
    /// A new one goes at <see cref="HostConfig.Resolver"/> when that is set and
    /// free — the workstation's NRPT rule may already point there — and
    /// otherwise at the first pinned address nothing has.
    /// </para>
    /// <para>
    /// Nothing is saved here. The caller gets the configuration with the
    /// resolver in it and decides when that is written.
    /// </para>
    /// </remarks>
    /// <param name="api">The daemon.</param>
    /// <param name="config">The host, as it stands.</param>
    /// <param name="report">Told what is happening, a line at a time. The caller indents.</param>
    /// <param name="ct">Cancellation. A cancelled wait leaves the instance, and the next run adopts it.</param>
    /// <returns><paramref name="config"/> with <see cref="HostConfig.Resolver"/> set to the pinned address.</returns>
    /// <exception cref="IncusException">It could not be made, or it never answered.</exception>
    public static async Task<HostConfig> EnsureAsync(
        IncusApi api,
        HostConfig config,
        Action<string>? report,
        CancellationToken ct)
    {
        report ??= _ => { };

        var preferred = config.Resolver;

        if (await api.InstanceAsync(InstanceName, ct).ConfigureAwait(false) is { } existing)
        {
            if (!IsOurs(existing))
            {
                throw new IncusException(
                    $"there is already an instance called {InstanceName} on this daemon and envmux did not make it " +
                    $"(it has no {Label} label). Rename or remove it; envmux will not replace something it does not own.");
            }

            var at = PinnedAddress(existing);

            if (at.Length > 0 &&
                Value(existing, ConfigLabel).Equals(Fingerprint(UserData(config, at)), StringComparison.Ordinal))
            {
                report($"{InstanceName} is already here, a {Describe(existing.Type)} at {at}");

                if (!existing.IsRunning)
                {
                    report("starting it");
                    await api.StartAsync(InstanceName, ct).ConfigureAwait(false);
                }

                Demand(await AwaitAnswerAsync(api, config, at, existing.Type, report, ct).ConfigureAwait(false));
                return config with { Resolver = at };
            }

            // Made for a different zone, a different bridge, or by a version
            // that provisioned it differently. It keeps its address if it can,
            // because that is the half the workstation's NRPT rule remembers.
            report($"{InstanceName} was made for a different configuration; rebuilding it");
            await RemoveAsync(api, ct).ConfigureAwait(false);

            if (at.Length > 0)
            {
                preferred = at;
            }
        }

        var taken = await TakenAsync(api, config.Network, ct).ConfigureAwait(false);

        var address = ChooseAddress(config, preferred, taken)
            ?? throw new IncusException(
                $"there is no free pinned address on {config.Network} for {InstanceName} — every address between " +
                $"the bridge ({config.BridgeAddress}) and the DHCP range ({config.DhcpRange}) is taken. " +
                $"`{Commands.CommandName.Current} prune` frees the ones stale sessions hold.");

        var driver = (await api.ServerAsync(ct).ConfigureAwait(false)).Environment.Driver;

        if (!SupportsVirtualMachines(driver))
        {
            report(
                $"this daemon has no VM driver ({(driver.Length > 0 ? driver : "none reported")}), " +
                $"so {InstanceName} is a system container");
        }
        else
        {
            report($"creating {InstanceName} as a virtual machine at {address}, from {config.Image}");

            if (await TryVirtualMachineAsync(api, config, address, report, ct).ConfigureAwait(false) is not { } refused)
            {
                return config with { Resolver = address };
            }

            report($"a virtual machine would not run here ({refused}) — using a system container instead");
            await RemoveAsync(api, ct).ConfigureAwait(false);
        }

        report($"creating {InstanceName} as a system container at {address}, from {config.Image}");
        await CreateAsync(api, config, address, Container, report, ct).ConfigureAwait(false);

        Demand(await AwaitAnswerAsync(api, config, address, Container, report, ct).ConfigureAwait(false));
        return config with { Resolver = address };
    }

    /// <summary>
    /// Make it as a VM, and say why not if this daemon will not run one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A daemon that lists qemu and still cannot run a VM is a nested one
    /// without the extensions passed through, or one with no VM image for this
    /// architecture. Neither is worth failing an install over when a container
    /// does the same job, so both ways of not working are an answer rather than
    /// an exception: a create or start that is refused, and a machine that
    /// "runs" and never once lets a command in.
    /// </para>
    /// <para>
    /// The third way is not. A VM that booted, was asked, and does not resolve
    /// the zone is a fact about the network, and doing it all again as a
    /// container would spend five more minutes arriving at the same sentence.
    /// </para>
    /// </remarks>
    /// <returns>Null when it answers; otherwise why a VM is not an option here.</returns>
    private static async Task<string?> TryVirtualMachineAsync(
        IncusApi api,
        HostConfig config,
        string address,
        Action<string> report,
        CancellationToken ct)
    {
        try
        {
            await CreateAsync(api, config, address, VirtualMachine, report, ct).ConfigureAwait(false);
        }
        catch (IncusException e)
        {
            return FirstLine(e.Message);
        }

        var answer = await AwaitAnswerAsync(api, config, address, VirtualMachine, report, ct).ConfigureAwait(false);

        if (!answer.Ok && answer.Reached)
        {
            throw new IncusException(answer.Why);
        }

        return answer.Ok ? null : "it started, and its agent never came up";
    }

    /// <summary>How the wait ended.</summary>
    /// <param name="Ok">It answered.</param>
    /// <param name="Reached">A command ran inside it at least once, so what it said is about it and not about exec.</param>
    /// <param name="Why">The failure, as a whole sentence for a person. Empty when <paramref name="Ok"/>.</param>
    private readonly record struct Answer(bool Ok, bool Reached, string Why);

    private static void Demand(Answer answer)
    {
        if (!answer.Ok)
        {
            throw new IncusException(answer.Why);
        }
    }

    /// <summary>What there is, without changing any of it.</summary>
    /// <remarks>
    /// An instance of the right name that envmux did not make is reported as not
    /// existing, because everything a caller would do with the answer — point
    /// NRPT at it, remove it — is something to do only to our own.
    /// </remarks>
    public static async Task<UtilityStatus> StatusAsync(IncusApi api, HostConfig config, CancellationToken ct)
    {
        if (await api.InstanceAsync(InstanceName, ct).ConfigureAwait(false) is not { } instance || !IsOurs(instance))
        {
            return new UtilityStatus(false, false, "", "");
        }

        var address = PinnedAddress(instance);

        // Pinned is what is wanted, and it is on the instance whether or not it
        // is running. One made by hand without a pin is asked instead — only
        // when it is up, since a stopped instance has no state worth a call.
        if (address.Length == 0 && instance.IsRunning)
        {
            var state = await api.StateAsync(InstanceName, ct).ConfigureAwait(false);
            address = state is null ? "" : Addresses(state).FirstOrDefault(a => InRange(config, a)) ?? "";
        }

        return new UtilityStatus(true, instance.IsRunning, address, instance.Type);
    }

    /// <summary>Stop it and remove it.</summary>
    /// <remarks>
    /// Only the one envmux made. Host reset has to call this by name, the way it
    /// names the golden instance: it carries no session labels, so nothing that
    /// enumerates sessions finds it — and left behind it sits on the network and
    /// turns that network's delete into an in-use error.
    /// </remarks>
    /// <returns>True if it was removed, false if there was nothing of ours to remove.</returns>
    public static async Task<bool> RemoveAsync(IncusApi api, CancellationToken ct)
    {
        if (await api.InstanceAsync(InstanceName, ct).ConfigureAwait(false) is not { } instance || !IsOurs(instance))
        {
            return false;
        }

        // Not worth a graceful shutdown: it holds nothing, and a VM that never
        // finished booting would spend the whole timeout ignoring the request.
        await api.StopAsync(InstanceName, 5, ct).ConfigureAwait(false);

        return await api.DeleteAsync(InstanceName, ct).ConfigureAwait(false);
    }

    // What it is made from. Pure, so that what a daemon is sent can be read in a test.

    /// <summary>
    /// The forwarder's whole configuration.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>no-resolv</c> and <c>no-hosts</c> make it answer from nothing of its
    /// own: not the instance's <c>/etc/resolv.conf</c>, not its hosts file. The
    /// one <c>server=</c> line is then everything it knows, and a query for any
    /// other zone is refused rather than forwarded somewhere — NRPT only sends
    /// it the zone, and a resolver that would answer for the internet on a
    /// routed address is an open one.
    /// </para>
    /// <para>
    /// <c>bind-interfaces</c> with one <c>listen-address</c> binds that address
    /// and no other, which is what keeps it clear of whatever already holds
    /// port 53 on loopback — systemd-resolved's stub, on this image.
    /// </para>
    /// <para>
    /// <c>cache-size=0</c> because the thing being named is an instance that is
    /// torn down and made again, often at a different address, within a minute.
    /// The bridge is one hop away; a cache here could only ever be wrong.
    /// </para>
    /// </remarks>
    /// <param name="zone">The zone to forward — <see cref="HostConfig.DnsDomain"/>.</param>
    /// <param name="bridge">Who to ask: the bridge's own dnsmasq.</param>
    /// <param name="listen">The address this instance is pinned at.</param>
    public static string DnsmasqConfig(string zone, IPAddress bridge, IPAddress listen) =>
        new StringBuilder()
            .Line("# Written by envmux. This instance forwards one zone to the bridge and knows nothing itself.")
            .Line("no-resolv")
            .Line("no-hosts")
            .Line($"server=/{Zone(zone)}/{bridge}")
            .Line($"listen-address={listen}")
            .Line("bind-interfaces")
            .Line("cache-size=0")
            .Line("log-facility=-")
            .ToString();

    /// <summary>
    /// The unit that runs the forwarder.
    /// </summary>
    /// <remarks>
    /// <para>
    /// envmux's own unit over <c>dnsmasq-base</c>, rather than the
    /// <c>dnsmasq</c> package and the unit it ships. That package starts its
    /// daemon from the postinst with Debian's defaults — every address, port 53
    /// — and only afterwards reads what was asked for; its init script also
    /// offers itself to <c>resolvconf</c> as the machine's own resolver on
    /// 127.0.0.1, where this does not listen. The binary alone has neither
    /// opinion.
    /// </para>
    /// <para>
    /// <c>Restart=always</c> with no start limit is what makes
    /// <c>bind-interfaces</c> safe across a reboot. Bound that way dnsmasq exits
    /// if its address is not on an interface yet, and at boot it is not: the
    /// address comes from DHCP, a moment after the network target is reached.
    /// It fails, waits two seconds, and starts.
    /// </para>
    /// </remarks>
    public static string Unit() =>
        new StringBuilder()
            .Line("[Unit]")
            .Line("Description=envmux: DNS for the session zone, forwarded to the bridge")
            .Line("After=network-online.target")
            .Line("Wants=network-online.target")
            .Line("StartLimitIntervalSec=0")
            .Line()
            .Line("[Service]")
            .Line($"ExecStart=/usr/sbin/dnsmasq --keep-in-foreground --conf-file={ConfigPath}")
            .Line("Restart=always")
            .Line("RestartSec=2")
            .Line()
            .Line("[Install]")
            .Line("WantedBy=multi-user.target")
            .ToString();

    /// <summary>
    /// The <c>cloud-init.user-data</c> that turns the stock image into the forwarder.
    /// </summary>
    /// <remarks>
    /// <c>write_files</c> runs before packages are installed and <c>runcmd</c>
    /// after, so by the time the unit is enabled both the binary and its
    /// configuration are there. The first line is not a comment to cloud-init:
    /// without <c>#cloud-config</c> exactly, the rest is ignored in silence.
    /// </remarks>
    public static string UserData(string zone, IPAddress bridge, IPAddress listen)
    {
        var data = new StringBuilder()
            .Line("#cloud-config")
            .Line("package_update: true")
            .Line("packages:")
            .Line("  - dnsmasq-base")
            .Line("write_files:");

        WriteFile(data, ConfigPath, DnsmasqConfig(zone, bridge, listen));
        WriteFile(data, $"/etc/systemd/system/{UnitName}", Unit());

        return data
            .Line("runcmd:")
            .Line("  - [systemctl, daemon-reload]")
            .Line($"  - [systemctl, enable, --now, {UnitName}]")
            .ToString();
    }

    private static string UserData(HostConfig config, string address) =>
        UserData(config.DnsDomain, config.BridgeAddress, IPAddress.Parse(address));

    /// <summary>One <c>write_files</c> entry, as a literal block.</summary>
    private static void WriteFile(StringBuilder data, string path, string content)
    {
        data.Line($"  - path: {path}")
            .Line("    permissions: '0644'")
            .Line("    content: |");

        foreach (var line in content.TrimEnd(Shell.Newline).Split(Shell.Newline))
        {
            // An empty line in a literal block carries no indentation, and one
            // that did would be trailing whitespace for somebody's linter.
            data.Line(line.Length > 0 ? $"      {line}" : "");
        }
    }

    /// <summary>
    /// The creation request.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The same pull a session makes when there is no golden snapshot, from the
    /// same one remote. For a VM only <c>type</c> differs: the alias names both
    /// variants and the daemon asks the remote for the one that matches.
    /// </para>
    /// <para>
    /// The nic names the network itself rather than inheriting the default
    /// profile's, for the reason a session's does: on a daemon envmux did not
    /// build that profile points at <c>incusbr0</c>. A VM's is left unnamed —
    /// <c>name</c> is what a container's interface is called inside it, and a
    /// VM's firmware decides that for itself.
    /// </para>
    /// <para>
    /// <c>boot.autostart</c> because the workstation's NRPT rule outlives a
    /// reboot of the Incus host, and a zone whose resolver stays down until
    /// somebody runs envmux again is every session unreachable by name.
    /// </para>
    /// <para>
    /// Secure boot is turned off for a VM. Whether an image boots under it is a
    /// property of the image — a signed shim, or not — and <c>host.json</c> may
    /// name any image; one that does not is a machine that sits in its firmware
    /// for ten minutes looking exactly like a slow boot. There is nothing on
    /// this instance for a measured boot to protect: it holds one line of
    /// configuration, and that line is in this file.
    /// </para>
    /// </remarks>
    public static InstancesPost Spec(HostConfig config, string address, string kind, DateTimeOffset now)
    {
        var userData = UserData(config, address);

        var eth0 = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["type"] = "nic",
            ["network"] = config.Network,
            ["ipv4.address"] = address,
        };

        if (kind == Container)
        {
            eth0["name"] = "eth0";
        }

        var settings = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [Label] = LabelValue,
            [ConfigLabel] = Fingerprint(userData),
            [InstanceSpec.Keys.Created] = now.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture),
            ["boot.autostart"] = "true",
            ["limits.cpu"] = "1",
            ["limits.memory"] = "512MiB",
            ["cloud-init.user-data"] = userData,
        };

        if (kind == VirtualMachine)
        {
            settings["security.secureboot"] = "false";
        }

        return new InstancesPost
        {
            Name = InstanceName,
            Type = kind,
            Description = $"envmux: answers DNS for .{config.DnsDomain} by asking the bridge",
            Source = new InstanceSource
            {
                Type = "image",
                Alias = config.Image,
                Protocol = "simplestreams",
                Server = config.ImageServer,
                Mode = "pull",
            },
            Config = settings,
            Devices = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal)
            {
                ["eth0"] = eth0,
            },
            Start = false,
        };
    }

    /// <summary>
    /// Ask, from inside, whether the forwarder answers.
    /// </summary>
    /// <remarks>
    /// <para>
    /// From inside because, when this runs, the workstation has no route to the
    /// subnet yet — wiring comes after. What is asked is the real question all
    /// the same: a DNS query for this instance's own name, sent to the pinned
    /// address, which only gets an answer if dnsmasq is bound there <em>and</em>
    /// the bridge answers for the zone.
    /// </para>
    /// <para>
    /// The image has no <c>dig</c> and no <c>nslookup</c>, and installing one to
    /// ask one question is not worth the package. It has Python, because
    /// cloud-init is written in it. Where it somehow does not, a listening
    /// socket is taken as the answer.
    /// </para>
    /// <para>
    /// Exit 0: answered. <see cref="NotListening"/>: nothing is bound yet, so
    /// cloud-init is still working. <see cref="NotResolving"/>: bound, and the
    /// name did not resolve through it. Deliberately not 1 or 2, because those
    /// are what an exec that never ran the script comes back as — a VM whose
    /// agent is not up, a shell that is not there — and the difference between
    /// "it said no" and "it could not be asked" decides whether a container is
    /// worth trying instead.
    /// </para>
    /// </remarks>
    public static string Probe(string zone, IPAddress listen) =>
        new StringBuilder()
            .Line($"ss -lun | grep -qF '{listen}:53 ' || exit {Code(NotListening)}")
            .Line("command -v python3 >/dev/null 2>&1 || exit 0")

            // A raw string has whatever line endings the checkout gave this file,
            // and the far side wants one kind.
            .Line($"exec python3 -c '{Source}' {listen} {InstanceName}.{Zone(zone)} {Code(NotResolving)}")
            .ToString();

    /// <summary>The probe's exit code for "nothing is bound to the address yet".</summary>
    public const int NotListening = 53;

    /// <summary>The probe's exit code for "bound, and the name does not resolve through it".</summary>
    public const int NotResolving = 54;

    private static string Code(int exit) => exit.ToString(CultureInfo.InvariantCulture);

    private static string Source => ProbeSource.ReplaceLineEndings("\n");

    /// <summary>One A query over UDP, and whether it was answered. No single quotes: it travels inside a pair.</summary>
    private const string ProbeSource =
        """
        import socket, sys
        no = int(sys.argv[3])
        labels = sys.argv[2].encode().split(b".")
        query = b"em\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00"
        query += b"".join(bytes([len(l)]) + l for l in labels) + b"\x00\x00\x01\x00\x01"
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(3)
        try:
            s.sendto(query, (sys.argv[1], 53))
            reply = s.recv(512)
        except OSError:
            sys.exit(no)
        ok = reply[:2] == query[:2] and reply[3] & 15 == 0 and reply[6:8] != b"\x00\x00"
        sys.exit(0 if ok else no)
        """;

    /// <summary>Whether a daemon's driver list includes the one that runs VMs.</summary>
    /// <param name="driver"><c>environment.driver</c> from <c>GET /1.0</c> — "lxc", or "lxc | qemu".</param>
    public static bool SupportsVirtualMachines(string driver) =>
        driver.Contains("qemu", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Where a new utility instance goes.
    /// </summary>
    /// <remarks>
    /// The address it had, or the one <c>host.json</c> already names, when that
    /// is a pinned address nothing else holds — the workstation's NRPT rule may
    /// point there, and moving the resolver for no reason breaks a wiring that
    /// was working. Otherwise the first free one.
    /// </remarks>
    /// <param name="config">The host.</param>
    /// <param name="preferred">An address to keep if possible, or empty.</param>
    /// <param name="taken">Every address something else has: pinned, or leased.</param>
    public static string? ChooseAddress(HostConfig config, string preferred, IEnumerable<string> taken)
    {
        var used = new HashSet<string>(taken, StringComparer.Ordinal);

        if (preferred.Length > 0 &&
            IPAddress.TryParse(preferred, out var wanted) &&
            !used.Contains(wanted.ToString()) &&
            IsPinned(config, wanted))
        {
            return wanted.ToString();
        }

        // Which never hands out config.Resolver — right for a session, and right
        // here too: had the resolver's address been usable it was taken above.
        return config.FirstFreePinned(used)?.ToString();
    }

    private static bool IsPinned(HostConfig config, IPAddress address)
    {
        for (var i = 0; config.Pinned(i) is { } candidate; i++)
        {
            if (candidate.Equals(address))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>A short, stable name for a user-data document.</summary>
    public static string Fingerprint(string userData) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(userData)))[..16];

    /// <summary>
    /// The zone, refused if it is anything but a DNS name.
    /// </summary>
    /// <remarks>
    /// It goes into a YAML document and a shell command. <c>host.json</c> is
    /// checked long before it gets here, and an adopted network's
    /// <c>dns.domain</c> is whatever the daemon's owner typed.
    /// </remarks>
    private static string Zone(string zone)
    {
        var value = zone.Trim().TrimEnd('.').ToLowerInvariant();

        return value.Length > 0 && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '.')
            ? value
            : throw new ArgumentException($"'{zone}' is not a DNS zone", nameof(zone));
    }

    // The daemon.

    private static async Task CreateAsync(
        IncusApi api,
        HostConfig config,
        string address,
        string kind,
        Action<string> report,
        CancellationToken ct)
    {
        await api.CreateAsync(Spec(config, address, kind, DateTimeOffset.UtcNow), report, ct).ConfigureAwait(false);
        await api.StartAsync(InstanceName, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Poll until the forwarder answers, or say why it did not.
    /// </summary>
    /// <remarks>
    /// An exec that throws is not a failure while the clock is running: a VM
    /// refuses every exec until its agent is up, and that is most of a minute
    /// after the instance reports Running.
    /// </remarks>
    private static async Task<Answer> AwaitAnswerAsync(
        IncusApi api,
        HostConfig config,
        string address,
        string kind,
        Action<string> report,
        CancellationToken ct)
    {
        var name = $"{InstanceName}.{config.DnsDomain}";
        var deadline = DateTimeOffset.UtcNow + (kind == VirtualMachine ? VirtualMachineDeadline : ContainerDeadline);
        var probe = Probe(config.DnsDomain, IPAddress.Parse(address));

        report($"waiting for it to answer {name} at {address}");

        int? last = null;
        var refusal = "";

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                var result = await Command.ShellAsync(api, InstanceName, probe, ct: ct).ConfigureAwait(false);

                if (result.Ok)
                {
                    report($"{name} resolves through {address}");
                    return new Answer(true, true, "");
                }

                // Only the script's own verdicts count as having asked. Anything
                // else is an exec that ended before it got that far, and what
                // it printed is the reason.
                if (result.ExitCode is NotListening or NotResolving)
                {
                    last = result.ExitCode;
                }
                else
                {
                    refusal = FirstLine(result.Text);
                }
            }
            catch (IncusException e)
            {
                refusal = FirstLine(e.Message);
            }

            if (DateTimeOffset.UtcNow >= deadline)
            {
                break;
            }

            await Task.Delay(PollInterval, ct).ConfigureAwait(false);
        }

        var why = last switch
        {
            null => $"envmux could never run a command in it to ask ({(refusal.Length > 0 ? refusal : "no reason given")})",
            NotResolving =>
                $"dnsmasq is listening at {address} but {name} does not resolve through it, which means the " +
                $"bridge at {config.BridgeAddress} is not answering for '{config.DnsDomain}' — check the " +
                "network's dns.domain and dns.mode",
            _ => "nothing is listening on port 53 there — cloud-init did not finish installing dnsmasq: " +
                 await DiagnoseAsync(api, ct).ConfigureAwait(false),
        };

        return new Answer(
            false,
            last is not null,
            $"{InstanceName} is running but never answered DNS: {why}. It has been left in place to look at, " +
            "and running this again adopts it.");
    }

    /// <summary>What cloud-init has to say for itself. Best effort: this is already the failure path.</summary>
    private static async Task<string> DiagnoseAsync(IncusApi api, CancellationToken ct)
    {
        try
        {
            var result = await Command.ShellAsync(
                api,
                InstanceName,
                "cloud-init status 2>&1 | tail -n 1; tail -n 4 /var/log/cloud-init-output.log 2>/dev/null",
                ct: ct).ConfigureAwait(false);

            var lines = result.Text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            return lines.Length > 0 ? string.Join(" | ", lines) : "cloud-init said nothing";
        }
        catch (IncusException e)
        {
            return FirstLine(e.Message);
        }
    }

    /// <summary>
    /// Every address something on the network already has — other than this instance's own.
    /// </summary>
    /// <remarks>
    /// <see cref="IncusApi.TakenAddressesAsync"/> with one thing left out. When
    /// the utility instance is rebuilt it should come back where it was, because
    /// that is the address the workstation's NRPT rule remembers; and its own
    /// pin, or a lease dnsmasq has not yet let go of, would otherwise be the
    /// reason it could not.
    /// </remarks>
    private static async Task<IReadOnlyCollection<string>> TakenAsync(IncusApi api, string network, CancellationToken ct)
    {
        var instances = await api.InstancesAsync(ct).ConfigureAwait(false);
        var leases = await api.LeasesAsync(network, ct).ConfigureAwait(false);

        return InstanceSpec.TakenAddresses(
            instances.Where(i => i.Name != InstanceName),
            leases.Where(l => !l.Hostname.Equals(InstanceName, StringComparison.Ordinal)));
    }

    // Reading an instance.

    /// <summary>Whether an instance of this name is the one envmux made.</summary>
    public static bool IsOurs(Instance instance) =>
        instance.Name == InstanceName && instance.Config.ContainsKey(Label);

    private static string PinnedAddress(Instance instance) =>
        instance.Devices.TryGetValue("eth0", out var eth0) && eth0.TryGetValue("ipv4.address", out var pinned)
            ? pinned
            : "";

    private static string Value(Instance instance, string key) =>
        instance.Config.TryGetValue(key, out var value) ? value : "";

    /// <summary>
    /// Every global IPv4 address, on whichever interface.
    /// </summary>
    /// <remarks>
    /// Not <see cref="InstanceState.Address"/>, which reads <c>eth0</c> and
    /// nothing else. That is right for a container and wrong for a VM, whose one
    /// interface is called whatever its firmware enumerated it as —
    /// <c>enp5s0</c>, on the machine type Incus builds.
    /// </remarks>
    private static IEnumerable<string> Addresses(InstanceState state) =>
        state.Network
            .Where(n => n.Key != "lo")
            .SelectMany(n => n.Value.Addresses)
            .Where(a => a.Family.Equals("inet", StringComparison.Ordinal) &&
                        a.Scope.Equals("global", StringComparison.Ordinal))
            .Select(a => a.Address);

    private static bool InRange(HostConfig config, string address) =>
        IPAddress.TryParse(address, out var parsed) && config.Range.Contains(parsed);

    private static string Describe(string kind) =>
        kind == VirtualMachine ? "virtual machine" : "system container";

    private static string FirstLine(string text)
    {
        var end = text.IndexOfAny(['\r', '\n']);
        return (end < 0 ? text : text[..end]).Trim();
    }
}
