using System.Text;

namespace Envmux.Session;

/// <summary>
/// The account a session runs as, made once inside a fresh instance.
/// </summary>
/// <remarks>
/// <para>
/// Much smaller than it was. Under Docker this had to reproduce the host user's
/// exact uid and gid, because the project directory was a bind mount and every
/// file the session wrote appeared on the host owned by whoever wrote it —
/// getting that wrong left a working tree full of root-owned files that the
/// person who started the session could not delete.
/// </para>
/// <para>
/// Nothing is bind-mounted now. The repository lives inside the instance and
/// travels as a bundle, so no uid inside is ever seen from outside and there is
/// nothing to match. What is left is the part that always mattered: the session
/// is not root, so a mistake inside the instance stays inside it.
/// </para>
/// </remarks>
internal static class Bootstrap
{
    /// <summary>
    /// The shell that makes the account, or leaves it alone if it is there.
    /// </summary>
    /// <remarks>
    /// Idempotent, because an adopted instance runs it again — and a second run
    /// that failed on "user already exists" would report the session as having
    /// no account at all.
    /// </remarks>
    /// <param name="user">The account the session runs as.</param>
    /// <param name="workdir">Where the repository is cloned. Made here so the clone has somewhere to land.</param>
    /// <param name="workdirLink">
    /// The session-named symlink to <paramref name="workdir"/> that the editor
    /// opens — <see cref="SessionPlan.WorkdirLink"/>, which says why.
    /// </param>
    public static string Script(string user, string workdir, string workdirLink)
    {
        var quoted = Workspace.Quote(user);
        var script = new StringBuilder();

        script.Line("set -eu");

        // -m for a home directory, because everything a tool keeps state in is
        // under one, and a user without one lands in / and writes there.
        script.Line($"id -u {quoted} >/dev/null 2>&1 || useradd -m -s /bin/bash {quoted}");

        // sudo without a password, deliberately. This is a development machine
        // that is thrown away and rebuilt from a snapshot; the alternative is a
        // password nobody was told, on an account nobody can log into anyway.
        script.Line("mkdir -p /etc/sudoers.d");
        script.Line(
            $"printf '%s ALL=(ALL) NOPASSWD:ALL\\n' {quoted} > /etc/sudoers.d/envmux-{Config.Slug.From(user)}");
        script.Line($"chmod 0440 /etc/sudoers.d/envmux-{Config.Slug.From(user)}");

        script.Line($"mkdir -p {Workspace.Quote(workdir)}");
        script.Line($"chown {quoted} {Workspace.Quote(workdir)}");

        // A name for the workdir that says which session this is, for the
        // editor to open. Made beside the workdir because it is the workdir,
        // seen from the recents list; it is not what anything else runs in.
        //
        // `-n` is the whole of the idempotence. Without it a second run finds a
        // link that already resolves to a directory and does what ln does with
        // any directory — puts the new link *inside* it, /envmux_feat-login/work.
        // With it the link is treated as the file it is, and `-f` replaces it,
        // which is also what picks up a workdir changed in the config between
        // one session on this instance and the next.
        //
        // Anything at that path that is not a link is left alone. The name is
        // one no distribution ships and no slug can produce, so whatever is
        // there was put there by hand inside this instance, and a bootstrap
        // script is not the thing to decide it goes. The editor will open the
        // path regardless and show what is there, which is the honest outcome.
        var link = Workspace.Quote(workdirLink);
        script.Line($"if [ -L {link} ] || [ ! -e {link} ]; then ln -sfn {Workspace.Quote(workdir)} {link}; fi");

        // Into the docker group, when the image has one. A docker feature adds
        // its _REMOTE_USER to that group while the image is being built — and
        // this account does not exist yet at that point, because it is made per
        // session on a copy. So the group is there and the session user is not
        // in it, and everything that reaches for the socket without sudo is
        // told the daemon is unhealthy. Aspire says exactly that:
        // "Container runtime 'docker' was found but appears to be unhealthy."
        script.Line($"getent group docker >/dev/null 2>&1 && usermod -aG docker {quoted} || true");

        // Somewhere for latched tasks to write, whoever they belong to.
        script.Line($"mkdir -p {Incus.Latch.LogDirectory}");
        script.Line($"chmod 1777 {Incus.Latch.LogDirectory}");

        script.Line($"printf '%s\\n' {quoted}");

        return script.ToString();
    }

    /// <summary>Where the session's environment is written for every shell in the instance.</summary>
    public const string EnvironmentProfile = "/etc/profile.d/envmux-session.sh";

    /// <summary>
    /// The shell that puts the session's environment where everything finds it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is what makes <c>services</c> mean anything. A declared Postgres
    /// gets an instance, an address and a generated password, and the session
    /// log says "credentials are in the environment" — and until this existed
    /// they were not. They were computed, shown by <c>--dry-run</c>, and
    /// dropped. A task running <c>psql -h "$DB_HOST"</c> got <c>-h ""</c>, fell
    /// back to a local socket, and failed with <c>connection to server on socket
    /// "/var/run/postgresql/.s.PGSQL.5432" failed</c> — a message about the
    /// wrong machine entirely.
    /// </para>
    /// <para>
    /// A profile script rather than a per-exec environment, because there are
    /// four ways into this instance — a latched task, the TUI's shell, the
    /// portal's shell, and ssh for the editor — and all four start a login
    /// shell. Setting it per-exec means setting it in four places and finding
    /// the fifth later.
    /// </para>
    /// <para>
    /// Readable by everyone in the container, which is worth saying out loud
    /// because it holds a database password. A session instance has one account
    /// on it and is deleted with the session; the alternative is a file the
    /// session user can read and root's tasks cannot, which is a different bug.
    /// </para>
    /// </remarks>
    /// <param name="environment">The session's variables, in any order.</param>
    public static string EnvironmentScript(IReadOnlyDictionary<string, string> environment)
    {
        var script = new StringBuilder();

        script.Line("set -eu");
        script.Line("mkdir -p /etc/profile.d");
        script.Line($"cat > {EnvironmentProfile} <<'ENVMUX_SESSION_ENV'");
        script.Line("# Written by envmux: what this session's services and config expose.");

        foreach (var (key, value) in environment.OrderBy(e => e.Key, StringComparer.Ordinal))
        {
            // Single-quoted, so a generated password with a $ or a backtick in
            // it arrives as itself rather than as whatever a shell made of it.
            script.Line($"export {key}={Workspace.Quote(value)}");
        }

        script.Line("ENVMUX_SESSION_ENV");
        script.Line($"chmod 0644 {EnvironmentProfile}");

        return script.ToString();
    }

    /// <summary>
    /// The shell that lets this machine ssh back in.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Without it <c>envmux code</c> hands out
    /// <c>vscode-remote://ssh-remote+matt@planno-demo.envmux/work</c> and nothing
    /// can connect: sshd is in the image and answers, and the answer is
    /// <c>Permission denied (publickey,password)</c>, because the account is
    /// created with no password and no authorized_keys. The editor button in the
    /// window and in the portal pointed at the same nowhere.
    /// </para>
    /// <para>
    /// A public key is not a secret, so this needs none of the ceremony the
    /// coding tools and the git credentials do. It is the half of a keypair that
    /// exists to be handed out.
    /// </para>
    /// <para>
    /// Written whole rather than appended, so a session started twice does not
    /// accumulate the same key, and so a key removed from this machine stops
    /// working here too.
    /// </para>
    /// </remarks>
    /// <param name="user">The account to let in.</param>
    /// <param name="keys">This machine's public keys, one per line.</param>
    public static string AuthorizedKeysScript(string user, IReadOnlyList<string> keys)
    {
        var quoted = Workspace.Quote(user);
        var home = Home(user);
        var directory = $"{home}/.ssh";
        var file = $"{directory}/authorized_keys";

        var script = new StringBuilder();

        script.Line("set -eu");
        script.Line($"mkdir -p {Workspace.Quote(directory)}");

        // sshd refuses a key file anyone else can write, and says so only in its
        // own log — from the client it is an ordinary permission denied.
        script.Line($"cat > {Workspace.Quote(file)} <<'ENVMUX_AUTHORIZED_KEYS'");

        foreach (var key in keys)
        {
            script.Line(key);
        }

        script.Line("ENVMUX_AUTHORIZED_KEYS");
        script.Line($"chmod 0700 {Workspace.Quote(directory)}");
        script.Line($"chmod 0600 {Workspace.Quote(file)}");
        // `matt:` rather than `matt`: the trailing colon sets the group to the
        // account's own login group, where the bare name leaves whatever group
        // root created it with.
        script.Line($"chown -R {Workspace.Quote(user + ":")} {Workspace.Quote(directory)}");

        return script.ToString();
    }

    /// <summary>The home directory the account gets, which tool state is written under.</summary>
    public static string Home(string user) => $"/home/{user}";
}
