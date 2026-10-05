namespace Envmux.Editor;

/// <summary>
/// This machine's public SSH keys, for getting back into a session.
/// </summary>
/// <remarks>
/// <para>
/// The gap this closes: <c>envmux code</c> produced
/// <c>vscode-remote://ssh-remote+matt@planno-demo.envmux/work</c> and nothing
/// could ever connect to it. sshd is in the golden image and answers — the
/// failure is <c>Permission denied (publickey,password)</c> — because the
/// session account is created with no password and no
/// <c>authorized_keys</c>. The editor button in the window and in the portal
/// pointed at the same nowhere.
/// </para>
/// <para>
/// A public key is not a secret, which is why this needs none of the ceremony
/// the coding tools and the git credentials do. It is the half of a keypair that
/// exists to be handed out, and handing it to a container you started on your own
/// machine is what it is for.
/// </para>
/// <para>
/// Every <c>.pub</c> in <c>~/.ssh</c>, because ssh will offer all of them and
/// picking one would mean picking wrong for whoever keeps a key per host. The
/// files that are not keys are excluded by name rather than by parsing: a
/// <c>known_hosts</c> is a list of other people's keys and would authorise every
/// machine this workstation has ever connected to.
/// </para>
/// <para>
/// And <see cref="SshIdentity"/>, envmux's own, first. That one is the reason
/// this works without arranging anything: it is the key
/// <c>~/.ssh/config</c> tells ssh to offer for the zone, so it is the key that
/// has to be inside. The rest are a courtesy to whoever would rather use theirs.
/// </para>
/// </remarks>
internal static class HostKeys
{
    /// <summary>Where ssh keeps them.</summary>
    private static string Directory =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".ssh");

    /// <summary>
    /// Every public key on this machine, one per line.
    /// </summary>
    /// <remarks>
    /// Empty when there are none, which is a real state and not an error: a
    /// workstation that has never made a key is one where the editor cannot
    /// attach yet, and the session is otherwise fine.
    /// </remarks>
    public static IReadOnlyList<string> Public()
    {
        var keys = new List<string>();

        // envmux's own first, and without needing a ~/.ssh at all: a workstation
        // that has never made a key still gets an editor that attaches.
        if (SshIdentity.PublicKey() is { } identity)
        {
            keys.Add(identity);
        }

        if (!System.IO.Directory.Exists(Directory))
        {
            return keys;
        }

        foreach (var path in System.IO.Directory.EnumerateFiles(Directory, "*.pub"))
        {
            // known_hosts.pub is not a thing, but a stray one would be a list of
            // other machines' host keys — authorising every server this
            // workstation has ever met to log in here.
            if (Path.GetFileName(path).StartsWith("known_hosts", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            foreach (var line in ReadLines(path))
            {
                var key = line.Trim();

                if (LooksLikeAKey(key) && !keys.Contains(key, StringComparer.Ordinal))
                {
                    keys.Add(key);
                }
            }
        }

        return keys;
    }

    /// <summary>
    /// Forget the host key remembered for a name envmux is about to reuse.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A session name maps to a hostname, and a recreated session is a new
    /// machine answering to the old name with a new host key. ssh calls that
    /// what it is:
    /// </para>
    /// <code>
    /// @@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@
    /// IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
    /// </code>
    /// <para>
    /// It is right to shout, and it is wrong here: envmux destroyed that machine
    /// and made this one, so the old key is known-dead rather than suspicious.
    /// Left alone it blocks the editor outright — strict checking refuses the
    /// connection, and the advice in the message is to edit known_hosts by hand.
    /// </para>
    /// <para>
    /// Only the one name, and only when an instance was actually created. This
    /// forgets a key for a host envmux owns the naming of; it is not a general
    /// tidy-up of somebody's known_hosts.
    /// </para>
    /// </remarks>
    /// <param name="hostname">The session's hostname.</param>
    /// <param name="ct">Cancellation.</param>
    public static async Task ForgetAsync(string hostname, CancellationToken ct = default)
    {
        // Both files. The block SshConfig writes sends the zone's host keys to
        // envmux's own known_hosts, and a workstation set up before that block
        // existed has them in ssh's default one — so a name is forgotten in the
        // place it is remembered, whichever of the two that is.
        await ForgetFromAsync(hostname, null, ct).ConfigureAwait(false);

        if (File.Exists(SshIdentity.KnownHostsPath))
        {
            await ForgetFromAsync(hostname, SshIdentity.KnownHostsPath, ct).ConfigureAwait(false);
        }
    }

    private static async Task ForgetFromAsync(string hostname, string? file, CancellationToken ct)
    {
        try
        {
            // Failure is fine and unreported: no ssh-keygen on PATH, no
            // known_hosts yet, or nothing remembered for this name. All three
            // mean there is no stale key in the way, which is the goal.
            await Process.ProcessRunner
                .RunAsync("ssh-keygen", file is null ? ["-R", hostname] : ["-R", hostname, "-f", file], ct: ct)
                .ConfigureAwait(false);
        }
        catch (Process.ProcessException)
        {
        }
    }

    /// <summary>
    /// The key files that were used, by name.
    /// </summary>
    /// <remarks>
    /// Worth saying out loud, because ssh only offers a key whose filename it
    /// recognises. A key called <c>twm_dev_001</c> is authorised here and still
    /// refused on the way in until <c>~/.ssh/config</c> names it or <c>-i</c>
    /// does — and the failure is an ordinary "Permission denied", which reads
    /// like the key never arrived.
    /// </remarks>
    public static IReadOnlyList<string> Names()
    {
        var names = new List<string>();

        // "envmux" rather than "id_ed25519", which would read as the one in
        // ~/.ssh. What matters to whoever is reading the log is which of the two
        // arrived, not what either is called on disk.
        if (SshIdentity.PublicKey() is not null)
        {
            names.Add("envmux");
        }

        if (System.IO.Directory.Exists(Directory))
        {
            names.AddRange(System.IO.Directory
                .EnumerateFiles(Directory, "*.pub")
                .Where(p => !Path.GetFileName(p).StartsWith("known_hosts", StringComparison.OrdinalIgnoreCase))
                .Where(p => ReadLines(p).Any(l => LooksLikeAKey(l.Trim())))
                .Select(Path.GetFileName)
                .OfType<string>());
        }

        return names;
    }

    /// <summary>
    /// Whether a line is a public key rather than a comment or a blank.
    /// </summary>
    /// <remarks>
    /// By prefix, which is what every one of them starts with: <c>ssh-rsa</c>,
    /// <c>ssh-ed25519</c>, <c>ecdsa-sha2-…</c>, and <c>sk-</c> for the
    /// hardware-backed ones. Parsing the base64 to be certain would reject a key
    /// type nobody has invented yet, and an authorized_keys line that sshd does
    /// not recognise is ignored rather than fatal.
    /// </remarks>
    internal static bool LooksLikeAKey(string line) =>
        line.Length > 0 &&
        !line.StartsWith('#') &&
        (line.StartsWith("ssh-", StringComparison.Ordinal) ||
         line.StartsWith("ecdsa-", StringComparison.Ordinal) ||
         line.StartsWith("sk-", StringComparison.Ordinal));

    /// <summary>A file that cannot be read is a file with no keys in it.</summary>
    private static string[] ReadLines(string path)
    {
        try
        {
            return File.ReadAllLines(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }
}
