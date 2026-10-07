using Envmux.Config;
using Envmux.Host;
using Envmux.Portal;
using Envmux.Routing;

namespace Envmux.Session;

/// <summary>
/// A <see cref="SessionConfig"/> with every default applied and a session name
/// resolved — what the session is actually going to do, before it does any of it.
/// </summary>
/// <remarks>
/// Resolving defaults once, here, is what lets everything downstream — git, the
/// Incus client, the TUI — read plain non-nullable values instead of each
/// re-deciding what an absent field meant.
/// </remarks>
internal sealed record SessionPlan
{
    /// <summary>The project directory envmux was run in. Also the git repository root.</summary>
    public required string Directory { get; init; }

    /// <summary>The project's name: the first label of this session's hostname.</summary>
    public required string Project { get; init; }

    /// <summary>This session's name: its instance, its branch, its second label.</summary>
    public required string Session { get; init; }

    /// <summary>Whether this session has the repository's guest dispatch capability.</summary>
    public bool Chef { get; init; }

    /// <summary>
    /// The image an instance is created from when there is no golden snapshot.
    /// </summary>
    /// <remarks>
    /// The slow path, and the one that says so. The normal path is a copy of
    /// <see cref="Incus.Golden.Source"/>, which on a ZFS pool is a clone rather
    /// than a copy — near-instant, and near-zero disk until something is written.
    /// </remarks>
    public required string Image { get; init; }

    /// <summary>The immutable base selected by this launch's managed Docker backend.</summary>
    /// <remarks>It belongs to the resolved plan, never the repository's configuration file.</remarks>
    public string? ManagedGoldenImage { get; init; }

    /// <summary>The configured image and the exact managed base, when one was selected.</summary>
    /// <remarks>Distinct managed recipes need distinct feature-cache names, including concurrent launches.</remarks>
    public string ImageFingerprintBase => ManagedGoldenImage is { } image
        ? $"{Image}\nmanaged-golden-image={image}"
        : Image;

    /// <summary>
    /// The toolchain layered onto the image, as dev container features.
    /// </summary>
    /// <remarks>
    /// Empty for a project that needs nothing beyond the golden image, which is
    /// most of them and is why a session is normally a copy and nothing else.
    /// </remarks>
    public required IReadOnlyList<Incus.Feature> Features { get; init; }

    /// <summary>
    /// What this project's image is built from, hashed.
    /// </summary>
    /// <remarks>
    /// Part of the image's name, so the image and the config cannot drift apart:
    /// change a feature and the next session looks for an image that does not
    /// exist yet, and builds it.
    /// </remarks>
    public string ImageFingerprint => Incus.Features.Fingerprint(ImageFingerprintBase, Features);

    /// <summary>Whether this project has an image of its own to be copied from.</summary>
    public bool HasProjectImage => Features.Count > 0;

    /// <summary>
    /// Whether the instance has to be able to run containers of its own.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Derived from the features rather than declared, because it is not a
    /// choice anybody makes separately: a project that asks for Docker wants
    /// Docker to work, and a project that does not should not have a container
    /// runtime it never uses.
    /// </para>
    /// <para>
    /// Incus will not let a system container start containers without
    /// <c>security.nesting</c>, and the failure is not obvious from inside — the
    /// daemon starts and then cannot set up cgroups, which reads as a broken
    /// Docker rather than a container that was never allowed one.
    /// </para>
    /// </remarks>
    public bool NeedsNesting =>
        Features.Any(f => f.Name.Contains("docker", StringComparison.OrdinalIgnoreCase));

    public required string Workdir { get; init; }
    public required string Shell { get; init; }

    /// <summary>How the editor key opens this session, with defaults applied.</summary>
    public required EditorConfig Editor { get; init; }

    /// <summary>
    /// A symlink at the root of the instance that names the workdir after the
    /// session — <c>/&lt;project&gt;_&lt;session&gt;</c>, pointing at <see cref="Workdir"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Every instance clones the repository to the same place, <c>/work</c>
    /// unless the config says otherwise, which is right for tasks and wrong for
    /// an editor. VS Code files a window under the last segment of the folder it
    /// opened, so the recent list held a dozen entries all called <c>work</c>
    /// with the hostname in grey beside each, and reopening the one from Tuesday
    /// meant trying them in turn. This path exists to be that last segment.
    /// </para>
    /// <para>
    /// An underscore between the halves rather than the hostname's hyphen,
    /// because a slug never contains one — <see cref="Slug.From"/> collapses
    /// everything that is not a letter or digit to a hyphen. So the name reads
    /// back into project and session without ambiguity, and, the same fact from
    /// the other side, cannot be the name of anything a Debian root already has
    /// in it.
    /// </para>
    /// <para>
    /// Only the editor is pointed here. The clone lands in <see cref="Workdir"/>,
    /// tasks and shells start there, the survey reads there and
    /// <c>ENVMUX_WORKDIR</c> says so — a path that appears in a log line or a
    /// config file should be the one things actually happen in. The link is a
    /// courtesy to a recents list, not a second name for the workspace.
    /// </para>
    /// </remarks>
    public string WorkdirLink => $"/{Project}_{Session}";

    /// <summary>
    /// The folder an editor opens: <c>editor.folder</c> when one was written
    /// down, otherwise <see cref="WorkdirLink"/>.
    /// </summary>
    /// <remarks>
    /// A folder somebody named is opened as named, even one under the workdir.
    /// Rewriting <c>/work/api</c> onto the link would gain nothing — the window
    /// would still be called <c>api</c> — and would put a path they never wrote
    /// in front of them.
    /// </remarks>
    public string EditorFolder => Editor.Folder ?? WorkdirLink;

    /// <summary>The declared tasks, in the order they will start.</summary>
    public required IReadOnlyList<TaskPlan> Tasks { get; init; }

    public required IReadOnlyDictionary<string, string> Env { get; init; }

    /// <summary>Every declared route: a port on this session's own address.</summary>
    public required IReadOnlyList<RoutedEndpoint> Routes { get; init; }

    /// <summary>The loopback port the portal is served on, or the range to claim within.</summary>
    /// <remarks>
    /// The only port envmux allocates, and it is not a route's. Everything a
    /// session runs is reached on the port it bound, at the address the instance
    /// holds.
    /// </remarks>
    public required PortSpec Port { get; init; }

    /// <summary>The services this session depends on, with credentials already generated.</summary>
    public required IReadOnlyList<ServicePlan> Services { get; init; }

    /// <summary>The zone the session's hostname sits under. From the host, not the project.</summary>
    public required string Domain { get; init; }

    /// <summary>The branch this session's work lands on, in the host repository.</summary>
    public required string Branch { get; init; }

    /// <summary>What the branch is created from.</summary>
    public required string Base { get; init; }

    /// <summary>
    /// Whether the instance outlives the session.
    /// </summary>
    /// <remarks>
    /// Kept by default. A session's commits are bundled back into the host
    /// repository when it ends, but anything uncommitted lives only in the
    /// instance — and deleting somebody's uncommitted work because a default
    /// said so is unforgivable. A kept instance is stopped, costs almost nothing
    /// on a copy-on-write pool, and <c>envmux prune</c> is how it goes.
    /// </remarks>
    public required bool KeepOnExit { get; init; }

    /// <summary>Whether the session is also served as a page, and how it is reached.</summary>
    public required PortalPlan Portal { get; init; }

    /// <summary>
    /// What the session runs on, when the config or the command line said; null for
    /// <see cref="Backends.BackendCatalog.Default"/>.
    /// </summary>
    public Backends.BackendKind? Backend { get; init; }

    /// <summary>The session's SOCKS port and the browser launched on it.</summary>
    public required Socks.SocksPlan Browser { get; init; }

    /// <summary>Host tool state to carry into the instance, by tool name. Empty carries nothing.</summary>
    public required IReadOnlyDictionary<string, string> Tools { get; init; }

    /// <summary>
    /// Whether this host's git credentials go into the instance.
    /// </summary>
    /// <remarks>
    /// Declared as <c>"git"</c> in <c>tools</c>, alongside the coding tools,
    /// because it is the same decision: state from this machine that makes
    /// something inside the instance work without signing in again. It is not a
    /// file mount like the others — there may be no file to mount — so it is
    /// read here rather than by <c>ToolMounts</c>.
    /// </remarks>
    public bool CarryGitCredentials =>
        Tools.TryGetValue("git", out var setting) &&
        !setting.Equals("off", StringComparison.OrdinalIgnoreCase);

    /// <summary>The repository's git directory on the host.</summary>
    public string GitDirPath => Path.Combine(Directory, ".git");

    /// <summary>
    /// The instance's name, which is also the first label of its hostname.
    /// </summary>
    /// <remarks>
    /// One string doing two jobs: Incus registers an instance in the bridge's
    /// DNS under its own name, so the name being the label is what makes
    /// <see cref="Hostname"/> resolve without anything else being configured.
    /// </remarks>
    public string InstanceName => RouteTable.InstanceName(Project, Session);

    /// <summary>Where this session answers, for every port it listens on.</summary>
    public string Hostname => RouteTable.Hostname(Project, Session, Domain);

    public static SessionPlan Resolve(SessionConfig config, string directory, string? requestedSession = null)
    {
        var fullPath = Path.GetFullPath(directory);
        var project = string.IsNullOrWhiteSpace(config.Name)
            ? Slug.FromDirectory(fullPath)
            : Slug.From(config.Name);

        var session = SessionName.Resolve(requestedSession);

        var domain = string.IsNullOrWhiteSpace(config.Domain)
            ? RouteTable.DefaultDomain
            : config.Domain.Trim().Trim('.').ToLowerInvariant();

        var port = config.Port ?? PortSpec.Default;
        port.Validate();

        var git = config.Git;
        var branchPrefix = Blank(git?.BranchPrefix) ?? GitConfig.DefaultBranchPrefix;

        var routes = RouteTable.Build(project, session, domain, config.Routes);
        var workdir = Blank(config.Workdir) ?? SessionConfig.DefaultWorkdir;

        // An instance name is a DNS label, and DNS labels stop at 63 characters.
        // Caught here because Incus would refuse the creation with a message
        // about names, several seconds into a session that looked like it was
        // starting.
        var instance = RouteTable.InstanceName(project, session);
        if (instance.Length > 63)
        {
            throw new ConfigException(
                $"'{instance}' is {instance.Length} characters, and an instance name is also a DNS label, " +
                "which stops at 63. Shorten 'name' in .envmux.json, or the session name.");
        }

        // Services resolve first: they generate the credentials that the
        // session's own environment then carries, and a task may depend on one.
        var services = (config.Services ?? [])
            .OrderBy(s => s.Key, StringComparer.Ordinal)
            .Select(s => ServicePlan.Resolve(s.Key, s.Value, project, session, domain))
            .ToList();

        var tasks = (config.Tasks ?? [])
            .Select(t => TaskPlan.Resolve(t.Key, t.Value, workdir, services))
            .ToList();

        if (tasks.Select(t => t.Name).Distinct(StringComparer.Ordinal).Count() != tasks.Count)
        {
            // Two names that slug to the same thing would be two tasks envmux
            // cannot tell apart when signalling one of them — and, now, two
            // tmux sessions with one name.
            throw new ConfigException(
                "two tasks resolve to the same name: " +
                string.Join(", ", tasks.GroupBy(t => t.Name, StringComparer.Ordinal)
                    .Where(g => g.Count() > 1).Select(g => $"'{g.Key}'")));
        }

        // A name that is both would make every dependsOn on it ambiguous.
        var shared = tasks.Select(t => t.Name)
            .Intersect(services.Select(s => Slug.From(s.Name)), StringComparer.Ordinal)
            .ToList();

        if (shared.Count > 0)
        {
            throw new ConfigException(
                $"'{shared[0]}' is both a task and a service — 'dependsOn' could not tell which was meant");
        }

        tasks = [.. TaskGraph.Order(tasks)];

        // Last, because it needs both sides resolved: which route each
        // url-declaring task speaks for, by ready port or by name.
        routes = RouteTable.Pin(routes, tasks);

        // A name that is no route would otherwise open http://proof and a
        // browser error, far from the typo that caused it.
        if (config.Browser?.Open is { Length: > 0 } open &&
            Socks.BrowserLaunch.IsRouteName(open.Trim()) &&
            !routes.Any(r => r.Name.Equals(open.Trim(), StringComparison.OrdinalIgnoreCase)))
        {
            throw new ConfigException(
                $"'browser.open' is '{open.Trim()}', which is not a route. Name one of " +
                $"{(routes.Count > 0 ? string.Join(", ", routes.Select(r => r.Name)) : "the routes (there are none)")}, " +
                "or give a URL like localhost:3000/admin");
        }

        var portal = PortalPlan.Resolve(config.Portal);
        var env = BuildEnvironment(config, services, directory);

        // The room, for a repository that has adopted the convention. One more
        // task, declared here rather than added by whoever starts the session,
        // so that a restart — which re-resolves the plan from the file — keeps
        // it, and so that --dry-run shows it. See Agents.RoomClient for what
        // it is and why it is a task.
        var chef = config.Chef && string.Equals(session, "chef", StringComparison.Ordinal);
        if (chef && !Agents.RoomClient.Reachable(portal))
        {
            throw new ConfigException("chef needs portal.enabled and portal.token to be true");
        }

        if (chef || Agents.RoomClient.Wanted(fullPath))
        {
            if (tasks.Any(t => t.Name.Equals(Agents.RoomClient.TaskName, StringComparison.Ordinal)))
            {
                throw new ConfigException(
                    $"this project declares a task called '{Agents.RoomClient.TaskName}', which is the name envmux runs " +
                    "the room's client as in a repository with a .context/. Rename it.");
            }

            if (Agents.RoomClient.Reachable(portal))
            {
                tasks = [.. tasks, Agents.RoomClient.Task(workdir, portal)];
            }

            // The convention stamps lines with local time and files them in a
            // local quarter hour, and the instance's clock is UTC. Under the
            // config's own env, never over it.
            env.TryAdd(
                Agents.Chatroom.TimeZoneVariable,
                Agents.Chatroom.PosixTimeZone(TimeZoneInfo.Local.GetUtcOffset(DateTimeOffset.Now)));
        }

        return new SessionPlan
        {
            Directory = fullPath,
            Project = project,
            Session = session,
            Chef = chef,
            Image = Blank(config.Image) ?? SessionConfig.DefaultImage,
            Features = Incus.Features.Resolve(config.Features),
            Workdir = workdir,
            Shell = Blank(config.Shell) ?? SessionConfig.DefaultShell,
            Editor = config.Editor ?? new EditorConfig(),
            Tasks = tasks,
            Env = env,
            Routes = routes,
            Port = port,
            Services = services,
            Domain = domain,
            Branch = SessionName.Branch(branchPrefix, session),
            Base = Blank(git?.Base) ?? GitConfig.DefaultBase,
            KeepOnExit = git?.KeepOnExit ?? true,
            Tools = config.Tools ?? [],
            Portal = portal,
            Browser = Socks.SocksPlan.Resolve(config.Browser, instance) with { Domain = domain },
            Backend = config.Backend is { Length: > 0 } backend
                ? Backends.BackendCatalog.Parse(backend)
                  ?? throw new ConfigException($"'backend' is '{backend}' — it is \"incus\" or \"docker\"")
                : null,
        };

        static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
    }

    /// <summary>
    /// The session instance's environment: what the services expose, what
    /// envmux generated, and what the declaration said — in that order.
    /// </summary>
    /// <remarks>
    /// The order is the precedence, lowest first. Service references come first
    /// because they are derived rather than chosen; generated values next; and
    /// the literal <c>env</c> block last, so a person who writes a value down
    /// always wins over one envmux inferred. That is also the escape hatch when
    /// a generated name collides with something real.
    /// </remarks>
    private static Dictionary<string, string> BuildEnvironment(
        SessionConfig config,
        IReadOnlyList<ServicePlan> services,
        string directory)
    {
        var env = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var service in services)
        {
            foreach (var (key, value) in service.ReferenceEnvironment())
            {
                env[key] = value;
            }
        }

        // Files on this machine, before the literal block. A gitignored .env is
        // where a project's local secrets are, and the bundle does not carry it
        // — so without this a session has the code and none of what runs it.
        foreach (var relative in config.EnvFile?.Arguments ?? [])
        {
            var path = Path.IsPathRooted(relative)
                ? relative
                : Path.Combine(directory, relative);

            foreach (var (key, value) in DotEnv.Read(path))
            {
                env[key] = value;
            }
        }

        foreach (var (name, spec) in config.Generate ?? [])
        {
            if (string.IsNullOrWhiteSpace(spec.Kind))
            {
                throw new ConfigException($"generate '{name}' does not say what kind of value to make");
            }

            env[name] = Generated.Of(spec.Kind, spec.Length);
        }

        foreach (var (key, value) in config.Env ?? [])
        {
            env[key] = value;
        }

        return env;
    }
}
