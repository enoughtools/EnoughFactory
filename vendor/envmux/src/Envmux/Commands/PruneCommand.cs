using Envmux.Backends;
using System.Globalization;

using Envmux.Config;
using Envmux.Host;
using Envmux.Incus;
using Envmux.Session;

namespace Envmux.Commands;

/// <summary>
/// The janitor for what a session deliberately leaves behind.
/// </summary>
/// <remarks>
/// <para>
/// This used to be about accidents — containers created with <c>--rm</c> that
/// the engine never got to collect, and worktrees kept because deleting
/// somebody's uncommitted work by default is unforgivable.
/// </para>
/// <para>
/// The accidents are gone with the engine, and what is left is on purpose. An
/// instance is <em>kept</em> when a session ends, because keeping it is what
/// makes starting the same session again pick up where you left off — with its
/// dependencies installed, its uncommitted work in place and its latched tasks
/// still running. On a copy-on-write pool that costs almost nothing, so they
/// accumulate, and this is what clears them out.
/// </para>
/// </remarks>
internal static class PruneCommand
{
    /// <param name="all">
    /// Also take down instances that are still running. Off by default: a
    /// running instance is usually a session somebody is using, and one whose
    /// envmux was hard-killed looks exactly the same from here.
    /// </param>
    /// <param name="force">
    /// Also remove instances with uncommitted work in them. That work exists
    /// nowhere else — commits come back through a bundle and changes do not —
    /// so it is never removed without being asked for twice.
    /// </param>
    public static async Task<int> RunAsync(string directory, bool force, bool dryRun, bool all = false, BackendKind? requested = null)
    {
        var host = HostConfig.Load();

        await using var backend = BackendCatalog.Open(requested ?? SessionPlan.Resolve(
            SessionConfig.Load(directory), directory, "unnamed").Backend, host);

        var removed = 0;
        var kept = 0;

        var here = PhysicalPath.Of(directory);
        var git = new Git.GitCli(directory);

        List<Instance> ours;
        List<Instance> images;

        try
        {
            var everything = (await backend.Instances.ListAsync().ConfigureAwait(false))
                .Where(InstanceSpec.IsOurs)
                .Where(i => i.Name != Golden.InstanceName)
                .OrderBy(i => i.Name, StringComparer.Ordinal)
                .ToList();

            // A project image is not a session, and removing one while a session
            // is copied from it is not a thing to attempt: on a copy-on-write
            // pool the copies depend on the snapshot they came from. They are
            // handled at the end, once the sessions are gone.
            images = [.. everything.Where(InstanceSpec.IsImage)];
            ours = [.. everything.Except(images)];
        }
        catch (BackendException e)
        {
            Console.Error.WriteLine($"envmux: {e.Message}");
            return 1;
        }

        // Sessions before the services beside them, so a service can be kept
        // because its session was. Not the order the list happens to be in:
        // `footprint-side` sorts before `footprint-side-db` by luck rather than
        // by rule, and a service named `api` under a session named `web` would
        // not.
        var keptSessions = new HashSet<string>(StringComparer.Ordinal);

        foreach (var instance in ours
            .OrderBy(i => InstanceSpec.Label(i, InstanceSpec.Keys.Service).Length > 0)
            .ThenBy(i => i.Name, StringComparer.Ordinal))
        {
            var from = InstanceSpec.Label(instance, InstanceSpec.Keys.Directory);

            // Scoped to this repository. An instance belonging to another
            // project is not this command's to remove, however tidy that would be.
            if (from.Length > 0 && !PhysicalPath.Same(from, here))
            {
                continue;
            }

            var session = InstanceSpec.Label(instance, InstanceSpec.Keys.Session);
            var service = InstanceSpec.Label(instance, InstanceSpec.Keys.Service);

            // Keeping a session and removing its database is a state nobody
            // asked for: the session comes back with an empty one, and whatever
            // it was keeping the session for now has to migrate again.
            if (service.Length > 0 && keptSessions.Contains(session))
            {
                Console.WriteLine($"keep   {instance.Name,-40} ('{session}' is being kept)");
                kept++;
                continue;
            }

            if (instance.IsRunning && !all)
            {
                Console.WriteLine($"keep   {instance.Name,-40} (running — use --all)");
                keptSessions.Add(session);
                kept++;
                continue;
            }

            var dirty = force ? 0 : await IsDirtyAsync(backend, instance).ConfigureAwait(false);
            if (dirty is null or > 0)
            {
                Console.WriteLine(
                    $"keep   {instance.Name,-40} ({dirty?.ToString(CultureInfo.InvariantCulture) ?? "unknown"} " +
                    "uncommitted change(s), or workspace unreadable — use --force)");

                keptSessions.Add(session);
                kept++;
                continue;
            }

            var branch = InstanceSpec.Label(instance, InstanceSpec.Keys.Branch);
            var note = branch.Length > 0 ? $"  [{branch}]" : "";

            Console.WriteLine($"{(dryRun ? "would" : "rm   ")}  {instance.Name,-40}{note}");

            if (dryRun)
            {
                continue;
            }

            if (instance.IsRunning)
            {
                await backend.Instances.StopAsync(instance.Name, 10).ConfigureAwait(false);
            }

            if (await backend.Instances.DeleteAsync(instance.Name).ConfigureAwait(false))
            {
                removed++;
            }

            // And its branch, if there is nothing on it. `git branch -d` is the
            // whole safety argument: it refuses a branch holding commits that
            // are not reachable from anywhere else, which is exactly the branch
            // that must survive — the one teardown brought work back onto.
            //
            // Without this, prune clears the instances and leaves a branch per
            // session behind forever, which is the branch list nobody can read
            // that teardown already deletes empty branches to avoid.
            if (branch.Length > 0 && await git.DeleteBranchAsync(branch).ConfigureAwait(false))
            {
                Console.WriteLine($"       {branch} had nothing on it and was removed");
            }
        }

        removed += await PruneImagesAsync(backend, images, here, dryRun, all).ConfigureAwait(false);

        Console.WriteLine();
        Console.WriteLine(dryRun
            ? $"nothing removed (--dry-run); {kept.ToString(CultureInfo.InvariantCulture)} kept"
            : $"removed {removed.ToString(CultureInfo.InvariantCulture)} instance(s); " +
              $"{kept.ToString(CultureInfo.InvariantCulture)} kept");

        return 0;
    }

    /// <summary>
    /// Remove the toolchain images nothing is built on any more.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A project image is the golden snapshot with a toolchain on top, named
    /// after a hash of what it was built from. Change a feature and the next
    /// session builds a new one and the old one stays — so without this they
    /// accumulate one per edit, at a few hundred megabytes each.
    /// </para>
    /// <para>
    /// Only after the sessions, and only when none are left for that project.
    /// On a copy-on-write pool a session is a clone of the image's snapshot, and
    /// removing the thing a clone came from is at best refused. Waiting is both
    /// simpler and correct: the images that matter are the superseded ones, and
    /// nothing is running on those.
    /// </para>
    /// <para>
    /// A refusal is reported rather than thrown. There are legitimate reasons
    /// for one — another project sharing a fingerprint, a session this command
    /// was not scoped to — and none of them are a reason to abandon a prune
    /// that has already removed what it could.
    /// </para>
    /// </remarks>
    private static async Task<int> PruneImagesAsync(
        IBackend backend,
        List<Instance> images,
        string here,
        bool dryRun,
        bool all)
    {
        if (images.Count == 0)
        {
            return 0;
        }

        // Asked again, because the sessions above have just gone.
        var live = (await backend.Instances.ListAsync().ConfigureAwait(false))
            .Where(InstanceSpec.IsOurs)
            .Where(i => !InstanceSpec.IsImage(i))
            .Select(i => InstanceSpec.Label(i, InstanceSpec.Keys.Project))
            .ToHashSet(StringComparer.Ordinal);

        var removed = 0;

        foreach (var image in images)
        {
            var from = InstanceSpec.Label(image, InstanceSpec.Keys.Directory);

            if (from.Length > 0 && !PhysicalPath.Same(from, here))
            {
                continue;
            }

            var project = InstanceSpec.Label(image, InstanceSpec.Keys.Project);

            if (live.Contains(project))
            {
                Console.WriteLine($"keep   {image.Name,-40} (a session is built on it)");
                continue;
            }

            // A running image is one being built right now, by an envmux in
            // another terminal. The check above cannot see that: during a build
            // there is no session instance yet, so nothing says the project is
            // busy. Deleting it would take the toolchain out from under a
            // session that is starting, and the failure would land somewhere far
            // from here.
            //
            // The same flag as a running session, and for the same reason:
            // "still running" is the one state this command does not act on
            // without being asked twice.
            if (image.IsRunning && !all)
            {
                Console.WriteLine($"keep   {image.Name,-40} (being built — use --all)");
                continue;
            }

            Console.WriteLine($"{(dryRun ? "would" : "rm   ")}  {image.Name,-40}  [toolchain]");

            if (dryRun)
            {
                continue;
            }

            try
            {
                if (image.IsRunning)
                {
                    await backend.Instances.StopAsync(image.Name, 10).ConfigureAwait(false);
                }

                if (await backend.Instances.DeleteAsync(image.Name).ConfigureAwait(false))
                {
                    removed++;
                }
            }
            catch (BackendException e)
            {
                Console.WriteLine($"       {image.Name} would not go: {e.Message}");
            }
        }

        return removed;
    }

    /// <summary>
    /// How many uncommitted changes an instance is holding, or null if it cannot be asked.
    /// </summary>
    /// <remarks>
    /// Only a stopped instance can be asked cheaply — starting one to look would
    /// be a prune that takes a minute per instance and leaves things running. So
    /// a stopped instance is started only long enough to answer, which is the
    /// one case where that is worth it: the alternative is deleting work without
    /// having looked.
    /// </remarks>
    private static async Task<int?> IsDirtyAsync(IBackend backend, Instance instance)
    {
        // A service instance has no repository in it, so there is nothing to
        // lose and nothing to check.
        if (InstanceSpec.Label(instance, InstanceSpec.Keys.Service).Length > 0)
        {
            return 0;
        }

        var started = false;

        try
        {
            if (!instance.IsRunning)
            {
                await backend.Instances.StartAsync(instance.Name).ConfigureAwait(false);
                started = true;
            }

            var result = await Command.ShellAsync(
                backend.Exec,
                instance.Name,
                $"cd {Session.Workspace.Quote(SessionConfig.DefaultWorkdir)} 2>/dev/null || exit 1; " +
                "status=$(git status --porcelain 2>/dev/null) || exit 1; " +
                "if [ -z \"$status\" ]; then echo 0; else printf '%s\\n' \"$status\" | wc -l; fi")
                .ConfigureAwait(false);

            return result.ExitCode == 0 && int.TryParse(result.Text.Trim(), CultureInfo.InvariantCulture, out var count) ? count : null;
        }
        catch (BackendException)
        {
            // Failure to inspect is not evidence that deleting is safe.
            return null;
        }
        finally
        {
            if (started)
            {
                try
                {
                    await backend.Instances.StopAsync(instance.Name, 5).ConfigureAwait(false);
                }
                catch (BackendException)
                {
                    // It is about to be deleted anyway.
                }
            }
        }
    }
}
