using Envmux.Process;

namespace Envmux.Git;

/// <summary>A git operation that failed in a way the user has to know about.</summary>
internal sealed class GitException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>
/// The host's <c>git</c>, as far as envmux needs it.
/// </summary>
internal sealed class GitCli(string repository)
{
    /// <summary>The directory every command runs in.</summary>
    public string Repository { get; } = repository;

    public async Task<ProcessResult> RunAsync(params string[] args) =>
        await ProcessRunner.RunAsync("git", args, Repository).ConfigureAwait(false);

    public async Task<ProcessResult> CheckedAsync(params string[] args)
    {
        var result = await RunAsync(args).ConfigureAwait(false);
        return result.Ok
            ? result
            : throw new GitException($"git {string.Join(' ', args)} failed: {result.Error}");
    }

    /// <summary>Whether <c>git</c> exists and this directory is inside a work tree.</summary>
    public async Task<bool> IsRepositoryAsync()
    {
        try
        {
            var result = await RunAsync("rev-parse", "--is-inside-work-tree").ConfigureAwait(false);
            return result.Ok && result.Output.Equals("true", StringComparison.Ordinal);
        }
        catch (ProcessException)
        {
            return false;
        }
    }

    /// <summary>The repository's root, which is not necessarily where we were run.</summary>
    public async Task<string> TopLevelAsync() =>
        (await CheckedAsync("rev-parse", "--show-toplevel").ConfigureAwait(false)).Output;

    /// <summary>The common git directory — the one every worktree shares.</summary>
    public async Task<string> CommonDirAsync()
    {
        var output = (await CheckedAsync("rev-parse", "--path-format=absolute", "--git-common-dir")
            .ConfigureAwait(false)).Output;
        return Path.GetFullPath(output);
    }

    /// <summary>Whether a ref resolves. Used to decide add-or-adopt.</summary>
    public async Task<bool> RefExistsAsync(string reference) =>
        (await RunAsync("rev-parse", "--verify", "--quiet", $"{reference}^{{commit}}").ConfigureAwait(false)).Ok;

    /// <summary>Whether the repository has any commits at all.</summary>
    public async Task<bool> HasCommitsAsync() => await RefExistsAsync("HEAD").ConfigureAwait(false);

    /// <summary>The commit a ref points at, or null if it does not resolve.</summary>
    public async Task<string?> ResolveAsync(string reference)
    {
        var result = await RunAsync("rev-parse", "--verify", "--quiet", $"{reference}^{{commit}}")
            .ConfigureAwait(false);

        return result.Ok && result.Output.Length > 0 ? result.Output.Trim() : null;
    }

    /// <summary>
    /// Point a branch at a commit, creating it if there is none.
    /// </summary>
    /// <remarks>
    /// The session's branch exists in the host repository from the moment the
    /// session starts, before anything has been committed on it. That is what
    /// makes <c>git log &lt;branch&gt;</c> work while the session is still
    /// running, and what the instance clones.
    /// </remarks>
    public async Task CreateBranchAsync(string branch, string start)
    {
        if (await ResolveAsync(branch).ConfigureAwait(false) is not null)
        {
            return;
        }

        await CheckedAsync("branch", branch, start).ConfigureAwait(false);
    }

    /// <summary>
    /// Write a bundle of one branch, which is a git remote in a single file.
    /// </summary>
    /// <remarks>
    /// This is how a repository crosses a machine boundary without a server on
    /// either side of it. A bundle is cloneable and fetchable exactly like a
    /// remote, so the instance gets real history and a real repository rather
    /// than a copied directory that only looks like one.
    /// </remarks>
    public Task BundleAsync(string path, string branch) =>
        CheckedAsync("bundle", "create", path, branch);

    /// <summary>How many commits are on <paramref name="head"/> that are not on <paramref name="base"/>.</summary>
    public async Task<int> CountAsync(string @base, string head)
    {
        var result = await RunAsync("rev-list", "--count", $"{@base}..{head}").ConfigureAwait(false);

        return result.Ok && int.TryParse(result.Output.Trim(), out var count) ? count : 0;
    }

    /// <summary>
    /// Take a branch out of a bundle and into this repository.
    /// </summary>
    /// <remarks>
    /// Not forced. A fetch that would not fast-forward means the branch moved on
    /// both sides, and quietly discarding one of them is not something to do to
    /// somebody's commits — it is reported instead.
    /// </remarks>
    public async Task<bool> FetchBundleAsync(string path, string branch)
    {
        var result = await RunAsync("fetch", path, $"{branch}:{branch}").ConfigureAwait(false);
        return result.Ok;
    }

    /// <summary>The committer identity to give the instance, so its commits are yours.</summary>
    public async Task<(string Name, string Email)> IdentityAsync()
    {
        var name = await RunAsync("config", "user.name").ConfigureAwait(false);
        var email = await RunAsync("config", "user.email").ConfigureAwait(false);

        return (name.Ok ? name.Output.Trim() : "", email.Ok ? email.Output.Trim() : "");
    }

    /// <summary>Remove a branch that has nothing on it, for a session that produced nothing.</summary>
    public async Task<bool> DeleteBranchAsync(string branch) =>
        (await RunAsync("branch", "-d", branch).ConfigureAwait(false)).Ok;
}
