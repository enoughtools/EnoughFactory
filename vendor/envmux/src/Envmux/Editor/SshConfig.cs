using System.Text;

namespace Envmux.Editor;

/// <summary>The <c>~/.ssh/config</c> block could not be written.</summary>
internal sealed class SshConfigException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>What writing the block did to the file.</summary>
internal enum SshConfigChange
{
    /// <summary>The block was already exactly this.</summary>
    Unchanged,

    /// <summary>There was no block, and now there is one.</summary>
    Added,

    /// <summary>There was a block and it now says something else.</summary>
    Updated,
}

/// <summary>What is in the file now, and what it covers.</summary>
/// <param name="Change">Added, updated, or already right.</param>
/// <param name="Location">The file it happened to.</param>
/// <param name="Zones">The zones the block matches, in the order it lists them.</param>
internal sealed record SshConfigResult(
    SshConfigChange Change,
    string Location,
    IReadOnlyList<string> Zones);

/// <summary>
/// The <c>Host *.&lt;zone&gt;</c> entry that makes a session's name an ssh
/// alias, and points ssh at envmux's own key for it.
/// </summary>
/// <remarks>
/// <para>
/// A name under the zone resolves nowhere on this workstation: there is no
/// route to the range and no DNS rule for the zone any more. The block is what
/// keeps <c>ssh myproj-feat-login.envmux</c> — and the editor's Remote-SSH
/// attach, which is that — working anyway. Its <c>ProxyCommand</c> runs
/// <c>envmux relay</c>, which reaches the instance's port 22 from inside the
/// instance over the host's API, the way the session's browser proxy reaches a
/// dev server (<see cref="Commands.RelayCommand"/>). ssh never resolves the
/// name; it hands it to the relay as <c>%h</c>.
/// </para>
/// <para>
/// A key in <c>~/.envmux</c> is a key ssh will never offer: it looks for
/// <c>id_ed25519</c>, <c>id_rsa</c> and the rest in <c>~/.ssh</c> and offers
/// nothing else unless it is told to. This is the telling. Without it the key
/// exists, the session authorises it, and the connection is still refused with
/// <c>Permission denied (publickey)</c> — which is the same message as having no
/// key at all.
/// </para>
/// <para>
/// It is written to the <em>top</em> of the file. ssh takes the first value it
/// obtains for each keyword, so a <c>Host *</c> block already in the file wins
/// over anything appended after it — appending would have worked on a fresh
/// workstation and quietly done nothing on a configured one.
/// </para>
/// <para>
/// Between two markers, and only ever between them. Everything outside is
/// somebody else's file: it is copied through byte for byte, including its line
/// endings, and a block whose end marker has been deleted is refused rather than
/// guessed at.
/// </para>
/// </remarks>
internal static class SshConfig
{
    /// <summary>The line the managed block starts at.</summary>
    public const string Begin = "# >>> envmux >>>";

    /// <summary>The line it ends at.</summary>
    public const string End = "# <<< envmux <<<";

    /// <summary>Where ssh reads it, on every platform envmux runs on.</summary>
    public static string Location =>
        System.IO.Path.Combine(SshDirectory, "config");

    /// <summary>
    /// ssh's own directory — not envmux's.
    /// </summary>
    /// <remarks>
    /// The one thing here that <c>ENVMUX_HOME</c> does not move, because it is
    /// not envmux's to move: <c>ssh</c> and VS Code's Remote-SSH read this path
    /// and nothing envmux sets changes that. <c>ENVMUX_SSH_HOME</c> exists for
    /// the tests, which must not write into a real one.
    /// </remarks>
    public static string SshDirectory =>
        Environment.GetEnvironmentVariable("ENVMUX_SSH_HOME") is { Length: > 0 } overridden
            ? overridden
            : System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".ssh");

    /// <summary>
    /// The block itself, for a set of zones.
    /// </summary>
    /// <remarks>
    /// One <c>Host</c> line with every zone on it, because ssh takes a list of
    /// patterns and a second <c>Host</c> block would be a second place for the
    /// same four settings to disagree.
    /// </remarks>
    /// <param name="zones">The zones session names end in.</param>
    /// <param name="keyPath">The private key ssh should offer.</param>
    /// <param name="knownHostsPath">Where to remember those hosts' keys.</param>
    /// <param name="relay">The command that reaches an instance, from <see cref="Relay()"/>; <c>%h %p</c> is appended.</param>
    /// <exception cref="SshConfigException">None of the zones is a name ssh could match on.</exception>
    public static string Block(IEnumerable<string> zones, string keyPath, string knownHostsPath, string relay)
    {
        var patterns = Normalize(zones);

        if (patterns.Count == 0)
        {
            throw new SshConfigException("there is no zone to write a Host entry for");
        }

        var block = new StringBuilder();

        block.Append(Begin).Append('\n');
        block.Append("# Written by `").Append(Commands.CommandName.Current)
            .Append(" ssh`. A session's name is an alias: the ProxyCommand reaches its\n");
        block.Append("# instance through the host's API, so nothing has to resolve it. envmux keeps\n");
        block.Append("# one key and every session it starts lets that key in, so the editor attaches\n");
        block.Append("# without anything being copied by hand. Delete this block and envmux leaves\n");
        block.Append("# it deleted until you run that again.\n");
        block.Append("Host ").Append(string.Join(' ', patterns.Select(p => "*." + p))).Append('\n');

        // %h is the alias as ssh has it, zone and all; the relay takes the
        // instance off the front of it. %p is 22 unless a Port was given.
        block.Append("    ProxyCommand ").Append(relay).Append(" %h %p\n");
        block.Append("    IdentityFile ").Append(Quote(Tilde(keyPath))).Append('\n');

        // Only this key, so a workstation with eight of them does not walk
        // through the other seven and hit MaxAuthTries before reaching it.
        block.Append("    IdentitiesOnly yes\n");

        // A session recreated under the same name is a new machine with a new
        // host key, which ssh reports as REMOTE HOST IDENTIFICATION HAS CHANGED
        // and refuses. Its own file keeps that churn out of ~/.ssh/known_hosts,
        // and accept-new takes the first sight of a name without asking while
        // still refusing a key that changed underneath it.
        block.Append("    UserKnownHostsFile ").Append(Quote(Tilde(knownHostsPath))).Append('\n');
        block.Append("    StrictHostKeyChecking accept-new\n");
        block.Append(End);

        return block.ToString();
    }

    /// <summary>
    /// The command ssh runs to reach an instance: this very executable, by its
    /// absolute path, and the word <c>relay</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Absolute, because ssh runs the <c>ProxyCommand</c> from wherever it was
    /// invoked — an editor's helper process, a service — with whatever
    /// <c>PATH</c> that has, and a bare <c>envmux</c> there is the installed
    /// copy or nothing. The path is the process's own, so a dev build installed
    /// as <c>devenvmux</c> writes itself and an installed release writes itself,
    /// and each block reaches the host that build was made for.
    /// </para>
    /// <para>
    /// Run as <c>dotnet envmux.dll</c> the process is <c>dotnet</c>, and writing
    /// that alone would make ssh run the runtime with no program. So the
    /// assembly goes after it, and the line is <c>"dotnet" "envmux.dll" relay</c>.
    /// Always quoted, both of them: a profile directory with a space in it is
    /// ordinary, and quoting a path without one costs nothing on either shell
    /// the command is run by. Forward slashes, because that is what every other
    /// path in this file uses and Windows accepts them everywhere it matters.
    /// </para>
    /// </remarks>
    public static string Relay() =>
        Relay(
            Environment.ProcessPath,

            // Not Assembly.Location, which is empty in a single-file build and
            // refused by the analyser for that reason. Under the dotnet host the
            // base directory is the dll's own, and only that case reads this.
            System.IO.Path.Combine(
                AppContext.BaseDirectory,
                (System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name ?? "envmux") + ".dll"));

    /// <summary>Keep ssh attached to the engine selected when its block was written.</summary>
    public static string RelayFor(Backends.BackendKind? backend) => backend is null
        ? Relay()
        : Relay() + (backend == Backends.BackendKind.Incus ? " --backend incus" : " --backend docker");

    /// <summary>The same, from a given process path and entry assembly.</summary>
    /// <param name="processPath">The executable that is running, or null when the runtime cannot say.</param>
    /// <param name="entryAssembly">The entry assembly's file, used only when the process is the <c>dotnet</c> host.</param>
    internal static string Relay(string? processPath, string? entryAssembly)
    {
        if (processPath is not { Length: > 0 })
        {
            // Nothing better to write: the name on PATH, and the hope it is there.
            return Commands.CommandName.Current + " relay";
        }

        var isDotnetHost = Path.GetFileNameWithoutExtension(processPath.Replace('\\', '/'))
            .Equals("dotnet", StringComparison.OrdinalIgnoreCase);

        return isDotnetHost && entryAssembly is { Length: > 0 }
            ? $"{Always(processPath)} {Always(entryAssembly)} relay"
            : $"{Always(processPath)} relay";
    }

    /// <summary>
    /// The zones a block already in the file covers.
    /// </summary>
    /// <remarks>
    /// Read back so that writing the block never narrows it. A workstation can
    /// have a project whose <c>.envmux.json</c> names a zone of its own, and
    /// running this from a different project must not stop ssh finding the key
    /// for that one. Anything that is not a <c>*.&lt;zone&gt;</c> pattern is
    /// ignored rather than carried, since it is not something envmux wrote.
    /// </remarks>
    /// <param name="existing">The whole file.</param>
    public static IReadOnlyList<string> Zones(string existing)
    {
        var (begin, end) = Bounds(existing);

        if (begin < 0 || end < 0)
        {
            return [];
        }

        foreach (var line in existing[begin..end].Split('\n'))
        {
            var text = line.Trim();

            if (!text.StartsWith("Host ", StringComparison.Ordinal))
            {
                continue;
            }

            return Normalize(
                text[5..]
                    .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Where(p => p.StartsWith("*.", StringComparison.Ordinal))
                    .Select(p => p[2..]));
        }

        return [];
    }

    /// <summary>
    /// The file with the block in it, put there without disturbing anything else.
    /// </summary>
    /// <remarks>
    /// Replaced in place when it is there and prepended when it is not — see the
    /// class remarks for why the top of the file rather than the bottom.
    /// </remarks>
    /// <param name="existing">The whole file, or empty when there is none.</param>
    /// <param name="block">What <see cref="Block"/> produced.</param>
    /// <exception cref="SshConfigException">The block was opened and never closed.</exception>
    public static string Merge(string existing, string block)
    {
        var (begin, end) = Bounds(existing);

        if (begin >= 0 && end < 0)
        {
            throw new SshConfigException(
                $"{Location} has a '{Begin}' line and no '{End}' after it. " +
                "Repair or delete that block by hand — guessing where it ends could take " +
                "somebody else's Host entry with it.");
        }

        // In whatever this file already ends its lines with. A CRLF config with
        // one LF-terminated block in it is a file that looks corrupted in an
        // editor and diffs as though every line changed.
        var newline = Newline(existing);
        var body = block.Replace("\n", newline, StringComparison.Ordinal);

        if (begin >= 0)
        {
            return existing[..begin] + body + existing[(end + End.Length)..];
        }

        return existing.Length == 0
            ? body + newline
            : body + newline + newline + existing;
    }

    /// <summary>
    /// Write the block, and say what that changed.
    /// </summary>
    /// <param name="zones">The zones to cover, on top of whatever the block already covers.</param>
    /// <exception cref="SshConfigException">The file could not be read, or written, or made sense of.</exception>
    public static SshConfigResult Apply(IEnumerable<string> zones, Backends.BackendKind? backend = null)
    {
        var existing = Read();
        var wanted = Wanted(zones, existing);
        var block = Block(wanted, SshIdentity.KeyPath, SshIdentity.KnownHostsPath, RelayFor(backend));

        var merged = Merge(existing, block);

        var change = existing.Contains(Begin, StringComparison.Ordinal)
            ? SshConfigChange.Updated
            : SshConfigChange.Added;

        if (string.Equals(merged, existing, StringComparison.Ordinal))
        {
            return new SshConfigResult(SshConfigChange.Unchanged, Location, wanted);
        }

        Write(merged);
        return new SshConfigResult(change, Location, wanted);
    }

    /// <summary>
    /// Everything the block would cover: what is asked for, and what it already
    /// covered.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Writing this must never narrow it. A workstation can have a project whose
    /// <c>.envmux.json</c> names a zone of its own, and running this from a
    /// different project would otherwise take that project's editor down with
    /// it. Deleting the block is how a zone that is genuinely gone goes away.
    /// </para>
    /// <para>
    /// What is already in the file comes first, so a zone never moves once it is
    /// written. Ordered the other way round — the caller's first — running this
    /// from two projects in turn would reshuffle the <c>Host</c> line each time,
    /// and a command whose job is to be safe to re-run would rewrite the file on
    /// every invocation.
    /// </para>
    /// </remarks>
    /// <param name="zones">The zones the caller knows about.</param>
    /// <param name="existing">The file, or null to read it.</param>
    public static IReadOnlyList<string> Wanted(IEnumerable<string> zones, string? existing = null) =>
        Normalize([.. Zones(existing ?? Read()), .. zones]);

    /// <summary>The file, or empty when there is not one yet.</summary>
    public static string Read()
    {
        try
        {
            return File.Exists(Location) ? File.ReadAllText(Location) : "";
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new SshConfigException($"{Location}: {e.Message}", e);
        }
    }

    /// <summary>
    /// Write it, all at once or not at all.
    /// </summary>
    /// <remarks>
    /// Through a temporary file and a move, like <c>host.json</c>: this is a
    /// file the user owns and ssh reads on every connection, and half of it is
    /// worse than an old version of it.
    /// </remarks>
    private static void Write(string content)
    {
        try
        {
            System.IO.Directory.CreateDirectory(SshDirectory);

            var temporary = Location + ".envmux-new";
            File.WriteAllText(temporary, content);

            // ssh will not read a config anyone else can write, and says so as
            // "Bad owner or permissions". Windows has no mode; its ACLs come
            // from the profile directory this was created in.
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }

            File.Move(temporary, Location, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new SshConfigException($"{Location}: {e.Message}", e);
        }
    }

    /// <summary>Where the managed block starts and where its end marker starts, or -1.</summary>
    private static (int Begin, int End) Bounds(string text)
    {
        var begin = text.IndexOf(Begin, StringComparison.Ordinal);

        if (begin < 0)
        {
            return (-1, -1);
        }

        var end = text.IndexOf(End, begin, StringComparison.Ordinal);

        return (begin, end);
    }

    /// <summary>
    /// Zones as ssh can match them: lowercase, deduplicated, junk dropped.
    /// </summary>
    /// <remarks>
    /// The order is the order they arrived in, so the host's own zone stays
    /// first and re-running this does not shuffle the file. Dropping rather than
    /// refusing, because one of the sources is a block somebody may have edited
    /// and a bad pattern there should not stop the good ones being written.
    /// </remarks>
    internal static IReadOnlyList<string> Normalize(IEnumerable<string> zones)
    {
        var seen = new List<string>();

        foreach (var zone in zones)
        {
            var name = zone.Trim().Trim('.').ToLowerInvariant();

            if (IsAZone(name) && !seen.Contains(name, StringComparer.Ordinal))
            {
                seen.Add(name);
            }
        }

        return seen;
    }

    /// <summary>
    /// Whether a name is a DNS name, and so safe to put on a <c>Host</c> line.
    /// </summary>
    /// <remarks>
    /// The zone comes from <c>host.json</c> and from a repository's
    /// <c>.envmux.json</c>, and one of those is a file that arrives with a
    /// checkout. A newline in it would append lines to <c>~/.ssh/config</c>,
    /// which is a file that decides what this machine connects to and with
    /// what. Refusal, not escaping — ssh config has no escaping to reach for.
    /// </remarks>
    internal static bool IsAZone(string name) =>
        name.Length > 0 &&
        name.Length <= 253 &&
        name.Split('.').All(label =>
            label.Length is > 0 and <= 63 &&
            char.IsAsciiLetterOrDigit(label[0]) &&
            char.IsAsciiLetterOrDigit(label[^1]) &&
            label.All(c => char.IsAsciiLetterOrDigit(c) || c == '-'));

    /// <summary>
    /// A path as an ssh config should say it: <c>~</c> for home, forward slashes.
    /// </summary>
    /// <remarks>
    /// <c>~</c> so the file is the same on every machine somebody syncs it to,
    /// and forward slashes because OpenSSH on Windows treats a backslash in a
    /// config value as an escape rather than a separator.
    /// </remarks>
    internal static string Tilde(string path)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var slashed = path.Replace('\\', '/');

        if (home.Length == 0)
        {
            return slashed;
        }

        var prefix = home.Replace('\\', '/').TrimEnd('/') + "/";

        return slashed.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? "~/" + slashed[prefix.Length..]
            : slashed;
    }

    /// <summary>
    /// Quote a path that needs it, which is a path with a space in it.
    /// </summary>
    /// <remarks>
    /// <c>C:/Users/Firstname Lastname/.envmux/id_ed25519</c> is an ordinary
    /// Windows profile path and an ssh config line that means two arguments.
    /// Double quotes are what ssh_config understands; a path containing one is
    /// not something to quote around, so it is refused.
    /// </remarks>
    /// <exception cref="SshConfigException">The path has a quote or a newline in it.</exception>
    internal static string Quote(string path)
    {
        if (path.AsSpan().ContainsAny('"', '\n', '\r'))
        {
            throw new SshConfigException($"'{path}' is not a path an ssh config can name");
        }

        return path.Contains(' ', StringComparison.Ordinal) ? $"\"{path}\"" : path;
    }

    /// <summary>
    /// A path quoted whether or not it needs it, with forward slashes, for a
    /// value a shell will split rather than ssh itself.
    /// </summary>
    /// <remarks>
    /// <c>ProxyCommand</c> is handed to a shell — <c>sh -c</c>, or on Windows
    /// the process is spawned from the line as it is — where an unquoted path is
    /// fine until a directory name has a space in it, and the failure is
    /// <c>C:/Users/Firstname: command not found</c> at the moment somebody
    /// presses the editor button. No tilde: a shell does not expand one in the
    /// middle of an argument, and ssh does not expand one here at all.
    /// </remarks>
    /// <exception cref="SshConfigException">The path has a quote or a newline in it.</exception>
    private static string Always(string path)
    {
        var slashed = path.Replace('\\', '/');

        if (slashed.AsSpan().ContainsAny('"', '\n', '\r'))
        {
            throw new SshConfigException($"'{path}' is not a path an ssh config can name");
        }

        return $"\"{slashed}\"";
    }

    /// <summary>What this file already ends its lines with, so the block matches.</summary>
    private static string Newline(string text) =>
        text.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
}
