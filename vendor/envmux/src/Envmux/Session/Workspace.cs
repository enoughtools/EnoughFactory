using System.Globalization;
using System.Text;

using Envmux.Config;
using Envmux.Git;
using Envmux.Incus;

namespace Envmux.Session;

/// <summary>What a session left in its instance when it ended.</summary>
/// <param name="Branch">The branch its work is on.</param>
/// <param name="Head">The commit that branch points at, short.</param>
/// <param name="CommitsAhead">How many commits it added.</param>
/// <param name="DirtyFiles">How many files were changed and not committed.</param>
internal sealed record WorkspaceStatus(string Branch, string Head, int CommitsAhead, int DirtyFiles)
{
    public bool IsClean => DirtyFiles == 0;
}

/// <summary>
/// Getting the repository into the instance, and the commits back out.
/// </summary>
/// <remarks>
/// <para>
/// This is the one thing the machine boundary genuinely changed. A session used
/// to be a git worktree bind-mounted into a container, sharing the host's object
/// store directly — which is only possible while the container and the
/// repository are on the same machine. They are not any more: the instance is
/// inside a VM, and a Windows path is not something it can be handed.
/// </para>
/// <para>
/// So the repository travels as a <b>bundle</b>: a single file that is a
/// complete git remote. The instance clones it and gets real history, real refs
/// and a real repository — not a copied directory that resembles one. When the
/// session ends, the commits come back the same way and are fetched into the
/// host repository, so the promise that mattered is intact: your work is in the
/// repository you started from, on a branch, reachable with <c>git log</c>.
/// </para>
/// <para>
/// It travels over the files API rather than over a git remote on the
/// workstation, and that is deliberate. A remote would mean the instance
/// connecting <em>inbound</em> to a listener on Windows, which the firewall
/// blocks by default on any profile worth having — a rollout failure that would
/// look like git being broken. The files API rides the connection envmux
/// already has, outbound, authenticated, and already working.
/// </para>
/// <para>
/// What does not come back is uncommitted work. That is why an instance is kept
/// rather than deleted when a session ends with a dirty tree, and why the
/// summary says so out loud.
/// </para>
/// </remarks>
internal static class Workspace
{
    /// <summary>Where a bundle lands inside the instance on the way in.</summary>
    private const string InboundBundle = "/tmp/envmux-seed.bundle";

    /// <summary>And on the way out.</summary>
    private const string OutboundBundle = "/tmp/envmux-work.bundle";

    /// <summary>
    /// Put the repository in the instance, checked out on the session's branch.
    /// </summary>
    /// <returns>The commit the branch started from, which is what "ahead" is measured against.</returns>
    public static async Task<string> SeedAsync(
        Backends.IBackend backend,
        GitCli git,
        SessionPlan plan,
        string user,
        SessionLog log,
        Action<string> phase,
        CancellationToken ct = default)
    {
        var start = await git.ResolveAsync(plan.Base).ConfigureAwait(false)
            ?? throw new SessionException(
                $"'{plan.Base}' does not resolve to a commit in {plan.Directory}");

        // The branch exists on the host from the start, so `git log <branch>`
        // works while the session is still running rather than only after it.
        await git.CreateBranchAsync(plan.Branch, start).ConfigureAwait(false);

        // An instance that already has this workspace keeps it. Re-cloning would
        // be the opposite of why the instance was kept: the promise of starting
        // a session again is that the uncommitted work is still there, and the
        // clone script begins with `rm -rf` on the working directory.
        //
        // It also does not work. The previous session's tasks are still latched
        // and still running in that directory, so the wipe raced them and failed
        // with `rm: cannot remove '/work/src': Directory not empty` — a dev
        // server writing to node_modules faster than rm could delete it.
        if (await AlreadySeededAsync(backend, plan, ct).ConfigureAwait(false))
        {
            if (Backends.DockerEngine.MachineWorkspaceBinding.Current(plan.Workdir) is { } mounted)
            {
                foreach (var trustedPath in mounted.TrustedGitPaths)
                {
                    var trusted = await Command.CaptureAsync(backend.Exec, plan.InstanceName,
                        ["git", "config", "--global", "--add", "safe.directory", trustedPath], user, ct: ct).ConfigureAwait(false);
                    if (!trusted.Ok)
                    {
                        throw new SessionException($"could not configure the mounted workspace for {user}: {LastLine(trusted.Text)}");
                    }
                }
            }

            log.Info($"{plan.Workdir} is already {plan.Branch}, and was left as it is");
            return start;
        }

        if (Backends.DockerEngine.MachineWorkspaceBinding.Current(plan.Workdir) is not null)
        {
            throw new SessionException($"the manager-owned ArtifactFS workspace is not readable on {plan.Branch}; it was left untouched");
        }

        phase("bundling the repository");

        var bundle = Path.Combine(Path.GetTempPath(), $"envmux-{Guid.NewGuid():N}.bundle");

        try
        {
            await git.BundleAsync(bundle, plan.Branch).ConfigureAwait(false);

            var bytes = await File.ReadAllBytesAsync(bundle, ct).ConfigureAwait(false);
            log.Debug($"bundle {plan.Branch} — {Size(bytes.LongLength)}");

            phase($"sending {Size(bytes.LongLength)} to {plan.InstanceName}");
            await backend.Files.PushAsync(plan.InstanceName, InboundBundle, bytes, "0600", ct: ct).ConfigureAwait(false);
        }
        finally
        {
            File.Delete(bundle);
        }

        phase("cloning it inside the instance");

        var (name, email) = await git.IdentityAsync().ConfigureAwait(false);
        var clone = await Command.ShellAsync(
            backend.Exec, plan.InstanceName, CloneScript(plan, user, name, email), null, log.Debug, ct)
            .ConfigureAwait(false);

        if (!clone.Ok)
        {
            throw new SessionException(
                $"could not clone the repository into {plan.InstanceName}: {LastLine(clone.Text)}");
        }

        log.Info($"{plan.Workdir} is {plan.Branch} at {Short(start)}, cloned from this repository");
        return start;
    }

    /// <summary>
    /// Whether the instance already holds this session's workspace.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Both halves matter. A directory that is a git repository is not enough —
    /// it could be a different session's, if an instance were ever reused across
    /// names — and neither is the branch alone, since the checkout has to be
    /// where the work is.
    /// </para>
    /// <para>
    /// Anything unreadable is "not seeded", which sends the caller down the
    /// clone path. That is the safe direction: cloning over a broken workspace
    /// produces a working one, and skipping the clone because a probe failed
    /// would produce a session with no repository in it.
    /// </para>
    /// </remarks>
    private static async Task<bool> AlreadySeededAsync(
        Backends.IBackend backend,
        SessionPlan plan,
        CancellationToken ct)
    {
        var probe = new StringBuilder();
        probe.Line($"cd {Quote(plan.Workdir)} 2>/dev/null || exit 1");
        var mounted = Backends.DockerEngine.MachineWorkspaceBinding.Current(plan.Workdir);
        var trust = mounted is null ? "" : string.Join(" ", mounted.TrustedGitPaths.Select(path => $"-c safe.directory={Quote(path)}")) + " ";
        probe.Line($"git {trust}rev-parse --abbrev-ref HEAD 2>/dev/null || exit 1");

        var asked = await Command
            .CaptureAsync(backend.Exec, plan.InstanceName, ["sh", "-c", probe.ToString()], null, null, null, ct)
            .ConfigureAwait(false);

        return asked.Ok && asked.Text.Trim().Equals(plan.Branch, StringComparison.Ordinal);
    }

    /// <summary>
    /// The shell that turns a bundle into a working repository owned by the session user.
    /// </summary>
    /// <remarks>
    /// The bundle is removed at the end, and so is the <c>origin</c> it left
    /// behind. A remote pointing at a file in <c>/tmp</c> that no longer exists
    /// is a <c>git fetch</c> that fails for a reason nobody could guess.
    /// </remarks>
    private static string CloneScript(SessionPlan plan, string user, string name, string email)
    {
        var script = new StringBuilder();

        script.Line("set -eu");

        // Emptied, not removed: on Docker the workdir is a volume's mount point,
        // which cannot be removed ("Device or resource busy"), and git clones
        // into an existing directory as long as it is empty.
        script.Line($"mkdir -p {Quote(plan.Workdir)}");

        // The directory kept its owner — the session's account, which the
        // bootstrap handed it to — and git run as root refuses a repository
        // somebody else owns. Trusted for this script's git calls only, through
        // git's environment config, so nothing is written to root's gitconfig.
        script.Line("export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory");
        script.Line($"export GIT_CONFIG_VALUE_0={Quote(plan.Workdir)}");
        script.Line($"find {Quote(plan.Workdir)} -mindepth 1 -maxdepth 1 -exec rm -rf {{}} +");
        script.Line($"git clone --branch {Quote(plan.Branch)} {InboundBundle} {Quote(plan.Workdir)}");
        script.Line($"cd {Quote(plan.Workdir)}");
        script.Line("git remote remove origin");
        script.Line($"rm -f {InboundBundle}");

        if (name.Length > 0)
        {
            script.Line($"git config user.name {Quote(name)}");
        }

        if (email.Length > 0)
        {
            script.Line($"git config user.email {Quote(email)}");
        }

        // The repository is cloned as root and then handed over, because the
        // account is created by the same provisioning that runs this and there
        // is no ordering in which the clone could have been done as them.
        script.Line($"chown -R {Quote(user)} {Quote(plan.Workdir)}");

        // Somebody else's checkout under your uid is the sort of thing git now
        // refuses to touch, and the message it gives is about security rather
        // than about ownership.
        script.Line($"git config --global --add safe.directory {Quote(plan.Workdir)}");

        return script.ToString();
    }

    /// <summary>
    /// Bring the session's commits back into the host repository.
    /// </summary>
    /// <returns>What it produced, or null when the instance could not be read.</returns>
    public static async Task<WorkspaceStatus?> HarvestAsync(
        Backends.IBackend backend,
        GitCli git,
        SessionPlan plan,
        string start,
        SessionLog log,
        Action<string> phase,
        CancellationToken ct = default)
    {
        phase("looking for work to bring back");

        var survey = await Command.ShellAsync(backend.Exec, plan.InstanceName, SurveyScript(plan, start), null, null, ct)
            .ConfigureAwait(false);

        if (!survey.Ok)
        {
            log.Warn($"could not read the repository in {plan.InstanceName}; nothing was brought back");
            return null;
        }

        var (head, ahead, dirty) = ParseSurvey(survey.Text);

        if (ahead > 0)
        {
            phase($"fetching {ahead.ToString(CultureInfo.InvariantCulture)} commit(s) back");

            if (await backend.Files.PullAsync(plan.InstanceName, OutboundBundle, ct).ConfigureAwait(false) is { } bytes)
            {
                var bundle = Path.Combine(Path.GetTempPath(), $"envmux-{Guid.NewGuid():N}.bundle");

                try
                {
                    await File.WriteAllBytesAsync(bundle, bytes, ct).ConfigureAwait(false);

                    if (!await git.FetchBundleAsync(bundle, plan.Branch).ConfigureAwait(false))
                    {
                        // Non-fast-forward: the branch moved on the host too.
                        // Discarding one side would be discarding commits, so it
                        // is left for a person, with the bundle kept.
                        var kept = Path.Combine(plan.Directory, SessionConfig.StateDirectory,
                            $"{plan.Session}.bundle");

                        Directory.CreateDirectory(Path.GetDirectoryName(kept)!);
                        File.Copy(bundle, kept, overwrite: true);

                        log.Error($"{plan.Branch} moved on both sides, so nothing was merged.");
                        log.Error($"  the session's commits are in {Path.GetFileName(kept)}:");
                        log.Error($"  git fetch {SessionConfig.StateDirectory}/{plan.Session}.bundle {plan.Branch}");
                    }
                    else
                    {
                        log.Info($"{ahead} commit(s) fetched onto {plan.Branch}");
                    }
                }
                finally
                {
                    File.Delete(bundle);
                }
            }
            else
            {
                log.Warn($"{plan.InstanceName} reported commits but produced no bundle");
            }
        }
        else if (await git.ResolveAsync(plan.Branch).ConfigureAwait(false) == start)
        {
            // Nothing was ever committed on it. A branch per session that
            // produced nothing is a branch list nobody can read.
            if (await git.DeleteBranchAsync(plan.Branch).ConfigureAwait(false))
            {
                log.Debug($"{plan.Branch} had no commits on it and was removed");
            }
        }

        return new WorkspaceStatus(plan.Branch, Short(head), ahead, dirty);
    }

    /// <summary>
    /// Ask the instance three questions and, if there is anything, write the bundle.
    /// </summary>
    /// <remarks>
    /// One exec rather than four. Each is a round trip to a VM, and this runs
    /// during teardown where the window is already gone and every second of it
    /// is a terminal that appears to have hung.
    /// </remarks>
    private static string SurveyScript(SessionPlan plan, string start)
    {
        var script = new StringBuilder();

        script.Line("set -eu");
        script.Line($"cd {Quote(plan.Workdir)}");
        script.Line("printf 'head=%s\\n' \"$(git rev-parse HEAD 2>/dev/null || echo none)\"");
        script.Line(
            $"ahead=$(git rev-list --count {Quote(start)}..HEAD 2>/dev/null || echo 0)");
        script.Line("printf 'ahead=%s\\n' \"$ahead\"");
        script.Line(
            "printf 'dirty=%s\\n' \"$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')\"");

        // Only when there is something, because `git bundle create` refuses to
        // make an empty one — and never fatally, because `set -e` would
        // otherwise turn any bundle failure into a survey that reports nothing
        // at all. The caller already handles "said there were commits, produced
        // no bundle"; this is what lets that branch be reached instead of the
        // one that says the repository could not be read.
        script.Line("if [ \"$ahead\" -gt 0 ]; then");
        script.Line(
            $"  git bundle create {OutboundBundle} {Quote(plan.Branch)} --not {Quote(start)} " +
            ">/dev/null 2>&1 || true");
        script.Line("fi");

        return script.ToString();
    }

    internal static (string Head, int Ahead, int Dirty) ParseSurvey(string output)
    {
        var head = "";
        var ahead = 0;
        var dirty = 0;

        foreach (var line in output.Split('\n', StringSplitOptions.TrimEntries))
        {
            if (line.StartsWith("head=", StringComparison.Ordinal))
            {
                head = line["head=".Length..];
            }
            else if (line.StartsWith("ahead=", StringComparison.Ordinal) &&
                     int.TryParse(line["ahead=".Length..], CultureInfo.InvariantCulture, out var a))
            {
                ahead = a;
            }
            else if (line.StartsWith("dirty=", StringComparison.Ordinal) &&
                     int.TryParse(line["dirty=".Length..], CultureInfo.InvariantCulture, out var d))
            {
                dirty = d;
            }
        }

        return (head, ahead, dirty);
    }

    /// <summary>
    /// Wrap a value so a shell hands it on unchanged.
    /// </summary>
    /// <remarks>
    /// Single quotes, with the one escape single quotes need. Every one of these
    /// strings — a workdir, a branch, an account name — is a value from a
    /// configuration file, and a configuration file is not a place to have
    /// decided shell metacharacters are impossible.
    /// </remarks>
    internal static string Quote(string value) =>
        "'" + value.Replace("'", "'\\''", StringComparison.Ordinal) + "'";

    private static string Short(string commit) => commit.Length > 8 ? commit[..8] : commit;

    private static string LastLine(string output) =>
        output.Split('\n', StringSplitOptions.RemoveEmptyEntries).LastOrDefault()?.Trim() ?? "no output";

    private static string Size(long bytes) => bytes switch
    {
        < 1024 => $"{bytes.ToString(CultureInfo.InvariantCulture)} B",
        < 1024 * 1024 => $"{(bytes / 1024.0).ToString("F0", CultureInfo.InvariantCulture)} KiB",
        _ => $"{(bytes / (1024.0 * 1024)).ToString("F1", CultureInfo.InvariantCulture)} MiB",
    };
}
