using System.Globalization;
using System.Net;
using System.Text;

namespace Envmux.Socks;

/// <summary>
/// A loopback port the session expects something on, and what it knows about why nothing is there yet.
/// </summary>
/// <param name="Name">The route or task that serves it.</param>
/// <param name="Port">The port, inside the instance.</param>
/// <param name="Detail">What is happening, in a sentence: "task 'web' is waiting on install". Null when nothing is known.</param>
internal sealed record ExpectedPort(string Name, int Port, string? Detail);

/// <summary>
/// The page a browser gets for a port the session knows about but nothing is listening on yet.
/// </summary>
/// <remarks>
/// <para>
/// Without it, pressing <c>b</c> while the dev server is still installing shows
/// Chrome's "can't connect" page, and nobody knows whether to wait or to go and
/// look. The proxy is in the path and knows the difference: a port that a route
/// or a task's <c>ready</c> declares is one that is <em>coming</em>. So the
/// connection is accepted, the request is answered here with a 503 that says
/// what is starting, and the page polls its own URL until the answer is no
/// longer this page, then reloads into the real one.
/// </para>
/// <para>
/// A port nobody declared is still refused. Answering every empty port with a
/// page would turn a typo into a page that waits forever.
/// </para>
/// <para>
/// HTTP only. A client that opens with a TLS ClientHello (an https route) is
/// hung up on, because there is no certificate here to answer it with, and a
/// websocket upgrade gets a plain 503, which Vite's client and the like retry.
/// </para>
/// </remarks>
internal static class LoadingPage
{
    /// <summary>
    /// The header that marks a response as this page rather than the app.
    /// </summary>
    /// <remarks>
    /// Readable by the page's own poll because the poll is same-origin: it asks
    /// for the URL the page was served at.
    /// </remarks>
    public const string Header = "X-Envmux-Loading";

    /// <summary>How long the client has to send its request before it is dropped.</summary>
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);

    /// <summary>The most of a request head that is read. The page needs none of it but the method and the upgrade header.</summary>
    private const int MaxHead = 16 * 1024;

    /// <summary>A TLS record carrying a handshake starts with this byte.</summary>
    private const byte TlsHandshake = 0x16;

    /// <summary>Read the request, and answer it with the page, or hang up on TLS.</summary>
    public static async Task ServeAsync(Stream client, ExpectedPort expected, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(RequestTimeout);

        var head = await ReadHeadAsync(client, deadline.Token).ConfigureAwait(false);

        if (head is null)
        {
            return;
        }

        var response = IsUpgrade(head) ? Response(expected, html: false) : Response(expected, html: true);
        await client.WriteAsync(response, ct).ConfigureAwait(false);
        await client.FlushAsync(ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The request head as text, or null for TLS or a client that sent nothing.
    /// </summary>
    private static async Task<string?> ReadHeadAsync(Stream client, CancellationToken ct)
    {
        var buffer = new byte[MaxHead];
        var length = 0;

        while (length < buffer.Length)
        {
            var read = await client.ReadAsync(buffer.AsMemory(length), ct).ConfigureAwait(false);

            if (read == 0)
            {
                break;
            }

            if (length == 0 && buffer[0] == TlsHandshake)
            {
                return null;
            }

            length += read;

            if (buffer.AsSpan(0, length).IndexOf("\r\n\r\n"u8) >= 0)
            {
                break;
            }
        }

        return length == 0 ? null : Encoding.Latin1.GetString(buffer, 0, length);
    }

    private static bool IsUpgrade(string head) =>
        head.Split("\r\n").Any(line =>
            line.StartsWith("Upgrade:", StringComparison.OrdinalIgnoreCase) &&
            line.Contains("websocket", StringComparison.OrdinalIgnoreCase));

    /// <summary>The whole HTTP response: a 503 that says it is envmux's, and why.</summary>
    public static byte[] Response(ExpectedPort expected, bool html)
    {
        var body = Encoding.UTF8.GetBytes(html
            ? Html(expected)
            : $"envmux: {expected.Name} on port {expected.Port.ToString(CultureInfo.InvariantCulture)} is not up yet\n");

        var head = new StringBuilder()
            .Append("HTTP/1.1 503 Service Unavailable\r\n")
            .Append(CultureInfo.InvariantCulture, $"Content-Type: {(html ? "text/html" : "text/plain")}; charset=utf-8\r\n")
            .Append(CultureInfo.InvariantCulture, $"Content-Length: {body.Length}\r\n")
            .Append("Cache-Control: no-store\r\n")
            .Append("Retry-After: 1\r\n")
            .Append(CultureInfo.InvariantCulture, $"{Header}: 1\r\n")
            .Append("Connection: close\r\n")
            .Append("\r\n")
            .ToString();

        return [.. Encoding.ASCII.GetBytes(head), .. body];
    }

    /// <summary>
    /// The page.
    /// </summary>
    /// <remarks>
    /// Polls with <c>fetch</c> rather than reloading on a timer, so the tab does
    /// not flash every second and a form half-filled in another tab of the same
    /// app is not disturbed. It reloads once, when the answer stops carrying
    /// <see cref="Header"/>. A meta refresh covers a browser with scripts off.
    /// </remarks>
    public static string Html(ExpectedPort expected)
    {
        var name = WebUtility.HtmlEncode(expected.Name);
        var port = expected.Port.ToString(CultureInfo.InvariantCulture);
        var detail = expected.Detail is { Length: > 0 } d ? $"<p class=\"detail\">{WebUtility.HtmlEncode(d)}</p>" : "";

        return $$"""
            <!doctype html>
            <html lang="en">
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>envmux · starting {{name}}</title>
            <noscript><meta http-equiv="refresh" content="2"></noscript>
            <style>
              :root { color-scheme: light dark; --ink: #1f2328; --dim: #656d76; --bg: #ffffff; --accent: #0969da; }
              @media (prefers-color-scheme: dark) { :root { --ink: #e6edf3; --dim: #8d96a0; --bg: #0d1117; --accent: #4493f8; } }
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink);
                     font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
              main { padding: 2rem; max-width: 32rem; text-align: center; }
              .mark { font: 600 0.8rem/1 ui-monospace, "Cascadia Mono", monospace; letter-spacing: 0.2em; color: var(--dim); }
              h1 { font-size: 1.5rem; margin: 1rem 0 0.25rem; }
              .detail, .where { color: var(--dim); margin: 0.25rem 0; }
              .spinner { width: 2rem; height: 2rem; margin: 1.5rem auto 0; border-radius: 50%;
                         border: 3px solid color-mix(in srgb, var(--accent) 25%, transparent); border-top-color: var(--accent);
                         animation: spin 0.9s linear infinite; }
              @keyframes spin { to { transform: rotate(360deg); } }
              @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
            </style>
            </head>
            <body>
            <main>
              <div class="mark">ENVMUX</div>
              <h1>{{name}} is starting</h1>
              <p class="where">Nothing is listening on port {{port}} in the instance yet.</p>
              {{detail}}
              <div class="spinner" role="status" aria-label="waiting"></div>
            </main>
            <script>
              const poll = async () => {
                try {
                  const answer = await fetch(location.href, { cache: "no-store" })
                  if (!answer.headers.has("{{Header}}")) { location.reload(); return }
                } catch { /* the proxy or the session is gone for a moment; keep trying */ }
                setTimeout(poll, 1000)
              }
              setTimeout(poll, 1000)
            </script>
            </body>
            </html>
            """;
    }
}
