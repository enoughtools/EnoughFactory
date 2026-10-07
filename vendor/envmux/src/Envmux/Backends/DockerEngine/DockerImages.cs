using Envmux.Incus;

namespace Envmux.Backends.DockerEngine;

/// <summary>
/// The images sessions are made from, on a Docker engine: the engine is the store.
/// </summary>
/// <remarks>
/// <para>
/// On Incus the golden image is an instance provisioned over exec and
/// snapshotted (<see cref="Golden"/>), and a session is a copy of the snapshot.
/// A Docker engine has no snapshot to copy, and needs none: what it builds it
/// has, and a container is made from it a moment later.
/// </para>
/// <para>
/// <b>The golden image is built locally, by default.</b> From
/// <c>images/golden</c> as this binary carries it (<see cref="GoldenContext"/>),
/// through the engine's own build endpoint, tagged
/// <c>envmux-golden:&lt;build&gt;</c>. The alternative — pulling one somebody
/// published — is one more thing to trust and one more thing to keep published,
/// for the sake of a few minutes once per machine; the only thing a local build
/// takes on faith is the base image, which the Dockerfile pins by digest. The
/// alternative is still there for whoever wants it: name a reference as
/// <c>goldenTag</c> in the backend's <c>docker</c> block and that image is used
/// as it is, pulled when the engine has not got it, and never built.
/// </para>
/// <para>
/// <b>A project's image is a commit.</b> A container from the golden image,
/// every feature installed over exec by the loop Incus uses, stopped, committed
/// as <c>envmux-image-&lt;project&gt;-&lt;fingerprint&gt;:base</c> — the name
/// <see cref="ProjectImage.Source"/> gives it with the slash made a colon, so
/// what a session's creation body names and what the engine holds are the same
/// words — and the container removed. The engine's build cache plays no part: a
/// feature is a script from a registry, not a Dockerfile instruction.
/// </para>
/// <para>
/// Plain methods; the seam's <c>IImages</c> adapter will wrap them. The install
/// loop is a copy of <c>ProjectImage.InstallAllAsync</c>'s private one, because
/// that one is written against <see cref="IncusApi"/>; when the seam gives it an
/// exec to run through instead, this copy goes and both backends share it.
/// </para>
/// </remarks>
/// <param name="engine">The engine.</param>
/// <param name="config">The backend's <c>docker</c> block, for <c>goldenTag</c>.</param>
/// <param name="exec">
/// How to run things in a container, which only <see cref="BuildProjectAsync"/>
/// needs. Without one <see cref="CanBuildProject"/> is false and the golden half
/// still works — which is all an install and a prune want.
/// </param>
internal sealed class DockerImages(IDockerEngine engine, DockerBackendConfig config, EngineExec? exec = null)
{
    /// <summary>The labels an image envmux made carries. Images have no names to go by that prune could trust.</summary>
    internal static class Labels
    {
        /// <summary>Marks it as ours, and says which schema made it: <see cref="InstanceSpec.Keys.SchemaVersion"/>.</summary>
        public const string Schema = DockerSpec.Labels.Schema;

        /// <summary><see cref="KindGolden"/> or <see cref="KindImage"/>. What to select by.</summary>
        public const string Kind = DockerSpec.Labels.Kind;

        public const string KindGolden = "golden";

        public const string KindImage = "image";

        /// <summary>
        /// Which golden build: on the golden image, its own; on a project's
        /// image, the one it was made on. On both — so never select golden by
        /// this being present; that is what <see cref="Kind"/> is for.
        /// </summary>
        public const string Golden = "envmux.golden";

        /// <summary>The exact manager-prepared base; feature caches cannot substitute another recipe.</summary>
        public const string GoldenImage = "envmux.golden.image";
    }

    /// <summary>What every name this makes starts with.</summary>
    internal const string DefaultPrefix = "envmux-";

    /// <summary>
    /// What every name this makes starts with, for a test on an engine that is
    /// somebody's: <c>swarmtest-</c> gives <c>swarmtest-golden:…</c>.
    /// </summary>
    internal string Prefix { get; init; } = DefaultPrefix;

    /// <summary>Labels added to everything this makes, for the same test.</summary>
    internal IReadOnlyDictionary<string, string> ExtraLabels { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>How to reach the feature registry, for a test that must not. Null is the network.</summary>
    internal HttpMessageHandler? Registry { get; init; }

    internal Func<DateTimeOffset> Now { get; init; } = () => DateTimeOffset.UtcNow;

    /// <summary>The golden build this binary would make.</summary>
    public static string GoldenBuild => GoldenContext.Build;

    /// <summary>
    /// The golden image's reference on the engine — what a session's container is created from.
    /// </summary>
    /// <remarks>
    /// The manager's immutable image wins for its one launch. Otherwise the
    /// one place <c>goldenTag</c> is read. Null, which is the default, is
    /// the locally built image under this binary's build; anything else is a
    /// reference somebody chose, used exactly as written.
    /// </remarks>
    public static string GoldenReference(DockerBackendConfig config) => GoldenReference(config, DefaultPrefix);

    /// <summary>A project's image on the engine: <see cref="ProjectImage.Source"/>, as an image reference.</summary>
    public static string ProjectReference(string project, string fingerprint) =>
        ProjectReference(project, fingerprint, DefaultPrefix);

    /// <summary>This instance's golden reference, which differs from the static one only under a test's prefix.</summary>
    internal string GoldenImage => GoldenReference(config, Prefix);

    /// <summary>Whether the golden image is one somebody published and named, rather than one built here.</summary>
    private bool GoldenIsPublished => !string.IsNullOrWhiteSpace(config.GoldenTag);

    public bool CanBuildProject => exec is not null;

    public async Task<bool> HasGoldenAsync(CancellationToken ct = default)
    {
        var image = await engine.ImageAsync(GoldenImage, ct).ConfigureAwait(false);
        if (image is not null && config.ManagedGoldenImage is { } managed &&
            !string.Equals(image.Id, managed, StringComparison.Ordinal))
        {
            throw new BackendException($"the managed engine returned another image for {managed}; prepare the exact immutable image before starting");
        }

        return image is not null;
    }

    /// <summary>
    /// Build the golden image on the engine — or pull it, when the record names a published one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// "From scratch" is as true as the engine's layer cache lets it be. The
    /// build context is the same bytes every time, so a second build on the
    /// same engine is a run of cache hits and takes seconds, which is the point
    /// of having layers; it also means asking again does not fetch a newer
    /// agent or newer packages. What does is a change to the Dockerfile — a new
    /// build, a new tag — or removing the image and the engine's build cache by
    /// hand. The engine's build endpoint has a <c>nocache</c> switch that
    /// <see cref="IDockerEngine.BuildAsync"/> does not carry yet.
    /// </para>
    /// <para>
    /// An image under an earlier build's tag is left where it is: a session may
    /// be running on it. It carries <see cref="Labels.Golden"/>, which no longer
    /// matches <see cref="GoldenBuild"/>, and that is what prune goes by.
    /// </para>
    /// </remarks>
    public async Task BuildGoldenAsync(Action<string> report, CancellationToken ct = default)
    {
        var reference = GoldenImage;

        if (config.ManagedGoldenImage is not null)
        {
            throw new BackendException($"the prepared managed golden image {reference} is unavailable; prepare it on the owned engine before starting");
        }

        if (GoldenIsPublished)
        {
            report($"pulling {reference}, the golden image this backend's record names — it is used as published, not built");
            await engine.PullAsync(reference, report, ct).ConfigureAwait(false);
        }
        else
        {
            // Said once, before the silence. The first build on an engine pulls
            // a base image, runs apt and downloads the agent; nothing about the
            // builder's own lines says which kind of build this is going to be.
            report(
                $"building {reference} on {engine.Endpoint} — the first build on an engine downloads a base image, " +
                "installs packages and fetches the agent, which is minutes; after that its layers are cached and " +
                "it is seconds");

            using var context = new MemoryStream(GoldenContext.Tar(GoldenContext.Files), writable: false);

            await engine.BuildAsync(context, reference, GoldenLabels(), Narrate(report), ct).ConfigureAwait(false);
        }

        // Asked rather than assumed: a builder that ended without an error and
        // without an image is a session that fails later with "no such image",
        // about a build that said it worked.
        if (await engine.ImageAsync(reference, ct).ConfigureAwait(false) is null)
        {
            throw new BackendException(
                GoldenIsPublished
                    ? $"{reference} was pulled and the engine at {engine.Endpoint} still does not have it"
                    : $"the build of {reference} finished and the engine at {engine.Endpoint} does not have it — " +
                      "the builder's last lines above are the only account of why");
        }

        report($"golden ready — a session is now a container from {reference}");
    }

    /// <summary>
    /// Whether this project's image is built — and built on the golden image sessions now use.
    /// </summary>
    /// <remarks>
    /// The second half is what Incus does not need. There a golden rebuild is
    /// something a person runs; here it follows from a new envmux whose
    /// Dockerfile moved, and a project image made on the build before would go
    /// on being copied without whatever the move was for — the init that starts
    /// sshd, a tool the relay needs. So an image that says it was made on
    /// another build is not this project's image any more, the session builds
    /// one, and the tag moves to it. An image that does not say, or a golden
    /// image that was published rather than built, is taken as it is.
    /// </remarks>
    public async Task<bool> HasProjectAsync(string project, string fingerprint, CancellationToken ct = default)
    {
        var image = await engine.ImageAsync(ProjectReference(project, fingerprint, Prefix), ct).ConfigureAwait(false);

        if (image is null)
        {
            return false;
        }

        if (config.ManagedGoldenImage is { } managed)
        {
            return image.Labels.TryGetValue(Labels.GoldenImage, out var baseId) &&
                   string.Equals(baseId, managed, StringComparison.Ordinal);
        }

        return GoldenIsPublished ||
               !image.Labels.TryGetValue(Labels.Golden, out var madeOn) ||
               string.Equals(madeOn, GoldenBuild, StringComparison.Ordinal);
    }

    /// <summary>
    /// Build a project's image: a container from golden, every feature, committed.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <paramref name="baseImage"/> is only hashed, never pulled. Above the seam
    /// it is an Incus image alias — <c>debian/13</c> — which means nothing to a
    /// Docker engine, and the fallback it exists for does not arise: a backend
    /// that can build the golden image builds it when it is missing, rather than
    /// installing a toolchain onto something that has no tmux in it.
    /// </para>
    /// <para>
    /// The build container runs the image's own command and is given nothing of
    /// its own — no command, no environment — because a commit keeps the
    /// container's configuration as the image's: a container started with
    /// <c>sleep</c> commits to an image whose sessions run <c>sleep</c> and have
    /// no sshd. The labels are kept the same way, which is how the image gets
    /// them: <see cref="IDockerEngine.CommitAsync"/> takes none.
    /// </para>
    /// <para>
    /// Destructive about its own leftovers, for the reasons
    /// <see cref="ProjectImage.BuildAsync"/> gives: a container under this name
    /// is a build that was interrupted, and one that threw is removed before the
    /// failure is reported, because the next attempt will probably have a
    /// different fingerprint and never find it.
    /// </para>
    /// </remarks>
    public async Task BuildProjectAsync(
        string project,
        string directory,
        string baseImage,
        IReadOnlyList<Feature> features,
        string user,
        Action<string> report,
        CancellationToken ct = default)
    {
        if (exec is null)
        {
            throw new BackendException(
                "this DockerImages was made without an exec, so it cannot install features; " +
                "the backend constructs it with one");
        }

        var fingerprint = Features.Fingerprint(baseImage, features);
        var repository = $"{Prefix}image-{project}-{fingerprint}";
        var container = $"{Prefix}build-{project}-{fingerprint}";

        if (await engine.InspectAsync(container, ct).ConfigureAwait(false) is not null)
        {
            report("removing a half-built image from an earlier attempt");
            await engine.RemoveAsync(container, force: true, volumes: true, ct).ConfigureAwait(false);
        }

        var golden = await engine.ImageAsync(GoldenImage, ct).ConfigureAwait(false);

        if (golden is null)
        {
            report($"there is no golden image on this engine yet, and {project}'s image is made from it — building that first");
            await BuildGoldenAsync(report, ct).ConfigureAwait(false);

            golden = await engine.ImageAsync(GoldenImage, ct).ConfigureAwait(false)
                     ?? throw new BackendException($"{GoldenImage} was built and the engine does not have it");
        }

        if (config.ManagedGoldenImage is { } managed && !string.Equals(golden.Id, managed, StringComparison.Ordinal))
        {
            throw new BackendException($"the managed engine returned another image for {managed}; prepare the exact immutable image before starting");
        }

        if (features.Any(f => f.Name.Contains("docker", StringComparison.OrdinalIgnoreCase)))
        {
            // Installed as asked, and said plainly: the feature unpacks a client
            // and a daemon, and a session here is not allowed the privileges a
            // daemon needs. Better heard now than as "Cannot connect to the
            // Docker daemon" from a task.
            report("a docker feature is declared: it will be installed, but a session on the docker backend " +
                   "cannot run a Docker daemon of its own, so nothing will answer it");
        }

        report($"building {project}'s image from {GoldenImage}");

        await engine.CreateContainerAsync(
            container,
            new ContainerCreate
            {
                Image = GoldenImage,
                Labels = ProjectLabels(project, fingerprint, directory, golden),
            },
            ct).ConfigureAwait(false);

        string image;

        try
        {
            await engine.StartAsync(container, ct).ConfigureAwait(false);

            await InstallAllAsync(exec, container, features, user, report, ct).ConfigureAwait(false);

            await ForgetHostIdentityAsync(exec, container, ct).ConfigureAwait(false);

            // Stopped rather than paused: a feature may have left something
            // running, and a commit of a filesystem something is still writing
            // is a copy of it mid-write.
            report("stopping it so the image is clean");
            await engine.StopAsync(container, 10, ct).ConfigureAwait(false);

            report($"committing as {repository}:{ProjectImage.SnapshotName}");
            image = await engine.CommitAsync(container, repository, ProjectImage.SnapshotName, ct)
                .ConfigureAwait(false);
        }
        catch
        {
            report("removing what was half-built");

            try
            {
                await engine.RemoveAsync(container, force: true, volumes: true, CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch (BackendException)
            {
                // The original failure is the one worth reporting.
            }

            throw;
        }

        // The image holds everything the container did. What is left is a
        // stopped container with a name the next build of this toolchain wants.
        await engine.RemoveAsync(container, force: true, volumes: true, ct).ConfigureAwait(false);

        report($"{project}'s image is ready ({Short(image)}) — every session is now a container from it");
    }

    /// <summary>Install every feature, in the order they were declared.</summary>
    /// <remarks>
    /// The same requests <c>ProjectImage.InstallAllAsync</c> makes on Incus — the
    /// manifest for the option defaults, the install script as root through
    /// <c>sh -c</c> with <see cref="Command.Defaults"/> — so a feature that
    /// installs on the one backend installs on the other.
    /// </remarks>
    private async Task InstallAllAsync(
        EngineExec runner,
        string container,
        IReadOnlyList<Feature> features,
        string user,
        Action<string> report,
        CancellationToken ct)
    {
        var at = 0;

        // One client for all of them: the registry is the same host and the
        // manifests are small. A test hands in a handler that answers nothing.
        using var registry = Registry is null
            ? new HttpClient { Timeout = TimeSpan.FromSeconds(30) }
            : new HttpClient(Registry, disposeHandler: false) { Timeout = TimeSpan.FromSeconds(30) };

        foreach (var feature in features)
        {
            at++;

            report($"installing {feature.Name} ({Text(at)} of {Text(features.Count)})");

            // What the feature declares about itself, which is where its option
            // defaults live. Without them a feature receives empty strings for
            // everything the config did not mention, and fails somewhere that
            // does not name the option.
            var metadata = await FeatureManifest.ReadAsync(feature, registry, ct).ConfigureAwait(false);

            if (metadata is null)
            {
                report($"could not read what {feature.Name} declares; installing it with only the options given here");
            }

            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(Features.Deadline);

            var installed = await runner.CapturedAsync(
                    container,
                    ["sh", "-c", Features.InstallScript(feature, user, metadata)],
                    cwd: null,
                    Command.Defaults,
                    deadline.Token)
                .ConfigureAwait(false);

            if (!installed.Ok)
            {
                // Named, and with what it said. A feature that fails here fails
                // for everyone using this project, so the message has to be
                // enough to fix it without running anything by hand.
                throw new BackendException(
                    $"the feature {feature.Reference} would not install: {LastLines(installed.Text)}");
            }
        }
    }

    /// <summary>
    /// Take the build container's ssh host keys out before it becomes an image.
    /// </summary>
    /// <remarks>
    /// The golden image's init made them when the build container started, as
    /// it does for any container, and a commit would carry them into every
    /// session of this project: one host identity, and its private half, shared
    /// by machines that are supposed to be strangers. A failure here fails the
    /// build, because the alternative is an image that looks fine.
    /// </remarks>
    private static async Task ForgetHostIdentityAsync(EngineExec runner, string container, CancellationToken ct)
    {
        var removed = await runner.CapturedAsync(
                container,
                ["sh", "-c", $"rm -rf {HostIdentityDirectory}"],
                cwd: null,
                Command.Defaults,
                ct)
            .ConfigureAwait(false);

        if (!removed.Ok)
        {
            throw new BackendException(
                $"could not remove the build container's ssh host keys ({HostIdentityDirectory}) before committing it, " +
                $"and an image with keys in it is one every session would share: {removed.Text}");
        }
    }

    /// <summary>Where <c>images/golden/envmux-init</c> keeps what is this container's and nobody else's.</summary>
    internal const string HostIdentityDirectory = "/home/.envmux";

    private Dictionary<string, string> GoldenLabels()
    {
        var labels = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [Labels.Schema] = InstanceSpec.Keys.SchemaVersion,
            [Labels.Kind] = Labels.KindGolden,
            [Labels.Golden] = GoldenBuild,
        };

        foreach (var (key, value) in ExtraLabels)
        {
            labels[key] = value;
        }

        return labels;
    }

    /// <summary>
    /// What a project's image says about itself: what Incus writes on the
    /// image's instance, under Docker's spelling of the same keys.
    /// </summary>
    private Dictionary<string, string> ProjectLabels(
        string project,
        string fingerprint,
        string directory,
        ImageInspect golden)
    {
        var labels = new Dictionary<string, string>(StringComparer.Ordinal);

        // InstanceSpec's keys are Incus' — `user.envmux.project` — and a Docker
        // label has no `user.` namespace to live in. The same strings with that
        // taken off are what the container labels already use (DockerSpec.Labels).
        foreach (var (key, value) in InstanceSpec.ForImage(project, fingerprint, directory, Now(), nesting: false))
        {
            labels[DockerSpec.LabelOf(key)] = value;
        }

        labels[Labels.Kind] = Labels.KindImage;

        if (config.ManagedGoldenImage is not null)
        {
            labels[Labels.GoldenImage] = golden.Id;
        }

        // The golden image's own account of which build it is, so a published
        // one that says is believed and one that does not is not guessed at.
        if (golden.Labels.TryGetValue(Labels.Golden, out var build))
        {
            labels[Labels.Golden] = build;
        }

        foreach (var (key, value) in ExtraLabels)
        {
            labels[key] = value;
        }

        return labels;
    }

    /// <summary>
    /// The builder's lines, passed on as they come.
    /// </summary>
    /// <remarks>
    /// All of them. Most are apt talking to itself, and the one that matters —
    /// the step that failed, and what it printed — is only findable among the
    /// rest. Blank ones are dropped because a phase line that is empty reads as
    /// a hang.
    /// </remarks>
    private static Action<string> Narrate(Action<string> report) =>
        line =>
        {
            var text = line.TrimEnd();

            if (text.Length > 0)
            {
                report(text);
            }
        };

    private static string GoldenReference(DockerBackendConfig config, string prefix) =>
        config.ManagedGoldenImage ?? (string.IsNullOrWhiteSpace(config.GoldenTag)
            ? $"{prefix}golden:{GoldenBuild}"
            : config.GoldenTag.Trim());

    private static string ProjectReference(string project, string fingerprint, string prefix)
    {
        // ProjectImage.InstanceName starts with the default prefix; under a
        // test's prefix the rest of the name is still Incus' own.
        var name = ProjectImage.InstanceName(project, fingerprint);

        return $"{prefix}{name[DefaultPrefix.Length..]}:{ProjectImage.SnapshotName}";
    }

    private static string Short(string id)
    {
        var hex = id.StartsWith("sha256:", StringComparison.Ordinal) ? id["sha256:".Length..] : id;
        return hex.Length > 12 ? hex[..12] : hex;
    }

    /// <summary>The end of some output, which is where a failure says why.</summary>
    private static string LastLines(string text, int lines = 4) =>
        string.Join(" | ", text
            .ReplaceLineEndings("\n")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .TakeLast(lines));

    private static string Text(int n) => n.ToString(System.Globalization.CultureInfo.InvariantCulture);
}
