namespace Envmux.Live;

/// <summary>Where a path in a live namespace is actually read and written.</summary>
internal enum Route
{
    /// <summary>The host's own tool state. Live: what the workstation has right now.</summary>
    Live,

    /// <summary>
    /// A per-session directory on the host, private to this session. Where
    /// writes to paths nobody classified go, so a tool that invents a new file
    /// still works and still does not touch the workstation's state.
    /// </summary>
    Overlay,

    /// <summary>
    /// An empty directory, advertised so the guest has somewhere to bind-mount
    /// its own storage over. Bulk history lives here and never crosses the pipe.
    /// </summary>
    Placeholder,

    /// <summary>
    /// Read from the workstation, written to the session.
    /// </summary>
    /// <remarks>
    /// For state that is the workstation's to give and the session's to change:
    /// the credential a tool signs in with, and the per-machine config file it
    /// rewrites constantly. The session gets what the workstation has until the
    /// moment it writes its own, and from then on its own — so nothing a
    /// container does can reach back and rewrite the credential the person at
    /// the keyboard is using.
    /// </remarks>
    Shadow,

    /// <summary>
    /// Not a file on either side: answered by the server when read. Git
    /// credentials live here — see <c>GitVault</c>.
    /// </summary>
    Virtual,

    /// <summary>Not served at all.</summary>
    Denied,
}

/// <summary>
/// One tool's state, as the guest sees it: which paths come live off the
/// workstation, which are the guest's own, and where the host keeps each.
/// </summary>
/// <param name="Name">The namespace, which is the first path segment: <c>claude</c>.</param>
/// <param name="HostRoot">The tool's state directory on this workstation.</param>
/// <param name="Live">Top-level names served from <paramref name="HostRoot"/>, read and written there.</param>
/// <param name="Shadow">
/// Top-level names read from <paramref name="HostRoot"/> and written to the
/// session, so the session inherits the workstation and then diverges from it.
/// </param>
/// <param name="Local">
/// Top-level directory names the guest keeps for itself. Advertised as empty
/// directories so there is a mount point; the guest binds its own storage over
/// each one.
/// </param>
/// <param name="Alias">
/// Names that live somewhere other than under <paramref name="HostRoot"/> —
/// Claude Code's <c>.claude.json</c>, which sits beside the home directory
/// rather than inside the state directory.
/// </param>
internal sealed record Namespace(
    string Name,
    string HostRoot,
    IReadOnlySet<string> Live,
    IReadOnlySet<string> Shadow,
    IReadOnlySet<string> Local,
    IReadOnlyDictionary<string, string> Alias)
{
    /// <summary>
    /// Classify a path within this namespace.
    /// </summary>
    /// <remarks>
    /// <para>
    /// On the first segment only. A tool's state is organised at the top level —
    /// <c>projects/</c> is history, <c>plugins/</c> is configuration — and
    /// classifying deeper would mean a policy that has to know the shape of
    /// every subtree. What is under a live directory is live; what is under a
    /// local one is the guest's, and never reaches here at all because the
    /// guest has bound its own storage over it.
    /// </para>
    /// <para>
    /// Unclassified is <see cref="Route.Overlay"/> rather than
    /// <see cref="Route.Live"/>, which is the whole security posture in one
    /// line: a file the workstation holds is served because it was named, not
    /// because a tool asked for it.
    /// </para>
    /// </remarks>
    public Route RouteFor(string relative)
    {
        if (relative.Length == 0)
        {
            return Route.Live;
        }

        var head = Head(relative);

        if (Local.Contains(head))
        {
            // Only the directory itself is a placeholder: anything below it is
            // behind the guest's own bind mount and is never requested. If one
            // is requested anyway — the bind failed, or the guest is something
            // else — it must not fall through to the workstation's copy.
            return relative.Length == head.Length ? Route.Placeholder : Route.Denied;
        }

        if (Shadow.Contains(head))
        {
            return Route.Shadow;
        }

        return Live.Contains(head) ? Route.Live : Route.Overlay;
    }

    /// <summary>Where a live path is on this workstation, or null if it escapes the root.</summary>
    public string? HostPathFor(string relative)
    {
        if (relative.Length == 0)
        {
            return HostRoot;
        }

        var head = Head(relative);
        var rest = relative.Length == head.Length ? "" : relative[(head.Length + 1)..];

        var root = Alias.TryGetValue(head, out var aliased)
            ? aliased
            : Path.Combine(HostRoot, head);

        return rest.Length == 0 ? root : Safe(root, rest);
    }

    private static string Head(string relative)
    {
        var slash = relative.IndexOf('/', StringComparison.Ordinal);
        return slash < 0 ? relative : relative[..slash];
    }

    /// <summary>
    /// Join, and refuse anything that leaves the root.
    /// </summary>
    /// <remarks>
    /// The guest is on the other side of a socket that every container on the
    /// bridge can reach, so <c>../../../../Users/Matt/.ssh/id_rsa</c> is a
    /// request that will arrive. Resolved and compared rather than scanned for
    /// <c>..</c>, because the scan misses the encodings.
    /// </remarks>
    private static string? Safe(string root, string relative)
    {
        var full = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        var prefix = Path.GetFullPath(root);

        if (!prefix.EndsWith(Path.DirectorySeparatorChar))
        {
            prefix += Path.DirectorySeparatorChar;
        }

        return full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? full : null;
    }
}

/// <summary>
/// What envmux knows how to serve live, and the default split between what is
/// the workstation's and what is the session's.
/// </summary>
internal static class Policy
{
    /// <summary>
    /// Claude Code's state, split.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>.credentials.json</c> is the file this whole design exists for. It
    /// holds an OAuth access token that the tool refreshes on its own schedule,
    /// so a session that was handed a copy is a session whose credential goes
    /// stale in the middle of the afternoon — and the fix, today, is to end the
    /// session and start another.
    /// </para>
    /// <para>
    /// <c>projects</c> and <c>file-history</c> are the other end of the same
    /// argument: measured at 317 MB and 15 MB on this workstation, they are
    /// every transcript of every other repository, and a session opened for one
    /// project has no business reading them. They are the session's own, on the
    /// session's own disk, and <c>envmux live sync</c> is what turns one of them
    /// on when you actually want it.
    /// </para>
    /// </remarks>
    /// <summary>
    /// Read and written on the workstation. Empty by default, deliberately.
    /// </summary>
    /// <remarks>
    /// The first run of Claude Code inside a session re-synced its plugin
    /// marketplace on startup — eleven <c>PUT</c>s and <c>MKCOL</c>s into the
    /// workstation's own <c>plugins/</c>, from a container, on the tool's own
    /// initiative. Same bytes, this time. The lesson is general: a tool treats
    /// its state directory as its own and will rewrite any of it, so nothing a
    /// container writes should reach the workstation unless somebody asked for
    /// exactly that, per entry. <c>envmux live sync claude/settings.json</c> is
    /// how they ask.
    /// </remarks>
    private static readonly string[] ClaudeLive = [];

    /// <summary>
    /// Read from the workstation, written to the session.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>.credentials.json</c> is the file this whole design exists for, and
    /// the one place read-write would be a mistake. The session must read it —
    /// that is what "arrives signed in" means — but a token refresh performed
    /// inside a container must not land on the credential the person at the
    /// keyboard is using. So the session reads the workstation's until it writes
    /// its own, and after that reads its own.
    /// </para>
    /// <para>
    /// <c>.claude.json</c> for a different reason: it is not configuration so
    /// much as a machine's diary. Startup counts, cached feature flags, which
    /// tips have been shown, and — the part that matters — a <c>projects</c> map
    /// with an entry per directory the tool has ever been run in. Seventy-four
    /// of them on this workstation, by absolute Windows path. That is not
    /// something to hand a container, and the session rewrites the file
    /// constantly anyway.
    /// </para>
    /// </remarks>
    private static readonly string[] ClaudeShadow =
    [
        ".credentials.json",
        ".claude.json",
        "settings.json",
        "plugins",
        "commands",
        "agents",
        "skills",
        "mcp-needs-auth-cache.json",
    ];

    private static readonly string[] ClaudeLocal =
    [
        "projects", "file-history", "todos", "shell-snapshots", "statsig",
        "cache", "paste-cache", "backups", "jobs", "sessions", "session-env",
        "ide", "chrome", "daemon", "tasks", "downloads",
    ];

    /// <summary>
    /// Build the namespaces for this workstation, with any per-session overrides
    /// applied.
    /// </summary>
    /// <param name="overrides">
    /// <c>namespace/name</c> to <c>live</c> or <c>local</c> — the
    /// <c>.envmux.json</c> <c>live</c> block, and what <c>envmux live sync</c>
    /// writes. <c>claude/projects: live</c> is the one worth having.
    /// </param>
    /// <summary>The namespace git credentials are served under. Every entry in it is virtual.</summary>
    public const string Git = "git";

    public static IReadOnlyList<Namespace> For(IReadOnlyDictionary<string, string>? overrides = null)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        var namespaces = new List<Namespace>
        {
            // No host root: nothing under it is a file anywhere. It is here so
            // that scopes, listings and the audit log treat it like any other
            // tool, which is what it is from the guest's side.
            Build(Git, "", [], [], []),

            Build("claude", Path.Combine(home, ".claude"), ClaudeLive, ClaudeShadow, ClaudeLocal,
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    // Claude Code puts this beside the home directory rather
                    // than inside the state directory. CLAUDE_CONFIG_DIR moves
                    // where the tool *looks*, so inside the session it is one
                    // directory and one mount; out here it is still two places.
                    [".claude.json"] = Path.Combine(home, ".claude.json"),
                }),

            Build("codex", Path.Combine(home, ".codex"),
                [],
                ["auth.json", "config.toml", "instructions.md"],
                ["sessions", "history.jsonl", "log", "cache"]),

            Build("gh", Path.Combine(home, ".config", "gh"),
                [],
                ["hosts.yml", "config.yml"],
                []),
        };

        return overrides is null or { Count: 0 }
            ? namespaces
            : [.. namespaces.Select(n => Override(n, overrides))];
    }

    private static Namespace Build(
        string name,
        string root,
        string[] live,
        string[] shadow,
        string[] local,
        IReadOnlyDictionary<string, string>? alias = null) =>
        new(name,
            root,
            new HashSet<string>(live, StringComparer.OrdinalIgnoreCase),
            new HashSet<string>(shadow, StringComparer.OrdinalIgnoreCase),
            new HashSet<string>(local, StringComparer.OrdinalIgnoreCase),
            alias ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase));

    private static Namespace Override(Namespace ns, IReadOnlyDictionary<string, string> overrides)
    {
        var live = new HashSet<string>(ns.Live, StringComparer.OrdinalIgnoreCase);
        var shadow = new HashSet<string>(ns.Shadow, StringComparer.OrdinalIgnoreCase);
        var local = new HashSet<string>(ns.Local, StringComparer.OrdinalIgnoreCase);

        foreach (var (key, value) in overrides)
        {
            var slash = key.IndexOf('/', StringComparison.Ordinal);

            if (slash < 0 || !key[..slash].Equals(ns.Name, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var entry = key[(slash + 1)..];

            live.Remove(entry);
            shadow.Remove(entry);
            local.Remove(entry);

            switch (value.ToLowerInvariant())
            {
                case "live": live.Add(entry); break;
                case "shadow": shadow.Add(entry); break;
                default: local.Add(entry); break;
            }
        }

        return ns with { Live = live, Shadow = shadow, Local = local };
    }
}
