using System.Globalization;

using Envmux.Host;
using Envmux.Host.Windows;
using Envmux.Incus;

namespace Envmux.Commands;

/// <summary>
/// Everything about the machine sessions run on, rather than about a session.
/// </summary>
/// <remarks>
/// <para>
/// The IncusOS host is built once per workstation and then largely forgotten,
/// which is exactly why every step of building it lives here as a command rather
/// than in a script somebody has to find. There is no shell on the result: if
/// the seed was wrong, or the fingerprint was never pinned, the only way to find
/// out is to ask, and these are the asking.
/// </para>
/// <para>
/// The steps are separate and each is idempotent, because they fail in different
/// places for different people — <c>build</c> needs a downloaded image,
/// <c>vm</c> needs Hyper-V, <c>trust</c> needs the VM to have booted — and a
/// single command that does all three is one that has to be restarted from the
/// top.
/// </para>
/// <para>
/// Nothing here touches this workstation's networking. It used to: a route for
/// the range and an NRPT rule for the zone, added by <c>wire</c>. A session is
/// reached through the browser its window opens and through its ssh alias, both
/// over the host's API, and <c>unwire</c> is kept only to take an older
/// version's wiring back off.
/// </para>
/// </remarks>
internal static class HostCommand
{
    private const string Usage = """
        envmux host — the IncusOS machine sessions run on.

        usage:
          envmux host status
          envmux host init [--cidr <a.b.c.d/n>] [--dhcp <first-last>] [--domain <label>]
                           [--vm <name>] [--switch <name>] [--mac <address>]
          envmux host cert [--force]
          envmux host build <IncusOS.img> [--out <dir>] [--seed-only]
          envmux host vm [--disk <GiB>] [--memory <GiB>] [--cpus <n>]
          envmux host installed
          envmux host screen [--out <path>]
          envmux host console [--seconds <n>]
          envmux host trust [<address>] [--accept]
          envmux host unwire
          envmux host range [--cidr <a.b.c.d/n>] [--dhcp <first-last>]
          envmux host golden
          envmux host reset [--yes] [--keep-down]
          envmux host prepare [--check] [--ssh <user@host>] [--network <name>]
                              [--cidr <a.b.c.d/n>] [--name <client>]

        an Incus that already exists:
          prepare  write the script that readies the Incus host: the API on the
                   network, IPv4 forwarding, a way past Docker's FORWARD rules
                   or ufw for the bridge — the instances' own way out — and,
                   last, a trust token. The script goes to stdout and nothing
                   else does, so it pipes — to the clipboard, to a file — and
                   is pasted into a shell on the host as it is. Its last line
                   is `ENVMUX-TOKEN: <token>`, and `envmux install --token
                   <token>` needs nothing else. --ssh runs it there over your
                   own ssh — the sudo prompt is yours — keeps the token off
                   the screen, and offers to carry straight on into install
                   with it. --check reads and reports, changes nothing, and
                   mints no token. --network and --cidr default to
                   host.json's, or envmux0 on 10.100.0.1/24; --name is what
                   the daemon's trust list will call this client (default:
                   envmux).

        the order, once, for a Hyper-V host:
          init     write host.json — the range, the zone, the VM's name and MAC
          cert     generate the client certificate this host will trust on sight
          build    seed a copy of the install image and convert it to VHDX
          vm       create the Generation 2 VM: secure boot off, vTPM on
                   …start it, let it install, and stop it…
          installed  detach the install media, so it does not install again
          screen   save a picture of the VM's screen. The only way to see what a
                   machine with no shell is doing before its API is up.
          console  the same thing in words, off the VM's serial port. Better when
                   it works; needs media built by a version that seeds a console.
          trust    look at the certificate incusd presents, and pin it
          golden   build the instance every session is copied from

        afterwards:
          range    change the range on a host that is already up: the network
                   object and host.json. Nothing on this workstation follows it,
                   because nothing here routes to it. A network that was adopted
                   (install --network) is refused: its range is its owner's to
                   move.
          unwire   remove the route and the NRPT rule an older envmux added to
                   this workstation. Needs an elevated prompt; nothing to do on
                   a machine that never had them. `wire` no longer exists, and
                   says so.

        recovery:
          reset    tear the host down and build it again. The host is meant to be
                   ephemeral; this is the command that treats it that way. It
                   destroys every session on the host, then reinstalls. A
                   Hyper-V rebuild reseeds trust with nothing to paste; an
                   existing-Incus rebuild re-attaches and needs a trust token
                   (--token). On an existing Incus only what envmux made is
                   removed: its instances, a leftover envmux-util, and the
                   network if envmux created it — an adopted network is left
                   exactly as it is. --keep-down tears down and stops there.
        """;

    public static async Task<int> RunAsync(IReadOnlyList<string> args, CancellationToken ct = default)
    {
        // -h/--help anywhere, not just first: `host reset --help` should print
        // the usage, not start explaining how it is about to tear the host down.
        if (args.Count == 0 || args.Any(a => a is "-h" or "--help"))
        {
            Console.WriteLine(Usage);
            return 0;
        }

        var rest = args.Skip(1).ToList();

        try
        {
            return args[0] switch
            {
                "status" => await StatusAsync(ct).ConfigureAwait(false),
                "init" => Init(rest),
                "cert" => Cert(rest),
                "build" => await BuildAsync(rest, ct).ConfigureAwait(false),
                "vm" => await VmAsync(rest, ct).ConfigureAwait(false),
                "installed" => await InstalledAsync(ct).ConfigureAwait(false),
                "screen" => await ScreenAsync(rest, ct).ConfigureAwait(false),
                "console" => await ConsoleAsync(rest, ct).ConfigureAwait(false),
                "trust" => await TrustAsync(rest, ct).ConfigureAwait(false),
                "wire" => Wire(),
                "unwire" => await UnwireAsync(ct).ConfigureAwait(false),
                "range" => await RangeAsync(rest, ct).ConfigureAwait(false),
                "golden" => await GoldenAsync(ct).ConfigureAwait(false),
                "reset" => await ResetAsync(rest, ct).ConfigureAwait(false),
                "prepare" => await PrepareAsync(rest, ct).ConfigureAwait(false),
                _ => Unknown(args[0]),
            };
        }
        catch (Exception e) when (e is IncusException or CertificateException or DiskImageException
                                      or PowershellException or Process.ProcessException)
        {
            Console.Error.WriteLine($"envmux: {e.Message}");
            return 1;
        }
    }

    /// <summary>How many pinned addresses are spoken for.</summary>
    /// <remarks>
    /// Counted from the instances rather than tracked, because the instances are
    /// the only durable record — envmux keeps no state of its own, and a count
    /// it maintained would be a thing to get out of step.
    /// </remarks>
    private static async Task<int> PinnedInUseAsync(IncusApi api, CancellationToken ct)
    {
        try
        {
            return (await api.InstancesAsync(ct).ConfigureAwait(false))
                .Count(i => i.Devices.TryGetValue("eth0", out var eth0) &&
                            eth0.ContainsKey("ipv4.address"));
        }
        catch (IncusException)
        {
            return 0;
        }
    }

    private static int Unknown(string name)
    {
        Console.Error.WriteLine($"envmux: 'host {name}' is not a thing envmux does");
        Console.Error.WriteLine(Usage);
        return 2;
    }

    // status — the one command that is safe to run at any point, and says which
    // of the others is next.

    private static async Task<int> StatusAsync(CancellationToken ct)
    {
        var config = HostConfig.Load();

        Console.WriteLine($"config     {HostConfig.Location}{(File.Exists(HostConfig.Location) ? "" : "  (not written yet)")}");
        Console.WriteLine($"provider   {(config.IsHyperV ? "hyperv — a VM envmux built" : "incus — a daemon that already existed")}");
        Console.WriteLine($"range      {config.Cidr}   dhcp {(config.DhcpRange.Length > 0 ? config.DhcpRange : "none")}");
        Console.WriteLine($"zone       *.{config.DnsDomain}  — the ssh alias a session answers to; nothing here resolves it");

        // The VM's particulars only where there is a VM. On a daemon envmux
        // attached to they describe nothing, and read as something missing.
        if (config.IsHyperV)
        {
            Console.WriteLine($"vm         {config.VmName} on switch '{config.Switch}' at {config.Mac}");
        }

        foreach (var problem in config.Problems())
        {
            Console.WriteLine($"  problem  {problem}");
        }

        Console.WriteLine(File.Exists(HostConfig.CertificatePath)
            ? $"cert       {HostConfig.CertificatePath}"
            : "cert       none — run `envmux host cert`");

        if (config.IsHyperV && Powershell.IsAvailable && await HyperV.IsAvailableAsync(ct).ConfigureAwait(false))
        {
            var vm = await HyperV.StatusAsync(config.VmName, ct).ConfigureAwait(false);

            Console.WriteLine(vm.Exists
                ? $"hyper-v    {vm.State}, {vm.Disks.Count.ToString(CultureInfo.InvariantCulture)} disk(s)"
                : "hyper-v    no such VM — run `envmux host vm`");

            if (vm.Disks.Count > 1)
            {
                Console.WriteLine("  warning  the install media is still attached — " +
                                  "run `envmux host installed` once the install has finished");
            }
        }

        // An older envmux's route and NRPT rule, if this workstation still has
        // them. Nothing needs them, and a route for a range nothing here should
        // reach is worth knowing about before a VPN lands on the same prefix.
        if (Powershell.IsAvailable)
        {
            await LegacyWiringLinesAsync(config, ct).ConfigureAwait(false);
        }

        if (!config.IsProvisioned)
        {
            Console.WriteLine(config.IsHyperV
                ? "api        not reachable yet — run `envmux host trust` once the VM is up"
                : "api        not attached yet — run `envmux install`");
            return 0;
        }

        Console.WriteLine($"api        https://{IncusClient.Authority(config.Api)}");
        Console.WriteLine($"pinned     {config.Fingerprint}");

        using var client = IncusClient.Connect(config);
        var api = new IncusApi(client);

        try
        {
            var server = await api.ServerAsync(ct).ConfigureAwait(false);

            Console.WriteLine($"incus      {server.Environment.ServerVersion} on " +
                              $"{server.Environment.KernelArchitecture}, storage {server.Environment.Storage}");

            Console.WriteLine((server.IsTrusted, config.IsHyperV) switch
            {
                (true, true) => "auth       trusted — the seeded certificate is doing its job",
                (true, false) => "auth       trusted — this client's certificate is in the daemon's trust store",
                (false, true) => "auth       UNTRUSTED — the certificate was not seeded, or not the one being sent",
                (false, false) => "auth       UNTRUSTED — the daemon does not know this client's certificate; " +
                                  "`envmux install --token <token>` adds it",
            });

            // Asked rather than parsed: the /os/ surface is proxied through
            // Incus and its shape is not documented. That it answers is the
            // whole of what is worth knowing here.
            Console.WriteLine(await api.IsIncusOsAsync(ct).ConfigureAwait(false)
                ? "os         IncusOS — /os/1.0 answers, so updates are A/B and there is no shell"
                : "os         not IncusOS — /os/1.0 does not answer. Everything still works; " +
                  "the host is somebody's Linux rather than an appliance");

            if (await api.NetworkAsync(config.Network, ct).ConfigureAwait(false) is { } network)
            {
                var ours = Seed.IsOurs(network);

                Console.WriteLine(
                    $"network    {network.Name} {Value(network, "ipv4.address")}  " +
                    $"dhcp {(Value(network, "ipv4.dhcp.ranges") is { Length: > 0 } ranges ? ranges : "none")}  " +
                    $"zone .{(Value(network, "dns.domain") is { Length: > 0 } zone ? zone : InstallCommand.IncusDefaultDomain)}");

                // Whose it is decides what envmux will ever do to it, so it is
                // said where the network is, not left to be inferred from a name.
                Console.WriteLine(ours
                    ? "           envmux made it — `envmux host range` moves it, `envmux host reset` removes it"
                    : "           adopted — read, never reconfigured, and left in place by `envmux host reset`");

                if (!Value(network, "ipv4.address").StartsWith(config.BridgeAddress + "/", StringComparison.Ordinal))
                {
                    Console.WriteLine("  warning  the host's range and host.json disagree — " +
                                      "pinned addresses are chosen from host.json" +
                                      (ours ? "; `envmux host range` moves the network" : "; `envmux install` again reads the network"));
                }

                // How much of the pinned band is gone. Running out is not an
                // error — an instance takes a lease instead — but it costs the
                // property pinning exists for: an address known before the
                // instance boots, and so a connection string writable before it
                // does. Worth seeing coming rather than inferring from sessions
                // that got slower.
                var pinned = await PinnedInUseAsync(api, ct).ConfigureAwait(false);
                var capacity = config.PinnedCapacity;

                Console.WriteLine(
                    $"addresses  {pinned.ToString(CultureInfo.InvariantCulture)} of " +
                    $"{capacity.ToString(CultureInfo.InvariantCulture)} pinned in use");

                if (pinned >= capacity)
                {
                    // Named, because every other line here names the command
                    // that supplies what it is missing — where there is one. A
                    // host built before the default moved has eight of these,
                    // and moving the DHCP range down is the whole fix; an
                    // adopted network's DHCP range is not envmux's to move.
                    Console.WriteLine(
                        "  warning  the pinned band is full; new instances take a DHCP lease and " +
                        "have to be asked their address." +
                        (ours
                            ? " `envmux host range --dhcp " +
                              $"{config.Range.BaseAddress.ToString()[..^1]}100-" +
                              $"{config.Range.BaseAddress.ToString()[..^1]}200` widens it."
                            : ""));
                }
            }
            else
            {
                Console.WriteLine(config.IsHyperV
                    ? $"network    no '{config.Network}' — the seed's preseed did not apply"
                    : $"network    no '{config.Network}' on this daemon — `envmux install` creates it, or adopts one " +
                      "with --network");
            }

            Console.WriteLine(await Golden.ExistsAsync(api, ct).ConfigureAwait(false)
                ? $"golden     {Golden.Source} — a new environment is a copy of it"
                : "golden     none — run `envmux host golden`");

            var instances = await api.InstancesAsync(ct).ConfigureAwait(false);

            // A leftover envmux-util is said by name rather than listed as an
            // instance, because it is not a session and nothing needs it.
            if (instances.Any(i => i.Name == LegacyUtility.InstanceName))
            {
                Console.WriteLine(
                    $"legacy     {LegacyUtility.InstanceName} is still here — an older envmux's resolver; nothing asks " +
                    "it anything now. `envmux host reset` removes it");
            }

            foreach (var instance in instances.Where(i => i.Name is not (Golden.InstanceName or LegacyUtility.InstanceName)))
            {
                var state = instance.IsRunning
                    ? await api.StateAsync(instance.Name, ct).ConfigureAwait(false)
                    : null;

                Console.WriteLine(
                    $"instance   {instance.Name,-32} {instance.Status,-8} {state?.Address ?? ""}");
            }
        }
        catch (IncusException e)
        {
            Console.WriteLine($"api        {e.Message}");
            return 1;
        }

        return 0;
    }

    /// <summary>
    /// What an older envmux's wiring left on this workstation, when anything.
    /// </summary>
    /// <remarks>
    /// Said only when it is there. A machine that never had the route and the
    /// rule — every machine set up from now on — gets no line, because a line
    /// saying "none" would read as something missing, and nothing is.
    /// </remarks>
    private static async Task LegacyWiringLinesAsync(HostConfig config, CancellationToken ct)
    {
        var wiring = await WindowsNetwork.StatusAsync(config, ct).ConfigureAwait(false);

        if (wiring.Route is { } hop)
        {
            Console.WriteLine($"legacy     route {WindowsNetwork.DestinationPrefix(config)} → {hop} — an older envmux's; nothing uses it");
        }

        if (wiring.Nrpt is { } servers)
        {
            Console.WriteLine($"legacy     nrpt  {WindowsNetwork.Namespace(config)} → {servers} — an older envmux's; nothing uses it");
        }

        if (wiring.Any)
        {
            Console.WriteLine($"           `{CommandName.Current} host unwire` removes them, from an elevated prompt");
        }
    }

    private static string Value(IncusNetworkInfo network, string key) =>
        network.Config.TryGetValue(key, out var value) ? value : "";


    // init — the range, and everything derived from it.

    private static int Init(List<string> args)
    {
        var config = HostConfig.Load();

        for (var i = 0; i < args.Count; i++)
        {
            if (i + 1 >= args.Count)
            {
                Console.Error.WriteLine($"envmux: {args[i]} needs a value");
                return 2;
            }

            var value = args[++i];

            config = args[i - 1] switch
            {
                "--cidr" => config with { Cidr = value },
                "--dhcp" => config with { DhcpRange = value },
                "--domain" => config with { DnsDomain = value.Trim('.').ToLowerInvariant() },
                "--vm" => config with { VmName = value },
                "--switch" => config with { Switch = value },
                "--mac" => config with { Mac = value },
                "--image" => config with { Image = value },
                _ => config,
            };

            if (!args[i - 1].StartsWith("--", StringComparison.Ordinal))
            {
                Console.Error.WriteLine($"envmux: unknown option '{args[i - 1]}'");
                return 2;
            }
        }

        // Refused before it is written, not after. This file is copied into a
        // disk image and installed on a machine with no console.
        if (config.Problems() is { Count: > 0 } problems)
        {
            foreach (var problem in problems)
            {
                Console.Error.WriteLine($"envmux: {problem}");
            }

            return 2;
        }

        config.Save();

        Console.WriteLine($"wrote {HostConfig.Location}");
        Console.WriteLine();

        foreach (var line in Seed.Describe(config))
        {
            Console.WriteLine($"  {line}");
        }

        Console.WriteLine();
        Console.WriteLine("next: envmux host cert");
        return 0;
    }

    // cert — generated offline, and the public half goes into the seed.

    private static int Cert(List<string> args)
    {
        var force = args.Contains("--force");

        if (File.Exists(HostConfig.CertificatePath) && !force)
        {
            Console.WriteLine($"there is already a certificate at {HostConfig.CertificatePath}");
            Console.WriteLine("  --force replaces it — which means reseeding and reinstalling the host,");
            Console.WriteLine("  because the old one is what the installed host trusts.");
            return 0;
        }

        using var certificate = ClientCertificate.Create(DateTimeOffset.UtcNow);
        ClientCertificate.Write(certificate, HostConfig.CertificatePath, HostConfig.KeyPath);

        Console.WriteLine($"certificate  {HostConfig.CertificatePath}");
        Console.WriteLine($"key          {HostConfig.KeyPath}  (this never leaves the machine)");
        Console.WriteLine($"fingerprint  {ClientCertificate.Fingerprint(certificate)}");
        Console.WriteLine($"valid until  {certificate.NotAfter.ToUniversalTime():yyyy-MM-dd}");
        Console.WriteLine();
        Console.WriteLine("next: envmux host build <IncusOS.img>");
        return 0;
    }

    // build — a seeded copy of the install media, converted to something
    // Hyper-V will boot.

    private static async Task<int> BuildAsync(List<string> args, CancellationToken ct)
    {
        var image = args.FirstOrDefault(a => !a.StartsWith('-'));

        if (image is null)
        {
            Console.Error.WriteLine("envmux: which image? `envmux host build <IncusOS_....img>`");
            return 2;
        }

        var config = HostConfig.Load();

        if (config.Problems() is { Count: > 0 } problems)
        {
            foreach (var problem in problems)
            {
                Console.Error.WriteLine($"envmux: {problem}");
            }

            return 2;
        }

        if (!File.Exists(HostConfig.CertificatePath))
        {
            Console.Error.WriteLine("envmux: there is no client certificate yet. Run `envmux host cert`.");
            return 2;
        }

        var outputDirectory = Option(args, "--out") ?? HostConfig.VmDirectory;
        Directory.CreateDirectory(outputDirectory);

        var name = Path.GetFileNameWithoutExtension(image);
        var seeded = Path.Combine(outputDirectory, $"{name}-seeded.img");

        Console.WriteLine($"copying {Path.GetFileName(image)} — the download is not modified in place");
        File.Copy(image, seeded, overwrite: true);

        var files = Seed.Files(config, ClientCertificate.Pem(HostConfig.CertificatePath));
        var archive = Seed.Archive(files);
        var offset = DiskImage.InjectSeed(seeded, archive);

        Console.WriteLine(
            $"seeded  {archive.Length.ToString(CultureInfo.InvariantCulture)} bytes at " +
            $"0x{offset.ToString("x", CultureInfo.InvariantCulture)} (partition 2)");

        foreach (var file in files)
        {
            Console.WriteLine($"  {file.Name}");
        }

        Console.WriteLine();
        foreach (var line in Seed.Describe(config))
        {
            Console.WriteLine($"  {line}");
        }

        if (args.Contains("--seed-only"))
        {
            Console.WriteLine();
            Console.WriteLine($"seeded image: {seeded}");
            return 0;
        }

        var vhdx = Path.Combine(outputDirectory, $"{name}.vhdx");

        Console.WriteLine();

        await HyperV.ConvertAsync(
            seeded,
            vhdx,

            // Derived from the configuration rather than random, so building
            // the same image twice produces the same disk identity.
            Deterministic(config, name),
            DateTimeOffset.UnixEpoch,
            line => Console.WriteLine($"  {line}"),
            ct).ConfigureAwait(false);

        Console.WriteLine($"media   {vhdx}");
        Console.WriteLine();
        Console.WriteLine("next: envmux host vm");
        return 0;
    }

    /// <summary>A stable id for a build, so the same inputs make the same disk.</summary>
    private static Guid Deterministic(HostConfig config, string name)
    {
        var seed = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes($"{config.VmName}|{config.Mac}|{config.Cidr}|{name}"));

        return new Guid(seed.AsSpan(0, 16));
    }

    // vm — the one Hyper-V configuration that works.

    private static async Task<int> VmAsync(List<string> args, CancellationToken ct)
    {
        var config = HostConfig.Load();

        if (!await HyperV.IsAvailableAsync(ct).ConfigureAwait(false))
        {
            Console.Error.WriteLine(
                "envmux: the Hyper-V PowerShell module is not here. Enable the Hyper-V feature first.");
            return 1;
        }

        if (await HyperV.StatusAsync(config.VmName, ct).ConfigureAwait(false) is { Exists: true } existing)
        {
            Console.WriteLine($"{config.VmName} already exists ({existing.State}).");
            Console.WriteLine("  Remove it in Hyper-V Manager to build it again — this will not do that for you.");
            return 0;
        }

        var root = Option(args, "--root") ?? HostConfig.VmDirectory;
        var media = Directory.EnumerateFiles(root, "*.vhdx").FirstOrDefault();

        if (media is null)
        {
            Console.Error.WriteLine($"envmux: no seeded .vhdx in {root}. Run `envmux host build` first.");
            return 2;
        }

        await HyperV.CreateAsync(
            config,
            root,
            media,
            Gib(Option(args, "--disk"), HyperV.DefaultSystemDisk),
            Gib(Option(args, "--memory"), HyperV.DefaultMemory),
            int.TryParse(Option(args, "--cpus"), CultureInfo.InvariantCulture, out var cpus)
                ? cpus
                : HyperV.DefaultProcessors,
            line => Console.WriteLine($"  {line}"),
            ct).ConfigureAwait(false);

        Console.WriteLine();
        Console.WriteLine("Start it, and let it install. It reboots itself when it is done.");
        Console.WriteLine();
        Console.WriteLine("  Start-VM -Name " + config.VmName);
        Console.WriteLine();
        Console.WriteLine("then: envmux host installed");
        return 0;
    }

    private static long Gib(string? value, long fallback) =>
        long.TryParse(value, CultureInfo.InvariantCulture, out var gib) && gib > 0
            ? gib * 1024 * 1024 * 1024
            : fallback;

    // installed — the step everybody forgets.

    private static async Task<int> InstalledAsync(CancellationToken ct)
    {
        var config = HostConfig.Load();
        var status = await HyperV.StatusAsync(config.VmName, ct).ConfigureAwait(false);

        if (!status.Exists)
        {
            Console.Error.WriteLine($"envmux: there is no VM named {config.VmName}");
            return 1;
        }

        if (status.IsRunning)
        {
            Console.Error.WriteLine(
                $"envmux: {config.VmName} is running. Shut it down first — a disk cannot be detached under it.");
            return 1;
        }

        if (status.Media is null)
        {
            Console.WriteLine("the install media is already detached; nothing to do");
            return 0;
        }

        // Not optional. IncusOS becomes confused if seed data is still present
        // at boot, and it checks the IncusOSInstallComplete UEFI variable and
        // refuses to proceed if it believes it booted the media again.
        await HyperV.DetachMediaAsync(config.VmName, ct).ConfigureAwait(false);

        Console.WriteLine($"detached {Path.GetFileName(status.Media.Path)}");
        Console.WriteLine("the system disk is now the first boot device");
        Console.WriteLine();
        Console.WriteLine("start it again, then: envmux host trust");
        return 0;
    }

    // screen — what a machine with no shell is showing.

    /// <summary>
    /// Save a picture of the VM's screen.
    /// </summary>
    /// <remarks>
    /// The IncusOS documentation's answer to "it is not doing what I expected"
    /// is to look at the console in Hyper-V Manager, because there is nothing
    /// else to look at. This is that, from here, in a file you can attach to a
    /// message.
    /// </remarks>
    private static async Task<int> ScreenAsync(List<string> args, CancellationToken ct)
    {
        var config = HostConfig.Load();

        var path = Option(args, "--out")
            ?? Path.Combine(HostConfig.Directory, $"{config.VmName}-screen.png");

        if (await Framebuffer.SaveAsync(config.VmName, path, ct).ConfigureAwait(false) is not { } written)
        {
            Console.Error.WriteLine(
                $"envmux: nothing to capture from {config.VmName}. It is off, it has not set a video mode " +
                "yet, or this is not an elevated prompt — the thumbnail API needs one.");

            return 1;
        }

        Console.WriteLine(written);
        return 0;
    }

    // console — the same news as `screen`, in words rather than pixels.

    /// <summary>
    /// Read the guest's serial console, for as long as asked.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The counterpart to <c>host screen</c>, and the better of the two when it
    /// works: text that can be read, searched and pasted, rather than a picture
    /// of text. It needs both halves in place — a COM port on the VM, which
    /// envmux sets, and a guest told to write to it, which comes from the kernel
    /// seed and so is fixed at the moment the media was written.
    /// </para>
    /// <para>
    /// A host whose media predates the kernel seed will connect and then sit
    /// there silently, which is why this says how long it waited rather than
    /// simply printing nothing.
    /// </para>
    /// </remarks>
    private static async Task<int> ConsoleAsync(List<string> args, CancellationToken ct)
    {
        var config = HostConfig.Load();

        var seconds = int.TryParse(Option(args, "--seconds"), CultureInfo.InvariantCulture, out var given)
            ? given
            : 5;

        await using var console = await SerialConsole
            .ConnectAsync(HyperV.ConsolePipe(config.VmName), ct).ConfigureAwait(false);

        if (console is null)
        {
            Console.Error.WriteLine(
                $"envmux: no serial console for {config.VmName}. It is off, it has no COM port, or " +
                "something else already has the pipe open — Hyper-V allows one reader.");

            return 1;
        }

        // Nothing arrives on connect: the pipe carries what is said from now on,
        // not what was said before. So the only thing to do is listen.
        await Task.Delay(TimeSpan.FromSeconds(seconds), ct).ConfigureAwait(false);

        var text = console.Text;

        if (text.Trim().Length == 0)
        {
            Console.Error.WriteLine(
                $"envmux: connected, but {config.VmName} said nothing in " +
                $"{seconds.ToString(CultureInfo.InvariantCulture)}s. Either it has nothing to say, or its " +
                "install media was written without a kernel seed and the guest is not using the port.");

            return 1;
        }

        Console.Write(text);

        if (!text.EndsWith(Environment.NewLine, StringComparison.Ordinal) &&
            !text.EndsWith('\n'))
        {
            Console.WriteLine();
        }

        return 0;
    }

    // trust — the only place a fingerprint is ever learned.

    private static async Task<int> TrustAsync(List<string> args, CancellationToken ct)
    {
        var config = HostConfig.Load();
        var address = args.FirstOrDefault(a => !a.StartsWith('-')) ?? config.Api;

        if (address.Length == 0)
        {
            Console.WriteLine("looking for the VM's address…");

            // The guest says it on the console, and that beats deducing it from
            // a neighbour table Windows has had no reason to populate.
            await using var console = await SerialConsole
                .ConnectAsync(HyperV.ConsolePipe(config.VmName), ct).ConfigureAwait(false);

            if (console is not null)
            {
                await Task.Delay(TimeSpan.FromSeconds(3), ct).ConfigureAwait(false);
            }

            var said = console is null ? null : InstallerSays.Address(console);

            if ((said ?? await HyperV.AddressAsync(config, ct).ConfigureAwait(false)) is not { } found)
            {
                Console.Error.WriteLine(
                    "envmux: could not find the VM's address. Give it explicitly: `envmux host trust <address>`.");
                return 1;
            }

            address = found.ToString();
            Console.WriteLine($"found {address}");
        }

        using var presented = await IncusClient.LearnFingerprintAsync(address, ct).ConfigureAwait(false);
        var fingerprint = ClientCertificate.Fingerprint(presented);

        Console.WriteLine();
        Console.WriteLine($"address      https://{IncusClient.Authority(address)}");
        Console.WriteLine($"subject      {presented.Subject}");
        Console.WriteLine($"issued       {presented.NotBefore.ToUniversalTime():yyyy-MM-dd}");
        Console.WriteLine($"fingerprint  {fingerprint}");
        Console.WriteLine();

        if (config.Fingerprint.Length > 0 &&
            !IncusClient.Normalise(config.Fingerprint).Equals(fingerprint, StringComparison.Ordinal))
        {
            Console.WriteLine("This is NOT the certificate that was pinned before.");
            Console.WriteLine($"  was  {config.Fingerprint}");
            Console.WriteLine("  A rebuilt host looks exactly like this. So does something else answering.");
            Console.WriteLine();
        }

        if (!args.Contains("--accept"))
        {
            if (Console.IsInputRedirected)
            {
                Console.Error.WriteLine("envmux: pass --accept to pin this without being asked.");
                return 2;
            }

            Console.Write("Pin it? [y/N] ");
            var answer = Console.ReadLine()?.Trim().ToLowerInvariant();
            Console.WriteLine();

            if (answer is not ("y" or "yes"))
            {
                Console.WriteLine("nothing pinned");
                return 1;
            }
        }

        (config with { Api = IncusClient.Authority(address), Fingerprint = fingerprint }).Save();

        Console.WriteLine($"pinned, and written to {HostConfig.Location}");

        using var client = IncusClient.Connect(HostConfig.Load());
        var server = await new IncusApi(client).ServerAsync(ct).ConfigureAwait(false);

        Console.WriteLine((server.IsTrusted, config.IsHyperV) switch
        {
            (true, true) => $"auth: trusted — incus {server.Environment.ServerVersion}, no token was ever exchanged",
            (true, false) => $"auth: trusted — incus {server.Environment.ServerVersion}",
            (false, true) => "auth: UNTRUSTED — the seeded certificate is not the one this client is sending",
            (false, false) => "auth: UNTRUSTED — the daemon does not know this client's certificate. " +
                              "`envmux install --token <token>` adds it",
        });

        return server.IsTrusted ? 0 : 1;
    }

    // wire — gone. Said, rather than left to be "not a thing envmux does", because
    // the playbooks people followed named it and a workstation set up by them
    // may still carry what it added.

    private static int Wire()
    {
        Console.WriteLine($"`{CommandName.Current} host wire` is no longer needed, and no longer exists.");
        Console.WriteLine();
        Console.WriteLine("  A session is reached through the browser its window opens (`b`) and through");
        Console.WriteLine("  ssh, both over the host's API. Nothing on this workstation routes to the range");
        Console.WriteLine("  or resolves the zone, and nothing needs an elevated prompt.");
        Console.WriteLine();
        Console.WriteLine($"  An older envmux's route and NRPT rule come off with `{CommandName.Current} host unwire`.");
        return 0;
    }

    /// <summary>
    /// Take an older envmux's route and rule back off this workstation.
    /// </summary>
    /// <remarks>
    /// The one thing left of the wiring. Whatever is there for this range and
    /// this zone is that version's — nothing current writes either — so there
    /// is no other host's wiring to protect and no <c>--force</c> to ask for.
    /// </remarks>
    private static async Task<int> UnwireAsync(CancellationToken ct)
    {
        var config = HostConfig.Load();

        if (!Powershell.IsAvailable)
        {
            Console.WriteLine("nothing to do: the route and the NRPT rule were Windows', and this is not Windows");
            return 0;
        }

        if (!await WindowsNetwork.UnwireAsync(config, line => Console.WriteLine($"  {line}"), ct).ConfigureAwait(false))
        {
            Console.WriteLine(
                $"nothing to do: no route for {WindowsNetwork.DestinationPrefix(config)} and no NRPT rule for " +
                $"{WindowsNetwork.Namespace(config)} on this workstation");
        }

        return 0;
    }

    // range — the one value that lives in two places, changed in both of them.

    /// <summary>
    /// Move the range of a network envmux made, on a host that is already up.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Two things have to agree: the network object and <c>host.json</c>, which
    /// is where pinned addresses are chosen from. Changing the first is one API
    /// call and is not a one-way door. There used to be two more — this
    /// workstation's route and its NRPT rule — and they were the half that got
    /// forgotten; nothing here is derived from the range any more.
    /// </para>
    /// <para>
    /// Sessions are not touched: an instance holds its address until it is
    /// recreated, and which of them are worth keeping is not this command's
    /// call. The one instance that is removed is a leftover <c>envmux-util</c>
    /// from an older envmux, pinned on the old range and answering nothing
    /// anybody asks.
    /// </para>
    /// <para>
    /// A network envmux adopted is refused outright. Its range is its owner's,
    /// other tenants are on it, and the promise made when it was adopted was
    /// that it would never be reconfigured.
    /// </para>
    /// </remarks>
    private static async Task<int> RangeAsync(List<string> args, CancellationToken ct)
    {
        var config = HostConfig.Load();

        var moved = config with
        {
            Cidr = Option(args, "--cidr") ?? config.Cidr,
            DhcpRange = Option(args, "--dhcp") ?? config.DhcpRange,
        };

        if (moved.Problems() is { Count: > 0 } problems)
        {
            foreach (var problem in problems)
            {
                Console.Error.WriteLine($"envmux: {problem}");
            }

            return 2;
        }

        using var client = IncusClient.Connect(config);
        var api = new IncusApi(client);

        if (await api.NetworkAsync(config.Network, ct).ConfigureAwait(false) is not { } network)
        {
            Console.Error.WriteLine($"envmux: the host has no '{config.Network}' network to change");
            return 1;
        }

        if (!Seed.IsOurs(network))
        {
            Console.Error.WriteLine(
                $"envmux: '{config.Network}' was adopted, not made by envmux, so its range is not envmux's to " +
                "move — other things on that daemon may be using it. If its owner moves it, `envmux install` " +
                "again reads the new range into host.json.");
            return 1;
        }

        if (moved == config)
        {
            Console.WriteLine($"range      {config.Cidr}   dhcp {config.DhcpRange}");
            Console.WriteLine("            unchanged — pass --cidr or --dhcp to move it");
            return 0;
        }

        // Everything attached, before anything moves. A running instance keeps
        // its address until it restarts, so this is the list of things that will
        // be on the old range afterwards.
        var attached = (await api.InstancesAsync(ct).ConfigureAwait(false))
            .Where(i => i.Name != LegacyUtility.InstanceName &&
                        i.Devices.TryGetValue("eth0", out var eth0) &&
                        eth0.TryGetValue("network", out var name) && name == config.Network)
            .ToList();

        Console.WriteLine($"was        {config.Cidr}   dhcp {config.DhcpRange}");
        Console.WriteLine($"now        {moved.Cidr}   dhcp {moved.DhcpRange}");
        Console.WriteLine();

        var updated = new Dictionary<string, string>(network.Config, StringComparer.Ordinal)
        {
            ["ipv4.address"] = $"{moved.BridgeAddress}/{moved.Cidr.Split('/')[1]}",
            ["ipv4.dhcp.ranges"] = moved.DhcpRange,
        };

        // An older envmux's utility instance goes first, so that nothing is
        // left pinned to an address outside the range it is on. It is not made
        // again: nothing asks it anything.
        if (await LegacyUtility.RemoveAsync(api, ct).ConfigureAwait(false))
        {
            Console.WriteLine($"  removed {LegacyUtility.InstanceName}, an older envmux's resolver, pinned on the old range");
        }

        await api.PutNetworkAsync(config.Network, updated, ct).ConfigureAwait(false);
        Console.WriteLine($"  {config.Network} is now {updated["ipv4.address"]}");

        // The legacy fields describe the old range, if they describe anything.
        (moved with { Gateway = "", Resolver = "" }).Save();
        Console.WriteLine($"  {HostConfig.Location} written");

        // A pinned address on the old range is now off the bridge's subnet, so
        // it goes rather than being translated: the next start picks a free one
        // on the new one.
        foreach (var instance in attached)
        {
            if (!instance.Devices["eth0"].ContainsKey("ipv4.address"))
            {
                continue;
            }

            Console.WriteLine($"  {instance.Name} is pinned to the old range and will need recreating");
        }

        Console.WriteLine();
        Console.WriteLine("next: envmux prune --all — the instances still on the old range");
        return 0;
    }

    // prepare — the half of onboarding a remote that happens on the remote.

    /// <summary>What <c>host prepare</c> was asked for, with the defaults filled in.</summary>
    /// <param name="Network">The bridge the host is to forward for.</param>
    /// <param name="Cidr">Its range, to be said in the script.</param>
    /// <param name="Name">What the daemon's trust list will call this client.</param>
    /// <param name="Check">Read and report; change nothing, mint nothing.</param>
    /// <param name="Ssh">Where to run it, or null to print it.</param>
    /// <param name="Forwarded">The options that go on to <c>envmux install</c> unchanged.</param>
    internal sealed record PrepareOptions(
        string Network,
        string Cidr,
        string Name,
        bool Check,
        string? Ssh,
        IReadOnlyList<string> Forwarded);

    /// <summary>What the daemon's trust list calls this client when nobody says otherwise.</summary>
    internal const string DefaultClientName = "envmux";

    private static readonly string[] PrepareValues = ["--ssh", "--network", "--cidr", "--name"];
    private static readonly string[] PrepareSwitches = ["--check", "--yes", "-y"];

    /// <summary>
    /// Read <c>host prepare</c>'s arguments against what <c>host.json</c> already says.
    /// </summary>
    /// <remarks>
    /// The network and the range default to the recorded ones when there is a
    /// <c>host.json</c>, because a host being prepared a second time — after a
    /// reboot lost a rule, after the path check said so — is being prepared for
    /// the network it already has. With no file they are what
    /// <c>envmux install</c> will create. Anything not recognised is refused
    /// rather than ignored: this ends in a script that changes a firewall as
    /// root, and a mistyped <c>--chekc</c> must not become a run that changes it.
    /// </remarks>
    internal static PrepareOptions? Prepare(IReadOnlyList<string> args, HostConfig config, bool recorded, out string problem)
    {
        problem = "";
        var values = new Dictionary<string, string>(StringComparer.Ordinal);

        for (var i = 0; i < args.Count; i++)
        {
            if (PrepareSwitches.Contains(args[i]))
            {
                continue;
            }

            if (!PrepareValues.Contains(args[i]))
            {
                problem = $"'host prepare' does not take '{args[i]}'";
                return null;
            }

            if (i + 1 >= args.Count || args[i + 1].StartsWith("--", StringComparison.Ordinal))
            {
                problem = $"{args[i]} needs a value";
                return null;
            }

            values[args[i]] = args[++i];
        }

        return new PrepareOptions(
            values.GetValueOrDefault("--network") ?? (recorded ? config.Network : HostConfig.DefaultNetwork),
            values.GetValueOrDefault("--cidr") ?? (recorded ? config.Cidr : HostConfig.DefaultCidr),
            values.GetValueOrDefault("--name") ?? DefaultClientName,
            args.Contains("--check"),
            values.GetValueOrDefault("--ssh"),
            [.. args.Where(a => a is "--yes" or "-y")]);
    }

    /// <summary>
    /// The <c>envmux install</c> that carries on from a prepared host.
    /// </summary>
    /// <remarks>
    /// The token, and what was said to <c>prepare</c> that install has to hear
    /// too: a bridge other than <c>envmux0</c> is one the daemon already has, so
    /// it is adopted; a range that was named is the range to create with.
    /// </remarks>
    internal static List<string> InstallArguments(PrepareOptions options, IReadOnlyList<string> given, string token)
    {
        var args = new List<string> { "--provider", HostConfig.Incus, "--token", token };

        if (!options.Network.Equals(HostConfig.DefaultNetwork, StringComparison.Ordinal))
        {
            args.AddRange(["--network", options.Network]);
        }
        else if (given.Contains("--cidr"))
        {
            args.AddRange(["--cidr", options.Cidr]);
        }

        args.AddRange(options.Forwarded);
        return args;
    }

    /// <summary>
    /// What of the script's output goes to the screen: everything but the token's line.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The output is passed through as it arrives, a character at a time rather
    /// than a line at a time, because the one line that matters most has no end:
    /// <c>[sudo] password for you:</c> waits on the same line for an answer, and
    /// a line-buffered tee would sit on it while the person sat wondering.
    /// </para>
    /// <para>
    /// A line that starts with <see cref="HostPrep.TokenMarker"/> is held back
    /// instead. When envmux is about to use the token itself there is no reason
    /// for it to cross a screen — a shared one, a recorded one — and when it is
    /// not, the caller shows what was held. Only the first few characters of a
    /// line are ever in doubt, and only until one of them is not the marker's.
    /// </para>
    /// </remarks>
    internal sealed class TokenLineFilter
    {
        private readonly System.Text.StringBuilder _pending = new();
        private readonly System.Text.StringBuilder _held = new();
        private readonly System.Text.StringBuilder _all = new();
        private State _state = State.LineStart;

        private enum State
        {
            LineStart,
            Passing,
            Holding,
        }

        /// <summary>Everything that arrived, for <see cref="HostPrep.TokenFrom"/>. Never printed as it is.</summary>
        public string Transcript => _all.ToString();

        /// <summary>The marker lines that were kept off the screen.</summary>
        public string Held => _held.ToString();

        /// <summary>Take some output; get back what of it to show now.</summary>
        public string Feed(string chunk)
        {
            var show = new System.Text.StringBuilder();
            _all.Append(chunk);

            foreach (var c in chunk)
            {
                switch (_state)
                {
                    case State.Holding:
                        _held.Append(c);
                        break;

                    case State.Passing:
                        show.Append(c);
                        break;

                    default:
                        _pending.Append(c);

                        if (_pending.Length == HostPrep.TokenMarker.Length &&
                            _pending.ToString() == HostPrep.TokenMarker)
                        {
                            _held.Append(_pending);
                            _pending.Clear();
                            _state = State.Holding;
                        }
                        else if (!HostPrep.TokenMarker.StartsWith(_pending.ToString(), StringComparison.Ordinal))
                        {
                            show.Append(_pending);
                            _pending.Clear();
                            _state = State.Passing;
                        }

                        break;
                }

                if (c == '\n')
                {
                    show.Append(_pending);
                    _pending.Clear();
                    _state = State.LineStart;
                }
            }

            return show.ToString();
        }

        /// <summary>Whatever was still in doubt when the output ended.</summary>
        public string Flush()
        {
            var rest = _pending.ToString();
            _pending.Clear();
            return rest;
        }
    }

    /// <summary>
    /// Print the script for the Incus host, or run it there over the person's own ssh.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Printed, the script is the only thing on stdout — what it is and what to
    /// do with it go to stderr — so it can be piped to a clipboard or a file and
    /// arrive as a script. That is the default because it is the one that works
    /// from anywhere: a web console, a screen share, somebody else's hands.
    /// </para>
    /// <para>
    /// Over <c>--ssh</c>, ssh is the person's: their keys, their agent, their
    /// config, their terminal for stdin and stderr, so the sudo prompt is asked
    /// of them and answered by them. Only stdout comes through here, to be shown
    /// and to have the token taken out of it. The token is held in memory for as
    /// long as it takes to hand it to <c>envmux install</c>, and is never written
    /// anywhere. It is shown only when envmux is <em>not</em> going to use it —
    /// declined, not elevated, or an install that stopped — because then it is
    /// the person's to carry, and a single-use secret nobody can see is a
    /// credential left lying on the daemon.
    /// </para>
    /// </remarks>
    private static async Task<int> PrepareAsync(List<string> args, CancellationToken ct)
    {
        var recorded = File.Exists(HostConfig.Location);

        if (Prepare(args, HostConfig.Load(), recorded, out var problem) is not { } options)
        {
            Console.Error.WriteLine($"envmux: {problem}");
            return 2;
        }

        string script;
        IReadOnlyList<string>? ssh = null;

        try
        {
            script = HostPrep.Script(options.Network, options.Cidr, options.Name, options.Check);

            if (options.Ssh is { } target)
            {
                ssh = HostPrep.SshCommandLine(target, script, options.Check);
            }
        }
        catch (ArgumentException e)
        {
            Console.Error.WriteLine($"envmux: {e.Message.Split(" (Parameter", 2)[0]}");
            return 2;
        }

        if (ssh is null)
        {
            Console.Error.WriteLine(
                $"envmux: the script for the Incus host — network {options.Network} ({options.Cidr}), client " +
                $"'{options.Name}'{(options.Check ? ", --check: it reads and changes nothing" : "")}.");
            Console.Error.WriteLine(
                "        Paste it into a shell on that host; it asks for sudo itself, once. Only the script is on");
            Console.Error.WriteLine(
                $"        stdout, so `{CommandName.Current} host prepare | Set-Clipboard` copies exactly it." +
                (options.Check ? "" : $" Its last line is the token: {CommandName.Current} install --token <that>"));

            Console.Out.Write(script);
            return 0;
        }

        // Whether install could carry on from here, asked before a token is
        // minted rather than after: one that cannot be used here has to be shown
        // instead, and it is better to know that going in.
        var blockers = options.Check
            ? []
            : await Provisioning.ProblemsAsync(needsHyperV: false, ct).ConfigureAwait(false);

        Console.Error.WriteLine(
            $"envmux: running the script on {options.Ssh} over your ssh — network {options.Network} ({options.Cidr}), " +
            $"client '{options.Name}'{(options.Check ? ", --check" : "")}. Any password prompt is ssh's or sudo's, and yours.");
        Console.Error.WriteLine();

        var filter = new TokenLineFilter();
        int exit;

        try
        {
            exit = await RunAttachedAsync(ssh, filter, ct).ConfigureAwait(false);
        }
        catch (System.ComponentModel.Win32Exception e)
        {
            Console.Error.WriteLine(
                $"envmux: ssh could not be started ({e.Message}). It comes with the OpenSSH client: " +
                "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0. Without it, " +
                $"`{CommandName.Current} host prepare` prints the script to paste on the host instead.");
            return 1;
        }

        var token = HostPrep.TokenFrom(filter.Transcript);

        if (token is null)
        {
            // A --check run, or one that stopped early: what was held is a line
            // that says there is no token, and is shown as it came.
            Console.Out.Write(filter.Held);

            if (exit != 0)
            {
                Console.Error.WriteLine();
                Console.Error.WriteLine($"envmux: the script ended with {exit.ToString(CultureInfo.InvariantCulture)}, and no token came back.");
            }

            return exit;
        }

        Console.WriteLine($"{HostPrep.TokenMarker}(received, and kept off the screen)");
        Console.WriteLine();

        if (blockers.Count > 0)
        {
            foreach (var blocker in blockers)
            {
                Console.Error.WriteLine($"envmux: {blocker}");
            }

            return Handed(filter, "So install cannot carry on from here. The token, for an elevated prompt:");
        }

        if (!new Prompt(args.Contains("--yes") || args.Contains("-y")).Yes("continue into install with this token?", true))
        {
            return Handed(filter, "Not continuing. The token is yours to use, once:");
        }

        var code = await InstallCommand.RunAsync(InstallArguments(options, args, token), ct).ConfigureAwait(false);

        if (code != 0)
        {
            Console.Error.WriteLine();
            Handed(
                filter,
                "If that stopped before \"added — the daemon trusts envmux now\", the token is still unused:");
        }

        return code;

        static int Handed(TokenLineFilter filter, string why)
        {
            Console.Error.WriteLine($"envmux: {why}");
            Console.Out.Write(filter.Held);
            Console.Error.WriteLine($"        {CommandName.Current} install --provider incus --token <that>");
            return 0;
        }
    }

    /// <summary>
    /// Run a command with the person's terminal for its stdin and stderr, showing its stdout as it comes.
    /// </summary>
    private static async Task<int> RunAttachedAsync(IReadOnlyList<string> argv, TokenLineFilter filter, CancellationToken ct)
    {
        var start = new System.Diagnostics.ProcessStartInfo(argv[0])
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
        };

        foreach (var argument in argv.Skip(1))
        {
            start.ArgumentList.Add(argument);
        }

        using var process = System.Diagnostics.Process.Start(start)
            ?? throw new System.ComponentModel.Win32Exception("the process did not start");

        var buffer = new char[256];

        try
        {
            int read;
            while ((read = await process.StandardOutput.ReadAsync(buffer.AsMemory(), ct).ConfigureAwait(false)) > 0)
            {
                Console.Out.Write(filter.Feed(new string(buffer, 0, read)));
                await Console.Out.FlushAsync(ct).ConfigureAwait(false);
            }

            Console.Out.Write(filter.Flush());
            await process.WaitForExitAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            throw;
        }

        return process.ExitCode;
    }

    // golden — the instance every session is a copy of.

    private static async Task<int> GoldenAsync(CancellationToken ct)
    {
        var config = HostConfig.Load();

        using var client = IncusClient.Connect(config);
        var api = new IncusApi(client);

        var started = DateTimeOffset.UtcNow;

        await Golden.BuildAsync(api, config, line => Console.WriteLine($"  {line}"), ct).ConfigureAwait(false);

        Console.WriteLine();
        Console.WriteLine(
            $"took {(DateTimeOffset.UtcNow - started).TotalSeconds.ToString("F0", CultureInfo.InvariantCulture)}s. " +
            "Copies of it are near-instant on a ZFS pool.");

        return 0;
    }

    // reset — the recovery mode. A host is meant to be ephemeral: losing the
    // client's certificate, or wanting a clean one, should cost a rebuild and
    // not an afternoon. This tears the host down and, unless told to stop,
    // builds it again — the one command that treats the host as disposable.

    private static async Task<int> ResetAsync(List<string> args, CancellationToken ct)
    {
        var config = HostConfig.Load();
        var yes = args.Contains("--yes") || args.Contains("--accept");

        // A Hyper-V rebuild reseeds the same certificate offline, so trust comes
        // back on its own. An existing-Incus rebuild re-attaches, which needs a
        // fresh trust token — and if this run cannot be asked for one and none
        // was passed, the rebuild would fail at the trust step, after the
        // teardown had already removed trust and the certificate. Refuse before
        // tearing anything down rather than strand a half-reset daemon.
        if (!config.IsHyperV &&
            !args.Contains("--keep-down") &&
            Option(args, "--token") is not { Length: > 0 } &&
            (yes || Console.IsInputRedirected))
        {
            Console.Error.WriteLine(
                "envmux: an existing-Incus reset rebuilds by re-attaching, which needs a fresh trust token, " +
                "and this run cannot be asked for one. Pass --token <token> to rebuild unattended, or " +
                "--keep-down to tear down only.");
            return 2;
        }

        Console.WriteLine();
        Console.WriteLine(config.IsHyperV
            ? $"This tears down the Hyper-V host '{config.VmName}' and builds a new one."
            : $"This detaches from the Incus daemon at {config.Api} and re-attaches.");
        Console.WriteLine();

        if (config.IsHyperV)
        {
            Console.WriteLine("  - stop and remove the VM, and delete its disk");
            Console.WriteLine("  - clear this client's certificate and key");
            Console.WriteLine("  - remove an older envmux's route and NRPT rule, if this workstation still has them");
            Console.WriteLine();
            Console.WriteLine("  Every session on this host is destroyed, and uncommitted work in one is lost.");
        }
        else
        {
            Console.WriteLine($"  - remove envmux's own instances, a leftover {LegacyUtility.InstanceName} among them");
            Console.WriteLine($"  - remove the {config.Network} network if envmux made it; one it adopted is left exactly as it is");
            Console.WriteLine("  - take envmux out of the daemon's trust store");
            Console.WriteLine("  - clear this client's certificate, and remove an older envmux's route and NRPT rule");
            Console.WriteLine("    if this workstation still has them");
            Console.WriteLine();
            Console.WriteLine("  The daemon itself is left alone — only what envmux made on it is removed.");
        }

        Console.WriteLine();

        if (!yes)
        {
            if (Console.IsInputRedirected)
            {
                Console.Error.WriteLine("envmux: pass --yes to reset without being asked. This destroys sessions.");
                return 2;
            }

            Console.Write("Reset the host? [y/N] ");
            var answer = Console.ReadLine();

            if (answer is null || !answer.Trim().StartsWith("y", StringComparison.OrdinalIgnoreCase))
            {
                Console.WriteLine("nothing done");
                return 1;
            }
        }

        Console.WriteLine();

        if (config.IsHyperV)
        {
            Console.WriteLine($"  removing VM {config.VmName}…");
            await HyperV.RemoveAsync(config.VmName, ct).ConfigureAwait(false);
            Console.WriteLine("  removed");
        }
        else
        {
            await ResetIncusAsync(config, ct).ConfigureAwait(false);
        }

        // An older envmux's wiring, whichever provider. Best effort: a
        // workstation that never had it is the ordinary case, and one that is
        // not elevated must not strand a reset on a route nothing uses.
        try
        {
            if (Powershell.IsAvailable &&
                await WindowsNetwork.UnwireAsync(config, line => Console.WriteLine($"  {line}"), ct).ConfigureAwait(false))
            {
                Console.WriteLine("  (an older envmux's; nothing current puts them back)");
            }
        }
        catch (PowershellException e)
        {
            Console.WriteLine($"  an older envmux's route and NRPT rule are left as they are: {e.Message}");
            Console.WriteLine($"  `{CommandName.Current} host unwire` removes them, from an elevated prompt");
        }

        // The certificate, the key and the VM's disk go. The identity — range,
        // zone, provider, the daemon's address — is kept, so the rebuild does
        // not re-ask what was already decided. The fingerprint is cleared,
        // because the host it pinned no longer exists; and the two fields an
        // older envmux wrote, because the file is being rewritten anyway and
        // nothing reads them.
        ClearCredentials();
        (config with { Fingerprint = "", Gateway = "", Resolver = "" }).Save();

        Console.WriteLine();
        Console.WriteLine("  torn down.");

        if (args.Contains("--keep-down"))
        {
            Console.WriteLine("  --keep-down: not rebuilding. Run `envmux install` when ready.");
            return 0;
        }

        Console.WriteLine("  rebuilding…");

        // Hand off to install, carrying the same arguments so --image, --version,
        // --yes and the rest flow through. The kept host.json makes install keep
        // the range and zone; a fresh certificate and, for Hyper-V, a fresh seed
        // re-establish trust with no token to paste.
        return await InstallCommand
            .RunAsync(args.Where(a => a != "--keep-down").ToList(), ct)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Reset for a daemon envmux does not own: remove only what envmux made.
    /// </summary>
    /// <remarks>
    /// Every step is best effort. The daemon may already be unreachable, or may
    /// no longer trust this client — neither is a reason to leave the local side
    /// half-reset, so a daemon that will not answer is reported and stepped past.
    /// </remarks>
    private static async Task ResetIncusAsync(HostConfig config, CancellationToken ct)
    {
        try
        {
            using var client = IncusClient.Connect(config);
            var api = new IncusApi(client);

            try
            {
                // Everything envmux made: the labelled instances, and the golden
                // instance — which carries no labels, so IsOurs misses it, and
                // which sits on envmux0, so leaving it behind also blocks the
                // network delete below with an in-use error rather than a 404.
                // An older envmux's utility instance has its own way out below,
                // so it is not also taken here by whatever labels it has.
                var ours = (await api.InstancesAsync(ct).ConfigureAwait(false))
                    .Where(i => i.Name != LegacyUtility.InstanceName &&
                                (InstanceSpec.IsOurs(i) || i.Name == Golden.InstanceName))
                    .ToList();

                foreach (var instance in ours)
                {
                    Console.WriteLine($"  removing instance {instance.Name}…");

                    try
                    {
                        await api.StopAsync(instance.Name, ct: ct).ConfigureAwait(false);
                    }
                    catch (IncusException)
                    {
                        // Already stopped, which is all the stop was for.
                    }

                    await api.DeleteAsync(instance.Name, ct).ConfigureAwait(false);
                }
            }
            catch (IncusException e)
            {
                Console.WriteLine($"  instances left as they are: {e.Message}");
            }

            try
            {
                if (await LegacyUtility.RemoveAsync(api, ct).ConfigureAwait(false))
                {
                    Console.WriteLine($"  removed {LegacyUtility.InstanceName}, an older envmux's resolver for *.{config.DnsDomain}");
                }
            }
            catch (IncusException e)
            {
                Console.WriteLine($"  {LegacyUtility.InstanceName} left as it is: {e.Message}");
            }

            try
            {
                // Asked before deleting, every time. A network envmux adopted
                // has other tenants and an owner, and the promise made when it
                // was adopted was that it would never be deleted — by name
                // alone there is no telling it from one envmux made.
                if (await api.NetworkAsync(config.Network, ct).ConfigureAwait(false) is { } network)
                {
                    if (!Seed.IsOurs(network))
                    {
                        Console.WriteLine($"  {config.Network} was adopted, not made by envmux — left exactly as it is");
                    }
                    else if (await api.DeleteNetworkAsync(config.Network, ct).ConfigureAwait(false))
                    {
                        Console.WriteLine($"  removed network {config.Network}");
                    }
                }
            }
            catch (IncusException e)
            {
                Console.WriteLine($"  {config.Network} left as it is: {e.Message}");
            }

            try
            {
                if (File.Exists(HostConfig.CertificatePath) && File.Exists(HostConfig.KeyPath))
                {
                    using var mine = ClientCertificate.Load(HostConfig.CertificatePath, HostConfig.KeyPath);

                    if (await api.RemoveTrustedCertificateAsync(ClientCertificate.Fingerprint(mine), ct)
                        .ConfigureAwait(false))
                    {
                        Console.WriteLine("  removed envmux from the daemon's trust store");
                    }
                }
            }
            catch (Exception e) when (e is IncusException or CertificateException)
            {
                Console.WriteLine($"  trust store left as it is: {e.Message}");
            }
        }
        catch (IncusException e)
        {
            Console.WriteLine(
                $"  the daemon at {config.Api} did not answer, so only the local side is cleared: {e.Message}");
        }
    }

    /// <summary>
    /// Remove this client's certificate and key, and the VM's disk directory.
    /// </summary>
    /// <remarks>
    /// The certificate and key are the credentials a rebuild replaces; the vm
    /// directory is the disk Hyper-V's <c>Remove-VM</c> leaves behind. All three
    /// absent is the wanted state, so anything already gone is not an error, and
    /// a file that will not delete is reported by the rebuild that trips over it
    /// rather than here.
    /// </remarks>
    private static void ClearCredentials()
    {
        foreach (var path in new[] { HostConfig.CertificatePath, HostConfig.KeyPath })
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (IOException)
            {
                // Reported later, by whatever needs it gone.
            }
        }

        try
        {
            if (Directory.Exists(HostConfig.VmDirectory))
            {
                Directory.Delete(HostConfig.VmDirectory, recursive: true);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Console.WriteLine($"  {HostConfig.VmDirectory} could not be removed: {e.Message}");
        }
    }

    private static string? Option(List<string> args, string name)
    {
        var index = args.IndexOf(name);
        return index >= 0 && index + 1 < args.Count ? args[index + 1] : null;
    }
}
