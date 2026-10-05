namespace Envmux.Editor;

/// <summary>What <see cref="SshIdentity.EnsureAsync"/> found, or had to do.</summary>
internal enum IdentityChange
{
    /// <summary>The key was already there, whole.</summary>
    Existed,

    /// <summary>There was no key, and now there is one.</summary>
    Created,

    /// <summary>The private half was there and the public half was rebuilt from it.</summary>
    Recovered,

    /// <summary>There is no key and there could not be one — see the reason.</summary>
    Failed,
}

/// <summary>The key, what happened to it, and why not when that is the answer.</summary>
/// <param name="Change">Found, made, rebuilt, or not.</param>
/// <param name="PublicKey">The public half, one line, or null when there is none.</param>
/// <param name="Reason">Why there is no key, when there is none.</param>
/// <param name="ToolMissing">
/// Whether the reason is that there is no <c>ssh-keygen</c> at all, which is the
/// one failure with a fix worth printing — and printing that fix for a key with
/// a passphrase on it sends the reader to install something they already have.
/// </param>
internal sealed record IdentityResult(
    IdentityChange Change,
    string? PublicKey,
    string? Reason,
    bool ToolMissing = false)
{
    public bool Ok => Change is not IdentityChange.Failed;
}

/// <summary>
/// One ed25519 key, envmux's own, that every session lets in.
/// </summary>
/// <remarks>
/// <para>
/// The gap this closes: <see cref="HostKeys"/> authorises every <c>*.pub</c> in
/// <c>~/.ssh</c>, which is the right thing to do with keys somebody else made
/// and the wrong thing to depend on. A workstation with no key at all cannot
/// attach an editor to anything; a workstation whose key is called
/// <c>work_laptop</c> is authorised and still refused, because ssh only offers
/// keys whose filename it recognises. Both arrive as
/// <c>Permission denied (publickey)</c>, which says nothing about either.
/// </para>
/// <para>
/// So envmux keeps one of its own, beside <c>host.json</c> and the client
/// certificate — one place for envmux's things, and one that
/// <c>ENVMUX_HOME</c> moves, so a test never writes into a real <c>~/.ssh</c>.
/// <see cref="SshConfig"/> writes the <c>~/.ssh/config</c> entry that names it
/// and the session writes its public half into the instance; between them there
/// is nothing left to arrange by hand.
/// </para>
/// <para>
/// Made by <c>ssh-keygen</c> rather than in process, because .NET has no
/// Ed25519 — and it is not a new dependency:
/// <see cref="HostKeys.ForgetAsync"/> already runs it, and a machine without it
/// has no ssh to attach an editor with either.
/// </para>
/// </remarks>
internal static class SshIdentity
{
    /// <summary>The private half, named the way ssh names them.</summary>
    public const string KeyFileName = "id_ed25519";

    /// <summary>The half that exists to be handed out.</summary>
    public const string PublicKeyFileName = KeyFileName + ".pub";

    /// <summary>
    /// Host keys for the zone, kept apart from the workstation's own.
    /// </summary>
    /// <remarks>
    /// A recreated session is a new machine answering to the old name, so this
    /// file churns in a way <c>~/.ssh/known_hosts</c> should not have to. Keeping
    /// it here lets envmux forget a name without editing a file full of other
    /// people's machines.
    /// </remarks>
    public const string KnownHostsFileName = "known_hosts";

    public static string KeyPath => Path.Combine(Host.HostConfig.Directory, KeyFileName);

    public static string PublicKeyPath => Path.Combine(Host.HostConfig.Directory, PublicKeyFileName);

    public static string KnownHostsPath => Path.Combine(Host.HostConfig.Directory, KnownHostsFileName);

    /// <summary>Whether both halves are on disk.</summary>
    public static bool Exists => File.Exists(KeyPath) && File.Exists(PublicKeyPath);

    /// <summary>
    /// The public half, or null when there is not one yet.
    /// </summary>
    /// <remarks>
    /// Read each time rather than cached: it is one short file, and a session
    /// started in the same minute as <c>envmux ssh</c> should see the key that
    /// command just made.
    /// </remarks>
    public static string? PublicKey()
    {
        try
        {
            foreach (var line in File.ReadAllLines(PublicKeyPath))
            {
                if (HostKeys.LooksLikeAKey(line.Trim()))
                {
                    return line.Trim();
                }
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }

        return null;
    }

    /// <summary>
    /// Make the key if it is not there, and hand back the public half either way.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Idempotent, because this runs from <c>envmux install</c> and from
    /// <c>envmux ssh</c> and the second is usually somebody checking. An existing
    /// key is never regenerated: it is authorised inside every session currently
    /// running, and replacing it would lock the editor out of all of them at
    /// once.
    /// </para>
    /// <para>
    /// The public half is rebuilt from the private one when it has gone missing,
    /// which is otherwise a dead end — <c>ssh-keygen -f</c> on a key that exists
    /// asks whether to overwrite it, and a prompt in the middle of an install is
    /// a hang.
    /// </para>
    /// </remarks>
    /// <param name="ct">Cancellation.</param>
    public static async Task<IdentityResult> EnsureAsync(CancellationToken ct = default)
    {
        if (Exists)
        {
            return new IdentityResult(IdentityChange.Existed, PublicKey(), null);
        }

        try
        {
            System.IO.Directory.CreateDirectory(Host.HostConfig.Directory);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new IdentityResult(IdentityChange.Failed, null, $"{Host.HostConfig.Directory}: {e.Message}");
        }

        return File.Exists(KeyPath)
            ? await RecoverAsync(ct).ConfigureAwait(false)
            : await CreateAsync(ct).ConfigureAwait(false);
    }

    /// <summary>A new keypair, with no passphrase.</summary>
    /// <remarks>
    /// No passphrase because there is nobody to type one: the editor attaches
    /// from a button and the session authorises the key without being asked, so
    /// an agent would have to be running and loaded for any of it to work. This
    /// is a credential for development instances on a bridge this workstation
    /// routes to, rebuilt from a snapshot whenever they are rebuilt — the same
    /// trade the passwordless sudo inside them is.
    /// </remarks>
    private static async Task<IdentityResult> CreateAsync(CancellationToken ct)
    {
        var comment = Comment();

        try
        {
            var made = await Process.ProcessRunner
                .RunAsync("ssh-keygen", ["-t", "ed25519", "-f", KeyPath, "-N", "", "-C", comment, "-q"], ct: ct)
                .ConfigureAwait(false);

            if (!made.Ok)
            {
                return new IdentityResult(IdentityChange.Failed, null, made.Error);
            }
        }
        catch (Process.ProcessException e)
        {
            return Missing(e);
        }

        Restrict(KeyPath);

        return PublicKey() is { } key
            ? new IdentityResult(IdentityChange.Created, key, null)
            : new IdentityResult(IdentityChange.Failed, null, $"ssh-keygen wrote no {PublicKeyFileName}");
    }

    /// <summary>The public half, derived back out of the private one.</summary>
    private static async Task<IdentityResult> RecoverAsync(CancellationToken ct)
    {
        try
        {
            // -P "" so a key somebody replaced with a passphrase-protected one
            // fails here and says so. Without it ssh-keygen asks for the
            // passphrase on a stdin this process does not own, which in the
            // middle of `envmux install` is a hang with no visible cause.
            var derived = await Process.ProcessRunner
                .RunAsync("ssh-keygen", ["-y", "-P", "", "-f", KeyPath], ct: ct)
                .ConfigureAwait(false);

            if (!derived.Ok || !HostKeys.LooksLikeAKey(derived.Output.Trim()))
            {
                return new IdentityResult(IdentityChange.Failed, null, derived.Error);
            }

            // A comment is what tells this key apart in an authorized_keys
            // somebody is reading, so one goes on when there is none. Current
            // ssh-keygen keeps the comment in the private key and prints it
            // here; older ones print the type and the key alone, and appending
            // unconditionally gave the recovered file two of them.
            var printed = derived.Output.Trim();
            var key = printed.Split(' ', 3).Length >= 3 ? printed : $"{printed} {Comment()}";

            File.WriteAllText(PublicKeyPath, key + Environment.NewLine);

            return new IdentityResult(IdentityChange.Recovered, key, null);
        }
        catch (Process.ProcessException e)
        {
            return Missing(e);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new IdentityResult(IdentityChange.Failed, null, e.Message);
        }
    }

    /// <summary>Who and where this key was made, for whoever reads an authorized_keys.</summary>
    private static string Comment() => $"envmux ({Environment.UserName}@{Environment.MachineName})";

    /// <summary>
    /// A failure that ran nothing, told apart from one that ran and refused.
    /// </summary>
    /// <remarks>
    /// <see cref="Process.ProcessRunner"/> turns "no such executable" into exit
    /// 127, which is the only case where "install the OpenSSH client" is the
    /// right thing to print. A key with a passphrase on it also arrives here,
    /// and that reader has ssh-keygen already.
    /// </remarks>
    private static IdentityResult Missing(Process.ProcessException e) =>
        new(IdentityChange.Failed, null, e.Result.Error, e.Result.ExitCode == 127);

    /// <summary>
    /// Take the group and the world off the private key.
    /// </summary>
    /// <remarks>
    /// ssh refuses a private key anyone else can read — "UNPROTECTED PRIVATE KEY
    /// FILE" — and ssh-keygen already writes it correctly. This is for the case
    /// where something else did not: a umask, a copied file, a directory
    /// inherited from somewhere. Windows has no mode and needs none; the ACLs
    /// there come from the profile directory the file was made in.
    /// </remarks>
    private static void Restrict(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        try
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // The key exists and is probably fine, and ssh says so plainly if not.
        }
    }
}
