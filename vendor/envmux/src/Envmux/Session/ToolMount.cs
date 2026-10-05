using System.Formats.Tar;

using Envmux.Incus;

namespace Envmux.Session;

/// <summary>
/// A coding tool's host state, carried in so the tool arrives already logged in.
/// </summary>
/// <param name="Name">The key used in <c>tools</c>.</param>
/// <param name="HostPath">Where the state lives on the host.</param>
/// <param name="ContainerRelativePath">Where it goes, relative to the session user's home.</param>
internal sealed record ToolMount(string Name, string HostPath, string ContainerRelativePath)
{
    /// <summary>
    /// The command that drops you into this tool, or null if there is nothing
    /// to drop into.
    /// </summary>
    /// <remarks>
    /// The distinction is between a tool that <em>is</em> a session — an agent
    /// you sit in front of — and one whose mounted state exists so that
    /// something else works. <c>gh</c> is the second kind: mounting it means
    /// <c>git push</c> is authenticated, and running <c>gh</c> on its own
    /// prints usage and exits, which is not a thing to offer a button for.
    /// </remarks>
    public string? Launch => Name switch
    {
        "claude" or "codex" or "gemini" or "opencode" => Name,
        _ => null,
    };


    /// <summary>Anything the tool needs told about where its state ended up.</summary>
    public IReadOnlyDictionary<string, string> Env(string containerHome) => Name switch
    {
        // Claude Code keeps .claude.json beside $HOME rather than inside
        // ~/.claude, so without this only half its state is mounted. Learned
        // the hard way in the archive.
        "claude" => new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["CLAUDE_CONFIG_DIR"] = $"{containerHome}/.claude",
        },
        "codex" => new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["CODEX_HOME"] = $"{containerHome}/.codex",
        },
        _ => new Dictionary<string, string>(StringComparer.Ordinal),
    };
}

/// <summary>
/// Finds the coding tools installed on the host, so a session arrives able to
/// run them.
/// </summary>
/// <remarks>
/// <para>
/// This is the MVP bar: <c>envmux</c>, then your agent in the shell, already
/// signed in. It is also the sharpest edge in the product, and it got sharper
/// with the machine boundary: a bind mount was live in both directions and
/// could at least be revoked by ending the session, and this is a copy that
/// stays in the instance until the instance goes.
/// </para>
/// <para>
/// So it is explicit in the config and never a default. Credentials do not
/// travel because something inferred that they should.
/// </para>
/// </remarks>
internal static class ToolMounts
{
    /// <summary>
    /// What envmux knows how to mount: the tool name, and the host paths that
    /// hold its state, relative to the home directory.
    /// </summary>
    private static readonly (string Name, string[] Paths)[] Known =
    [
        ("claude", [".claude", ".claude.json"]),
        ("codex", [".codex"]),
        ("gemini", [".gemini"]),
        ("opencode", [".config/opencode"]),
        ("gh", [".config/gh"]),
    ];

    /// <summary>Every tool with state on this host, whether or not it is enabled.</summary>
    public static IReadOnlyList<string> Detect()
    {
        var home = Home();
        return [.. Known
            .Where(t => t.Paths.Any(p => Exists(Path.Combine(home, p.Replace('/', Path.DirectorySeparatorChar)))))
            .Select(t => t.Name)];
    }

    /// <summary>
    /// Resolve the <c>tools</c> declaration into mounts.
    /// </summary>
    /// <param name="tools">
    /// Name to <c>"auto"</c>, <c>"off"</c>, or an explicit host path. A null
    /// declaration mounts nothing: credentials do not travel into a container by
    /// accident.
    /// </param>
    public static IReadOnlyList<ToolMount> Resolve(IReadOnlyDictionary<string, string>? tools)
    {
        if (tools is null || tools.Count == 0)
        {
            return [];
        }

        var home = Home();
        var mounts = new List<ToolMount>();

        foreach (var (name, paths) in Known)
        {
            if (!tools.TryGetValue(name, out var setting) ||
                setting.Equals("off", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var explicitPath = setting.Equals("auto", StringComparison.OrdinalIgnoreCase) ? null : setting;

            foreach (var relative in paths)
            {
                var native = relative.Replace('/', Path.DirectorySeparatorChar);
                var hostPath = explicitPath is null
                    ? Path.Combine(home, native)
                    : (paths.Length == 1 ? explicitPath : Path.Combine(explicitPath, Path.GetFileName(native)));

                if (Exists(hostPath))
                {
                    mounts.Add(new ToolMount(name, hostPath, relative));
                }
            }
        }

        return mounts;
    }

    /// <summary>
    /// The tools among these that can be dropped into, named once each.
    /// </summary>
    /// <remarks>
    /// Distinct, because a tool can be several mounts: <c>claude</c> is
    /// <c>~/.claude</c> and <c>~/.claude.json</c> both, and it is still one
    /// thing to open. Ordered as <see cref="Known"/> lists them so the buttons
    /// do not move between sessions.
    /// </remarks>
    public static IReadOnlyList<string> Launchable(IReadOnlyList<ToolMount> mounts) =>
        [.. Known
            .Select(k => k.Name)
            .Where(name => mounts.Any(m =>
                m.Launch is not null && m.Name.Equals(name, StringComparison.Ordinal)))];

    /// <summary>
    /// Copy one tool's state into the instance, under the session user's home.
    /// </summary>
    /// <remarks>
    /// <para>
    /// As a tar through the files API, and then unpacked inside. The files API
    /// writes one file per call, and a tool's state is a directory of hundreds
    /// of small ones — a call each would be a session that takes a minute to
    /// start for no reason a person could see.
    /// </para>
    /// <para>
    /// Whether it worked is reported rather than thrown. A tool that did not
    /// arrive signed in is a tool you sign in again; it is not a session that
    /// should refuse to start.
    /// </para>
    /// </remarks>
    public static async Task<bool> PushAsync(
        Backends.IBackend backend,
        string instance,
        string user,
        ToolMount mount,
        CancellationToken ct = default)
    {
        try
        {
            var archive = Pack(mount);
            var remote = $"/tmp/envmux-tool-{Config.Slug.From(mount.ContainerRelativePath)}.tar";

            await backend.Files.PushAsync(instance, remote, archive, "0600", ct: ct).ConfigureAwait(false);

            var home = Bootstrap.Home(user);
            var quotedUser = Workspace.Quote(user);

            // Extracted as the account that will read it, so nothing arrives
            // owned by root inside a home directory the session cannot write.
            var script =
                $"set -eu\n" +
                $"mkdir -p {Workspace.Quote(home)}\n" +
                $"tar -xf {remote} -C {Workspace.Quote(home)}\n" +
                $"rm -f {remote}\n" +
                $"chown -R {quotedUser} {Workspace.Quote(home)}\n";

            var result = await Command.ShellAsync(backend.Exec, instance, script, null, null, ct).ConfigureAwait(false);
            return result.Ok;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or Backends.BackendException)
        {
            return false;
        }
    }

    /// <summary>
    /// The tool's state as a tar, rooted at the path it will have in the home
    /// directory.
    /// </summary>
    /// <remarks>
    /// Entry names are the container-relative path, so unpacking into
    /// <c>$HOME</c> puts <c>.claude/</c> and <c>.claude.json</c> exactly where
    /// the tool looks for them. Modes are set here rather than taken from the
    /// host, because a Windows host has no executable bit to take.
    /// </remarks>
    internal static byte[] Pack(ToolMount mount)
    {
        using var buffer = new MemoryStream();

        using (var writer = new TarWriter(buffer, TarEntryFormat.Pax, leaveOpen: true))
        {
            if (File.Exists(mount.HostPath))
            {
                Add(writer, mount.HostPath, mount.ContainerRelativePath);
            }
            else
            {
                foreach (var file in Directory.EnumerateFiles(mount.HostPath, "*", SearchOption.AllDirectories))
                {
                    var relative = Path.GetRelativePath(mount.HostPath, file).Replace('\\', '/');

                    if (IsHistory(mount.Name, relative))
                    {
                        continue;
                    }

                    Add(writer, file, $"{mount.ContainerRelativePath}/{relative}");
                }
            }
        }

        return buffer.ToArray();
    }

    /// <summary>
    /// What a tool keeps that is history rather than configuration.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Top-level names under the tool's state directory that are not carried.
    /// Measured on a working machine, <c>~/.claude</c> was 676 MB in 8,160
    /// files, of which <c>projects</c> was 590 MB and <c>file-history</c> 65 MB
    /// — every transcript and every edit of every other project on the host. It
    /// took a minute per session to copy.
    /// </para>
    /// <para>
    /// Size is the smaller half of the argument. A session opened for one
    /// repository was being handed the conversation history of every other one,
    /// which is not what "arrives signed in" was offering. What travels is what
    /// makes the tool work: the credential, the settings, the plugins.
    /// </para>
    /// <para>
    /// The daemon files go too, and those would matter at a byte: a lock and a
    /// status file describing a process on a different machine, landing exactly
    /// where a fresh one will look for its own.
    /// </para>
    /// <para>
    /// Codex transcripts, memories, logs and its local databases are excluded
    /// too: they describe other projects and processes, not this tool's sign-in.
    /// </para>
    /// </remarks>
    private static readonly Dictionary<string, string[]> History =
        new(StringComparer.Ordinal)
        {
            ["claude"] =
            [
                "projects", "file-history", "paste-cache", "cache", "backups", "jobs",
                "shell-snapshots", "downloads", "sessions", "session-env", "ide", "chrome",
                "daemon", "history.jsonl", "daemon.lock", "daemon.log", "daemon.status.json",
            ],
            ["codex"] =
            [
                "sessions", "archived_sessions", "history.jsonl", "shell_snapshots",
                "logs", "log", "memories", "sqlite", "state_5.sqlite", "state_5.sqlite-wal",
                "state_5.sqlite-shm", "logs_1.sqlite", "logs_1.sqlite-wal", "logs_1.sqlite-shm",
                "tmp", "cache", "session_index.jsonl",
            ],
        };

    /// <summary>
    /// Whether a path inside a tool's state is history rather than configuration.
    /// </summary>
    /// <param name="tool">The tool's name, as <c>tools</c> spells it.</param>
    /// <param name="relative">
    /// The path within the tool's state directory, with forward slashes.
    /// </param>
    internal static bool IsHistory(string tool, string relative)
    {
        if (!History.TryGetValue(tool, out var skip))
        {
            return false;
        }

        // The first segment only, because these are top-level names and a
        // directory called `cache` three levels down belongs to whatever put it
        // there.
        var slash = relative.IndexOf('/', StringComparison.Ordinal);
        var head = slash < 0 ? relative : relative[..slash];

        return skip.Contains(head, StringComparer.OrdinalIgnoreCase);
    }

    private static void Add(TarWriter writer, string path, string name)
    {
        var entry = new PaxTarEntry(TarEntryType.RegularFile, name)
        {
            DataStream = new MemoryStream(File.ReadAllBytes(path)),
            Mode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
            ModificationTime = File.GetLastWriteTimeUtc(path),
        };

        writer.WriteEntry(entry);
    }

    private static string Home() =>
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    private static bool Exists(string path) => Directory.Exists(path) || File.Exists(path);
}
