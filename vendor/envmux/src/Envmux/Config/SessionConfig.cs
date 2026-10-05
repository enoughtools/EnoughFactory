using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Config;

/// <summary>
/// Everything a session needs, as declared in <c>.envmux.json</c>.
/// </summary>
/// <remarks>
/// Every property is optional and every property has a default, which is why
/// these are nullable rather than required: the file itself is optional too,
/// and <c>envmux</c> in a directory with no config has to produce a working
/// session from the directory name alone.
/// </remarks>
internal sealed record SessionConfig
{
    /// <summary>The first label of every routed hostname. Defaults to the slugified directory name.</summary>
    public string? Name { get; init; }

    /// <summary>Let the named chef session dispatch up to three workers in this repository.</summary>
    public bool Chef { get; init; }

    /// <summary>
    /// The image an instance is created from, when it is not a copy of golden.
    /// </summary>
    /// <remarks>
    /// An alias on the official remote — <c>debian/13/cloud</c> — and rarely
    /// worth setting. The normal path is a copy of the golden snapshot, which is
    /// near-instant on a ZFS pool where a pull is minutes.
    /// </remarks>
    public string? Image { get; init; }

    /// <summary>
    /// Dev container features to install on top of the image.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Keyed and configured exactly as <c>devcontainer.json</c> spells them, so
    /// a project that already has one can have its <c>features</c> block copied
    /// across unchanged. A feature is an OCI artifact holding an
    /// <c>install.sh</c>; envmux fetches it and runs it as root in the instance.
    /// </para>
    /// <para>
    /// They are installed into a project image once and every session is a copy
    /// of that, so a toolchain that takes minutes to install costs those minutes
    /// on the first session and nothing on the rest. Changing this list changes
    /// the image's fingerprint, which rebuilds it.
    /// </para>
    /// <para>
    /// What is <em>not</em> taken from a devcontainer.json is its base image.
    /// The base here is always the golden snapshot, because that is what carries
    /// the things envmux itself needs — the multiplexer every task is latched
    /// into, sshd for the editor, the agent. Features are written to layer onto
    /// a Debian or Ubuntu base, which is what this is.
    /// </para>
    /// </remarks>
    public Dictionary<string, FeatureConfig>? Features { get; init; }

    /// <summary>Where the project directory is mounted, and the container's working directory.</summary>
    public string? Workdir { get; init; }

    /// <summary>What the TUI's shell key hands you.</summary>
    public string? Shell { get; init; }

    /// <summary>
    /// How the editor key attaches VS Code to the session container.
    /// </summary>
    /// <remarks>
    /// A path, or an object with <c>path</c>, <c>newWindow</c> and
    /// <c>folder</c>. Absent, envmux finds an editor and opens the working
    /// directory in the window already in front of you.
    /// </remarks>
    public EditorConfig? Editor { get; init; }

    /// <summary>
    /// Everything that runs inside the session container.
    /// </summary>
    /// <remarks>
    /// The internal counterpart to <see cref="Services"/>: a service is another
    /// container on the session's network, a task is a process in the one you
    /// work in. Values are a command, or an object with a command in it.
    /// Installs and migrations are tasks too — <c>"kind": "once"</c> — which is
    /// why there is no separate <c>setup</c> field.
    /// </remarks>
    public Dictionary<string, TaskConfig>? Tasks { get; init; }

    /// <summary>Literal environment variables for the container. No interpolation.</summary>
    public Dictionary<string, string>? Env { get; init; }

    /// <summary>
    /// Files on this machine to read the session's environment from.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A path, or a list of them, relative to the project directory. For the
    /// gitignored <c>.env</c> that holds a project's local secrets: the
    /// repository crosses to the instance as a bundle, so a file git was told to
    /// ignore does not — and the session gets the code without what makes it
    /// run.
    /// </para>
    /// <para>
    /// Named here rather than found, because this is a file of secrets leaving
    /// the machine. Missing files are skipped: a declaration describes a project,
    /// and a machine where it has not been set up yet should hear that from
    /// whatever needed the value.
    /// </para>
    /// <para>
    /// Lower precedence than <see cref="Env"/>, which is written down in the
    /// repository and is therefore the more deliberate of the two.
    /// </para>
    /// </remarks>
    public CommandSpec? EnvFile { get; init; }

    /// <summary>
    /// Route name to the port the server listens on.
    /// </summary>
    /// <remarks>
    /// A bare port, or <c>{ "port": n, "tls": true }</c> when the server on it
    /// speaks TLS. The instance has an address of its own, so the port a server
    /// binds is the port it is reached on — there is nothing to translate, and
    /// so nothing to declare about the translation. What is left to declare is
    /// what the server on the other end <em>is</em>, which is the scheme. The
    /// name is a label for the list.
    /// </remarks>
    public Dictionary<string, RouteConfig>? Routes { get; init; }

    /// <summary>
    /// The loopback port the portal is served on, or the range to claim within.
    /// </summary>
    /// <remarks>
    /// The last port envmux allocates, and the only one. It is not a route's
    /// port and nothing in the instance is reached through it: the portal is a
    /// page this process serves about the session, and it has to answer
    /// somewhere. <c>8080</c> or <c>[2050, 2060]</c>. See <see cref="PortSpec"/>.
    /// </remarks>
    public PortSpec? Port { get; init; }

    /// <summary>
    /// Containers this session depends on: a database, a cache, a queue.
    /// </summary>
    public Dictionary<string, ServiceConfig>? Services { get; init; }

    /// <summary>
    /// Environment variables envmux makes up, once per session.
    /// </summary>
    /// <remarks>
    /// Values are a kind — <c>"password"</c>, <c>"token"</c>, <c>"uuid"</c>,
    /// <c>"hex"</c> — or an object with a kind and a length.
    /// </remarks>
    public Dictionary<string, GenerateConfig>? Generate { get; init; }

    /// <summary>The domain routed hostnames sit under.</summary>
    public string? Domain { get; init; }

    /// <summary>
    /// Ignored. Read so that an older <c>.envmux.json</c> still loads.
    /// </summary>
    /// <remarks>
    /// It gave the session a certificate for its own name, because a session
    /// reached at a real name had lost the <c>localhost</c> exemption every
    /// browser grants. A session is opened at <c>localhost</c> in its own browser
    /// now, which has the exemption back, and the certificate authority is in
    /// <c>archive/zone</c>. The loader refuses fields it does not know, so this
    /// one stays known rather than breaking every file that set it.
    /// </remarks>
    public bool? Tls { get; init; }

    /// <summary>
    /// The session in a browser tab, on the port that is already claimed.
    /// </summary>
    /// <remarks>
    /// On by default, loopback-only because the listener is, and behind a
    /// per-session token unless told otherwise. See <see cref="PortalConfig"/>.
    /// </remarks>
    public PortalConfig? Portal { get; init; }

    /// <summary>
    /// A browser whose <c>localhost</c> is the instance, through a SOCKS5 port
    /// this session claims. See <see cref="BrowserConfig"/>.
    /// </summary>
    public BrowserConfig? Browser { get; init; }

    /// <summary>
    /// What the session runs on: <c>"incus"</c> or <c>"docker"</c>.
    /// </summary>
    /// <remarks>
    /// Absent, Docker: the engine on this machine, even where an Incus host is set
    /// up. <c>--backend</c> on the command line wins over this.
    /// </remarks>
    public string? Backend { get; init; }

    /// <summary>How the session's branch is made, and what happens to the instance after.</summary>
    public GitConfig? Git { get; init; }

    /// <summary>
    /// Host coding-tool state to mount, so agents arrive already signed in.
    /// </summary>
    /// <remarks>
    /// Values are <c>"auto"</c>, <c>"off"</c>, or an explicit host path. Absent
    /// means nothing is mounted: credentials do not travel into a container
    /// because a default said so.
    /// </remarks>
    /// <remarks>
    /// <c>"git"</c> is here too and is not a file. A session clones from a
    /// bundle and has no remote, so the first push needs whatever this machine
    /// authenticates with — which on Windows lives in the Credential Manager
    /// rather than in <c>~/.git-credentials</c>. Setting it asks git for the
    /// credential its own helper holds, for this repository's remotes only.
    /// </remarks>
    public Dictionary<string, string>? Tools { get; init; }

    public const string FileName = ".envmux.json";

    /// <summary>Where envmux keeps anything it has to put in the project directory.</summary>
    public const string StateDirectory = ".envmux";

    /// <summary>The port the portal asks for before it starts walking upward.</summary>
    public const int DefaultPort = 8080;

    public const string DefaultWorkdir = "/work";
    public const string DefaultShell = "/bin/bash";

    /// <summary>
    /// The image a session falls back to when there is no golden snapshot.
    /// </summary>
    /// <remarks>
    /// The official remote's Debian, which is what <c>envmux host golden</c>
    /// builds from too. A session that lands here is a slow one — a pull rather
    /// than a copy — and says so.
    /// </remarks>
    public const string DefaultImage = "debian/13/cloud";

    /// <summary>
    /// Comments and trailing commas are allowed so the file can carry the notes
    /// a committed, human-reviewed declaration attracts.
    /// </summary>
    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        TypeInfoResolver = WireJsonContext.Default,
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,

        // A field envmux does not know is an error, not something to ignore.
        // A typo or an invented field that silently does nothing is the worst
        // possible outcome — most of all when something is writing this file
        // and checking its own work.
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    /// <summary>
    /// Read <c>.envmux.json</c> from <paramref name="directory"/>, or return an
    /// empty config when there is no file — which is a valid session, not an error.
    /// </summary>
    /// <exception cref="ConfigException">The file exists but does not parse.</exception>
    public static SessionConfig Load(string directory)
    {
        var path = Path.Combine(directory, FileName);
        if (!File.Exists(path))
        {
            return new SessionConfig();
        }

        try
        {
            return WireJson.Deserialize<SessionConfig>(File.ReadAllText(path), JsonOptions)
                   ?? new SessionConfig();
        }
        catch (JsonException e)
        {
            throw new ConfigException($"{FileName}: {e.Explain()}", e);
        }
    }
}

/// <summary>
/// Turn a parser failure into something worth acting on.
/// </summary>
/// <remarks>
/// The framework's message names the offending property and then the .NET type
/// it could not be mapped to, which is an implementation detail to a person and
/// noise to an agent. The field name and the way to look it up are the whole of
/// what is useful.
/// </remarks>
internal static partial class JsonErrors
{
    public static string Explain(this System.Text.Json.JsonException e)
    {
        var message = e.Message;

        if (message.Contains("could not be mapped", StringComparison.Ordinal))
        {
            var name = UnmappedProperty().Match(message) is { Success: true } m ? m.Groups[1].Value : "a field";
            return $"'{name}' is not a field envmux knows. " +
                   $"Run `{Commands.CommandName.Current} config schema` for every field it accepts.";
        }

        // Line and position are already in the framework's message and are
        // exactly what a caller needs to find the character.
        return message;
    }

    [System.Text.RegularExpressions.GeneratedRegex(@"property '([^']+)'")]
    private static partial System.Text.RegularExpressions.Regex UnmappedProperty();
}

/// <summary>
/// How a session's branch is made, and what happens to the instance afterwards.
/// </summary>
internal sealed record GitConfig
{
    /// <summary>Prefixed to the session name to make the branch.</summary>
    public string? BranchPrefix { get; init; }

    /// <summary>What the session's branch is created from.</summary>
    public string? Base { get; init; }

    /// <summary>
    /// Whether the instance survives the session.
    /// </summary>
    /// <remarks>
    /// Defaults to keeping it. Commits are bundled back into the host repository
    /// when a session ends, but anything uncommitted lives only in the instance,
    /// and deleting someone's uncommitted work by default is unforgivable. A
    /// kept instance is stopped rather than running, costs almost nothing on a
    /// copy-on-write pool, and <c>envmux prune</c> is how it goes.
    /// </remarks>
    public bool? KeepOnExit { get; init; }

    public const string DefaultBranchPrefix = "envmux/";
    public const string DefaultBase = "HEAD";
}

/// <summary>A configuration file that exists but cannot be used.</summary>
internal sealed class ConfigException : Exception
{
    public ConfigException(string message, Exception? inner = null) : base(message, inner) { }
}
