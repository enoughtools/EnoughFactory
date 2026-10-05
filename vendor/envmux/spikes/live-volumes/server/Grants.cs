using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace Envmux.Live;

/// <summary>
/// What one holder of a key may see: which namespaces, and which entries within
/// them.
/// </summary>
/// <param name="Namespaces">
/// Tool namespaces this key reaches at all. Empty means none, and a task with
/// none is a task that should not have been given a key.
/// </param>
/// <param name="Entries">
/// Per namespace, the top-level names allowed. A namespace absent from here is
/// allowed whole; a namespace present is allowed only these.
/// </param>
internal sealed record Scope(
    IReadOnlySet<string> Namespaces,
    IReadOnlyDictionary<string, IReadOnlySet<string>> Entries)
{
    public static readonly Scope Nothing = new(
        new HashSet<string>(StringComparer.OrdinalIgnoreCase),
        new Dictionary<string, IReadOnlySet<string>>(StringComparer.OrdinalIgnoreCase));

    /// <summary>Whether this key reaches a path at all.</summary>
    /// <param name="ns">The namespace, or null for the root listing.</param>
    /// <param name="relative">The path within it, forward slashes.</param>
    public bool Allows(string? ns, string relative)
    {
        if (ns is null)
        {
            return true;
        }

        if (!Namespaces.Contains(ns))
        {
            return false;
        }

        if (!Entries.TryGetValue(ns, out var allowed) || relative.Length == 0)
        {
            return true;
        }

        var slash = relative.IndexOf('/', StringComparison.Ordinal);
        return allowed.Contains(slash < 0 ? relative : relative[..slash]);
    }

    /// <summary>
    /// Parse the scope written beside a task name: <c>claude</c>, or
    /// <c>claude:settings.json,plugins</c>, or several separated by <c>;</c>.
    /// An empty string is <see cref="Nothing"/>.
    /// </summary>
    public static Scope Parse(string text)
    {
        var namespaces = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var entries = new Dictionary<string, IReadOnlySet<string>>(StringComparer.OrdinalIgnoreCase);

        foreach (var part in text.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var colon = part.IndexOf(':', StringComparison.Ordinal);
            var name = colon < 0 ? part : part[..colon];

            namespaces.Add(name);

            if (colon >= 0)
            {
                entries[name] = new HashSet<string>(
                    part[(colon + 1)..].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
                    StringComparer.OrdinalIgnoreCase);
            }
        }

        return new Scope(namespaces, entries);
    }

    public override string ToString() =>
        Namespaces.Count == 0
            ? "nothing"
            : string.Join(
                "; ",
                Namespaces.OrderBy(n => n, StringComparer.Ordinal).Select(n =>
                    Entries.TryGetValue(n, out var e)
                        ? $"{n}:{string.Join(',', e.OrderBy(x => x, StringComparer.Ordinal))}"
                        : n));
}

/// <summary>One key, and what it is for.</summary>
/// <param name="Id">Names the grant in logs and in the revoke call. Not a secret.</param>
/// <param name="Task">The task it was minted for, as <c>.envmux.json</c> spells it.</param>
/// <param name="Scope">What it reaches.</param>
/// <param name="Expires">When it stops working, whether or not anything revoked it.</param>
internal sealed record Grant(string Id, string Task, Scope Scope, DateTimeOffset Expires);

/// <summary>
/// The keys this session has issued, one per task.
/// </summary>
/// <remarks>
/// <para>
/// A session is not one program. It is an agent, a dev server, a build, a
/// package install, and every shell anyone opens in the portal — and they are
/// not equally trusted. The install task runs a package manager's postinstall
/// scripts, which is the least trusted code on the machine, and it has no
/// business reading the credential the agent signs in with.
/// </para>
/// <para>
/// So the unit of authorisation is the task, not the session: each one is minted
/// a key of its own, scoped to what it was declared to need, and the key is
/// handed to it in its own environment rather than written anywhere both can
/// read. What stops a task using another's key is that it never sees it, and
/// what stops it using another's <em>mount</em> is that the mount is made inside
/// that task's own mount namespace — see <c>guest-enter.sh</c>. Both halves are
/// needed: a scoped key with a shared mountpoint authorises nothing, because the
/// kernel is already holding the files open on the other task's behalf.
/// </para>
/// <para>
/// Keys are stored hashed. The store is in the memory of a process that also
/// holds the plaintext it is handing out, so this is not a defence against
/// reading that process — it is so that a crash dump, a log line or a swapped
/// page does not carry the key, which is the way these actually leak.
/// </para>
/// </remarks>
internal sealed class Grants
{
    private readonly ConcurrentDictionary<string, Grant> _byKeyHash = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> _hashById = new(StringComparer.Ordinal);

    /// <summary>How long a key lives if nothing renews it.</summary>
    /// <remarks>
    /// Long enough for a working day, short enough that a key copied out of a
    /// container image or a captured environment is not still working next week.
    /// A task that outlives it renews; a task that ended does not, which is what
    /// makes expiry the backstop for a revoke that never came.
    /// </remarks>
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(12);

    /// <summary>Mint a key for a task. The plaintext is returned once and never stored.</summary>
    public (Grant Grant, string Key) Issue(string task, Scope scope, DateTimeOffset? expires = null)
    {
        var key = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var grant = new Grant(
            Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant(),
            task,
            scope,
            expires ?? DateTimeOffset.UtcNow + Lifetime);

        var hash = Hash(key);

        _byKeyHash[hash] = grant;
        _hashById[grant.Id] = hash;

        return (grant, key);
    }

    /// <summary>The grant a presented key belongs to, or null.</summary>
    /// <remarks>
    /// Looked up by the hash of what was presented rather than compared against
    /// each stored key in turn: one dictionary probe, no secret-dependent
    /// branching, and it stays one probe when a session has twenty tasks.
    /// </remarks>
    public Grant? Resolve(string? key)
    {
        if (string.IsNullOrEmpty(key) || !_byKeyHash.TryGetValue(Hash(key), out var grant))
        {
            return null;
        }

        if (grant.Expires <= DateTimeOffset.UtcNow)
        {
            Revoke(grant.Id);
            return null;
        }

        return grant;
    }

    /// <summary>Take a key out of service — a task that ended, or a session closing.</summary>
    public bool Revoke(string id)
    {
        if (!_hashById.TryRemove(id, out var hash))
        {
            return false;
        }

        _byKeyHash.TryRemove(hash, out _);
        return true;
    }

    public IReadOnlyList<Grant> All => [.. _byKeyHash.Values];

    private static string Hash(string key) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
}
