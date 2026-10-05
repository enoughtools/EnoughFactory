using Envmux.Config;
using Envmux.Editor;
using Envmux.Host;

namespace Envmux.Commands;

/// <summary>
/// The key sessions let in, and the <c>~/.ssh/config</c> entry that offers it.
/// </summary>
/// <remarks>
/// <para>
/// Run once by <c>envmux install</c>, and available on its own because the two
/// halves it writes are the two that go stale: a workstation that had no
/// <c>ssh-keygen</c> during the install, a <c>~/.ssh/config</c> somebody
/// reorganised, a zone renamed in <c>host.json</c>, a repository whose
/// <c>.envmux.json</c> names a zone of its own. All four are "the editor
/// stopped attaching", and all four are this command.
/// </para>
/// <para>
/// Idempotent in both halves. The key is never regenerated — it is authorised
/// inside every session currently running — and the config block is rewritten
/// between its markers without touching anything else in the file.
/// </para>
/// </remarks>
internal static class SshCommand
{
    public static async Task<int> RunAsync(
        string directory,
        string? session,
        bool print,
        Backends.BackendKind? requested = null,
        CancellationToken ct = default)
    {
        // The one cost of calling this `ssh`: somebody will type a session name
        // after it expecting a shell. Taking no notice of the name and writing a
        // config file instead is the worst of the available answers.
        if (session is not null)
        {
            Console.Error.WriteLine($"envmux: `{CommandName.Current} ssh` takes no session name — it sets this");
            Console.Error.WriteLine("        machine up to reach sessions, rather than connecting to one.");
            Console.Error.WriteLine($"        For a shell in '{session}': `c` in its window, or the portal.");
            Console.Error.WriteLine($"        For an editor on it: `{CommandName.Current} code {session}`.");
            return 2;
        }

        var zones = Zones(directory);
        var backend = requested ?? Backends.BackendCatalog.Parse(SessionConfig.Load(directory).Backend)
            ?? Backends.BackendCatalog.Default;

        if (print)
        {
            // The block as it would be written — the same one, zones already in
            // the file included, so this is worth reading before letting it
            // happen. For pasting into a config somebody manages themselves too.
            Console.WriteLine(
                SshConfig.Block(
                    SshConfig.Wanted(zones), SshIdentity.KeyPath, SshIdentity.KnownHostsPath, SshConfig.RelayFor(backend)));

            if (!SshIdentity.Exists)
            {
                Console.Error.WriteLine(
                    $"envmux: {SshIdentity.KeyPath} does not exist yet — " +
                    $"`{CommandName.Current} ssh` makes it.");
            }

            return 0;
        }

        var identity = await SshIdentity.EnsureAsync(ct).ConfigureAwait(false);

        if (!identity.Ok)
        {
            Console.Error.WriteLine($"envmux: no ssh key, and one could not be made: {identity.Reason}");

            if (identity.ToolMissing)
            {
                Console.Error.WriteLine(
                    "        ssh-keygen has to be on PATH. On Windows it comes with the OpenSSH client: " +
                    "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0");
            }
            else
            {
                Console.Error.WriteLine(
                    $"        Delete {SshIdentity.KeyPath} and run this again to make a fresh one — " +
                    "sessions started after that will authorise it.");
            }

            // The config block is not written either. An entry naming a key that
            // is not there turns every connection into "no such identity file",
            // which is a worse failure than the one that just happened.
            return 1;
        }

        var config = SshConfig.Apply(zones, backend);

        Console.WriteLine($"  key     {SshConfig.Tilde(SshIdentity.KeyPath)} ({Said(identity.Change)})");
        Console.WriteLine(
            $"  config  {SshConfig.Tilde(config.Location)} — " +
            $"{string.Join(" ", config.Zones.Select(z => "*." + z))} → that key, through " +
            $"`{CommandName.Current} relay` ({Said(config.Change)})");
        Console.WriteLine();
        Console.WriteLine("  Sessions started from now on let it in. Running ones pick it up when they");
        Console.WriteLine($"  are started again. `{CommandName.Current} code` is the editor.");

        return 0;
    }

    /// <summary>
    /// Every zone this workstation's sessions could answer under.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The host's, from <c>host.json</c> — one bridge, one zone, so that is the
    /// suffix almost every alias ends in. And this repository's, because
    /// <c>.envmux.json</c> may name a <c>domain</c> of its own and a hardcoded
    /// <c>*.envmux</c> would leave exactly that project's editor unable to
    /// attach.
    /// </para>
    /// <para>
    /// Neither file is required to exist or to parse. This command is worth
    /// running before there is a host and inside a directory that is not a
    /// project, so a missing or broken one contributes nothing and stops
    /// nothing — <c>envmux config validate</c> is where a broken
    /// <c>.envmux.json</c> is somebody's problem.
    /// </para>
    /// </remarks>
    private static List<string> Zones(string directory)
    {
        var zones = new List<string>();

        try
        {
            zones.Add(HostConfig.Load().DnsDomain);
        }
        catch (Exception e) when (e is ConfigException or IOException or UnauthorizedAccessException)
        {
            zones.Add(HostConfig.DefaultDnsDomain);
        }

        try
        {
            if (SessionConfig.Load(directory).Domain is { Length: > 0 } domain)
            {
                zones.Add(domain);
            }
        }
        catch (Exception e) when (e is ConfigException or IOException or UnauthorizedAccessException)
        {
        }

        return zones;
    }

    private static string Said(IdentityChange change) => change switch
    {
        IdentityChange.Created => "created",
        IdentityChange.Recovered => "public half rebuilt",
        _ => "already here",
    };

    private static string Said(SshConfigChange change) => change switch
    {
        SshConfigChange.Added => "added",
        SshConfigChange.Updated => "updated",
        _ => "already right",
    };
}
