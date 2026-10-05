using System.Runtime.InteropServices;

using Envmux.Process;

namespace Envmux.Session;

/// <summary>
/// Who the host user is, so the container can be somebody with the same
/// ownership rather than root.
/// </summary>
/// <param name="Name">The host username.</param>
/// <param name="Uid">The host uid, or <c>null</c> where the platform has none worth mapping.</param>
/// <param name="Gid">The host gid, or <c>null</c>.</param>
internal sealed record HostUser(string Name, int? Uid, int? Gid)
{
    /// <summary>
    /// The uid a bootstrapped user gets when the host has none to map.
    /// </summary>
    /// <remarks>
    /// Deliberately unusual. A low number would collide with a uid the image
    /// already uses for something, and the collision would show up as a file
    /// owned by a service account rather than as an error.
    /// </remarks>
    public const int FallbackUid = 10001;

    /// <summary>
    /// The account name used when the host username is unusable as a Unix one.
    /// </summary>
    public const string FallbackName = "envmux";

    /// <summary>The uid the container user will actually be created with.</summary>
    public int EffectiveUid => Uid ?? FallbackUid;

    /// <summary>The gid the container user will actually be created with.</summary>
    public int EffectiveGid => Gid ?? FallbackUid;

    /// <summary>
    /// The host user as the container should know them.
    /// </summary>
    /// <remarks>
    /// On Linux and macOS the real uid and gid are read from <c>id</c>, so files
    /// the container writes into the bind-mounted worktree are owned by the
    /// person who started the session. On Windows there is no uid worth mapping
    /// — the boundary does not carry ownership across it — so only
    /// the name travels.
    /// </remarks>
    public static async Task<HostUser> DetectAsync(CancellationToken ct = default)
    {
        var name = Sanitise(Environment.UserName);

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return new HostUser(name, null, null);
        }

        var uid = await ReadIdAsync("-u", ct).ConfigureAwait(false);
        var gid = await ReadIdAsync("-g", ct).ConfigureAwait(false);
        return new HostUser(name, uid, gid);
    }

    private static async Task<int?> ReadIdAsync(string flag, CancellationToken ct)
    {
        try
        {
            var result = await ProcessRunner.RunAsync("id", [flag], ct: ct).ConfigureAwait(false);
            return result.Ok && int.TryParse(result.Output, out var value) ? value : null;
        }
        catch (ProcessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Reduce a host username to something <c>useradd</c> will accept.
    /// </summary>
    /// <remarks>
    /// Windows usernames routinely contain spaces, backslashes from a domain
    /// prefix, and capitals, none of which are legal in a Unix account name.
    /// </remarks>
    internal static string Sanitise(string name)
    {
        // A domain-qualified name is DOMAIN\user; the account is the tail.
        var tail = name.Split('\\', '/')[^1];

        var cleaned = new string([.. tail
            .ToLowerInvariant()
            .Select(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' ? c : '-')]).Trim('-');

        // Unix account names may not start with a digit.
        if (cleaned.Length > 0 && char.IsAsciiDigit(cleaned[0]))
        {
            cleaned = "u" + cleaned;
        }

        return cleaned.Length == 0 ? FallbackName : cleaned[..Math.Min(cleaned.Length, 32)];
    }
}
