using System.Globalization;
using System.Net;
using System.Security.Cryptography.X509Certificates;

using Envmux.Editor;
using Envmux.Host;
using Envmux.Host.Windows;
using Envmux.Incus;

namespace Envmux.Commands;

/// <summary>
/// The whole host build, asked rather than typed.
/// </summary>
/// <remarks>
/// <para>
/// Nothing here is new. Every step is one of the <c>envmux host</c> commands,
/// which all still exist and are still the way to do any of this on its own —
/// this asks the questions in order, fills in what it can work out, and waits
/// for the install so nobody has to sit watching Hyper-V Manager for the moment
/// it is safe to detach the media.
/// </para>
/// <para>
/// Every step is skipped when it is already done, so running it again after a
/// failure resumes rather than restarting. That is the property that matters
/// most: the slow parts are a download and an unattended install, and neither is
/// something to repeat because the step after it went wrong.
/// </para>
/// </remarks>
internal static class InstallCommand
{
    private const string Usage = """
        envmux install — build the host, asking as it goes.

        usage:
          envmux install --provider incus|hyperv [options]

        options:
          --yes                Take every default; ask nothing
          --provider <name>    hyperv (builds a VM) or incus (attach to
                               a daemon you already run). See host.md.
                               Naming the other one on a workstation that
                               already has a host swaps it to a new one.
          --token <token>      (incus) A trust token, from `envmux host prepare`
                               or `incus config trust add`. It is enough by
                               itself: it names the daemon's certificate and the
                               addresses it listens on, so they are tried, the
                               one presenting that certificate is pinned without
                               asking, and the token is redeemed. Not needed
                               when the daemon already trusts this client
          --api <host[:port]>  (incus) The daemon's address, instead of asking or
                               of trying the token's. https://host[:port] is
                               taken too; no port is 8443. Beside --token, a
                               certificate that is not the token's is refused
          --network <name>     (incus) Adopt a network the daemon already has,
                               instead of creating envmux0. Its range and its
                               zone are read from it; it is never reconfigured
                               and never deleted. --cidr and --domain do not apply
          --image <path>       Use this .img instead of downloading one
          --version <build>    Install this build — e.g. 202608201218
          --channel <name>     stable (default) or testing
          --cidr <a.b.c.d/n>   The range, instead of the one it suggests
          --domain <label>     The zone. Default: envmux
          --switch <name>      The virtual switch. Default: External
          --vm <name>          The VM's name. Default: envmux-host
          --disk <GiB>         System disk. Default: 256, minimum 50
          --memory <GiB>       Default: 16
          --cpus <n>           Default: 8

        the hyperv provider, in order:
           1  the range                 a 10.x.0.0/24 nothing here already uses
           2  the certificate           this client's, made once; the seed carries it
           3  the image                 the latest stable IncusOS, checksummed
           4  the switch                an External one, made if there is none
           5  the install media         a seeded copy, converted to VHDX
           6  the machine               Gen 2, Secure Boot off, vTPM on
           7  installing                started, watched, the media detached
           8  trust                     the fingerprint it presents, pinned
           9  the golden instance
          10  the editor's key

        the incus provider, in order:
           1  the range                 only who the host is; see 4
           2  the certificate           this client's, made once
           3  the daemon                pin it, and be trusted by it
           4  the network               one that exists is read — envmux0 from
                                        another workstation, or --network; only a
                                        new envmux0 is given a range chosen here
           5  the golden instance
           6  the editor's key

        Nothing is wired on this workstation: a session is reached through the
        browser its window opens (`b`) and through ssh, both over the host's
        API, so the host can be anywhere that API is reachable from.

        Every Hyper-V step is one of the `envmux host` commands and every one of
        those still works on its own. Run this again after a failure and it
        picks up where it stopped.
        """;

    /// <summary>The options that are each a fact about a daemon that already exists, and so name the provider.</summary>
    private static readonly string[] DaemonFlags = ["--api", "--token", "--network"];

    /// <summary>The options that choose a range, and so mean nothing to a network that already has one.</summary>
    private static readonly string[] RangeFlags = ["--cidr", "--domain"];

    /// <summary>How long to wait for the installer to finish before giving up on it.</summary>
    /// <remarks>
    /// Generous, and rarely approached: writing a three gigabyte image to an
    /// NVMe disk is seconds, not minutes. It is long enough for a slow disk and
    /// short enough that a VM which is never going to boot does not hold a
    /// terminal overnight.
    /// </remarks>
    private static readonly TimeSpan InstallDeadline = TimeSpan.FromMinutes(20);

    /// <summary>
    /// How long the screen has to be identical before the installer counts as
    /// finished with it.
    /// </summary>
    /// <remarks>
    /// The installer redraws while it works and stops when it is done, so a
    /// screen that has not changed in this long is one nothing is happening
    /// behind. Long enough not to be fooled by a pause between phases, short
    /// enough that a ten second install is not followed by a minute of waiting.
    /// </remarks>
    private static readonly TimeSpan ScreenSettled = TimeSpan.FromSeconds(20);

    /// <summary>
    /// How much has to have been written to the system disk before a still
    /// screen is believed.
    /// </summary>
    /// <remarks>
    /// A dynamic VHDX starts near empty. An installer that has laid down the
    /// image has grown it by gigabytes, and one that fell over at the first
    /// screen has not — so this is what tells "finished" from "stuck on the
    /// very first thing it did", which look identical from outside.
    /// </remarks>
    private const long WrittenEnough = 512L * 1024 * 1024;

    public static async Task<int> RunAsync(List<string> args, CancellationToken ct = default)
    {
        if (ProviderNamed(args) is null or "docker")
        {
            return await LocalInstall.RunAsync(args, ct).ConfigureAwait(false);
        }

        if (args.Contains("-h") || args.Contains("--help"))
        {
            Console.WriteLine(Usage);
            return 0;
        }

        var yes = args.Contains("--yes") || args.Contains("-y");
        var ask = new Prompt(yes);

        try
        {
            Console.WriteLine();
            Console.WriteLine("envmux install — one host, set up once, that every session on this machine runs on.");
            Console.WriteLine();

            if (await ConfigureAsync(args, ask, ct).ConfigureAwait(false) is not { } configured)
            {
                return 1;
            }

            var config = configured.Config;

            // After the provider is chosen, because what this machine has to
            // have depends on it: the Incus provider needs nothing of it — no
            // Hyper-V, and no elevation, since nothing is wired here any more.
            if (await Provisioning.ProblemsAsync(config.IsHyperV, ct).ConfigureAwait(false) is { Count: > 0 } problems)
            {
                foreach (var problem in problems)
                {
                    Console.Error.WriteLine($"envmux: {problem}");
                }

                return 1;
            }

            Certificate();

            // The one branch. A Hyper-V host is built — a VM, seeded and
            // installed — where an existing Incus is only attached to. Both
            // arrive at the same place: a daemon that trusts this client, with a
            // network for sessions. Everything after converges.
            _total = config.IsHyperV ? 10 : 6;

            var provisioned = config.IsHyperV
                ? await ProvisionHyperVAsync(config, args, ask, ct).ConfigureAwait(false)
                : await ProvisionIncusAsync(config, configured.RangeChosen, args, ask, ct).ConfigureAwait(false);

            if (!provisioned)
            {
                return 1;
            }

            config = HostConfig.Load();

            await GoldenAsync(config, config.IsHyperV ? 9 : 5, ct).ConfigureAwait(false);
            await SshAsync(config, ask, config.IsHyperV ? 10 : 6, ct).ConfigureAwait(false);

            Done(config);
            return 0;
        }
        catch (OperationCanceledException)
        {
            Console.WriteLine();
            Console.WriteLine($"stopped. `{CommandName.Current} install --provider {ProviderNamed(args)}` again picks up where this left off.");
            return 1;
        }
        catch (Exception e) when (e is IncusException or CertificateException or DiskImageException
                                      or ImageIndexException or PowershellException or Process.ProcessException)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine($"envmux: {e.Message}");
            Console.Error.WriteLine();
            Console.Error.WriteLine($"`{CommandName.Current} host status` says where this got to. `{CommandName.Current} install --provider {ProviderNamed(args)}` resumes.");
            return 1;
        }
    }

    /// <summary>
    /// Build a Hyper-V host: image, switch, media, VM, install, trust.
    /// </summary>
    /// <remarks>
    /// The original flow, unchanged and merely gathered. Each step is idempotent
    /// and each is also an <c>envmux host</c> command, so a failure here is
    /// resumed by running <c>envmux install</c> again. False on a failure that
    /// has already said why.
    /// </remarks>
    private static async Task<bool> ProvisionHyperVAsync(
        HostConfig config,
        List<string> args,
        Prompt ask,
        CancellationToken ct)
    {
        var image = await ImageAsync(args, ask, ct).ConfigureAwait(false);
        if (image is null)
        {
            return false;
        }

        if (!await SwitchAsync(config, ask, ct).ConfigureAwait(false))
        {
            return false;
        }

        var media = await BuildAsync(config, image, ct).ConfigureAwait(false);

        await VmAsync(config, args, media, ct).ConfigureAwait(false);

        if (!await InstallAsync(config, media, ct).ConfigureAwait(false))
        {
            return false;
        }

        return await TrustAsync(config, ask, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Attach to an Incus daemon that already exists: trust it, and find or make
    /// the network.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The short path. There is no VM to build, no image to write and no install
    /// to wait out — the daemon is up. What it lacks is what the Hyper-V seed
    /// does offline: it does not trust this client, and it may have no network
    /// for sessions. This supplies both online.
    /// </para>
    /// <para>
    /// Nothing about where the daemon is matters beyond its API answering. A
    /// session is reached through the browser its process opens and through
    /// ssh, both over an exec on that API, so the range is the instances' own
    /// business and the daemon can be on the LAN, behind an overlay, or on the
    /// far side of the internet with one port open. The subnet is either one
    /// envmux creates (<c>envmux0</c>) or one the daemon already had
    /// (<c>--network</c>), which is read and never written to.
    /// </para>
    /// </remarks>
    private static async Task<bool> ProvisionIncusAsync(
        HostConfig config,
        bool rangeChosen,
        List<string> args,
        Prompt ask,
        CancellationToken ct)
    {
        if (await DaemonAsync(config, args, ask, ct).ConfigureAwait(false) is not { } trusted)
        {
            return false;
        }

        using var client = IncusClient.Connect(trusted);
        var api = new IncusApi(client);

        return await NetworkAsync(api, trusted, args, ask, rangeChosen, ct).ConfigureAwait(false) is not null;
    }

    /// <summary>
    /// Where the daemon is to be looked for, and what vouches for it.
    /// </summary>
    /// <remarks>
    /// A class and not a record, for the reason <see cref="TrustToken"/> is one:
    /// it holds the token's text — the secret included, because that text is
    /// what gets redeemed — and a record writes itself a printer. Nothing
    /// generates a <c>ToString</c> for this, so nothing can put it in a message.
    /// </remarks>
    internal sealed class DaemonSource
    {
        /// <summary>The address to dial, as it was given. Null when the token's own addresses are to be probed.</summary>
        public string? Api { get; init; }

        /// <summary>The token, read — for its fingerprint and its addresses. Null when there is none, or none that parses.</summary>
        public TrustToken? Token { get; init; }

        /// <summary>The token exactly as it arrived, to be redeemed. Never printed.</summary>
        public string TokenText { get; init; } = "";

        /// <summary>Something worth saying before carrying on.</summary>
        public string Note { get; init; } = "";

        /// <summary>Why this cannot go ahead. Empty when it can.</summary>
        public string Refusal { get; init; } = "";
    }

    /// <summary>
    /// Decide where to look for the daemon from an address, a token, both or neither.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A token is enough by itself: it lists where the daemon listens and names
    /// its certificate, so the addresses are probed and the certificate picks
    /// one. With a token, the address <c>host.json</c> already holds is
    /// <em>not</em> used — the token is the newer statement of where the daemon
    /// is, and on a workstation being pointed at a different daemon the old
    /// address is exactly the wrong one. <c>--api</c> beside a token is an
    /// override: that address is dialled, and the token still says which
    /// certificate it has to present.
    /// </para>
    /// <para>
    /// A <c>--token</c> that does not parse is not fatal when there is an
    /// address to send it to. Other versions of Incus may mint other shapes, and
    /// the daemon is the judge of its own tokens; all that is lost is what the
    /// token would have said about the daemon. Without an address there is
    /// nowhere to send it, and that is refused. An expired one is refused either
    /// way, before anything is dialled, with how to get another.
    /// </para>
    /// </remarks>
    /// <param name="api"><c>--api</c>, or null.</param>
    /// <param name="token"><c>--token</c>, or null.</param>
    /// <param name="recorded"><see cref="HostConfig.Api"/>, which may be empty.</param>
    /// <param name="typed">What was typed at the address prompt, when it was asked: an address, or a pasted token.</param>
    /// <param name="now">For the token's expiry.</param>
    internal static DaemonSource Source(string? api, string? token, string recorded, string? typed, DateTimeOffset now)
    {
        api = api?.Trim() is { Length: > 0 } a ? a : null;
        token = token?.Trim() is { Length: > 0 } t ? t : null;
        typed = typed?.Trim() is { Length: > 0 } y ? y : null;

        // A token pasted where the address was asked for is a token.
        if (token is null && api is null && typed is not null && TrustToken.TryParse(typed, out _))
        {
            token = typed;
            typed = null;
        }

        api ??= typed;

        if (token is null)
        {
            return new DaemonSource { Api = api ?? (recorded.Trim().Length > 0 ? recorded.Trim() : null) };
        }

        if (!TrustToken.TryParse(token, out var parsed))
        {
            return api is null
                ? new DaemonSource
                {
                    Refusal =
                        "--token is not an Incus trust token envmux can read, so it says nothing about where the " +
                        "daemon is. Copy it again — all of it, from `envmux host prepare` or `incus config trust " +
                        "add` — or give the daemon's address with --api and it is sent as it is.",
                }
                : new DaemonSource
                {
                    Api = api,
                    TokenText = token,
                    Note =
                        "--token is not a trust token envmux can read, so it cannot vouch for the certificate. " +
                        "Carrying on with --api as before: the fingerprint is yours to check, and the daemon " +
                        "is the judge of the token.",
                };
        }

        if (parsed.IsExpired(now))
        {
            return new DaemonSource
            {
                Refusal =
                    $"the trust token for '{parsed.ClientName}' expired at " +
                    $"{parsed.ExpiresAt!.Value.ToUniversalTime():yyyy-MM-dd HH:mm} UTC, and the daemon will not honour " +
                    $"it. Mint another on the Incus host — `incus config trust add {parsed.ClientName}` — or run " +
                    $"`{CommandName.Current} host prepare` again, which ends by printing one.",
            };
        }

        return new DaemonSource { Api = api, Token = parsed, TokenText = token };
    }

    /// <summary>What to do with the certificate a daemon presented.</summary>
    internal enum PinDecision
    {
        /// <summary>It is the one <c>host.json</c> already pins. Nothing to decide.</summary>
        AlreadyPinned,

        /// <summary>It is the one the trust token names. Pinned without a question.</summary>
        TokenVouches,

        /// <summary>Nothing vouches for it but a person: show it and ask.</summary>
        Ask,

        /// <summary>There is a token, and this is not the certificate in it. Refused, with no question.</summary>
        Refuse,
    }

    /// <summary>
    /// Whether a presented certificate is pinned, asked about, or refused.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A token outranks everything. It was minted by the daemon's own command
    /// line and carried here out of band, so the fingerprint in it is a better
    /// check than a person comparing sixty-four hex digits by eye — and that
    /// cuts both ways. A match is pinned with no question, even over a different
    /// fingerprint pinned before, because a rebuilt daemon with a fresh token is
    /// exactly what that looks like. A mismatch is refused with no question:
    /// "pin it anyway?" would be offering to send a secret for one daemon to
    /// another.
    /// </para>
    /// <para>
    /// Without a token it is as it always was: the pinned one passes, anything
    /// else is shown to a person.
    /// </para>
    /// </remarks>
    /// <param name="presented">The fingerprint the address presented, normalised.</param>
    /// <param name="pinned"><see cref="HostConfig.Fingerprint"/>, normalised; empty when nothing is pinned.</param>
    /// <param name="vouched">The token's fingerprint, or null when there is no token that parses.</param>
    internal static PinDecision Pin(string presented, string pinned, string? vouched) =>
        vouched is not null
            ? presented.Equals(vouched, StringComparison.Ordinal) ? PinDecision.TokenVouches : PinDecision.Refuse
            : presented.Equals(pinned, StringComparison.Ordinal) ? PinDecision.AlreadyPinned : PinDecision.Ask;

    // 3 — the daemon: found, pinned, and trusting.

    /// <summary>
    /// Find the daemon, pin its certificate, and get into its trust store.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A trust token makes this one paste. It names the daemon's certificate and
    /// lists where it listens, so nobody types an address or compares hex: the
    /// addresses are tried, the one that presents that certificate is the
    /// daemon, and it is pinned on the token's say-so (<see cref="Pin"/>).
    /// </para>
    /// <para>
    /// The token works once, and is redeemed only when the daemon does not
    /// already trust this client — the ordinary case on every run but the first.
    /// Which of the daemon's addresses answered is of no further interest: it
    /// used to become the route's next hop, and there is no route.
    /// </para>
    /// </remarks>
    /// <returns><c>host.json</c> as saved, with the daemon pinned and trusting; null on a failure already said.</returns>
    private static async Task<HostConfig?> DaemonAsync(
        HostConfig config,
        List<string> args,
        Prompt ask,
        CancellationToken ct)
    {
        Step(3, "the daemon");

        var apiOption = Option(args, "--api");
        var tokenOption = Option(args, "--token");

        var typed = apiOption is null && tokenOption is null && config.Api.Length == 0
            ? ask.Line("incus address (host[:port] or https://…) — or paste a trust token", "")
            : null;

        var source = Source(apiOption, tokenOption, config.Api, typed, DateTimeOffset.UtcNow);

        if (source.Refusal.Length > 0)
        {
            Console.Error.WriteLine($"envmux: {source.Refusal}");
            return null;
        }

        if (source.Note.Length > 0)
        {
            Console.WriteLine($"  note     {source.Note}");
        }

        string authority;
        var defaulted = false;

        if (source.Api is { } given)
        {
            if (DaemonAuthority(given, out var unusable) is not { } dialled)
            {
                Console.Error.WriteLine($"envmux: {unusable}");
                return null;
            }

            authority = dialled;
            defaulted = !HasPort(given);
        }
        else if (source.Token is { } listed)
        {
            // Said by name and by count, never by content: the token is a
            // password until it is used.
            Console.WriteLine(
                $"  token        for '{listed.ClientName}': it names the daemon's certificate and " +
                $"{listed.Addresses.Count.ToString(CultureInfo.InvariantCulture)} address(es) it listens on");

            var probe = await listed.ProbeAsync(listed.Candidates(LocalInterface.Discover()), ct).ConfigureAwait(false);

            Console.WriteLine($"  tried        {probe.Describe()}");

            if (probe.Chosen is null)
            {
                Console.Error.WriteLine(
                    "envmux: none of the addresses in the token presented the daemon's certificate, so the daemon " +
                    "was not found from here. A timeout is a filter — a firewall, an allowlist on the API port, a " +
                    "network this machine is not on; a refusal is nothing listening. The token has not been used. " +
                    "`--api <address>` beside it names an address the token does not list.");
                return null;
            }

            authority = probe.Chosen.Authority;
        }
        else
        {
            Console.Error.WriteLine(
                "envmux: there is no daemon to attach to without its address or a trust token. " +
                "`--token <token>` is enough by itself; `--api <host>` names an address.");
            return null;
        }

        // Learn the certificate, exactly as `host trust` does — the one
        // connection made without a pinned fingerprint, which reads the
        // certificate and sends nothing. Least of all the token.
        X509Certificate2 presented;
        try
        {
            presented = await IncusClient.LearnFingerprintAsync(authority, ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is System.Net.Sockets.SocketException or IOException
                                      or System.Security.Authentication.AuthenticationException)
        {
            Console.Error.WriteLine($"envmux: {authority} did not answer a TLS handshake: {e.Message}");
            return null;
        }

        using (presented)
        {
            var fingerprint = ClientCertificate.Fingerprint(presented);
            var pinned = IncusClient.Normalise(config.Fingerprint);

            // What will be dialled, not what was typed. A URL with no port reads
            // as 443 to anybody who has used a browser, and Incus listens on
            // 8443 — so the default is said out loud where it was applied.
            Console.WriteLine(
                $"  address      https://{authority}" +
                (defaulted ? "  (no port given, so Incus's own: 8443)" : ""));
            Console.WriteLine($"  subject      {presented.Subject}");
            Console.WriteLine($"  fingerprint  {fingerprint}");

            switch (Pin(fingerprint, pinned, source.Token?.Fingerprint))
            {
                case PinDecision.AlreadyPinned:
                    // Asked once. A resumed install that stopped to re-confirm a
                    // decision already in host.json would be asking for nothing.
                    Console.WriteLine("  the one already pinned");
                    break;

                case PinDecision.TokenVouches:
                    Console.WriteLine(
                        "  matches the token — which came from the daemon's own command line, so it is pinned " +
                        "without asking");
                    break;

                case PinDecision.Refuse:
                    Console.Error.WriteLine(
                        $"envmux: that is not the daemon the token came from. The token names the certificate " +
                        $"{source.Token!.Fingerprint}, and {authority} presented a different one. Either something " +
                        "else answers at that address, or the token is from another host. Nothing was pinned, " +
                        "and the token was not sent.");
                    return null;

                default:
                    if (pinned.Length > 0)
                    {
                        Console.WriteLine("  This is NOT the certificate pinned before. A rebuilt daemon looks like this.");
                    }

                    if (!ask.Yes("pin it?", true))
                    {
                        Console.WriteLine("  nothing pinned");
                        return null;
                    }

                    break;
            }

            config = config with { Api = authority, Fingerprint = fingerprint };
            config.Save();
        }

        using var client = IncusClient.Connect(config);
        var api = new IncusApi(client);

        ServerInfo server;
        try
        {
            server = await api.ServerAsync(ct).ConfigureAwait(false);
        }
        catch (IncusException e)
        {
            Console.Error.WriteLine($"envmux: pinned {config.Api}, but it will not answer /1.0: {e.Message}");
            return null;
        }

        if (server.IsTrusted)
        {
            Console.WriteLine("  auth: trusted — envmux is already in this daemon's trust store");

            if (source.TokenText.Length > 0)
            {
                Console.WriteLine("  the token was not needed, and has not been used");
            }
        }
        else
        {
            // --token is the unattended path: a caller that already has one
            // does not stop to be asked. Without it, the daemon's owner is told
            // how to mint one and paste it.
            var token = source.TokenText;

            if (token.Length == 0)
            {
                Console.WriteLine();
                Console.WriteLine("  this daemon does not trust envmux yet. On the Incus host, run:");
                Console.WriteLine();
                Console.WriteLine("      incus config trust add envmux");
                Console.WriteLine();
                Console.WriteLine($"  and paste the token it prints — or `{CommandName.Current} host prepare`, which checks the");
                Console.WriteLine("  rest of the host too and ends with one.");
                Console.WriteLine();

                token = ask.Line("trust token", "").Trim();
            }

            if (token.Length == 0)
            {
                Console.Error.WriteLine("envmux: no token, so envmux cannot be added to the trust store.");
                return null;
            }

            await api.AddTrustedCertificateAsync(token, ct).ConfigureAwait(false);

            server = await api.ServerAsync(ct).ConfigureAwait(false);

            if (!server.IsTrusted)
            {
                Console.Error.WriteLine(
                    "envmux: the token was accepted but the daemon still answers auth: untrusted. " +
                    "Check the token was minted for a client certificate.");
                return null;
            }

            Console.WriteLine("  added — the daemon trusts envmux now");
        }

        Console.WriteLine(
            $"  incus {server.Environment.ServerVersion} on {server.Environment.KernelArchitecture}, " +
            $"storage {server.Environment.Storage}");

        return config;
    }


    // 4 — the network: envmux0, made here, or one the daemon already had.

    /// <summary>
    /// Find the network sessions attach to, or make it; and know its range.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A network that is already there is <em>read</em>, whoever made it: its
    /// range, its DHCP ranges and its zone go into <c>host.json</c> — the zone
    /// too, because the bridge's dnsmasq answers only for its own domain. That
    /// is the whole of what adopting one means, and it is equally right for an
    /// <c>envmux0</c> another workstation created. What differs is ownership,
    /// which comes from the description and not the name: <c>envmux0</c> with
    /// envmux's description is envmux's to move and to delete, and anything else
    /// is never PUT to and never removed.
    /// </para>
    /// <para>
    /// Only when there is no network is a range asked for. It is the instances'
    /// range, not this workstation's: nothing here routes to it, so the one
    /// thing worth avoiding is a range the instances themselves would then be
    /// unable to reach — a VPN's, a corporate LAN's — and the suggestion is
    /// made with that in mind.
    /// </para>
    /// </remarks>
    private static async Task<HostConfig?> NetworkAsync(
        IncusApi api,
        HostConfig config,
        List<string> args,
        Prompt ask,
        bool rangeChosen,
        CancellationToken ct)
    {
        Step(4, "the network");

        var name = Option(args, "--network") is { Length: > 0 } named ? named : config.Network;
        var network = await api.NetworkAsync(name, ct).ConfigureAwait(false);

        HostConfig settled;

        if (network is not null)
        {
            if (Adopt(config, network, out var refusal) is not { } read)
            {
                Console.Error.WriteLine($"envmux: {refusal}");
                return null;
            }

            Console.WriteLine(Seed.IsOurs(network)
                ? $"  {name} is already here, and envmux made it"
                : $"  adopting {name} — read, never reconfigured, never deleted");

            Console.WriteLine(
                $"  range   {read.Cidr}   dhcp " +
                (read.DhcpRange.Length > 0 ? read.DhcpRange : "none, so addresses are pinned around its leases"));

            Console.WriteLine(
                $"  zone    *.{read.DnsDomain}" +
                (network.Config.ContainsKey("dns.domain") ? "" : "  (the network names none, which is Incus for 'incus')"));

            // The network is where sessions actually are, so it wins — but not
            // silently, because somebody chose the other value.
            if (rangeChosen && !read.Cidr.Equals(config.Cidr, StringComparison.Ordinal))
            {
                Console.WriteLine($"  host.json said {config.Cidr}. The network is what sessions are on, so it is what is recorded.");
            }

            foreach (var flag in RangeFlags.Where(flag => Option(args, flag) is not null))
            {
                Console.WriteLine($"  {flag} does not apply: {name} already has one, and it is read rather than set");
            }

            settled = read;
        }
        else
        {
            // --network adopts. It does not create under a name of somebody's
            // choosing: a network envmux made is envmux0, which is how a person
            // reading `incus network list` tells the two apart too.
            if (!name.Equals(HostConfig.DefaultNetwork, StringComparison.Ordinal))
            {
                Console.Error.WriteLine(
                    $"envmux: this daemon has no network called '{name}'. --network adopts one that already " +
                    "exists — `incus network list` on the host shows them. Without it, envmux creates " +
                    $"{HostConfig.DefaultNetwork}.");
                return null;
            }

            Console.WriteLine($"  there is no {name} on this daemon yet, so it is made here");
            Console.WriteLine();
            Console.WriteLine("  Every session gets an address on this range. Nothing here routes to it; pick");
            Console.WriteLine("  one the instances will not need for anything else — not a VPN's, not the LAN's.");
            Console.WriteLine();

            // A range step one kept — from a host.json that was already there, or
            // from the host this workstation is being swapped away from — is one
            // somebody chose. Otherwise nobody has been asked yet, and asking
            // Windows what is in use beats offering the default blind.
            var suggested = Option(args, "--cidr")
                ?? (rangeChosen
                    ? config.Cidr
                    : await WindowsNetwork.SuggestCidrAsync(ct).ConfigureAwait(false));

            var cidr = ask.Line("range", suggested);

            settled = config with
            {
                Network = name,
                Cidr = cidr,
                DhcpRange = WindowsNetwork.DhcpFor(cidr),
                DnsDomain = (Option(args, "--domain") ?? ask.Line("zone", config.DnsDomain)).Trim('.').ToLowerInvariant(),
            };
        }

        if (settled.Problems() is { Count: > 0 } problems)
        {
            foreach (var problem in problems)
            {
                Console.Error.WriteLine($"envmux: {problem}");
            }

            return null;
        }

        if (network is null)
        {
            await api.CreateNetworkAsync(
                new NetworksPost
                {
                    Name = name,
                    Type = "bridge",
                    Description = Seed.NetworkDescription,
                    Config = new Dictionary<string, string>(Seed.NetworkConfig(settled), StringComparer.Ordinal),
                },
                ct).ConfigureAwait(false);

            Console.WriteLine();
            Console.WriteLine($"  created {name} on {settled.Cidr}, dns zone .{settled.DnsDomain}");
        }

        settled.Save();

        return settled;
    }

    /// <summary>
    /// <c>host.json</c> as it has to be to use a network the daemon already had.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A pure mapping, and a one-way one: network to file, never the reverse.
    /// <c>ipv4.address</c> is already the bridge's address and prefix, which is
    /// exactly what <see cref="HostConfig.Cidr"/> holds. <c>dns.domain</c> unset
    /// is Incus's default, <c>incus</c>. <c>ipv4.dhcp.ranges</c> unset is left
    /// empty rather than invented: the whole subnet is dnsmasq's to lease from
    /// then, and pinning works around the leases instead of below a range.
    /// </para>
    /// <para>
    /// Null, with a reason, for a network a session could not live on: not a
    /// bridge, no IPv4, DHCP off — a pinned address is <em>delivered</em> by
    /// DHCP, so without it an instance boots with none — or DNS off, which is
    /// the zone not existing. Said here rather than discovered as a session that
    /// starts and cannot be reached.
    /// </para>
    /// </remarks>
    internal static HostConfig? Adopt(HostConfig config, IncusNetworkInfo network, out string refusal)
    {
        refusal = "";

        if (!network.Type.Equals("bridge", StringComparison.OrdinalIgnoreCase))
        {
            refusal =
                $"'{network.Name}' is {(network.Type.Length > 0 ? $"of type '{network.Type}'" : "not a managed network")}, and " +
                "envmux can only adopt a managed bridge: its DHCP hands an instance the address envmux pinned, " +
                "and its dnsmasq answers instance names inside the instances.";
            return null;
        }

        var address = Setting(network, "ipv4.address");

        if (address.Length == 0 || address is "none" or "auto" || !address.Contains('/', StringComparison.Ordinal))
        {
            refusal =
                $"'{network.Name}' has no IPv4 address (ipv4.address is '{(address.Length > 0 ? address : "unset")}'), " +
                "and sessions are reached over IPv4. `incus network show` on the host lists bridges that have one.";
            return null;
        }

        if (Setting(network, "ipv4.dhcp") is "false")
        {
            refusal =
                $"'{network.Name}' has ipv4.dhcp off. A session's pinned address is handed to it by the " +
                "bridge's DHCP, so without it an instance boots with no address at all.";
            return null;
        }

        if (Setting(network, "dns.mode") is "none")
        {
            refusal =
                $"'{network.Name}' has dns.mode none, so nothing on it answers for instance names — and a " +
                "session's services are reached by name from inside it.";
            return null;
        }

        var domain = Setting(network, "dns.domain").Trim('.').ToLowerInvariant();

        return config with
        {
            Network = network.Name,
            Cidr = address,
            DhcpRange = Setting(network, "ipv4.dhcp.ranges"),
            DnsDomain = domain.Length > 0 ? domain : IncusDefaultDomain,
        };

        static string Setting(IncusNetworkInfo network, string key) =>
            network.Config.TryGetValue(key, out var value) ? value.Trim() : "";
    }

    /// <summary>What Incus calls a network's zone when the network does not say.</summary>
    internal const string IncusDefaultDomain = "incus";

    /// <summary>
    /// What to dial, from what somebody typed or pasted.
    /// </summary>
    /// <remarks>
    /// <c>host</c>, <c>host:port</c>, and — because the address usually arrives
    /// by being copied out of a browser or an <c>incus remote</c> listing —
    /// <c>https://host[:port]</c>, with or without a path behind it. No port
    /// means 8443, which is <see cref="IncusClient.Authority"/>'s rule and is
    /// kept: it is Incus's default and it is documented. Anything that is not
    /// https is refused rather than quietly upgraded, because a person who typed
    /// <c>http://</c> believes something about that daemon that is not true.
    /// </remarks>
    internal static string? DaemonAuthority(string given, out string problem)
    {
        problem = "";

        var value = Bare(given, out var scheme);

        if (scheme.Length > 0 && !scheme.Equals("https", StringComparison.OrdinalIgnoreCase))
        {
            problem = $"'{given.Trim()}' is {scheme}://, and an Incus daemon answers on https and nothing else.";
            return null;
        }

        if (value.Length == 0 || value.Any(char.IsWhiteSpace))
        {
            problem = $"'{given.Trim()}' is not an address — host, host:port or https://host[:port].";
            return null;
        }

        var authority = IncusClient.Authority(value);
        var port = authority[(authority.LastIndexOf(':') + 1)..];

        if (!int.TryParse(port, NumberStyles.None, CultureInfo.InvariantCulture, out var number) ||
            number is < 1 or > 65535)
        {
            problem = $"'{given.Trim()}' names port '{port}', which is not one.";
            return null;
        }

        return authority;
    }

    /// <summary>Whether what was typed carried a port of its own, or is about to be given 8443.</summary>
    internal static bool HasPort(string given)
    {
        var value = Bare(given, out _);
        return IncusClient.Authority(value).Equals(value, StringComparison.Ordinal);
    }

    /// <summary>The <c>host[:port]</c> in the middle of whatever was given, and the scheme in front of it.</summary>
    private static string Bare(string given, out string scheme)
    {
        var value = given.Trim();
        scheme = "";

        if (value.IndexOf("://", StringComparison.Ordinal) is var at and >= 0)
        {
            scheme = value[..at];
            value = value[(at + 3)..];
        }

        // A pasted URL brings a path — /1.0, or only a trailing slash — which
        // is no part of where to dial.
        return value.IndexOf('/', StringComparison.Ordinal) is var slash and >= 0 ? value[..slash] : value;
    }

    /// <summary>
    /// Which backend the arguments name, when they name one.
    /// </summary>
    /// <remarks>
    /// <c>--provider hyperv|incus</c> says it outright. <c>--api</c>,
    /// <c>--token</c> and <c>--network</c> say it too: each is a fact about a
    /// daemon that already exists, so somebody who passed one has answered the
    /// question and should not be asked it. Null when nothing was said, and an
    /// unknown name comes back as it was typed so it can be refused by name
    /// rather than quietly read as Hyper-V.
    /// </remarks>
    internal static string? ProviderNamed(List<string> args)
    {
        if (Option(args, "--provider") is { Length: > 0 } named)
        {
            return named.Equals(HostConfig.Incus, StringComparison.OrdinalIgnoreCase) ? HostConfig.Incus
                : named.Equals(HostConfig.HyperV, StringComparison.OrdinalIgnoreCase) ? HostConfig.HyperV
                : named.Equals("docker", StringComparison.OrdinalIgnoreCase) ? "docker"
                : named;
        }

        return DaemonFlags.Any(args.Contains) ? HostConfig.Incus : null;
    }

    /// <summary>
    /// Which backend to build against, from the arguments or a question.
    /// </summary>
    /// <remarks>
    /// Otherwise the default is Hyper-V — the one that needs no daemon to
    /// already exist — and the question is only asked when there is somebody to
    /// answer it; a <c>--yes</c> or a redirected stdin takes the default rather
    /// than hanging.
    /// </remarks>
    private static string ProviderFrom(List<string> args, Prompt ask, string fallback)
    {
        if (ProviderNamed(args) is { } named)
        {
            return named;
        }

        Console.WriteLine("  backend: hyperv builds a VM here; incus attaches to a daemon you already run.");

        return ask.Line("provider (hyperv/incus)", fallback)
            .Equals(HostConfig.Incus, StringComparison.OrdinalIgnoreCase)
            ? HostConfig.Incus
            : HostConfig.HyperV;
    }

    /// <summary>What step one settles.</summary>
    /// <param name="Config">The host, as written to <c>host.json</c>.</param>
    /// <param name="RangeChosen">
    /// Whether the range in it is one somebody chose, as opposed to the default
    /// nobody has been asked about yet. The Incus provider asks at step four,
    /// and only when it has to.
    /// </param>
    private sealed record Configured(HostConfig Config, bool RangeChosen);

    // 1 — the range, the zone, the names.

    /// <summary>
    /// Decide what host this is, and — for a host envmux builds — its range.
    /// </summary>
    /// <remarks>
    /// <para>
    /// For Hyper-V the range has to be settled first: it is written into the
    /// seed, and the seed is written into the image. For an Incus that already
    /// exists it cannot be settled yet. The daemon may already have the network
    /// — <c>envmux0</c>, made from another workstation, or one of its own named
    /// with <c>--network</c> — and then the range is <em>read</em>; asking for
    /// one here would be asking a question whose answer is about to be
    /// overwritten. So that provider is only told who the host is, and the range
    /// waits for step four.
    /// </para>
    /// <para>
    /// A <c>host.json</c> that names the <em>other</em> provider is a workstation
    /// being swapped from one host to another, and is treated as that rather
    /// than as a file to keep: the range and the zone carry over, because the
    /// ssh entry is written in terms of the zone, and the old host's address
    /// and fingerprint do not.
    /// </para>
    /// </remarks>
    private static async Task<Configured?> ConfigureAsync(
        List<string> args,
        Prompt ask,
        CancellationToken ct)
    {
        Step(1, "the range");

        var existing = File.Exists(HostConfig.Location);
        var config = HostConfig.Load();
        var named = ProviderNamed(args);
        var chosen = existing;

        if (named is not null && named != HostConfig.Incus && named != HostConfig.HyperV)
        {
            Console.Error.WriteLine(
                $"envmux: provider '{named}' is not one envmux knows — it is '{HostConfig.HyperV}' or '{HostConfig.Incus}'");
            return null;
        }

        if (existing)
        {
            Console.WriteLine($"  {HostConfig.Location} is already written");
            Console.WriteLine($"  host    {config.Provider}{(config.Api.Length > 0 ? $" at {config.Api}" : "")}");
            Console.WriteLine($"  range   {config.Cidr}   dhcp {(config.DhcpRange.Length > 0 ? config.DhcpRange : "none")}");
            Console.WriteLine($"  zone    *.{config.DnsDomain}");
            Console.WriteLine();

            if (named is not null && !named.Equals(config.Provider, StringComparison.OrdinalIgnoreCase))
            {
                Console.WriteLine($"  That is a {config.Provider} host, and this is asking for an {named} one: a swap.");
                Console.WriteLine("  The range and the zone are kept, so the ssh entry written in terms of them still");
                Console.WriteLine("  holds. The old host's address and fingerprint are forgotten. The old host");
                Console.WriteLine("  itself is not touched — `envmux host reset --keep-down` first, if it should go.");
                Console.WriteLine();

                if (!ask.Yes("swap this workstation to the new host?", true))
                {
                    Console.WriteLine("  nothing changed");
                    return null;
                }

                // gateway and resolver are an older envmux's, and this file is
                // being rewritten anyway: a good moment for it to stop carrying
                // them.
                config = config with
                {
                    Provider = named,
                    Api = "",
                    Fingerprint = "",
                    Gateway = "",
                    Resolver = "",
                    Network = HostConfig.DefaultNetwork,
                };

                config.Save();
            }
            else if (!config.IsHyperV && config.Api.Length == 0)
            {
                // Written by a run that stopped before it reached the daemon.
                // Nothing in it was chosen, so there is nothing to keep or not.
                chosen = false;
            }
            else if (!ask.Yes("keep it?", true))
            {
                existing = false;
                chosen = false;
            }
        }

        if (!existing)
        {
            var provider = ProviderFrom(args, ask, config.Provider);

            if (provider == HostConfig.Incus)
            {
                config = config with { Provider = provider };
            }
            else
            {
                var suggested = Option(args, "--cidr")
                    ?? await WindowsNetwork.SuggestCidrAsync(ct).ConfigureAwait(false);

                Console.WriteLine("  Every session gets an address on this range. Nothing here routes to it; pick");
                Console.WriteLine("  one the instances will not need for anything else — not a VPN's, not the LAN's.");
                Console.WriteLine();

                var cidr = ask.Line("range", suggested);

                config = config with
                {
                    Provider = provider,
                    Cidr = cidr,
                    DhcpRange = WindowsNetwork.DhcpFor(cidr),
                    DnsDomain = Option(args, "--domain") ?? ask.Line("zone", config.DnsDomain),
                    VmName = Option(args, "--vm") ?? config.VmName,
                    Switch = Option(args, "--switch") ?? config.Switch,
                    Network = HostConfig.DefaultNetwork,
                };

                chosen = true;
            }

            if (config.Problems() is { Count: > 0 } problems)
            {
                foreach (var problem in problems)
                {
                    Console.Error.WriteLine($"envmux: {problem}");
                }

                return null;
            }

            config.Save();
            Console.WriteLine();
            Console.WriteLine($"  wrote {HostConfig.Location}");
        }

        if (config.IsHyperV)
        {
            if (Option(args, "--network") is not null)
            {
                Console.Error.WriteLine(
                    "envmux: --network adopts a network on an Incus daemon that already exists. A Hyper-V host is " +
                    $"built with its own {HostConfig.DefaultNetwork}, so there is nothing to adopt.");
                return null;
            }
        }
        else if (!chosen)
        {
            Console.WriteLine("  The range waits for step 4. A network the daemon already has is read, not");
            Console.WriteLine("  chosen — and only a new envmux0 is given a range picked here.");
            return new Configured(config, false);
        }

        return new Configured(config, chosen);
    }


    // 2 — the certificate the host will trust before it has booted.

    private static void Certificate()
    {
        Step(2, "the certificate");

        if (File.Exists(HostConfig.CertificatePath))
        {
            Console.WriteLine($"  {HostConfig.CertificatePath} is already here");
            return;
        }

        using var certificate = ClientCertificate.Create(DateTimeOffset.UtcNow);
        ClientCertificate.Write(certificate, HostConfig.CertificatePath, HostConfig.KeyPath);

        Console.WriteLine($"  {HostConfig.CertificatePath}");
        Console.WriteLine($"  fingerprint {ClientCertificate.Fingerprint(certificate)}");
        Console.WriteLine("  it goes into the install image, so the host trusts this client from first boot");
    }

    // 3 — the image.

    private static async Task<string?> ImageAsync(List<string> args, Prompt ask, CancellationToken ct)
    {
        Step(3, "the image");

        if (Option(args, "--image") is { Length: > 0 } given)
        {
            if (!File.Exists(given))
            {
                Console.Error.WriteLine($"envmux: there is no image at {given}");
                return null;
            }

            Console.WriteLine($"  {given}");
            return given;
        }

        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };

        Console.WriteLine($"  asking {IncusOsIndex.Root}{IncusOsIndex.IndexPath}");

        var channel = Option(args, "--channel") ?? IncusOsIndex.Stable;
        var architecture = IncusOsIndex.Architecture;

        IReadOnlyList<IncusOsUpdate> published;

        try
        {
            published = await IncusOsIndex.FetchAsync(http, ct).ConfigureAwait(false);
        }
        catch (ImageIndexException e)
        {
            // Offline, or the CDN is having a day. A build that was downloaded
            // before is a perfectly good thing to install, and rebuilding a host
            // is exactly when the network is least likely to be the thing you
            // want to depend on.
            if (ImageDownload.Cached() is not { Count: > 0 } cached)
            {
                throw;
            }

            Console.WriteLine($"  {e.Message}");
            Console.WriteLine($"  but {Path.GetFileName(cached[0])} is already downloaded");

            if (ask.Yes("use it?", true))
            {
                return cached[0];
            }

            return null;
        }

        var builds = IncusOsIndex.Installable(published, architecture, channel);

        if (builds.Count == 0)
        {
            Console.Error.WriteLine($"envmux: the index lists no {channel} build for {architecture}");
            return null;
        }

        var wanted = Option(args, "--version");

        var chosen = wanted is null
            ? builds[0]
            : builds.FirstOrDefault(b => b.Version.Equals(wanted, StringComparison.Ordinal));

        if (chosen is null)
        {
            Console.Error.WriteLine($"envmux: no {channel} build called '{wanted}'. The recent ones are:");

            foreach (var build in builds.Take(8))
            {
                Console.Error.WriteLine($"          {build.Describe(architecture)}");
            }

            return null;
        }

        Console.WriteLine($"  latest {channel} for {architecture}: {chosen.Describe(architecture)}");

        if (wanted is null && builds.Count > 1 && !ask.Yes("use it?", true))
        {
            Console.WriteLine();

            for (var i = 0; i < Math.Min(8, builds.Count); i++)
            {
                Console.WriteLine($"    {(i + 1).ToString(CultureInfo.InvariantCulture)}  " +
                                  $"{builds[i].Describe(architecture)}");
            }

            Console.WriteLine();
            var pick = ask.Line("which", "1");

            if (!int.TryParse(pick, CultureInfo.InvariantCulture, out var index) ||
                index < 1 || index > Math.Min(8, builds.Count))
            {
                Console.Error.WriteLine($"envmux: '{pick}' is not one of those");
                return null;
            }

            chosen = builds[index - 1];
        }

        var file = IncusOsIndex.Image(chosen, architecture)!;

        Console.WriteLine();

        return await ImageDownload
            .EnsureAsync(http, chosen, file, line => Console.WriteLine($"  {line}"), ct)
            .ConfigureAwait(false);
    }

    // 4 — the switch, which has to be an external one.

    private static async Task<bool> SwitchAsync(HostConfig config, Prompt ask, CancellationToken ct)
    {
        Step(4, "the switch");

        if (await HyperVSwitch.FindAsync(config.Switch, ct).ConfigureAwait(false) is { } found)
        {
            Console.WriteLine($"  {found}");

            if (found.IsExternal)
            {
                return true;
            }

            Console.Error.WriteLine(
                $"envmux: '{config.Switch}' is {found.Kind}, and the VM needs an address on a network " +
                "Windows can route to. Name a different one with --switch.");

            return false;
        }

        var adapters = await HyperVSwitch.AdaptersAsync(ct).ConfigureAwait(false);

        if (adapters.Count == 0)
        {
            Console.Error.WriteLine(
                "envmux: no physical adapter is up to put a switch on. Connect one, or create the " +
                "switch yourself in Hyper-V Manager and name it with --switch.");

            return false;
        }

        Console.WriteLine($"  there is no switch called '{config.Switch}'. It can be made now.");
        Console.WriteLine();
        Console.WriteLine("  Creating one briefly interrupts the adapter it binds — Windows rebuilds the");
        Console.WriteLine("  stack around it. A second or two, and worth knowing about on a video call.");
        Console.WriteLine();

        var adapter = adapters[0];

        if (adapters.Count > 1)
        {
            for (var i = 0; i < adapters.Count; i++)
            {
                Console.WriteLine($"    {(i + 1).ToString(CultureInfo.InvariantCulture)}  {adapters[i]}");
            }

            Console.WriteLine();
            var pick = ask.Line("which adapter", "1");

            if (!int.TryParse(pick, CultureInfo.InvariantCulture, out var index) ||
                index < 1 || index > adapters.Count)
            {
                Console.Error.WriteLine($"envmux: '{pick}' is not one of those");
                return false;
            }

            adapter = adapters[index - 1];
        }
        else
        {
            Console.WriteLine($"    {adapter}");
            Console.WriteLine();
        }

        if (!ask.Yes($"create '{config.Switch}' on {adapter.Name}?", true))
        {
            Console.WriteLine("  nothing created");
            return false;
        }

        await HyperVSwitch.CreateAsync(config.Switch, adapter, ct).ConfigureAwait(false);
        Console.WriteLine($"  {config.Switch} created on {adapter.Name}");
        return true;
    }

    // 5 — seed a copy of the image and convert it.

    private static async Task<string> BuildAsync(HostConfig config, string image, CancellationToken ct)
    {
        Step(5, "the install media");

        Directory.CreateDirectory(HostConfig.VmDirectory);

        var name = Path.GetFileNameWithoutExtension(image);
        var vhdx = Path.Combine(HostConfig.VmDirectory, $"{name}.vhdx");

        if (File.Exists(vhdx))
        {
            Console.WriteLine($"  {vhdx} is already built");
            return vhdx;
        }

        var seeded = Path.Combine(HostConfig.VmDirectory, $"{name}-seeded.img");

        Console.WriteLine($"  copying {Path.GetFileName(image)} — the download is not modified in place");
        File.Copy(image, seeded, overwrite: true);

        var files = Seed.Files(config, ClientCertificate.Pem(HostConfig.CertificatePath));
        var archive = Seed.Archive(files);
        var offset = DiskImage.InjectSeed(seeded, archive);

        Console.WriteLine(
            $"  seeded {archive.Length.ToString(CultureInfo.InvariantCulture)} bytes at " +
            $"0x{offset.ToString("x", CultureInfo.InvariantCulture)} (partition 2)");

        foreach (var line in Seed.Describe(config))
        {
            Console.WriteLine($"    {line}");
        }

        await HyperV.ConvertAsync(
            seeded,
            vhdx,
            Deterministic(config, name),
            DateTimeOffset.UnixEpoch,
            line => Console.WriteLine($"  {line}"),
            ct).ConfigureAwait(false);

        // Several gigabytes of a file whose only job was to be converted.
        File.Delete(seeded);

        Console.WriteLine($"  {vhdx}");
        return vhdx;
    }

    // 6 — the VM.

    private static async Task VmAsync(HostConfig config, List<string> args, string media, CancellationToken ct)
    {
        Step(6, "the machine");

        if (await HyperV.StatusAsync(config.VmName, ct).ConfigureAwait(false) is { Exists: true } existing)
        {
            Console.WriteLine($"  {config.VmName} already exists ({existing.State.ToLowerInvariant()})");

            // Both of these are for a machine envmux made before it knew better,
            // and both are no-ops on one it made today.
            if (await HyperV.ClearCheckpointsAsync(config.VmName, ct).ConfigureAwait(false) is var removed &&
                removed > 0)
            {
                Console.WriteLine(
                    $"  removed {removed.ToString(CultureInfo.InvariantCulture)} automatic " +
                    (removed == 1 ? "checkpoint" : "checkpoints") +
                    " — they hide the real disks behind differencing ones");
            }

            await HyperV.EnsureConsoleAsync(config.VmName, ct).ConfigureAwait(false);

            return;
        }

        await HyperV.CreateAsync(
            config,
            HostConfig.VmDirectory,
            media,
            Gib(Option(args, "--disk"), HyperV.DefaultSystemDisk),
            Gib(Option(args, "--memory"), HyperV.DefaultMemory),
            int.TryParse(Option(args, "--cpus"), CultureInfo.InvariantCulture, out var cpus)
                ? cpus
                : HyperV.DefaultProcessors,
            line => Console.WriteLine($"  {line}"),
            ct).ConfigureAwait(false);
    }

    // 7 — start it, wait for the installer, detach the media, start it again.

    private static async Task<bool> InstallAsync(HostConfig config, string media, CancellationToken ct)
    {
        Step(7, "installing");

        var status = await HyperV.StatusAsync(config.VmName, ct).ConfigureAwait(false);

        // No media means it was already taken out, which means this ran before.
        if (status.Media is null)
        {
            Console.WriteLine("  already installed — the media was detached");

            if (!status.IsRunning)
            {
                await HyperV.StartAsync(config.VmName, ct).ConfigureAwait(false);
            }

            return true;
        }

        if (!status.IsRunning)
        {
            await HyperV.StartAsync(config.VmName, ct).ConfigureAwait(false);
        }

        Console.WriteLine("  it installs itself, unattended. Usually under a minute.");
        Console.WriteLine();

        if (!await AwaitInstallAsync(config, status.System?.Path, ct).ConfigureAwait(false))
        {
            await GiveUpAsync(config, ct).ConfigureAwait(false);
            return false;
        }

        Console.WriteLine("  taking the media out and restarting");

        await HyperV.StopAsync(config.VmName, ct).ConfigureAwait(false);
        await HyperV.DetachMediaAsync(config.VmName, ct).ConfigureAwait(false);
        await HyperV.StartAsync(config.VmName, ct).ConfigureAwait(false);

        return true;
    }

    /// <summary>
    /// Wait for the installer, by listening if it can and watching if it cannot.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The moment being waited for is genuinely awkward. The installer writes
    /// the image in seconds, logs that it succeeded, and then waits to be told
    /// the media has gone — machine still running, no address, no API, no guest
    /// agent. Every state envmux can poll is identical before and after.
    /// </para>
    /// <para>
    /// So there are two ways to know, and they are not equal.
    /// </para>
    /// <para>
    /// <b>Watching</b> is a guess, and it is what actually runs. The screen has
    /// not changed in twenty seconds, and the system disk has grown by
    /// gigabytes: nothing is happening, and something happened. On this image
    /// the guess is all there is, because the seed declares no console — naming
    /// <c>ttyS0</c> there made IncusOS die at startup on a device it does not
    /// enumerate, so the exact channel was given up to keep the host bootable.
    /// </para>
    /// <para>
    /// <b>Listening</b> would be exact — the same log line that appears on
    /// screen arriving as text off COM1, an answer rather than a guess — and the
    /// loop still checks for it first, so a platform that ever does speak on the
    /// port wins for free. None that envmux builds on today does, so it is a
    /// fast path that stays quiet, not the primary one.
    /// </para>
    /// <para>
    /// The guess is not trusted, it is tested — the caller detaches the media and
    /// waits for the API, and the host answering is the proof. If it was wrong,
    /// nothing was lost: a VM sitting unchanged for twenty seconds with a blank
    /// disk was not going to finish.
    /// </para>
    /// </remarks>
    private static async Task<bool> AwaitInstallAsync(HostConfig config, string? system, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow + InstallDeadline;
        var started = DateTimeOffset.UtcNow;

        await using var console = await SerialConsole
            .ConnectAsync(HyperV.ConsolePipe(config.VmName), ct).ConfigureAwait(false);

        // The seed declares no console on this image, so the pipe — if the COM
        // port put one there — stays silent; the screen is what is watched. The
        // listener is kept for a platform that one day speaks on it, where it
        // would be the exact answer the screen only guesses at.
        Console.WriteLine(console is null
            ? "  watching the screen for the installer to finish"
            : "  watching the screen for the installer to finish (a serial console is attached but this image is silent on it)");

        long? signature = null;
        var since = DateTimeOffset.UtcNow;
        var announced = "";

        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();

            // Said it, which is the whole point of the console being there.
            if (console is not null && InstallerSays.Finished(console))
            {
                Console.WriteLine("  it says it is installed and waiting for the media to go");
                return true;
            }

            if (console is not null && InstallerSays.Failed(console))
            {
                Console.Error.WriteLine();
                Console.Error.WriteLine("envmux: the installer says it failed. Its console said:");

                foreach (var said in Tail(console.Text, 12))
                {
                    Console.Error.WriteLine($"        {said}");
                }

                return false;
            }

            var status = await HyperV.StatusAsync(config.VmName, ct).ConfigureAwait(false);

            if (status is { Exists: true, IsRunning: false })
            {
                Console.WriteLine("  it powered itself off, which is the installer saying it is done");
                return true;
            }

            if (await HyperV.AddressAsync(config, ct).ConfigureAwait(false) is { } address &&
                await AnswersAsync(address, ct).ConfigureAwait(false))
            {
                Console.WriteLine("  it is already answering on 8443 — it rebooted into the installed system");
                return true;
            }

            var written = system is null
                ? 0
                : await HyperV.DiskBytesAsync(system, ct).ConfigureAwait(false);

            var screen = await Framebuffer.CaptureAsync(config.VmName, ct).ConfigureAwait(false);
            var now = screen is null ? (long?)null : Framebuffer.Signature(screen);

            if (now != signature)
            {
                signature = now;
                since = DateTimeOffset.UtcNow;
            }

            var still = DateTimeOffset.UtcNow - since;

            // The screen is the signal that actually arrives. The seed no longer
            // declares a console — it was fatal on this image — so the exact
            // answer above never comes, and this is what tells "finished" from
            // "stuck on the first thing". It is still safe alongside a console
            // that does speak: a working installer reports finished on the line
            // above and returns before this is reached, and while it is writing
            // the screen is changing, so `still` never crosses the threshold
            // until the write is actually done.
            if (screen is not null && still >= ScreenSettled && written >= WrittenEnough)
            {
                Console.WriteLine(
                    "  the screen has not changed in " +
                    $"{still.TotalSeconds.ToString("F0", CultureInfo.InvariantCulture)}s and " +
                    $"{ImageDownload.Size(written)} has been written — treating that as finished");

                return true;
            }

            var elapsed = (int)(DateTimeOffset.UtcNow - started).TotalSeconds;

            var line = screen is null
                ? "  waiting for it to draw something"
                : $"  {elapsed.ToString(CultureInfo.InvariantCulture),4}s  " +
                  $"{Framebuffer.Describe(screen)}, still for " +
                  $"{still.TotalSeconds.ToString("F0", CultureInfo.InvariantCulture)}s, " +
                  $"{ImageDownload.Size(written)} written";

            // Only when it says something new, so a minute of waiting is not
            // sixty identical lines.
            if (line != announced)
            {
                announced = line;
                Console.WriteLine(line);
            }

            await Task.Delay(TimeSpan.FromSeconds(3), ct).ConfigureAwait(false);
        }

        return false;
    }

    /// <summary>The last few lines of something, for a failure worth quoting.</summary>
    private static IEnumerable<string> Tail(string text, int lines) =>
        text.ReplaceLineEndings("\n")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .TakeLast(lines);

    /// <summary>
    /// Say what happened, and leave a picture of it.
    /// </summary>
    /// <remarks>
    /// The one thing that makes a stuck install actionable. There is no shell on
    /// that machine and no log to read, so the screen is the whole of the
    /// evidence — and a PNG on disk is something that can be looked at, kept, or
    /// attached to a message, which a glance at Hyper-V Manager is not.
    /// </remarks>
    private static async Task GiveUpAsync(HostConfig config, CancellationToken ct)
    {
        Console.Error.WriteLine();
        Console.Error.WriteLine(
            $"envmux: {config.VmName} did not finish installing within " +
            $"{InstallDeadline.TotalMinutes.ToString("F0", CultureInfo.InvariantCulture)} minutes.");

        var path = Path.Combine(HostConfig.Directory, $"{config.VmName}-stuck.png");

        if (await Framebuffer.SaveAsync(config.VmName, path, ct).ConfigureAwait(false) is { } written)
        {
            Console.Error.WriteLine($"        Its screen, as it is now: {written}");
        }

        await using var console = await SerialConsole
            .ConnectAsync(HyperV.ConsolePipe(config.VmName), ct).ConfigureAwait(false);

        if (console is not null && console.Text.Trim().Length > 0)
        {
            Console.Error.WriteLine("        The last thing its console said:");

            foreach (var line in Tail(console.Text, 12))
            {
                Console.Error.WriteLine($"          {line}");
            }
        }

        Console.Error.WriteLine($"        `{CommandName.Current} install --provider hyperv` resumes from here once it is unstuck.");
    }

    /// <summary>Whether anything is listening on the API port yet.</summary>
    /// <remarks>
    /// A connect and nothing else. No TLS, no request: the question is only
    /// whether incusd is up, and answering it should not need a fingerprint that
    /// has not been pinned yet.
    /// </remarks>
    private static Task<bool> AnswersAsync(IPAddress address, CancellationToken ct) =>
        AnswersAsync(address, IncusClient.DefaultPort, ct);

    // 8 — the fingerprint.

    private static async Task<bool> TrustAsync(HostConfig config, Prompt ask, CancellationToken ct)
    {
        Step(8, "trust");

        Console.WriteLine("  waiting for it to take an address and answer");

        var deadline = DateTimeOffset.UtcNow + TimeSpan.FromMinutes(5);
        IPAddress? address = null;

        // Asking the guest beats working it out. IncusOS prints its address on
        // the console — `Network configuration: enp0s3(192.168.19.47)` — where
        // the Windows side has to infer it from a neighbour table that has no
        // entry until something has already talked to the machine.
        await using var console = await SerialConsole
            .ConnectAsync(HyperV.ConsolePipe(config.VmName), ct).ConfigureAwait(false);

        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();

            var said = console is null ? null : InstallerSays.Address(console);

            if (said is not null && await AnswersAsync(said, ct).ConfigureAwait(false))
            {
                Console.WriteLine($"  it says it is on {said}");
                address = said;
                break;
            }

            address = await HyperV.AddressAsync(config, ct).ConfigureAwait(false);

            if (address is not null && await AnswersAsync(address, ct).ConfigureAwait(false))
            {
                break;
            }

            address = null;
            await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
        }

        if (address is null)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine(
                $"envmux: it has not answered on 8443. Give it a moment and run `{CommandName.Current} install --provider hyperv` again, " +
                "or pass the address yourself: `envmux host trust <address>`.");

            return false;
        }

        Console.WriteLine($"  {address}:{IncusClient.DefaultPort.ToString(CultureInfo.InvariantCulture)}");

        using var presented = await IncusClient
            .LearnFingerprintAsync(address.ToString(), ct).ConfigureAwait(false);

        var fingerprint = ClientCertificate.Fingerprint(presented);

        Console.WriteLine($"  subject      {presented.Subject}");
        Console.WriteLine($"  fingerprint  {fingerprint}");
        Console.WriteLine();

        // The wizard built this VM itself, minutes ago, from an image it seeded.
        // Pinning what it presents is not the same leap as pinning a host
        // somebody handed you an address for — but it is still the whole of the
        // trust decision, so it is shown and confirmed rather than assumed.
        if (!ask.Yes("pin it?", true))
        {
            Console.WriteLine("  nothing pinned");
            return false;
        }

        (config with
        {
            Api = IncusClient.Authority(address.ToString()),
            Fingerprint = fingerprint,
        }).Save();

        using var client = IncusClient.Connect(HostConfig.Load());
        var server = await new IncusApi(client).ServerAsync(ct).ConfigureAwait(false);

        if (!server.IsTrusted)
        {
            Console.Error.WriteLine(
                "envmux: the host answered and does not trust this client. The seeded certificate is not " +
                "the one being sent — the image was built with a different one.");

            return false;
        }

        Console.WriteLine($"  auth: trusted — incus {server.Environment.ServerVersion}, no token exchanged");
        return true;
    }

    /// <summary>Whether anything is listening on a port.</summary>
    /// <remarks>
    /// A connect and nothing else. No TLS, no request: the question is only
    /// whether the machine is there yet.
    /// </remarks>
    private static async Task<bool> AnswersAsync(IPAddress address, int port, CancellationToken ct)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(3));

            using var tcp = new System.Net.Sockets.TcpClient();
            await tcp.ConnectAsync(address, port, timeout.Token).ConfigureAwait(false);

            return true;
        }
        catch (Exception e) when (e is System.Net.Sockets.SocketException ||
                                  (e is OperationCanceledException && !ct.IsCancellationRequested))
        {
            return false;
        }
    }

    // 9 — the instance every session is copied from. (5, on a daemon that already existed.)

    private static async Task GoldenAsync(HostConfig config, int step, CancellationToken ct)
    {
        Step(step, "the golden instance");

        using var client = IncusClient.Connect(config);
        var api = new IncusApi(client);

        if (await Golden.ExistsAsync(api, ct).ConfigureAwait(false))
        {
            Console.WriteLine($"  {Golden.Source} is already here");
            return;
        }

        var started = DateTimeOffset.UtcNow;

        await Golden.BuildAsync(api, config, line => Console.WriteLine($"  {line}"), ct).ConfigureAwait(false);

        Console.WriteLine(
            $"  took {(DateTimeOffset.UtcNow - started).TotalSeconds.ToString("F0", CultureInfo.InvariantCulture)}s. " +
            "Every session after this is a clone of it.");
    }

    // 10 — the key the editor attaches with, and the ssh config that offers it. (6, on a daemon that already existed.)

    /// <summary>
    /// Make envmux's ssh key and point <c>~/.ssh/config</c> at it for the zone.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Last, and about this workstation rather than about the host — which is
    /// why it is the one step that asks before doing anything. Everything above
    /// writes to a VM, to Incus, or to envmux's own directory;
    /// <c>~/.ssh/config</c> is a file the person running this owns and may have
    /// strong opinions about, and it decides what this machine connects to and
    /// with what. It is also the only thing on this workstation that knows how
    /// to reach a session by name: the block's <c>ProxyCommand</c> is
    /// <c>envmux relay</c>, since nothing here resolves the zone.
    /// </para>
    /// <para>
    /// The key is made either way. It goes in envmux's own directory, is used by
    /// nothing else, and every session authorises it as it starts — so a
    /// declined config entry leaves a working setup that needs one line pasted
    /// rather than a whole step repeated.
    /// </para>
    /// </remarks>
    private static async Task SshAsync(HostConfig config, Prompt ask, int step, CancellationToken ct)
    {
        Step(step, "the editor's key");

        var identity = await SshIdentity.EnsureAsync(ct).ConfigureAwait(false);

        if (!identity.Ok)
        {
            // Not fatal. The host is built and sessions will run; it is the
            // editor button that will not work, and `envmux ssh` is the retry
            // once ssh-keygen is on PATH.
            Console.WriteLine($"  no key: {identity.Reason}");

            if (identity.ToolMissing)
            {
                Console.WriteLine(
                    "  ssh-keygen has to be on PATH — it comes with the OpenSSH client: " +
                    "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0");
            }

            Console.WriteLine($"  then `{CommandName.Current} ssh`. Sessions run without it; the editor does not attach.");
            return;
        }

        Console.WriteLine(
            $"  key   {SshConfig.Tilde(SshIdentity.KeyPath)} " +
            $"({(identity.Change == IdentityChange.Created ? "created" : "already here")})");

        if (!ask.Yes($"add a `Host *.{config.DnsDomain}` entry to ~/.ssh/config, naming that key?", true))
        {
            Console.WriteLine($"  skipped. `{CommandName.Current} ssh` does it later, `--print` shows the block.");
            return;
        }

        try
        {
            var written = SshConfig.Apply([config.DnsDomain], Backends.BackendKind.Incus);

            Console.WriteLine(
                $"  ssh   {SshConfig.Tilde(written.Location)} — " +
                $"{string.Join(" ", written.Zones.Select(z => "*." + z))} → that key, through `{CommandName.Current} relay`");
        }
        catch (SshConfigException e)
        {
            Console.WriteLine($"  ssh   not written: {e.Message}");
            Console.WriteLine($"  `{CommandName.Current} ssh --print` writes the block for you to paste.");
        }
    }

    private static void Done(HostConfig config)
    {
        Console.WriteLine();
        Console.WriteLine("──────────────────────────────────────────────────────────────────────");
        Console.WriteLine();
        Console.WriteLine($"  host    {config.Api}");
        Console.WriteLine($"  range   {config.Cidr}   on {config.Network} — the instances' own; nothing here routes to it");
        Console.WriteLine($"  zone    *.{config.DnsDomain}   the ssh alias a session answers to, through `{CommandName.Current} relay`");
        Console.WriteLine($"  state   {HostConfig.Directory}");
        Console.WriteLine();
        Console.WriteLine("  cd into a git repository and start one:");
        Console.WriteLine();
        Console.WriteLine($"    {CommandName.Current} init          # write a .envmux.json to edit");
        Console.WriteLine($"    {CommandName.Current} feat-login    # a session; `b` opens a browser whose localhost is it");
        Console.WriteLine();
        Console.WriteLine(config.IsHyperV
            ? $"  {CommandName.Current} host status is the diagnostic. There is no shell on that VM."
            : $"  {CommandName.Current} host status is the diagnostic, and it is safe to run at any time.");
        Console.WriteLine();
    }

    /// <summary>
    /// How many steps the chosen provider has, for the <c>[n/total]</c> counter.
    /// </summary>
    /// <remarks>
    /// Ten for Hyper-V, which builds a VM; six for an existing Incus, which only
    /// attaches to one. Set once when the provider is known, so a six-step flow
    /// does not print <c>[3/10]</c>.
    /// </remarks>
    private static int _total = 6;

    private static void Step(int number, string what)
    {
        Console.WriteLine();
        Console.WriteLine(
            $"[{number.ToString(CultureInfo.InvariantCulture)}/" +
            $"{_total.ToString(CultureInfo.InvariantCulture)}] {what}");
    }

    /// <summary>A stable id for a build, so the same inputs make the same disk.</summary>
    private static Guid Deterministic(HostConfig config, string name)
    {
        var seed = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes($"{config.VmName}|{config.Mac}|{config.Cidr}|{name}"));

        return new Guid(seed.AsSpan(0, 16));
    }

    private static long Gib(string? value, long fallback) =>
        long.TryParse(value, CultureInfo.InvariantCulture, out var gib) && gib > 0
            ? gib * 1024 * 1024 * 1024
            : fallback;

    private static string? Option(List<string> args, string name)
    {
        var index = args.IndexOf(name);
        return index >= 0 && index + 1 < args.Count ? args[index + 1] : null;
    }
}

/// <summary>
/// Asking, or not asking.
/// </summary>
/// <remarks>
/// <c>--yes</c> takes every default, and so does a redirected stdin — a prompt
/// nobody can see is a hang, and this is exactly the command somebody will put
/// in a setup script.
/// </remarks>
internal sealed class Prompt(bool assumeYes)
{
    private bool Silent => assumeYes || Console.IsInputRedirected || Console.IsOutputRedirected;

    public bool Yes(string question, bool byDefault)
    {
        if (Silent)
        {
            return byDefault;
        }

        Console.Write($"  {question} [{(byDefault ? "Y/n" : "y/N")}] ");
        var answer = Console.ReadLine()?.Trim().ToLowerInvariant() ?? "";

        return answer.Length == 0 ? byDefault : answer is "y" or "yes";
    }

    public string Line(string question, string byDefault)
    {
        if (Silent)
        {
            Console.WriteLine($"  {question}: {byDefault}");
            return byDefault;
        }

        Console.Write($"  {question} [{byDefault}] ");
        var answer = Console.ReadLine()?.Trim() ?? "";

        return answer.Length == 0 ? byDefault : answer;
    }
}
