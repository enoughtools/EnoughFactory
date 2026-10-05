namespace Envmux.Routing;

/// <summary>
/// Moving a URL a server printed onto the address it is actually reached at.
/// </summary>
/// <remarks>
/// <para>
/// A server prints the address it bound — <c>https://localhost:17178/login?t=…</c>
/// — because that is the only address it knows. It is reachable from inside the
/// instance and from nowhere else, and the person reading the routes pane is
/// somewhere else. What they need is the same URL with the session's own name
/// where the bound address was: same scheme, same port, same path, and the
/// query byte for byte, because the query is where the token is.
/// </para>
/// <para>
/// String surgery rather than <see cref="Uri"/>, deliberately. <c>Uri</c> is a
/// parser, and a parser normalises — it lower-cases, it unescapes, it drops a
/// default port, it re-encodes a query — and a token that has been
/// <em>normalised</em> is a token that no longer opens the page. The host is
/// the only part being changed, so the host is the only part that is looked
/// at; everything either side of it is copied.
/// </para>
/// <para>
/// Only an address that means "this machine" is replaced. A server that
/// printed a real hostname was telling the truth about where it is, and
/// rewriting that would turn a working link into a broken one.
/// </para>
/// </remarks>
internal static class PinnedUrl
{
    /// <summary>
    /// <paramref name="printed"/> with its host replaced by <paramref name="hostname"/>,
    /// when its host was a loopback or wildcard address. Otherwise unchanged.
    /// </summary>
    public static string Rewrite(string printed, string hostname)
    {
        var scheme = printed.IndexOf("://", StringComparison.Ordinal);
        if (scheme < 0)
        {
            return printed;
        }

        // The authority runs from after the scheme to the first thing that is
        // not part of it. Anything past that is copied untouched.
        var start = scheme + 3;
        var end = printed.IndexOfAny(['/', '?', '#'], start);
        if (end < 0)
        {
            end = printed.Length;
        }

        var authority = printed.AsSpan(start, end - start);

        // user:pass@ is not something a dev server prints, but it is legal, and
        // the host is what comes after it.
        var at = authority.LastIndexOf('@');
        var hostStart = at < 0 ? 0 : at + 1;
        var hostAndPort = authority[hostStart..];

        ReadOnlySpan<char> host;

        if (hostAndPort.Length > 0 && hostAndPort[0] == '[')
        {
            // An IPv6 literal keeps its brackets, and the colons inside them are
            // not a port separator.
            var close = hostAndPort.IndexOf(']');
            if (close < 0)
            {
                return printed;
            }

            host = hostAndPort[..(close + 1)];
        }
        else
        {
            var colon = hostAndPort.LastIndexOf(':');
            host = colon < 0 ? hostAndPort : hostAndPort[..colon];
        }

        if (!IsThisMachine(host))
        {
            return printed;
        }

        var offset = start + hostStart;

        return string.Concat(printed.AsSpan(0, offset), hostname, printed.AsSpan(offset + host.Length));
    }

    /// <summary>
    /// Whether a host, as a server would print it, means "wherever I am".
    /// </summary>
    /// <remarks>
    /// The loopbacks, the two unspecified addresses, and the two wildcards
    /// Kestrel accepts in <c>ASPNETCORE_URLS</c> and echoes back. Anything in
    /// <c>127/8</c> counts, because a server told to bind <c>127.0.0.2</c>
    /// prints that, and it is loopback all the same.
    /// </remarks>
    internal static bool IsThisMachine(ReadOnlySpan<char> host)
    {
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
            host.Equals("0.0.0.0", StringComparison.Ordinal) ||
            host.Equals("[::]", StringComparison.Ordinal) ||
            host.Equals("[::1]", StringComparison.Ordinal) ||
            host.Equals("[0:0:0:0:0:0:0:0]", StringComparison.Ordinal) ||
            host.Equals("[0:0:0:0:0:0:0:1]", StringComparison.Ordinal) ||
            host.Equals("+", StringComparison.Ordinal) ||
            host.Equals("*", StringComparison.Ordinal))
        {
            return true;
        }

        if (!host.StartsWith("127.", StringComparison.Ordinal))
        {
            return false;
        }

        foreach (var c in host)
        {
            if (!char.IsAsciiDigit(c) && c != '.')
            {
                return false;
            }
        }

        return true;
    }
}
