namespace Envmux.Backends.DockerEngine;

/// <summary>What kind of thing a line of the sweep is about.</summary>
internal enum SweepKind
{
    Container,
    Volume,
    Image,
}

/// <summary>One thing the sweep looked at, and what it decided.</summary>
/// <param name="Kind">What it is.</param>
/// <param name="Name">What the engine calls it — what is removed.</param>
/// <param name="Remove">Whether it goes. False is a thing kept, and <paramref name="Note"/> says why.</param>
/// <param name="Note">Why it is kept, or what it was: <c>[feat-login]</c>, <c>[toolchain]</c>.</param>
internal sealed record SweepItem(SweepKind Kind, string Name, bool Remove, string Note);

/// <summary>Everything on the engine the sweep decides from, read once.</summary>
/// <param name="Containers">Every container, running or not.</param>
/// <param name="Mounted">The names of the volumes some container mounts.</param>
/// <param name="Volumes">Every volume.</param>
/// <param name="Images">Every image, when images were asked about; otherwise none.</param>
internal sealed record EngineContents(
    IReadOnlyList<ContainerSummary> Containers,
    IReadOnlySet<string> Mounted,
    IReadOnlyList<VolumeSummary> Volumes,
    IReadOnlyList<ImageInspect> Images);

/// <summary>What the person asked of <c>envmux prune</c>.</summary>
/// <param name="Here">The repository it was run in, physical.</param>
/// <param name="Force">Also what may hold uncommitted work.</param>
/// <param name="All">Also what is running, or does not say whose it is.</param>
/// <param name="Images">Also images: golden builds that are not the current one, and this project's.</param>
/// <param name="GoldenBuild">The golden build this envmux would make — the one that is never superseded.</param>
internal sealed record SweepOptions(
    string Here,
    bool Force,
    bool All,
    bool Images,
    string GoldenBuild);

/// <summary>
/// What <c>envmux prune</c> does on a Docker engine after the sessions
/// themselves have been dealt with: the things a session leaves that are not
/// instances.
/// </summary>
/// <remarks>
/// <para>
/// A session on Docker is a container and the named volumes its <c>/home</c>
/// and workdir live on. The containers are instances and <c>prune</c> handles
/// them as it always has — running ones kept, uncommitted work asked about, the
/// branch named. This is the rest: a volume whose container is gone, a build
/// that was interrupted, and — when asked — images.
/// </para>
/// <para>
/// <b>By label, and only by label.</b> The engine is the person's own. It has
/// their other projects' containers on it, their databases' volumes, their
/// networks. Nothing is considered here unless it carries
/// <c>envmux.schema</c>, which only envmux writes; a name that merely looks
/// like one of ours is not evidence of anything. There is no <c>docker system
/// prune</c> in here and there never will be.
/// </para>
/// <para>
/// The deciding is <see cref="Select"/>, which is pure: it is handed what is on
/// the engine and says what would go and why the rest stays, so every rule has
/// a test on a machine with no engine. Networks are not swept here: a
/// session's network is removed with the session, and the seam owns that.
/// </para>
/// </remarks>
internal static class DockerPrune
{
    /// <summary>
    /// Decide. Containers, then volumes, then images — the order they have to
    /// go in, because each holds the one after it.
    /// </summary>
    /// <param name="contents">What is on the engine.</param>
    /// <param name="options">What was asked.</param>
    /// <param name="samePath">Whether two directories are the same one; <c>PhysicalPath.Same</c>.</param>
    public static IReadOnlyList<SweepItem> Select(
        EngineContents contents,
        SweepOptions options,
        Func<string, string, bool> samePath)
    {
        var items = new List<SweepItem>();
        var ours = contents.Containers.Where(c => c.Labels.ContainsKey(DockerSpec.Labels.Schema)).ToList();

        // Containers that are not instances: a project image's build, left by
        // an envmux that was killed between starting it and committing it.
        // Sessions and services are not looked at here at all.
        var going = new HashSet<string>(StringComparer.Ordinal);

        foreach (var container in ours.Where(IsBuild).OrderBy(NameOf, StringComparer.Ordinal))
        {
            if (!Here(container.Labels, options.Here, samePath))
            {
                continue;
            }

            if (IsRunning(container) && !options.All)
            {
                items.Add(new SweepItem(SweepKind.Container, NameOf(container), false, "(an image being built — use --all)"));
            }
            else
            {
                items.Add(new SweepItem(SweepKind.Container, NameOf(container), true, "[an image build that was interrupted]"));
                going.Add(container.Id);
            }
        }

        var staying = ours.Where(c => !going.Contains(c.Id)).ToList();

        // Volumes nothing mounts. What is on one cannot be asked about — there
        // is no container to run git in — so it is never removed unasked.
        foreach (var volume in contents.Volumes
                     .Where(v => v.Labels.ContainsKey(DockerSpec.Labels.Schema))
                     .Where(v => !contents.Mounted.Contains(v.Name))
                     .OrderBy(v => v.Name, StringComparer.Ordinal))
        {
            if (!Here(volume.Labels, options.Here, samePath))
            {
                continue;
            }

            var branch = Label(volume.Labels, DockerSpec.Labels.Branch);
            var whose = branch.Length > 0 ? $"[{branch}]" : Label(volume.Labels, DockerSpec.Labels.Session) is { Length: > 0 } s ? $"[{s}]" : "";
            var about = $"a session's disk with no container{(whose.Length > 0 ? " " + whose : "")}";

            // One that does not say which repository it came from may be
            // anybody's, so it takes both flags: the one that gives up
            // uncommitted work, and the one that reaches past the usual scope.
            var anybodys = Label(volume.Labels, DockerSpec.Labels.Directory).Length == 0;

            if (options.Force && (options.All || !anybodys))
            {
                items.Add(new SweepItem(SweepKind.Volume, volume.Name, true, $"[{about}]"));
            }
            else
            {
                items.Add(new SweepItem(
                    SweepKind.Volume,
                    volume.Name,
                    false,
                    anybodys
                        ? $"({about}, and it does not say which repository it is from — use --force --all)"
                        : $"({about} — what is on it cannot be asked; use --force)"));
            }
        }

        if (!options.Images)
        {
            return items;
        }

        var busy = staying
            .Where(IsInstance)
            .Select(c => Label(c.Labels, DockerSpec.Labels.Project))
            .ToHashSet(StringComparer.Ordinal);

        foreach (var image in contents.Images
                     .Where(i => i.Labels.ContainsKey(DockerSpec.Labels.Schema))
                     .OrderBy(Reference, StringComparer.Ordinal))
        {
            var reference = Reference(image);

            switch (Label(image.Labels, DockerImages.Labels.Kind))
            {
                // The current golden is never superseded. Every other one is a
                // build of a Dockerfile this envmux no longer carries.
                case DockerImages.Labels.KindGolden
                    when !Label(image.Labels, DockerImages.Labels.Golden).Equals(options.GoldenBuild, StringComparison.Ordinal):
                    items.Add(new SweepItem(SweepKind.Image, reference, true, "[a golden image from an earlier build]"));
                    break;

                case DockerImages.Labels.KindImage when Here(image.Labels, options.Here, samePath):
                    var project = Label(image.Labels, DockerSpec.Labels.Project);

                    items.Add(busy.Contains(project)
                        ? new SweepItem(SweepKind.Image, reference, false, "(a session is built on it)")
                        : new SweepItem(SweepKind.Image, reference, true, "[toolchain]"));
                    break;

                default:
                    break;
            }
        }

        return items;
    }

    /// <summary>Read the engine once, for <see cref="Select"/>.</summary>
    /// <param name="images">Whether to list the images too, which is only worth the round trips when they were asked about.</param>
    public static async Task<EngineContents> ReadAsync(IDockerEngine engine, bool images, CancellationToken ct = default)
    {
        var containers = await engine.ContainersAsync(null, all: true, ct).ConfigureAwait(false);
        var mounted = new HashSet<string>(StringComparer.Ordinal);

        // Every container's mounts and not only ours: a volume of ours that
        // somebody's own container has mounted is in use, whoever's it is.
        foreach (var container in containers)
        {
            if (await engine.InspectAsync(container.Id, ct).ConfigureAwait(false) is { } inspected)
            {
                foreach (var mount in inspected.Mounts.Where(m => m.Type.Equals("volume", StringComparison.OrdinalIgnoreCase)))
                {
                    mounted.Add(mount.Source);
                }
            }
        }

        return new EngineContents(
            containers,
            mounted,
            await engine.VolumesAsync(null, ct).ConfigureAwait(false),
            images
                ? await engine.ImagesAsync(new Dictionary<string, string>(StringComparer.Ordinal) { [DockerSpec.Labels.Schema] = "" }, ct).ConfigureAwait(false)
                : []);
    }

    /// <summary>
    /// Say each decision, and carry out the ones that are removals.
    /// </summary>
    /// <returns>How many things were removed, and how many were kept.</returns>
    public static async Task<(int Removed, int Kept)> ApplyAsync(
        IDockerEngine engine,
        IReadOnlyList<SweepItem> items,
        bool dryRun,
        Action<string> say,
        CancellationToken ct = default)
    {
        var removed = 0;
        var kept = 0;

        foreach (var item in items)
        {
            if (!item.Remove)
            {
                say($"keep   {item.Name,-40} {item.Note}");
                kept++;
                continue;
            }

            say($"{(dryRun ? "would" : "rm   ")}  {item.Name,-40}  {item.Note}");

            if (dryRun)
            {
                continue;
            }

            try
            {
                var gone = item.Kind switch
                {
                    SweepKind.Container => await engine.RemoveAsync(item.Name, force: true, volumes: false, ct).ConfigureAwait(false),
                    SweepKind.Volume => await engine.RemoveVolumeAsync(item.Name, ct).ConfigureAwait(false),
                    _ => await engine.RemoveImageAsync(item.Name, ct).ConfigureAwait(false),
                };

                if (gone)
                {
                    removed++;
                }
            }
            catch (BackendException e)
            {
                // The engine's own refusal is the last guard — a volume in use —
                // and it is reported, not thrown: a prune that has removed what
                // it could has done its job.
                say($"       {item.Name} would not go: {e.Message}");
            }
        }

        return (removed, kept);
    }

    /// <summary>Whether a container is a session or one of its services — an instance, which is not the sweep's.</summary>
    internal static bool IsInstance(ContainerSummary container) =>
        Label(container.Labels, DockerSpec.Labels.Session).Length > 0;

    /// <summary>
    /// Whether a container is a project image being built: it carries the
    /// image's labels (<see cref="DockerImages.Labels.KindImage"/>) and no
    /// session's — the same two halves as <see cref="Incus.InstanceSpec.IsImage"/>,
    /// because a container made from a project image inherits its labels and
    /// <see cref="DockerSpec"/> then says it is a session.
    /// </summary>
    internal static bool IsBuild(ContainerSummary container) =>
        Label(container.Labels, DockerImages.Labels.Kind).Equals(DockerImages.Labels.KindImage, StringComparison.Ordinal) &&
        !IsInstance(container);

    /// <summary>
    /// Scoped to this repository, as <c>prune</c> always is. A thing that does
    /// not say where it is from belongs to no other repository either.
    /// </summary>
    private static bool Here(IReadOnlyDictionary<string, string> labels, string here, Func<string, string, bool> samePath) =>
        Label(labels, DockerSpec.Labels.Directory) is not { Length: > 0 } from || samePath(from, here);

    private static bool IsRunning(ContainerSummary container) =>
        container.State.Equals("running", StringComparison.OrdinalIgnoreCase);

    private static string NameOf(ContainerSummary container) =>
        container.Names.Count > 0 ? container.Names[0].TrimStart('/') : container.Id;

    private static string Reference(ImageInspect image) =>
        image.RepoTags.Count > 0 ? image.RepoTags[0] : image.Id;

    private static string Label(IReadOnlyDictionary<string, string> labels, string key) =>
        labels.TryGetValue(key, out var value) ? value : "";
}
