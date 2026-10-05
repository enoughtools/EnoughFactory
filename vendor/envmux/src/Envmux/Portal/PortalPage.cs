namespace Envmux.Portal;

/// <summary>
/// The two pages the portal serves without the app being involved.
/// </summary>
/// <remarks>
/// Both are answers to "this is not going to work", and both have to be
/// readable in a browser that has just been handed a blank tab. They are here
/// as strings rather than as assets because the second one exists precisely for
/// the case where there are no assets.
/// </remarks>
internal static class PortalPage
{
    /// <summary>The same palette the routes page uses, so nothing arrives unstyled.</summary>
    private const string Style = """
        <style>
        :root{color-scheme:dark}
        body{background:#0a0118;color:#d8dce3;font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:0;padding:3rem 1.5rem}
        main{max-width:40rem;margin:0 auto}
        h1{color:#ff2bd6;font-size:1.1rem;letter-spacing:.18em;text-transform:uppercase;margin:0 0 1.5rem}
        p{color:#8d80ad;margin:0 0 1rem}
        code{color:#39ff14}
        </style>
        """;

    /// <summary>
    /// No token, or the wrong one.
    /// </summary>
    /// <remarks>
    /// It says where the right URL is rather than what the token is, which is
    /// the only useful thing it can say: whoever is reading this either has the
    /// terminal the session is running in, and the whole link is on it, or has
    /// no business here.
    /// </remarks>
    public static string Refused(string project, string session) =>
        $"""
         <!doctype html><meta charset=utf-8><title>envmux — {Escape(project)} / {Escape(session)}</title>{Style}
         <main>
         <h1>envmux — {Escape(project)} / {Escape(session)}</h1>
         <p>This session's portal wants its token.</p>
         <p>The whole link, token and all, is in the window envmux is running in — press
         <code>p</code> there to open it, or type <code>/portal</code> to have it written into the log.</p>
         <p>To serve it without one, set <code>portal.token</code> to <code>false</code> in
         <code>.envmux.json</code> — which hands a shell in this container to anything else running
         on this machine.</p>
         </main>
         """;

    /// <summary>
    /// The portal is on, and the page was never built.
    /// </summary>
    /// <remarks>
    /// Only ever seen in a working tree: a released build has the page in it or
    /// it did not release. Building envmux without Node is deliberately allowed,
    /// so this is what that trade looks like when you meet it.
    /// </remarks>
    public static string NotBuilt() =>
        $"""
         <!doctype html><meta charset=utf-8><title>envmux — portal not built</title>{Style}
         <main>
         <h1>envmux — portal not built</h1>
         <p>This build of envmux has no page in it. The session is running and its routes work;
         only this is missing.</p>
         <p>The page is built by <code>dotnet build</code> when Node is on PATH, and skipped when it
         is not. Install Node and build again, or build it yourself:</p>
         <p><code>npm --prefix src/Envmux/Portal/ui ci && npm --prefix src/Envmux/Portal/ui run build</code></p>
         </main>
         """;

    private static string Escape(string s) =>
        s.Replace("&", "&amp;", StringComparison.Ordinal)
         .Replace("<", "&lt;", StringComparison.Ordinal)
         .Replace(">", "&gt;", StringComparison.Ordinal)
         .Replace("\"", "&quot;", StringComparison.Ordinal);
}
