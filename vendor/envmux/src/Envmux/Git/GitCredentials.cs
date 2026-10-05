using System.Text;

using Envmux.Process;

namespace Envmux.Git;

/// <summary>One host's credential, as git hands it back.</summary>
/// <param name="Protocol">Always <c>https</c> here; ssh does not go through this.</param>
/// <param name="Host">The host it is for, e.g. <c>github.com</c>.</param>
/// <param name="Username">Who to authenticate as.</param>
/// <param name="Password">The token. Never logged, never printed, never in an error.</param>
internal sealed record GitCredential(string Protocol, string Host, string Username, string Password)
{
    /// <summary>The line git's <c>store</c> helper reads.</summary>
    public string Line =>
        $"{Protocol}://{Uri.EscapeDataString(Username)}:{Uri.EscapeDataString(Password)}@{Host}";

    /// <summary>What this is safe to say out loud.</summary>
    public override string ToString() => $"{Username}@{Host}";
}

/// <summary>
/// The host's git credentials, asked for rather than found.
/// </summary>
/// <remarks>
/// <para>
/// A session clones from a bundle and has no remote, so the moment anyone adds
/// one and pushes, they need whatever the host was using. On Windows that is
/// almost always Git Credential Manager, which keeps the token in the Windows
/// Credential Manager — a store with no file to copy and no Linux equivalent.
/// Looking for <c>~/.git-credentials</c> finds nothing and concludes, wrongly,
/// that there is nothing to carry.
/// </para>
/// <para>
/// So this asks git instead. <c>git credential fill</c> runs whatever helper the
/// host has configured, wherever it keeps things, and answers in the same four
/// lines regardless — which also means this works unchanged from a macOS
/// keychain or a Linux libsecret.
/// </para>
/// <para>
/// Inside the instance it is written as <c>~/.git-credentials</c> with the
/// <c>store</c> helper, because that is the one helper that needs nothing
/// installed.
/// </para>
/// <para>
/// <b>This is a credential leaving your machine.</b> It is behind the same
/// explicit opt-in as the coding tools, it is never a default, and it only ever
/// covers hosts this repository's own remotes point at — not every host the
/// helper knows about.
/// </para>
/// </remarks>
internal static class GitCredentials
{
    /// <summary>Where the store helper reads them inside the instance.</summary>
    public const string ContainerFile = ".git-credentials";

    /// <summary>
    /// The https hosts this repository's remotes point at.
    /// </summary>
    /// <remarks>
    /// Remotes, rather than every host the helper has ever seen, because a
    /// credential store is not enumerable through this interface and should not
    /// be: asking for what the repository needs is both possible and the right
    /// amount.
    /// </remarks>
    public static async Task<IReadOnlyList<string>> HostsAsync(GitCli git)
    {
        var listed = await git.RunAsync("remote", "-v").ConfigureAwait(false);

        if (!listed.Ok)
        {
            return [];
        }

        var hosts = new List<string>();

        foreach (var line in listed.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = line.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);

            if (parts.Length < 2 ||
                !Uri.TryCreate(parts[1], UriKind.Absolute, out var url) ||
                !url.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!hosts.Contains(url.Host, StringComparer.OrdinalIgnoreCase))
            {
                hosts.Add(url.Host);
            }
        }

        return hosts;
    }

    /// <summary>
    /// Ask the host's helper for one host's credential.
    /// </summary>
    /// <remarks>
    /// Null when there is nothing stored. Deliberately quiet: a helper that has
    /// no answer prints nothing and exits zero, and a repository nobody has
    /// pushed from yet is the normal case rather than a problem.
    /// </remarks>
    public static async Task<GitCredential?> ForAsync(GitCli git, string host, CancellationToken ct = default)
    {
        ProcessResult filled;

        try
        {
            filled = await ProcessRunner.RunAsync(
                "git",
                ["credential", "fill"],
                git.Repository,

                // The helper must not stop to ask. Without this a missing
                // credential opens a prompt on a terminal envmux is drawing to,
                // or on no terminal at all, and the session hangs on something
                // invisible.
                new Dictionary<string, string>(StringComparer.Ordinal) { ["GIT_TERMINAL_PROMPT"] = "0" },
                $"protocol=https\nhost={host}\n\n",
                ct).ConfigureAwait(false);
        }
        catch (ProcessException)
        {
            return null;
        }

        if (!filled.Ok)
        {
            return null;
        }

        string? username = null;
        string? password = null;

        foreach (var line in filled.Stdout.Split('\n'))
        {
            var trimmed = line.TrimEnd('\r');
            var split = trimmed.IndexOf('=', StringComparison.Ordinal);

            if (split <= 0)
            {
                continue;
            }

            var key = trimmed[..split];
            var value = trimmed[(split + 1)..];

            if (key.Equals("username", StringComparison.Ordinal))
            {
                username = value;
            }
            else if (key.Equals("password", StringComparison.Ordinal))
            {
                password = value;
            }
        }

        return string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password)
            ? null
            : new GitCredential("https", host, username, password);
    }

    /// <summary>Every credential this repository's remotes need and the host can supply.</summary>
    public static async Task<IReadOnlyList<GitCredential>> CollectAsync(
        GitCli git,
        CancellationToken ct = default)
    {
        var found = new List<GitCredential>();

        foreach (var host in await HostsAsync(git).ConfigureAwait(false))
        {
            if (await ForAsync(git, host, ct).ConfigureAwait(false) is { } credential)
            {
                found.Add(credential);
            }
        }

        return found;
    }

    /// <summary>
    /// The file the <c>store</c> helper reads, for these credentials.
    /// </summary>
    /// <remarks>
    /// LF-terminated and with no trailing blank line, because git's store parser
    /// is line-based and a stray carriage return becomes part of the host name.
    /// </remarks>
    public static string File(IReadOnlyList<GitCredential> credentials)
    {
        var text = new StringBuilder();

        foreach (var credential in credentials)
        {
            text.Append(credential.Line).Append('\n');
        }

        return text.ToString();
    }
}
