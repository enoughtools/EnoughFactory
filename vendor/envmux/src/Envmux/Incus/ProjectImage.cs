using Envmux.Host;

namespace Envmux.Incus;

/// <summary>
/// A project's own image: the golden snapshot with its toolchain on top.
/// </summary>
/// <remarks>
/// <para>
/// The golden snapshot holds what envmux itself needs and deliberately nothing
/// else — a project's toolchain belongs to the project. But installing .NET, Bun
/// and a browser takes minutes, and doing it per session would make every
/// session cost those minutes, which is the difference between a tool people use
/// for a five-minute question and one they only use for the afternoon.
/// </para>
/// <para>
/// So it happens once. The features are installed into an instance, that
/// instance is snapshotted, and every session is a copy of the snapshot — which
/// on a ZFS pool is a clone, so the second session costs what the first one did
/// minus the minutes.
/// </para>
/// <para>
/// The image's name carries a fingerprint of the declaration, so it cannot drift
/// from the config. Adding a feature or moving a version produces a different
/// name, the next session finds no image under it and builds one, and the old
/// image sits there until <c>envmux prune</c> takes it. There is nothing to
/// invalidate by hand — which matters because a stale toolchain does not present
/// as a stale toolchain, it presents as the project failing to build.
///
/// A floating tag republished upstream is the one thing this does not notice,
/// deliberately; see <see cref="Features.Fingerprint"/>.
/// </para>
/// </remarks>
internal static class ProjectImage
{
    /// <summary>The snapshot on it that sessions are copied from.</summary>
    public const string SnapshotName = "base";

    /// <summary>The instance a project's image lives in.</summary>
    /// <param name="project">The project's slug.</param>
    /// <param name="fingerprint">What it was built from, hashed.</param>
    public static string InstanceName(string project, string fingerprint) =>
        $"envmux-image-{project}-{fingerprint}";

    /// <summary>How a session names it as a copy source.</summary>
    /// <param name="project">The project's slug.</param>
    /// <param name="fingerprint">What it was built from, hashed.</param>
    public static string Source(string project, string fingerprint) =>
        $"{InstanceName(project, fingerprint)}/{SnapshotName}";

    /// <summary>Whether this project's image is already built.</summary>
    /// <param name="api">The host.</param>
    /// <param name="project">The project's slug.</param>
    /// <param name="fingerprint">What it was built from, hashed.</param>
    /// <param name="ct">Cancellation.</param>
    public static async Task<bool> ExistsAsync(
        IncusApi api,
        string project,
        string fingerprint,
        CancellationToken ct = default) =>
        (await api.SnapshotsAsync(InstanceName(project, fingerprint), ct).ConfigureAwait(false))
        .Contains(SnapshotName, StringComparer.Ordinal);

    /// <summary>
    /// Build it: golden, plus every feature, snapshotted.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Destructive about its own leftovers. A half-built image — one whose
    /// instance exists because a previous attempt was interrupted between
    /// creating it and snapshotting it — is removed rather than continued from,
    /// because "some of the features" is a state nothing can describe and
    /// everything downstream would be built on.
    /// </para>
    /// <para>
    /// Left stopped, because a snapshot of a running container is a copy of a
    /// filesystem mid-write, and because nothing needs it running: it exists to
    /// be copied.
    /// </para>
    /// </remarks>
    /// <param name="api">The host.</param>
    /// <param name="host">The host's config, for the image server.</param>
    /// <param name="project">The project's slug.</param>
    /// <param name="directory">The repository it is for, so prune can scope it.</param>
    /// <param name="baseImage">What to fall back to when there is no golden snapshot.</param>
    /// <param name="features">The toolchain, in the order it was declared.</param>
    /// <param name="user">The account sessions run as, for the features that install per-user.</param>
    /// <param name="report">Told what is happening, in words.</param>
    /// <param name="ct">Cancellation.</param>
    public static async Task BuildAsync(
        IncusApi api,
        HostConfig host,
        string project,
        string directory,
        string baseImage,
        IReadOnlyList<Feature> features,
        string user,
        Action<string> report,
        CancellationToken ct = default)
    {
        // The image needs whatever the sessions copied from it will need. A
        // docker feature's install.sh does more than unpack a binary — it sets
        // up a daemon — and doing that in a container that is not allowed one
        // produces an image that looks built and does not work.
        var nesting = features.Any(f => f.Name.Contains("docker", StringComparison.OrdinalIgnoreCase));

        var fingerprint = Features.Fingerprint(baseImage, features);
        var name = InstanceName(project, fingerprint);

        if (await api.InstanceAsync(name, ct).ConfigureAwait(false) is { } leftover)
        {
            report("removing a half-built image from an earlier attempt");

            if (leftover.IsRunning)
            {
                await api.StopAsync(name, 10, ct).ConfigureAwait(false);
            }

            await api.DeleteAsync(name, ct).ConfigureAwait(false);
        }

        var golden = await Golden.ExistsAsync(api, ct).ConfigureAwait(false);

        report(golden
            ? $"building {project}'s image from the golden snapshot"
            : $"building {project}'s image by pulling {baseImage}, which is slower than a copy");

        await api.CreateAsync(
            new InstancesPost
            {
                Name = name,
                Description = $"envmux: {project}'s toolchain ({Features.Describe(features)})",
                Config = InstanceSpec.ForImage(project, fingerprint, directory, DateTimeOffset.UtcNow, nesting),
                Source = golden
                    ? new InstanceSource { Type = "copy", Source = Golden.Source }
                    : new InstanceSource
                    {
                        Type = "image",
                        Alias = baseImage,
                        Protocol = "simplestreams",
                        Server = host.ImageServer,
                        Mode = "pull",
                    },

                // Named rather than inherited: a golden made before the network
                // was a field carries no nic of its own, and the default profile
                // on a daemon envmux did not build points somewhere else.
                Devices = InstanceSpec.Attached(host),
                Start = true,
            },
            report,
            ct).ConfigureAwait(false);

        // Features fetch from a registry and install packages, so this needs the
        // network before it needs anything else.
        if (await api.AwaitAddressAsync(name, TimeSpan.FromSeconds(60), ct).ConfigureAwait(false) is null)
        {
            throw new IncusException(
                $"{name} started but never took an address on {host.Network} — " +
                "features are downloaded, so this cannot proceed without one");
        }

        try
        {
            await InstallAllAsync(api, name, features, user, report, ct).ConfigureAwait(false);
        }
        catch
        {
            // A build that threw leaves an instance holding some of a toolchain,
            // and it is still running. The next build only clears a leftover
            // with the *same* fingerprint — and a build usually fails because
            // somebody is changing the features, which changes the fingerprint,
            // so the broken one would sit there running forever with nothing
            // that names it. Measured: two of them after one afternoon.
            report("removing what was half-built");

            try
            {
                await api.StopAsync(name, 10, CancellationToken.None).ConfigureAwait(false);
                await api.DeleteAsync(name, CancellationToken.None).ConfigureAwait(false);
            }
            catch (IncusException)
            {
                // The original failure is the one worth reporting.
            }

            throw;
        }

        report("stopping it so the snapshot is clean");
        await api.StopAsync(name, 30, ct).ConfigureAwait(false);

        report($"snapshotting as '{SnapshotName}'");
        await api.SnapshotAsync(name, SnapshotName, ct).ConfigureAwait(false);

        report($"{project}'s image is ready — every session is now a copy of it");
    }

    /// <summary>Install every feature, in the order they were declared.</summary>
    private static async Task InstallAllAsync(
        IncusApi api,
        string name,
        IReadOnlyList<Feature> features,
        string user,
        Action<string> report,
        CancellationToken ct)
    {
        var at = 0;

        // One client for all of them: the registry is the same host and the
        // manifests are small.
        using var registry = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };

        foreach (var feature in features)
        {
            at++;

            report($"installing {feature.Name} " +
                   $"({at.ToString(System.Globalization.CultureInfo.InvariantCulture)} of " +
                   $"{features.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)})");

            // What the feature declares about itself, which is where its option
            // defaults live. Without them a feature receives empty strings for
            // everything the config did not mention, and fails somewhere that
            // does not name the option.
            var metadata = await FeatureManifest.ReadAsync(feature, registry, ct).ConfigureAwait(false);

            if (metadata is null)
            {
                report($"could not read what {feature.Name} declares; " +
                       "installing it with only the options given here");
            }

            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(Features.Deadline);

            var installed = await Command.ShellAsync(
                api, name, Features.InstallScript(feature, user, metadata), null, null, deadline.Token)
                .ConfigureAwait(false);

            if (!installed.Ok)
            {
                // Named, and with what it said. A feature that fails here fails
                // for everyone using this project, so the message has to be
                // enough to fix it without running anything by hand.
                throw new IncusException(
                    $"the feature {feature.Reference} would not install: {LastLines(installed.Text)}");
            }
        }
    }

    /// <summary>The end of some output, which is where a failure says why.</summary>
    private static string LastLines(string text, int lines = 4) =>
        string.Join(" | ", text
            .ReplaceLineEndings("\n")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .TakeLast(lines));
}
