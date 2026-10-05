using System.Globalization;

using Envmux.Backends;
using Envmux.Config;
using Envmux.Editor;
using Envmux.Git;
using Envmux.Host;
using Envmux.Incus;
using Envmux.Portal;
using Envmux.Process;
using Envmux.Routing;

namespace Envmux.Session;

/// <summary>Something went wrong that ends the session.</summary>
internal sealed class SessionException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>
/// The launch sequence, and its exact reverse.
/// </summary>
/// <remarks>
/// <para>
/// This is the whole product: a branch, an instance with an address of its own,
/// the repository inside it, and the services beside it — created in that order
/// and taken down in the other one. Everything else is a view onto it.
/// </para>
/// <para>
/// What is missing compared to the version before it is the point. There is no
/// port to claim for a route, no published port to look up, no relay to install,
/// no reverse proxy to configure and no hostname to invent per route. An
/// instance holds an address, dnsmasq answers for its name, and a route is a
/// port. Everything that used to sit between a browser and a dev server was
/// there to undo the flattening of every environment onto one host port space,
/// and there is no flattening left to undo.
/// </para>
/// </remarks>
internal sealed class Session : IAsyncDisposable
{
    private readonly GitCli _git;
    private readonly HostConfig _host;

    /// <summary>What the instance runs on, once preflight has chosen and connected to it.</summary>
    private IBackend? _backend;
    private PortalListener? _portal;

    /// <summary>The session's SOCKS port, once claimed.</summary>
    private Socks.SocksListener? _socks;

    /// <summary>The browsers opened on it, which it lets in without a password.</summary>
    private readonly Socks.LaunchedBrowsers _browsers = new();

    /// <summary>Held while an editor is attached as a dev container, keeping the Docker endpoint up.</summary>
    private Docker.DockerLease? _dockerLease;

    /// <summary>The commit the session's branch started from, for measuring what it added.</summary>
    private string _base = "";

    private bool _disposed;

    /// <summary>Whether the session has already been taken down.</summary>
    private bool _stopped;

    /// <summary>What it reported when it was, so a second ask gets the same answer.</summary>
    private WorkspaceStatus? _report;

    private readonly List<SessionTask> _tasks = [];

    /// <summary>Every service instance that was created, for taking them down again.</summary>
    private readonly List<ServicePlan> _services = [];

    /// <summary>Everything running inside the instance.</summary>
    public IReadOnlyList<SessionTask> Tasks => _tasks;

    /// <summary>
    /// The coding tools whose host state was carried into the instance.
    /// </summary>
    /// <remarks>
    /// What actually went, not what was declared: a tool set to <c>"auto"</c>
    /// with no state on this host resolves to nothing, and offering to open it
    /// would be offering a tool that is not signed in.
    /// </remarks>
    public IReadOnlyList<ToolMount> Tools { get; private set; } = [];

    public SessionPlan Plan { get; private set; }

    /// <summary>A separate guest dispatch credential; never the browser's token.</summary>
    internal string ChefToken { get; } = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));

    public SessionLog Log { get; } = new();

    /// <summary>The account inside the instance. Never root.</summary>
    public string ContainerUser { get; private set; } = HostUser.FallbackName;

    /// <summary>The loopback port the portal claimed, once it has.</summary>
    public int Port => _portal?.Port ?? 0;

    /// <summary>The address the instance holds on the bridge, once it has one.</summary>
    public string Address { get; private set; } = "";

    /// <summary>Where this session answers, for every port it listens on.</summary>
    public string Hostname => Plan.Hostname;

    public IReadOnlyList<RoutedEndpoint> Routes => Plan.Routes;

    /// <summary>
    /// The routes as anything that lists them shows them, portal first.
    /// </summary>
    /// <remarks>
    /// Composed per call rather than kept, because it is a projection of three
    /// things that all change — whether there is an address yet, whether there
    /// is a portal port, and what each task with a <c>url</c> has printed — and
    /// a frame is composed from scratch anyway.
    /// </remarks>
    public IReadOnlyList<ListedRoute> Listed => RouteListing.Build(Plan, Port, Address, PrintedUrls());

    /// <summary>What each task with a <c>url</c> pattern has found so far, by name.</summary>
    private Dictionary<string, string>? PrintedUrls()
    {
        Dictionary<string, string>? printed = null;

        foreach (var task in _tasks)
        {
            if (task.PrintedUrl is { } url)
            {
                (printed ??= new Dictionary<string, string>(StringComparer.Ordinal))[task.Plan.Name] = url;
            }
        }

        return printed;
    }

    /// <summary>The instance's name, which is also the first label of its hostname.</summary>
    public string InstanceName => Plan.InstanceName;

    /// <summary>Raised whenever something a view is showing has changed.</summary>
    public event Action? Changed;

    /// <summary>
    /// Raised for every line a task produces, with the task's name.
    /// </summary>
    /// <remarks>
    /// For the headless run, which has no pane to put a task's output in and has
    /// to interleave it into the console instead. The TUI reads the buffered
    /// output rather than this, so that switching to a task shows what it said
    /// before you looked.
    /// </remarks>
    public event Action<string, string>? TaskOutput;

    /// <summary>
    /// Raised when something other than the window asks the session to end: the
    /// portal's stop, which is how a script or a test ends a headless run the way
    /// <c>q</c> ends one with a window.
    /// </summary>
    /// <remarks>
    /// An event rather than a cancellation the session owns, because ending is
    /// the process's business: whoever is running the session — the window, or
    /// the headless loop — tears it down the one way it always does.
    /// </remarks>
    public event Action? StopRequested;

    /// <summary>Ask whoever is running this session to end it.</summary>
    public void RequestStop() => StopRequested?.Invoke();

    /// <summary>
    /// What the session is doing right now, for a view to put on screen.
    /// </summary>
    /// <remarks>
    /// Separate from the log because it is a <em>current state</em>, not an
    /// event: "copying the golden snapshot" replaces itself rather than
    /// accumulating. Empty once the session is up.
    /// </remarks>
    public string Phase
    {
        get => _phase;
        private set
        {
            _phase = value;
            Announce();
        }
    }

    /// <summary>
    /// Tell the views something moved, and never let the telling be what fails.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The third event to need this, and the one that cost the most to find.
    /// <see cref="SessionLog"/> and the task-output event were isolated after a
    /// piped headless run lost its commits; <c>Changed</c> was not, and the
    /// headless narrator subscribes to it with <c>Console.WriteLine</c>.
    /// </para>
    /// <para>
    /// <c>Phase</c> is set on the first line of teardown — "stopping service
    /// 'db'" — so interrupting a session whose console had gone threw there and
    /// abandoned the rest: the service and the instance both left running, and
    /// nothing in the log to say why, because the log is what broke. Measured:
    /// the process exited and both instances were still Running two minutes
    /// later.
    /// </para>
    /// </remarks>
    private void Announce()
    {
        foreach (var subscriber in Changed?.GetInvocationList() ?? [])
        {
            try
            {
                ((Action)subscriber)();
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException
                                          or InvalidOperationException)
            {
                // Nowhere to report this: the thing that reports is what failed.
            }
        }
    }

    private string _phase = "starting";

    /// <summary>Whether the session is up and the addresses are real.</summary>
    public bool IsReady { get; private set; }

    /// <summary>When the session started, so a view can show how long it has been.</summary>
    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;

    /// <summary>What went wrong during startup, if anything did.</summary>
    public string? FailedWith { get; private set; }

    /// <summary>The backend, for the views that talk to the instance themselves.</summary>
    public IBackend Backend =>
        _backend ?? throw new SessionException("the session is not connected to a backend");

    public Session(SessionPlan plan)
    {
        Plan = plan;
        _git = new GitCli(plan.Directory);
        _host = HostConfig.Load();
    }

    /// <summary>
    /// Bring the session up: branch, instance, repository, services, tasks.
    /// </summary>
    public async Task StartAsync(CancellationToken ct = default)
    {
        var backend = _backend ?? throw new SessionException("the session started before its preflight");

        // 1. The instance. Everything else needs somewhere to be.
        await StartInstanceAsync(backend, ct).ConfigureAwait(false);

        // 2. The services, beside it rather than inside it — each with an
        //    address and a name of its own, so two sessions in one directory
        //    both get a Postgres on 5432.
        await StartServicesAsync(backend, ct).ConfigureAwait(false);

        // 2a. And what they expose, written where every shell in the instance
        //     reads it. After the services, because a reused one corrects its
        //     own credentials as it starts.
        await WriteEnvironmentAsync(backend, ct).ConfigureAwait(false);

        // 3. The repository, as a bundle over the files API. There is a machine
        //    boundary now, so it travels rather than being mounted.
        Phase = "preparing the workspace";
        _base = await Workspace
            .SeedAsync(backend, _git, Plan, ContainerUser, Log, p => Phase = p, ct)
            .ConfigureAwait(false);

        // 4. The portal, which is the only thing left that claims a port — and
        //    with it the bridge, the same API on the address the instance can
        //    reach.
        await StartPortalAsync(ct).ConfigureAwait(false);

        // 4b. The browser's port, claimed now so it is known before anybody
        //     asks for a browser, and held for as long as the session is.
        StartBrowserProxy();

        // 4a. The instance's way to that API: a proxy device, attached now that
        //     the instance exists and the listener has bound. Before the tasks,
        //     because one of them is the room's client and it dials this on
        //     its first breath.
        await WireRoomAsync(backend, ct).ConfigureAwait(false);

        foreach (var route in Plan.Routes)
        {
            Log.Info($"{route.Name} → {route.Url}");
        }

        IsReady = true;
        Phase = "";

        // 5. The tasks, after the session is already usable, so a slow install
        //    does not hold the URLs hostage. What has to happen before what is
        //    the tasks' own business: see dependsOn.
        _ = StartTasksAsync(ct);
    }

    /// <summary>
    /// Give the instance a loopback route to this process's API, for the room.
    /// </summary>
    /// <remarks>
    /// <para>
    /// An Incus proxy device (<see cref="ApiBridge"/>): incusd listens on
    /// <c>127.0.0.1:8078</c> inside the instance and connects out to the bridge
    /// listener on this machine. Rewritten every session, because the address
    /// on this side is whatever DHCP handed the workstation today and the port is
    /// whatever was free; nothing inside is ever told either.
    /// </para>
    /// <para>
    /// Only when the plan has the room's task — a repository that has adopted
    /// the convention, or a remote agent — so a project that has never heard of
    /// <c>.context/</c> gets no device and no listener facing anything. And
    /// never fatal: a room that could not be wired is a warning about the room,
    /// not a session that refuses to start.
    /// </para>
    /// </remarks>
    private async Task WireRoomAsync(IBackend backend, CancellationToken ct)
    {
        if (!Plan.Tasks.Any(Agents.RoomClient.Is))
        {
            if (Agents.RoomClient.Wanted(Plan.Directory))
            {
                Log.Warn(
                    $"{Agents.Chatroom.RoomDirectory}/ is not carried into {Plan.InstanceName}: the room signs in with " +
                    "the portal's token, and this project has the portal or its token turned off");
            }

            return;
        }

        if (_portal?.Bridge is not { } bridge)
        {
            Log.Warn(
                $"{Agents.Chatroom.RoomDirectory}/ is not carried into {Plan.InstanceName}: no address faces the host, " +
                "or no port was free for the API beside the portal's");
            return;
        }

        Phase = "wiring the room";

        try
        {
            if (!await backend.TryWireLoopbackAsync(
                    Plan.InstanceName, ApiBridge.DeviceName, ApiBridge.InsidePort, bridge, ct).ConfigureAwait(false))
            {
                Log.Warn($"room: {backend.Kind} cannot carry the API into {Plan.InstanceName}; the room stays on this side");
                return;
            }

            Log.Info(
                $"room: {Agents.Chatroom.RoomDirectory}/ is carried into {Plan.InstanceName} — " +
                $"{ApiBridge.InsideUrl} there is {bridge} here");
        }
        catch (BackendException e)
        {
            Log.Warn($"room: could not attach the API to {Plan.InstanceName} ({e.Message}); the room stays on this side");
        }
    }

    /// <summary>
    /// Bring the session up behind a UI that is already on screen.
    /// </summary>
    /// <remarks>
    /// The window exists before any of this runs, so a first-run image pull
    /// narrates itself instead of looking like a hang. A failure lands in the
    /// log and in <see cref="FailedWith"/> rather than tearing down a terminal
    /// the user is looking at.
    /// </remarks>
    public Task StartInBackgroundAsync(CancellationToken ct = default) => Task.Run(async () =>
    {
        try
        {
            await StartAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Quitting during startup is not a failure.
        }
        catch (Exception e)
        {
            FailedWith = e.Message;
            Phase = "failed";
            Log.Error(e.Message);
            Log.Info("^c or /quit to leave");
        }
    }, ct);

    /// <summary>
    /// Everything that can be checked before anything is created.
    /// </summary>
    /// <remarks>
    /// Kept separate, and run before the UI comes up, because these checks are
    /// fast and their failures are worth showing as a plain console error. The
    /// slow work happens behind a window that is already on screen, so it can
    /// narrate itself.
    /// </remarks>
    public async Task PreflightAsync()
    {
        try
        {
            _backend ??= BackendCatalog.Open(Plan.Backend, _host);
            await _backend.PreflightAsync().ConfigureAwait(false);
        }
        catch (BackendException e)
        {
            throw new SessionException(e.Message, e);
        }

        if (!await _git.IsRepositoryAsync().ConfigureAwait(false))
        {
            throw new SessionException(
                $"{Plan.Directory} is not a git repository. A session is a branch — run `git init` first.");
        }

        if (!await _git.HasCommitsAsync().ConfigureAwait(false))
        {
            throw new SessionException(
                "this repository has no commits yet. A session needs something to branch from.");
        }
    }

    /// <summary>
    /// What to say when the network the host's file names is not on the host.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Named as the host's file names it, because that is what was looked for:
    /// "no envmux0" on a daemon that was pointed at another bridge sends
    /// somebody after a network that was never meant to be there.
    /// </para>
    /// <para>
    /// And two different stories behind the same absence, so the advice
    /// differs. A VM envmux built gets its bridge from the seed, so a missing
    /// one is a seed that did not take. A daemon envmux was pointed at had the
    /// network on the day it was installed against — created then, or already
    /// there and adopted — so somebody has since removed or renamed it, and
    /// installing again is what makes one or picks another.
    /// </para>
    /// </remarks>
    internal static string MissingNetwork(HostConfig host) =>
        $"the host has no '{host.Network}' network, so an instance would have nowhere to be. " +
        (host.IsHyperV
            ? "The seed's preseed did not apply."
            : $"It was there when `{Commands.CommandName.Current} install` was run against this daemon, and " +
              $"is not now. Running it again makes {HostConfig.DefaultNetwork}, or adopts another with --network.");

    /// <summary>
    /// Create the session's instance, or adopt the one a previous run left.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Adoption is the reason instances are kept rather than deleted. Starting a
    /// session by the same name in the same directory again picks up the
    /// instance it left behind — with its uncommitted work, its installed
    /// dependencies and its latched tasks still in it — which is the cheap,
    /// obvious thing to want and was impossible when a container was thrown away
    /// at every exit.
    /// </para>
    /// <para>
    /// A copy of the golden snapshot otherwise. On a ZFS pool that is a clone:
    /// near-instant, and near-zero disk until something is written. Without one,
    /// it falls back to pulling an image, which is minutes rather than seconds
    /// and says so.
    /// </para>
    /// </remarks>
    private async Task StartInstanceAsync(IBackend backend, CancellationToken ct)
    {
        var existing = await backend.Instances.GetAsync(Plan.InstanceName, ct).ConfigureAwait(false);

        if (existing is null)
        {
            // A project with a toolchain gets an image of its own, built once
            // and copied after that. Without one this is the golden image, which
            // is the common case and the fast one.
            var user = (await HostUser.DetectAsync(ct).ConfigureAwait(false)).Name;
            var image = await backend.Images
                .ChooseAsync(Plan, user, line =>
                {
                    Phase = line;
                    Log.Info(line);
                }, ct)
                .ConfigureAwait(false);

            if (image is { Source: null, Golden: false })
            {
                Log.Warn($"there is no golden image, so this starts from {image.Describe} — " +
                         $"minutes, where a copy is seconds. `{Commands.CommandName.Current} host golden` makes one.");
            }

            Phase = image.Source is not null
                ? $"copying {Plan.Project}'s image"
                : image.Golden ? "copying the golden image" : $"pulling {image.Describe}";

            await backend.Instances.CreateAsync(backend.SessionSpec(Plan, image), p => Phase = p, ct)
                .ConfigureAwait(false);

            // A new machine answering to a name ssh may remember a different key
            // for. Only on creation: an adopted instance is the same machine and
            // its key is the one that should still be trusted.
            await Editor.HostKeys.ForgetAsync(Plan.Hostname, ct).ConfigureAwait(false);

            Log.Info(image.Source is not null || image.Golden
                ? $"instance {Plan.InstanceName} copied from {image.Describe}"
                : $"instance {Plan.InstanceName} created from {image.Describe}");
        }
        else
        {
            Log.Info($"instance {Plan.InstanceName} adopted — it is where you left it");
            WarnIfToolchainMoved(existing);
        }

        Phase = "starting the instance";

        if (existing is not { IsRunning: true })
        {
            await backend.Instances.StartAsync(Plan.InstanceName, ct).ConfigureAwait(false);
        }

        Phase = "waiting for its address";

        Address = await backend.Instances.AwaitAddressAsync(Plan.InstanceName, TimeSpan.FromSeconds(60), ct)
                      .ConfigureAwait(false)
                  ?? throw new SessionException(
                      $"{Plan.InstanceName} started but never took an address on {backend.Name}");

        Log.Info($"{Plan.Hostname} is {Address}");

        // The account, and the tools that travel with it. Before the workspace,
        // because the workspace is handed to this user.
        await BootstrapAsync(backend, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Say so when an adopted instance predates the toolchain the config asks for.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>features</c> installs into a project image, and an image is only ever
    /// consulted when an instance is <em>created</em>. Adopting one skips all of
    /// it — which is the whole point of adoption, and is exactly wrong the one
    /// time somebody has just added a feature.
    /// </para>
    /// <para>
    /// The failure otherwise arrives minutes later as a task saying <c>docker:
    /// command not found</c>, in a session that reported nothing unusual while
    /// starting, and the answer — prune it and start again — is not one anybody
    /// guesses from that message.
    /// </para>
    /// <para>
    /// Silent when the instance carries no fingerprint at all: those were made
    /// before this was stamped, and "your toolchain may have changed" about
    /// every instance on the machine is a warning people learn to skip.
    /// </para>
    /// </remarks>
    private void WarnIfToolchainMoved(Instance existing)
    {
        if (!existing.Config.TryGetValue(InstanceSpec.Keys.Image, out var was) ||
            was.Equals(Plan.ImageFingerprint, StringComparison.Ordinal))
        {
            return;
        }

        Log.Warn(
            "this instance was made before 'features' last changed, so it has the old toolchain — " +
            $"`{Commands.CommandName.Current} prune --force` removes it and starting this session " +
            "again builds a new one. Uncommitted work in it goes with it.");
    }

    /// <summary>
    /// Make the account the session runs as, and carry the tools into it.
    /// </summary>
    /// <remarks>
    /// Matching the host's uid the way the Docker version did is pointless now:
    /// nothing is bind-mounted, so nothing the session writes is ever read back
    /// through a host filesystem. What matters is only that it is not root, so
    /// that a mistake inside the instance is a mistake inside the instance.
    /// </remarks>
    private async Task BootstrapAsync(IBackend backend, CancellationToken ct)
    {
        Phase = "preparing the account";

        var host = await HostUser.DetectAsync(ct).ConfigureAwait(false);
        ContainerUser = host.Name;

        var result = await Command
            .ShellAsync(
                backend.Exec, Plan.InstanceName, Bootstrap.Script(ContainerUser, Plan.Workdir, Plan.WorkdirLink), null, null, ct)
            .ConfigureAwait(false);

        if (!result.Ok)
        {
            Log.Warn($"the account bootstrap was incomplete; the session may run as root: {LastLine(result.Text)}");
        }
        else
        {
            Log.Info($"user {ContainerUser}");
        }

        var tools = ToolMounts.Resolve(Plan.Tools);
        Tools = tools;

        // Grouped by tool rather than by mount, because a tool can be several:
        // claude is ~/.claude and ~/.claude.json both, and it is one thing to
        // report. Ungrouped it said "carried claude state across" twice, every
        // session, which reads like a bug in whatever is doing the carrying.
        foreach (var group in tools.GroupBy(t => t.Name, StringComparer.Ordinal))
        {
            Phase = $"carrying {group.Key} state across";

            var carried = 0;

            foreach (var mount in group)
            {
                if (await ToolMounts.PushAsync(backend, Plan.InstanceName, ContainerUser, mount, ct)
                    .ConfigureAwait(false))
                {
                    carried++;
                }
            }

            // All or nothing, said plainly. Half of a tool's state is a tool
            // that is signed in and cannot find its settings, which is worth
            // hearing about differently from one that did not arrive at all.
            if (carried == group.Count())
            {
                Log.Info($"carried {group.Key} state across — it should arrive signed in");
            }
            else if (carried > 0)
            {
                Log.Warn(
                    $"only part of {group.Key}'s state arrived " +
                    $"({carried.ToString(CultureInfo.InvariantCulture)} of " +
                    $"{group.Count().ToString(CultureInfo.InvariantCulture)})");
            }
            else
            {
                Log.Warn($"could not carry {group.Key} state across");
            }
        }

        await CarryGitCredentialsAsync(backend, ct).ConfigureAwait(false);
        await AuthorizeSshAsync(backend, ct).ConfigureAwait(false);
        await InstallRoomClientAsync(backend, ct).ConfigureAwait(false);
        var skills = await Command.ShellAsync(backend.Exec, Plan.InstanceName,
            Agents.ProjectSkills.GuestScript(ContainerUser), ContainerUser, ct: ct).ConfigureAwait(false);
        if (!skills.Ok)
        {
            Log.Warn("the bundled guest skills could not be installed; use the project skills installed by init");
        }
    }

    /// <summary>
    /// Put the room's client in the instance, for the task that runs it.
    /// </summary>
    /// <remarks>
    /// Written whole, every session, the way the environment profile is — so
    /// an adopted instance runs this build's client rather than the one it was
    /// made with. The script carries no secret; what it signs in with arrives
    /// in its task's environment and nowhere else. Only when the plan has the
    /// task, so a repository without a <c>.context/</c> leaves nothing behind.
    /// </remarks>
    private async Task InstallRoomClientAsync(IBackend backend, CancellationToken ct)
    {
        if (!Plan.Tasks.Any(Agents.RoomClient.Is))
        {
            return;
        }

        var installed = await Command
            .ShellAsync(backend.Exec, Plan.InstanceName, Agents.RoomClient.InstallScript(), null, null, ct)
            .ConfigureAwait(false);

        if (!installed.Ok)
        {
            Log.Warn($"could not install {Agents.RoomClient.Program}, so the room will not be carried: {LastLine(installed.Text)}");
        }
    }

    /// <summary>
    /// Let this machine ssh into the session, which is how the editor attaches.
    /// </summary>
    /// <remarks>
    /// Not behind the <c>tools</c> opt-in, unlike everything else carried
    /// across: a public key is the half of a keypair that exists to be handed
    /// out, and putting one into a container you just started on your own
    /// machine is what it is for. Without it <c>envmux code</c> produces a URI
    /// that cannot connect, which is worse than not offering one.
    /// </remarks>
    private async Task AuthorizeSshAsync(IBackend backend, CancellationToken ct)
    {
        var keys = Editor.HostKeys.Public();

        if (keys.Count == 0)
        {
            Log.Debug(
                "no public key to authorise, so the editor cannot attach over ssh. " +
                $"`{Commands.CommandName.Current} ssh` makes envmux's own and points " +
                "~/.ssh/config at it; the session is otherwise fine.");

            return;
        }

        var authorized = await Command
            .ShellAsync(
                backend.Exec,
                Plan.InstanceName,
                Bootstrap.AuthorizedKeysScript(ContainerUser, keys),
                null,
                null,
                ct)
            .ConfigureAwait(false);

        if (authorized.Ok)
        {
            Log.Debug(
                $"{keys.Count.ToString(CultureInfo.InvariantCulture)} public key(s) authorised for ssh: " +
                string.Join(", ", Editor.HostKeys.Names()));
        }
        else
        {
            Log.Warn($"could not authorise this machine for ssh, so the editor will not attach: {LastLine(authorized.Text)}");
        }
    }

    /// <summary>
    /// Write the session's environment into the instance, for every shell in it.
    /// </summary>
    /// <remarks>
    /// After the services rather than with the rest of the bootstrap, because a
    /// reused service corrects its own credentials as it starts and this has to
    /// carry the corrected ones. Written before the tasks, which is the only
    /// other ordering that matters.
    /// </remarks>
    private async Task WriteEnvironmentAsync(IBackend backend, CancellationToken ct)
    {
        Phase = "writing the session's environment";

        _environment ??= new Dictionary<string, string>(Plan.Env, StringComparer.Ordinal);
        Derive(_environment);
        if (Plan.Chef)
        {
            _environment["ENVMUX_CHEF_URL"] = ApiBridge.InsideUrl;
            _environment["ENVMUX_CHEF_TOKEN"] = ChefToken;
        }

        var written = await Command
            .ShellAsync(
                backend.Exec,
                Plan.InstanceName,
                Bootstrap.EnvironmentScript(_environment),
                null,
                null,
                ct)
            .ConfigureAwait(false);

        if (!written.Ok)
        {
            Log.Warn(
                "the session's environment could not be written, so service credentials will not be " +
                $"in it: {LastLine(written.Text)}");
        }

        await SetInstanceEnvironmentAsync(backend, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// What the session knows about itself, on top of what it was declared to be.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Under the literal <c>env</c> block, never over it. These are derived
    /// values, and the precedence rule the configuration documents is that a
    /// value somebody wrote down beats one envmux worked out — including this
    /// one, which is how a project overrides where its certificate is read from
    /// or what it calls itself.
    /// </para>
    /// <para>
    /// <c>ENVMUX_HOSTNAME</c> is the one everything else is built out of.
    /// <c>env</c> values are literal, with no interpolation, so a task that has
    /// to name its own session — an app host telling a dashboard what public URL
    /// to print — cannot get it from the config and has to read it from a shell
    /// that already knows.
    /// </para>
    /// </remarks>
    private void Derive(Dictionary<string, string> environment)
    {
        var derived = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["ENVMUX_PROJECT"] = Plan.Project,
            ["ENVMUX_SESSION"] = Plan.Session,
            ["ENVMUX_HOSTNAME"] = Plan.Hostname,
            ["ENVMUX_WORKDIR"] = Plan.Workdir,
        };

        if (Address.Length > 0)
        {
            derived["ENVMUX_ADDRESS"] = Address;
        }


        foreach (var (key, value) in derived)
        {
            if (!Plan.Env.ContainsKey(key))
            {
                environment[key] = value;
            }
        }
    }

    /// <summary>
    /// The same environment again, on the instance itself.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The profile covers every shell that logs in — a task, an attached
    /// terminal, ssh. It does not cover an <c>exec</c> that is not a login, and
    /// that is what anybody debugging by hand runs: <c>incus exec &lt;instance&gt;
    /// -- bash</c> gets no <c>DB_HOST</c>, which looks exactly like the bug where
    /// the environment was not being written at all. I made that mistake myself
    /// while checking this.
    /// </para>
    /// <para>
    /// Incus merges an instance's <c>environment.*</c> into every exec, and
    /// applies a change to a running instance from the next one — measured, not
    /// assumed. So both paths are covered and neither depends on the other.
    /// </para>
    /// <para>
    /// It does put the generated database password in <c>incus config show</c>.
    /// It is already in a world-readable file inside the instance, the host is
    /// the same person's, and the alternative is a debugging session that starts
    /// with a wrong answer.
    /// </para>
    /// </remarks>
    private async Task SetInstanceEnvironmentAsync(IBackend backend, CancellationToken ct)
    {
        var environment = _environment ?? new Dictionary<string, string>(Plan.Env, StringComparer.Ordinal);

        // No early return on an empty environment: a project with no services
        // and no envFile may still have something to clear, from a run when it
        // did. The backend removes what is no longer set.
        try
        {
            await backend.Instances.SetEnvironmentAsync(Plan.InstanceName, environment, ct).ConfigureAwait(false);
        }
        catch (BackendException e)
        {
            // Not fatal: the profile is the one every shell reads, and this is
            // the convenience on top of it.
            Log.Debug($"could not put the environment on the instance: {e.Message}");
        }
    }

    /// <summary>
    /// Pass a task's line on, and never let the passing on be what fails.
    /// </summary>
    /// <remarks>
    /// A headless run subscribes to this with <c>Console.WriteLine</c>, so a
    /// console that has gone — a piped run whose reader died — throws on the
    /// next line. That throw would come out inside the loop following the task's
    /// log, which would end the follower and, with it, ever learning what the
    /// task exited with. Whether anyone is reading the output is not the task's
    /// concern. <see cref="SessionLog"/> does the same for the same reason.
    /// </remarks>
    private void Announce(string task, string line)
    {
        try
        {
            TaskOutput?.Invoke(task, line);
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException)
        {
            // Nowhere to report this: the thing that reports is what failed.
        }
    }

    /// <summary>
    /// Give the instance the credentials this repository's remotes need.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A session clones from a bundle with no remote, so the first <c>git
    /// push</c> anyone runs — or any agent runs — needs whatever this machine
    /// was using. Copying a file does not find it: Git Credential Manager keeps
    /// the token in the Windows Credential Manager, which is not a file and has
    /// no Linux counterpart. <see cref="GitCredentials"/> asks git for it
    /// instead.
    /// </para>
    /// <para>
    /// Behind the same opt-in as the coding tools, and for the same reason: this
    /// is a credential leaving the machine, so it happens because it was asked
    /// for and never because something inferred it.
    /// </para>
    /// </remarks>
    private async Task CarryGitCredentialsAsync(IBackend backend, CancellationToken ct)
    {
        if (!Plan.CarryGitCredentials)
        {
            return;
        }

        var credentials = await GitCredentials.CollectAsync(_git, ct).ConfigureAwait(false);

        if (credentials.Count == 0)
        {
            Log.Debug("no git credentials on this host for this repository's remotes");
            return;
        }

        Phase = "carrying git credentials across";

        var home = Bootstrap.Home(ContainerUser);
        var path = $"{home}/{GitCredentials.ContainerFile}";

        try
        {
            // 0600 and owned by the session account: the whole point of the file
            // is that git will read it, and git refuses one anyone else can.
            await backend.Files.PushAsync(
                Plan.InstanceName,
                path,
                System.Text.Encoding.UTF8.GetBytes(GitCredentials.File(credentials)),
                "0600",
                ct: ct).ConfigureAwait(false);

            var script = new System.Text.StringBuilder();
            script.Line("set -eu");
            script.Line($"chown {Workspace.Quote(ContainerUser)} {Workspace.Quote(path)}");
            script.Line(
                $"su - {Workspace.Quote(ContainerUser)} -c " +
                Workspace.Quote("git config --global credential.helper store"));

            var applied = await Command
                .ShellAsync(backend.Exec, Plan.InstanceName, script.ToString(), null, null, ct)
                .ConfigureAwait(false);

            if (!applied.Ok)
            {
                Log.Warn($"could not set the credential helper: {LastLine(applied.Text)}");
                return;
            }

            // Named, never the token. This line ends up in a log a person may
            // well paste somewhere.
            Log.Info($"carried git credentials for {string.Join(", ", credentials.Select(c => c.ToString()))}");
        }
        catch (Exception e) when (e is BackendException or IOException)
        {
            Log.Warn($"could not carry git credentials across: {e.Message}");
        }
    }

    /// <summary>
    /// Start every declared service, each in an instance of its own.
    /// </summary>
    /// <remarks>
    /// Not on a private network any more, and deliberately: a service has a real
    /// name in the zone and a real address, so the connection string envmux
    /// writes into the session is the same one you can paste into a database
    /// client on the workstation. That was never true when a service was an
    /// alias on a bridge nothing outside could see.
    /// </remarks>
    private async Task StartServicesAsync(IBackend backend, CancellationToken ct)
    {
        _environment ??= new Dictionary<string, string>(Plan.Env, StringComparer.Ordinal);

        foreach (var service in Plan.Services)
        {
            Phase = $"starting service '{service.Name}'";

            var existing = await backend.Instances.GetAsync(service.InstanceName, ct).ConfigureAwait(false);

            if (existing is null)
            {
                await backend.Instances.CreateAsync(
                    backend.ServiceSpec(service, Plan),
                    p => Phase = p,
                    ct).ConfigureAwait(false);
            }
            else if (!service.Persist)
            {
                Log.Debug($"service '{service.Name}' was left from an earlier run; reusing it");
            }

            if (existing is not { IsRunning: true })
            {
                await backend.Instances.StartAsync(service.InstanceName, ct).ConfigureAwait(false);
            }

            // The instance's own credentials win over the planned ones, because
            // a password is generated per session and the database it protects
            // is not. See ServicePlan.AsCreated.
            var actual = existing is null ? service : service.AsCreated(existing.Config);

            if (!ReferenceEquals(actual, service))
            {
                Log.Debug($"service '{service.Name}' kept the credentials it was created with");
            }

            _services.Add(actual);
            Correct(service, actual);

            Log.Info(actual.Kind.NeedsCredentials
                ? $"{actual.Name} → {actual.Type} on {actual.Host}:{actual.Port} as {actual.User}/{actual.Database}"
                : $"{actual.Name} → {actual.Type} on {actual.Host}:{actual.Port}");
        }

        if (Plan.Services.Count > 0)
        {
            Log.Info($"{Plan.Services.Count} service(s) up; credentials are in the environment");
        }
    }

    /// <summary>
    /// Put a service's real credentials into the session's environment.
    /// </summary>
    /// <remarks>
    /// Only where the environment still holds what the plan put there. A value a
    /// person wrote in the <c>env</c> block overrides a derived one on purpose,
    /// and correcting it here would undo that — quietly, which is the worst way
    /// to be wrong about a password.
    /// </remarks>
    private void Correct(ServicePlan planned, ServicePlan actual)
    {
        if (ReferenceEquals(planned, actual) || _environment is null)
        {
            return;
        }

        var was = planned.ReferenceEnvironment();

        foreach (var (key, value) in actual.ReferenceEnvironment())
        {
            if (_environment.TryGetValue(key, out var current) &&
                was.TryGetValue(key, out var stale) &&
                current.Equals(stale, StringComparison.Ordinal))
            {
                _environment[key] = value;
            }
        }
    }

    /// <summary>
    /// The session's environment as it will actually be written.
    /// </summary>
    /// <remarks>
    /// A copy of the plan's, because a reused service can correct part of it and
    /// the plan is what was intended rather than what is.
    /// </remarks>
    private Dictionary<string, string>? _environment;

    private async Task StartPortalAsync(CancellationToken ct)
    {
        if (!Plan.Portal.Enabled)
        {
            return;
        }

        Phase = "serving the portal";

        // The bridge only when something in the instance will call it: the
        // address it binds faces the host's switch, and an endpoint nobody
        // dials is an endpoint that should not exist.
        var bridge = Plan.Tasks.Any(Agents.RoomClient.Is) ? Backend.BridgeAddress : null;

        _portal = new PortalListener(this);
        await _portal.StartAsync(Plan.Port, bridge, ct).ConfigureAwait(false);

        if (_portal.Bridge is { } endpoint)
        {
            Log.Info($"api → {endpoint}, for the instance (separate guest bearer)");
        }

        AnnouncePortal();
    }

    /// <summary>
    /// Create every declared task and start the ones that autostart.
    /// </summary>
    /// <remarks>
    /// Failures are per task and never fatal. A task that will not start is one
    /// pane saying so, next to a session that is otherwise working — which is
    /// the point of them being separate things rather than one script that
    /// either works or does not.
    /// </remarks>
    private async Task StartTasksAsync(CancellationToken ct)
    {
        if (Plan.Tasks.Count == 0 || _backend is null)
        {
            return;
        }

        // Every task exists before any of them starts, so that one waiting on
        // another has something to wait on.
        foreach (var plan in Plan.Tasks)
        {
            Add(plan);
        }

        foreach (var task in _tasks)
        {
            var dependencies = task.Plan.DependsOn
                .Where(d => !d.IsService)
                .Select(d => _tasks.First(t => t.Plan.Name.Equals(d.Name, StringComparison.Ordinal)))
                .ToList();

            task.DependOn(dependencies, ProbeAsync);
        }

        foreach (var task in _tasks)
        {
            if (!task.Plan.Autostart)
            {
                Log.Info($"task '{task.Plan.Name}' declared but not started (autostart is off)");
                continue;
            }

            var waits = task.Plan.DependsOn.Count > 0
                ? $"  (after {string.Join(", ", task.Plan.DependsOn.Select(d => d.Name))})"
                : "";

            Log.Info($"task '{task.Plan.Name}': {task.Plan.Display}{waits}");

            // Not awaited: each task does its own waiting, so the tree resolves
            // concurrently. Awaiting here would serialise it into whatever order
            // the file happened to list them in.
            _ = task.StartWhenReadyAsync(ct);
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }

    /// <summary>
    /// Ask the instance whether an endpoint is accepting connections yet.
    /// </summary>
    /// <remarks>
    /// <para>
    /// From inside, because that is where the question means something: a task's
    /// own port is on the instance's loopback, which nothing outside reaches by
    /// design.
    /// </para>
    /// <para>
    /// Through bash's <c>/dev/tcp</c> rather than <c>nc</c> or <c>curl</c>. The
    /// image is not required to carry a networking tool — that would be the "add
    /// this to your image" this design refuses — and bash is already required,
    /// because every latched task is started through one.
    /// </para>
    /// </remarks>
    private async Task<bool> ProbeAsync(TaskDependency dependency, CancellationToken ct)
    {
        if (_backend is null)
        {
            return false;
        }

        var host = dependency.Host ?? "127.0.0.1";
        var port = dependency.Port.ToString(CultureInfo.InvariantCulture);
        var deadline = ((int)SessionTask.ReadyWait.TotalSeconds).ToString(CultureInfo.InvariantCulture);

        var script =
            $"""
             end=$(( $(date +%s) + {deadline} ))
             while [ "$(date +%s)" -lt "$end" ]; do
               if (exec 3<>/dev/tcp/{host}/{port}) 2>/dev/null; then exit 0; fi
               sleep 1
             done
             exit 1
             """;

        try
        {
            var result = await Command
                .CaptureAsync(_backend.Exec, Plan.InstanceName, ["bash", "-c", script], ContainerUser, ct: ct)
                .ConfigureAwait(false);

            return result.Ok;
        }
        catch (BackendException e)
        {
            Log.Warn($"could not probe {dependency}: {e.Message}");
            return true;
        }
    }

    /// <summary>One task by name, or null if there is no such task.</summary>
    public SessionTask? FindTask(string name) =>
        _tasks.FirstOrDefault(t => t.Plan.Name.Equals(name, StringComparison.Ordinal));

    /// <summary>Create a task against the current instance and list it.</summary>
    private SessionTask Add(TaskPlan plan)
    {
        var task = new SessionTask(plan, Log);
        task.Changed += Announce;
        task.Line += line => Announce(plan.Name, line);

        // The route line again, now with the URL the server actually wants
        // opened. Rewritten first: the log is read from this machine, and a
        // localhost link in it would be a link to the wrong machine.
        task.UrlPrinted += printed =>
        {
            if (Plan.Routes.FirstOrDefault(r => plan.Name.Equals(r.PinnedBy, StringComparison.Ordinal)) is { } route)
            {
                Log.Info($"{route.Name} → {route.Pin(printed).Url}");
            }
        };

        task.Bind(Backend.Exec, Plan.InstanceName, ContainerUser, Latch.Id(Plan.Project, Plan.Session, plan.Name));
        _tasks.Add(task);
        Announce();
        return task;
    }

    /// <summary>
    /// Reload the declaration and apply it to the instance that is already up.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This used to recreate the container, because a container's shape — its
    /// published ports, its mounts, its network — was fixed at creation and half
    /// the config described it. Almost none of the config describes the instance
    /// any more: it describes what runs inside it. So restarting is stopping the
    /// tasks and starting them again from the file as it is on disk right now,
    /// and the instance, its address, its installed dependencies and its
    /// uncommitted work all stay exactly where they are.
    /// </para>
    /// <para>
    /// Which means a running session can stop matching the config it was born
    /// from. That is the point — editing the declaration and pressing restart is
    /// how you iterate on it.
    /// </para>
    /// </remarks>
    public async Task RestartAsync(CancellationToken ct = default)
    {
        Log.Info("restarting from .envmux.json as it is now");

        try
        {
            var reloaded = SessionConfig.Load(Plan.Directory);
            Plan = SessionPlan.Resolve(reloaded, Plan.Directory, Plan.Session);
        }
        catch (ConfigException e)
        {
            Log.Error($"config is broken, keeping the one we started with: {e.Message}");
        }

        await ClearTasksAsync(stop: true).ConfigureAwait(false);

        // Services can have been added to the file since the session started.
        await StartServicesAsync(Backend, ct).ConfigureAwait(false);

        Announce();

        _ = StartTasksAsync(ct);
    }

    /// <summary>
    /// Detach from every task, and optionally stop what they left running.
    /// </summary>
    private async Task ClearTasksAsync(bool stop)
    {
        foreach (var task in _tasks)
        {
            // Named, because this is the step that can take a while, and
            // "stopping task 'docs'" is the difference between waiting and
            // wondering.
            Phase = stop ? $"stopping task '{task.Plan.Name}'" : $"leaving task '{task.Plan.Name}' running";

            if (stop)
            {
                await task.StopAsync().ConfigureAwait(false);
            }
            else
            {
                await task.DetachAsync().ConfigureAwait(false);
            }

            task.Dispose();
        }

        _tasks.Clear();
        Announce();
    }

    /// <summary>
    /// The link to the portal, token and all, or null when there is none.
    /// </summary>
    public string? PortalUrl =>
        Plan.Portal.Enabled && Port > 0 ? Plan.Portal.Url(Port) : null;

    /// <summary>
    /// Put the portal's link in the log, and open it if that was asked for.
    /// </summary>
    /// <remarks>
    /// The whole link including the token, because a token nobody can read is a
    /// portal nobody can open — and because the only readers are the window in
    /// front of the person who started the session and whatever they piped a
    /// headless run into.
    /// </remarks>
    private void AnnouncePortal()
    {
        if (PortalUrl is not { } url)
        {
            return;
        }

        Log.Info($"portal → {(MachineBridge.Active ? $"http://127.0.0.1:{Port}/" : url)}");

        if (!Plan.Portal.WantsToken)
        {
            Log.Warn("portal: no token — anything on this machine can open a shell in this instance");
        }

        if (!PortalAssets.Built && !MachineBridge.Active)
        {
            Log.Warn("portal: this build has no page in it — it was built without Node");
        }

        if (!Plan.Portal.OpenOnStart || MachineBridge.Active)
        {
            return;
        }

        if (Browser.TryOpen(url, out var why))
        {
            Log.Info("portal: opened a browser");
        }
        else
        {
            Log.Warn($"portal: could not open a browser ({why})");
        }
    }

    /// <summary>The SOCKS port this session claimed, or 0 when it has none.</summary>
    public int BrowserPort => _socks?.Port ?? 0;

    /// <summary>
    /// The proxy with its credentials, for anything that is not a browser this
    /// session opened, or null when there is none.
    /// </summary>
    public string? BrowserProxyUrl => _socks?.Url;

    /// <summary>
    /// Claim the SOCKS port.
    /// </summary>
    /// <remarks>
    /// Never fatal. A session without a browser port is a session with one
    /// fewer way in, and the routes still work.
    /// </remarks>
    private void StartBrowserProxy()
    {
        if (!Plan.Browser.Enabled)
        {
            return;
        }

        var listener = new Socks.SocksListener(Plan.Browser, _browsers, DialInstanceAsync, Log, ExpectedOn);

        try
        {
            listener.Start();
        }
        catch (Socks.SocksException e)
        {
            Log.Warn($"browser: {e.Message} — set browser.port in {SessionConfig.FileName}");
            return;
        }

        _socks = listener;

        Log.Info(Plan.Browser.Egress == Socks.Egress.Local
            ? $"browser → socks5 on {PortalPlan.Loopback}:{listener.Port}; localhost is the instance, the rest leaves from here"
            : $"browser → socks5 on {PortalPlan.Loopback}:{listener.Port}; everything leaves from the instance");

        // With its credentials, for the same reason the portal's link carries
        // its token: the window in front of the person who started the session
        // is the only place it is written down, and curl needs it.
        Log.Info(MachineBridge.Active ? "browser proxy → available to the supervising service" : $"browser proxy → {listener.Url}");
    }

    /// <summary>
    /// What the session expects on a loopback port in the instance, or null
    /// when it expects nothing there — for the SOCKS port's loading page.
    /// </summary>
    /// <remarks>
    /// A port is expected when a route declares it or a task's <c>ready</c>
    /// does. The sentence under the title is the most specific thing known: the
    /// session still starting, a task waiting on another, one that failed or was
    /// stopped — because "starting" on a page that will never finish is worse
    /// than the browser's own error.
    /// </remarks>
    internal Socks.ExpectedPort? ExpectedOn(int port)
    {
        var route = Plan.Routes.FirstOrDefault(r => r.Port == port);
        var task = _tasks.FirstOrDefault(t => t.Plan.ReadyPort == port)
                   ?? (route?.PinnedBy is { } by ? FindTask(by) : null);

        if (route is null && task is null)
        {
            return null;
        }

        return new Socks.ExpectedPort(route?.Name ?? task!.Plan.Name, port, Explain(task));

        string? Explain(SessionTask? task)
        {
            if (!IsReady)
            {
                return Phase.Length > 0 ? $"The session is still starting: {Phase}." : "The session is still starting.";
            }

            if (task is null)
            {
                return null;
            }

            var name = task.Plan.Name;

            return task.State switch
            {
                TaskState.Waiting when Pending(task) is { Length: > 0 } pending =>
                    $"Task '{name}' is waiting on {pending}.",
                TaskState.Failed or TaskState.Exited =>
                    $"Task '{name}' has stopped ({task.Status}). Its output says why; this page will not finish on its own.",
                TaskState.Stopped or TaskState.Idle =>
                    $"Task '{name}' is {task.Status}. Start it with x, or /task start {name}.",
                _ => $"Task '{name}' is {task.Status}.",
            };
        }

        string Pending(SessionTask task) => string.Join(", ", task.Plan.DependsOn
            .Where(d => !d.IsService && FindTask(d.Name) is not { IsSatisfied: true })
            .Select(d => d.Name));
    }

    /// <summary>A connection from inside the instance, for the SOCKS port.</summary>
    private Task<Stream?> DialInstanceAsync(IReadOnlyList<string> hosts, int port, CancellationToken ct) =>
        _backend is { } backend && Address.Length > 0
            ? backend.Exec.DialAsync(Plan.InstanceName, ContainerUser, hosts, port, ct)
            : Task.FromResult<Stream?>(null);

    /// <summary>
    /// The routes with what their tasks have printed, so a route that announced
    /// <c>/app/</c> opens there.
    /// </summary>
    private IReadOnlyList<RoutedEndpoint> PinnedRoutes =>
        [.. Plan.Routes.Select(r => r.PinnedBy is { } by && FindTask(by)?.PrintedUrl is { } printed ? r.Pin(printed) : r)];

    /// <summary>What a browser opened on this session starts at. See <see cref="Socks.BrowserLaunch.StartUrl"/>.</summary>
    public string BrowserStartUrl => Socks.BrowserLaunch.StartUrl(Plan.Browser.Open, PinnedRoutes);

    /// <summary>
    /// Where a task is looked at: the route it speaks for, or its ready port.
    /// </summary>
    /// <remarks>
    /// A route first, because a route carries the path its task printed and is
    /// the name the person gave it. A route counts as the task's when the task
    /// pinned it, or when they share a name — the usual <c>"web": 3000</c> beside
    /// a task called <c>web</c>.
    /// </remarks>
    /// <returns>A route name or a URL for <see cref="OpenBrowser"/>, or null when the task serves no port.</returns>
    public string? BrowserTargetFor(SessionTask task)
    {
        var name = task.Plan.Name;
        var route = Plan.Routes.FirstOrDefault(r => string.Equals(r.PinnedBy, name, StringComparison.Ordinal))
                    ?? Plan.Routes.FirstOrDefault(r => r.Name.Equals(name, StringComparison.Ordinal))
                    ?? (task.Plan.ReadyPort is { } ready ? Plan.Routes.FirstOrDefault(r => r.Port == ready) : null);

        return route?.Name
               ?? (task.Plan.ReadyPort is { } port
                   ? $"http://localhost:{port.ToString(CultureInfo.InvariantCulture)}/"
                   : null);
    }

    /// <summary>
    /// Open a browser whose <c>localhost</c> is this session's instance.
    /// </summary>
    /// <remarks>
    /// Chrome, Firefox or Edge, on a profile of its own for this session, with
    /// the session's SOCKS port as its proxy. It is let in without a password
    /// because it is known by its process; see <see cref="Socks.LaunchedBrowsers"/>.
    /// </remarks>
    /// <param name="use">A browser's name or path, overriding <c>browser.use</c>.</param>
    /// <param name="url">A route's name or a URL to open at, instead of <c>browser.open</c>.</param>
    /// <exception cref="Socks.BrowserException">No browser, or none that would start.</exception>
    public void OpenBrowser(string? use = null, string? url = null)
    {
        if (_socks is null)
        {
            throw new Socks.BrowserException(Plan.Browser.Enabled
                ? "this session has no browser port — see the log for why"
                : $"browser.enabled is false in {SessionConfig.FileName}");
        }

        var browser = Socks.BrowserLaunch.Choose(use ?? Plan.Browser.Use, Socks.BrowserLaunch.Discover());
        var target = string.IsNullOrWhiteSpace(url)
            ? BrowserStartUrl
            : Socks.BrowserLaunch.StartUrl(url, PinnedRoutes);
        var profile = Socks.BrowserLaunch.ProfileDirectory(Plan.InstanceName, browser.Kind);

        using var process = Socks.BrowserLaunch.Start(
            browser, _socks.Port, profile, target, $"envmux {Plan.InstanceName}", Plan.Browser.Colour);
        _browsers.Add(process);

        Log.Info($"opened {browser.Name} on {target} through the session's proxy");
    }

    /// <summary>
    /// Whether the instance is a real container on this machine's Docker, which an
    /// editor attaches to directly — no shim, no endpoint of envmux's own.
    /// </summary>
    private bool OnDocker => _backend?.Kind == BackendKind.Docker;

    /// <summary>
    /// The URI an editor opens this session at.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Two forms, chosen by <c>editor.attach</c>. The default is the Dev
    /// Containers attach, which reaches the instance through the
    /// Docker-compatible endpoint and names it as a running container (§8.3) — an
    /// <c>attached-container</c> URI, so the extension attaches to what is already
    /// there rather than building anything. The other is SSH: the editor connects
    /// to the instance's hostname the way it would to any other remote
    /// development machine, and nothing else has to be running.
    /// </para>
    /// <para>
    /// Both open <see cref="SessionPlan.EditorFolder"/>, which is the
    /// session-named link to the workdir rather than the workdir itself — so the
    /// window is called <c>myproj_feat-login</c> and not <c>work</c>, like every
    /// other session's. The bootstrap made the link; this is the only consumer.
    /// </para>
    /// </remarks>
    public string? EditorUri
    {
        get
        {
            if (Address.Length == 0)
            {
                return null;
            }

            var folder = Plan.EditorFolder;

            return Plan.Editor.IsDevContainer
                ? DockerUri.AttachedContainerUri(Plan.InstanceName, folder, OnDocker ? null : Docker.ShimEndpoint.DockerHost)
                : VsCodeUri.SshFolderUri(ContainerUser, Plan.Hostname, folder);
        }
    }

    /// <summary>
    /// Attach an editor to the running instance.
    /// </summary>
    /// <remarks>
    /// Not awaited beyond the spawn. The editor is somebody's afternoon; the
    /// session goes on around it.
    /// </remarks>
    /// <exception cref="EditorException">No editor was found, or it would not start.</exception>
    public async Task OpenInEditorAsync()
    {
        if (EditorUri is not { } uri)
        {
            Log.Warn("no instance to attach an editor to yet");
            return;
        }

        // The Dev Containers attach needs the endpoint up. Bring it up if it is
        // not, and take a lease held for the session's lifetime — so it stays up
        // for reloads and reattaches, and closes itself once this session (and
        // any others holding it) ends. Nothing else is needed: the URI carries
        // the endpoint's address, so VS Code reaches it with no settings to set.
        if (Plan.Editor.IsDevContainer && !OnDocker)
        {
            try
            {
                _dockerLease ??= await Docker.DockerEndpoint.EnsureAsync(line => Log.Info($"editor: {line}"))
                    .ConfigureAwait(false);
            }
            catch (Docker.ShimException e)
            {
                Log.Warn($"editor: {e.Message}");
            }
        }

        var editor = EditorDiscovery.Find(Plan.Editor.Path);

        if (editor.Hint is { } hint)
        {
            Log.Warn($"editor: {hint}");
        }

        EditorLaunch.Start(
            new LaunchPlan(editor.Path, uri, Plan.Editor.NewWindow ?? false, null),
            warning => Log.Warn($"editor: {warning}"));

        Log.Info(Plan.Editor.IsDevContainer
            ? $"opened {Path.GetFileName(editor.Path)} on {Plan.InstanceName} (dev container)"
            : $"opened {Path.GetFileName(editor.Path)} on {Plan.Hostname}");

        // The link itself, because it is the thing worth keeping: it works from
        // anywhere the editor can be told to open a URI, and from any machine
        // that resolves the zone.
        Log.Info(uri);
    }

    /// <summary>
    /// Take everything down, and report what the session produced.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Once, however many times it is asked. Three separate things want to be
    /// sure this happened — the normal exit, the <c>await using</c> around the
    /// session, and the process-exit handler that exists for the ways a process
    /// ends without either.
    /// </para>
    /// <para>
    /// Every step announces itself through <see cref="Phase"/>, the same channel
    /// startup uses, because the window is already gone by the time it runs and
    /// a terminal that says nothing for several seconds reads as a program that
    /// failed to quit rather than one that is putting things away.
    /// </para>
    /// </remarks>
    public async Task<WorkspaceStatus?> StopAsync()
    {
        if (_stopped)
        {
            return _report;
        }

        _stopped = true;

        // Release the endpoint lease first: a session ending is one fewer reason
        // for the Docker endpoint to stay up, and the sooner it knows the sooner
        // it can tidy itself away if this was the last one.
        if (_dockerLease is not null)
        {
            await _dockerLease.DisposeAsync().ConfigureAwait(false);
            _dockerLease = null;
        }

        if (_socks is not null)
        {
            await _socks.DisposeAsync().ConfigureAwait(false);
            _socks = null;
        }

        if (_portal is not null)
        {
            Phase = "releasing the port";
            await _portal.DisposeAsync().ConfigureAwait(false);
            _portal = null;
        }

        if (_backend is { } backend && Address.Length > 0)
        {
            // The commits, before anything is stopped. This is the one step
            // that must not be skipped, so it comes first and everything after
            // it is disposable.
            try
            {
                _report = await Workspace
                    .HarvestAsync(backend, _git, Plan, _base, Log, p => Phase = p)
                    .ConfigureAwait(false);
            }
            catch (Exception e) when (e is BackendException or GitException or IOException)
            {
                Log.Error($"could not bring the session's commits back: {e.Message}");
            }

            // Tasks are left latched when the instance is being kept: a build
            // that is still running is a build that goes on running, and the
            // next session by this name attaches to it.
            await ClearTasksAsync(stop: !Plan.KeepOnExit).ConfigureAwait(false);

            await StopInstancesAsync(backend).ConfigureAwait(false);
        }
        else
        {
            await ClearTasksAsync(stop: false).ConfigureAwait(false);
        }

        if (_backend is not null)
        {
            await _backend.DisposeAsync().ConfigureAwait(false);
            _backend = null;
        }

        Phase = "";
        return _report;
    }

    /// <summary>
    /// Stop the instances, and remove them only if that is safe.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Kept by default, and always kept when there is uncommitted work in it.
    /// Commits come back through a bundle; anything not committed exists only
    /// here, and deleting somebody's uncommitted work because a default said so
    /// is unforgivable.
    /// </para>
    /// <para>
    /// A kept instance is stopped rather than running, which on a
    /// copy-on-write pool costs almost nothing, and <c>envmux prune</c> is how
    /// it goes.
    /// </para>
    /// </remarks>
    private async Task StopInstancesAsync(IBackend backend)
    {
        // Null means the instance could not be read — it had already gone, or
        // the connection had. Treated as dirty, because "we do not know" and
        // "there is nothing in there" are not the same answer and only one of
        // them is safe to act on.
        var dirty = _report is not { IsClean: true };

        // The one decision, made once and reused for the services and the
        // instance both. An instance is removed only when it was asked to go and
        // there is nothing in it that exists nowhere else — keepOnExit off, the
        // repository readable, and clean. Anything less keeps it.
        //
        // Services follow that decision rather than their own. Keeping the
        // session for its uncommitted work and deleting its database in the same
        // breath is a resume that finds an empty database and has to migrate
        // again — which is the state `envmux prune` was taught to avoid, and
        // this is the same trap in teardown.
        var removeInstance = !Plan.KeepOnExit && _report is { IsClean: true };

        foreach (var service in _services)
        {
            // Said as what it is. The instance below announces stopping and
            // removing separately; a service that was about to be deleted said
            // only "stopping", which reads as kept.
            var removing = !service.Persist && removeInstance;

            Phase = removing
                ? $"removing service '{service.Name}'"
                : $"stopping service '{service.Name}'";

            try
            {
                await backend.Instances.StopAsync(service.InstanceName, 10).ConfigureAwait(false);

                if (removing)
                {
                    await backend.Instances.DeleteAsync(service.InstanceName).ConfigureAwait(false);
                    Log.Debug($"service '{service.Name}' removed with the session");
                }
                else if (service.Persist)
                {
                    Log.Info($"service '{service.Name}' kept; its data is in {service.InstanceName}");
                }
            }
            catch (BackendException e)
            {
                Log.Warn($"service '{service.Name}': {e.Message}");
            }
        }

        _services.Clear();

        Phase = "stopping the instance";

        try
        {
            await backend.Instances.StopAsync(Plan.InstanceName, 15).ConfigureAwait(false);

            if (removeInstance)
            {
                Phase = "removing the instance";
                await backend.Instances.DeleteAsync(Plan.InstanceName).ConfigureAwait(false);
                Log.Info($"{Plan.InstanceName} removed");

                // Its browser profiles go with it: they hold logins for a
                // localhost that no longer exists. Kept with a kept instance,
                // so a restarted session is still signed in.
                Socks.BrowserLaunch.ForgetProfiles(Plan.InstanceName, Log.Debug);
            }
            else if (Plan.KeepOnExit)
            {
                Log.Info($"{Plan.InstanceName} kept — start this session again to pick it up where it is");
            }
            else if (_report is { IsClean: false } report)
            {
                Log.Warn(
                    $"{Plan.InstanceName} kept despite keepOnExit: it has " +
                    $"{report.DirtyFiles.ToString(CultureInfo.InvariantCulture)} uncommitted change(s), " +
                    "and they exist nowhere else");
            }
            else if (dirty)
            {
                Log.Warn(
                    $"{Plan.InstanceName} kept despite keepOnExit: its repository could not be read, " +
                    "so there is no way to know whether anything in it is uncommitted");
            }
        }
        catch (BackendException e)
        {
            Log.Warn($"{Plan.InstanceName}: {e.Message}");
        }
    }

    /// <summary>
    /// Hand this terminal to a shell in the instance until it exits.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Latched under a name of its own, so a shell you were in the middle of
    /// something in is still there next time — including after quitting envmux
    /// entirely, which is new and is the point of the latch.
    /// </para>
    /// <para>
    /// The pumping is done here rather than by handing off to a client, because
    /// there is no client to hand off to: <c>docker exec -it</c> used to own the
    /// console for the duration and there is no equivalent. So the console goes
    /// into raw mode, both directions are pumped, and the local window size is
    /// forwarded down the control socket whenever it changes.
    /// </para>
    /// </remarks>
    public async Task<int> AttachShellAsync(CancellationToken ct = default)
    {
        if (_backend is null || Address.Length == 0)
        {
            return 1;
        }

        var latch = Latch.Id(Plan.Project, Plan.Session, "shell");

        await using var exec = await _backend.Exec.InteractiveAsync(
            Plan.InstanceName,
            new ExecRequest
            {
                Command = Command.AsUser(ContainerUser, Latch.Shell(latch, Plan.Shell)),
                Cwd = Plan.Workdir,
                Environment = Command.EnvironmentFor(ContainerUser, Command.Defaults),
                Width = Math.Max(20, Console.WindowWidth),
                Height = Math.Max(5, Console.WindowHeight),
            },
            ct).ConfigureAwait(false);

        using var finished = CancellationTokenSource.CreateLinkedTokenSource(ct);

        // Before a single byte moves. With the console still interpreting its
        // input, Ctrl-C is a console control event rather than a keystroke, .NET
        // turns that into CancelKeyPress, and envmux quits the session instead
        // of interrupting whatever was actually meant to be interrupted.
        using var raw = Envmux.Ui.RawMode.Enter();

        var input = Console.OpenStandardInput();
        var output = Console.OpenStandardOutput();

        // Whatever the far end draws, straight out. Nothing interprets it: the
        // pty on the other side is a real terminal and this one is a real
        // terminal, and putting an emulator between them would only be a way to
        // get something wrong.
        var draining = Task.Run(async () =>
        {
            var buffer = new byte[16 * 1024];

            try
            {
                int read;
                while ((read = await exec.Terminal.ReadAsync(buffer, finished.Token).ConfigureAwait(false)) > 0)
                {
                    await output.WriteAsync(buffer.AsMemory(0, read), finished.Token).ConfigureAwait(false);
                    await output.FlushAsync(finished.Token).ConfigureAwait(false);
                }
            }
            catch (Exception e) when (e is OperationCanceledException or IOException
                                          or System.Net.WebSockets.WebSocketException)
            {
                // The shell ended, or we are being taken down.
            }
            finally
            {
                await finished.CancelAsync().ConfigureAwait(false);
            }
        }, CancellationToken.None);

        var typing = Task.Run(async () =>
        {
            var buffer = new byte[4096];
            var columns = Console.WindowWidth;
            var rows = Console.WindowHeight;

            try
            {
                while (!finished.IsCancellationRequested)
                {
                    // The size is checked here rather than on a timer because
                    // this is the only loop that is guaranteed to be running,
                    // and a resize nobody typed after is a resize nobody has
                    // noticed yet either.
                    if (Console.WindowWidth != columns || Console.WindowHeight != rows)
                    {
                        columns = Console.WindowWidth;
                        rows = Console.WindowHeight;
                        await exec.ResizeAsync(columns, rows, finished.Token).ConfigureAwait(false);
                    }

                    var read = await input.ReadAsync(buffer, finished.Token).ConfigureAwait(false);
                    if (read <= 0)
                    {
                        break;
                    }

                    await exec.Terminal.WriteAsync(buffer.AsMemory(0, read), finished.Token).ConfigureAwait(false);
                    await exec.Terminal.FlushAsync(finished.Token).ConfigureAwait(false);
                }
            }
            catch (Exception e) when (e is OperationCanceledException or IOException
                                          or System.Net.WebSockets.WebSocketException)
            {
                // Same.
            }
        }, CancellationToken.None);

        await draining.ConfigureAwait(false);
        await finished.CancelAsync().ConfigureAwait(false);

        // Not awaited: a blocking read on the real stdin does not come back
        // until somebody presses a key, and the shell has already gone.
        _ = typing;

        return await exec.ExitCodeAsync(CancellationToken.None).ConfigureAwait(false) ?? 0;
    }

    private static string LastLine(string output) =>
        output.Split('\n', StringSplitOptions.RemoveEmptyEntries).LastOrDefault()?.Trim() ?? "no output";

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        await StopAsync().ConfigureAwait(false);
    }
}
