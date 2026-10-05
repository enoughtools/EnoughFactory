using System.Net.Http.Json;
using System.Text.Json;

namespace Envmux.Agents;

/// <summary>
/// The <c>agent</c> command as a client of a running session's portal.
/// </summary>
/// <remarks>
/// <para>
/// A headed session — the chef — serves the control surface for remote agents
/// on its portal: start one, list them, read the room, post to it, stop one.
/// The command line and the browser page are two clients of that one API, and
/// this is the command line's half.
/// </para>
/// <para>
/// It is used when it is <em>told where the portal is</em>: <c>--portal</c>, or
/// <c>ENVMUX_PORTAL</c>, carrying the link the session logged — token and all,
/// which is the only form in which the token is ever written down. There is no
/// discovery on purpose. Finding the portal's port is easy; finding its token
/// is not, and the alternatives — writing it to disk, or a second credential
/// for local processes — each weaken a promise the portal makes about the
/// token. Without a link, the command does the same work directly against the
/// same files, and the portal sees the result the next time it looks.
/// </para>
/// </remarks>
internal sealed class PortalClient : IDisposable
{
    /// <summary>The environment variable that names a running session's portal.</summary>
    public const string Variable = "ENVMUX_PORTAL";

    private readonly HttpClient _http;
    private readonly Uri _base;
    private readonly string _token;

    private PortalClient(Uri portal)
    {
        _base = new Uri(portal.GetLeftPart(UriPartial.Authority));
        _token = System.Web.HttpUtility.ParseQueryString(portal.Query).Get("k") ?? "";
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
    }

    /// <summary>A client for a portal link, or null when there is no link to use.</summary>
    /// <exception cref="AgentException">The link is not a URL.</exception>
    public static PortalClient? From(string? link)
    {
        var given = string.IsNullOrWhiteSpace(link) ? Environment.GetEnvironmentVariable(Variable) : link;

        if (string.IsNullOrWhiteSpace(given))
        {
            return null;
        }

        return Uri.TryCreate(given.Trim(), UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
            ? new PortalClient(uri)
            : throw new AgentException($"'{given}' is not a portal link — it should look like http://127.0.0.1:8080/?k=…");
    }

    public string Describe() => _base.ToString().TrimEnd('/');

    public Task<JsonElement> GetAsync(string path, CancellationToken ct = default) =>
        SendAsync(new HttpRequestMessage(HttpMethod.Get, Url(path)), ct);

    public Task<JsonElement> PostAsync(string path, object body, CancellationToken ct = default) =>
        SendAsync(new HttpRequestMessage(HttpMethod.Post, Url(path)) { Content = WireJson.Content(body, AgentRegistry.Json) }, ct);

    private Uri Url(string path) => new(_base, $"/api{path}");

    /// <summary>
    /// The token goes in the <c>Authorization</c> header, as a bearer.
    /// </summary>
    /// <remarks>
    /// It used to go on the query, which the gate still takes. A header is the
    /// better place for a client that is a program: it is not in the URL a
    /// proxy logs or a shell history keeps, and it is the same form the client
    /// in the instance uses, so the gate has one story about programs.
    /// </remarks>
    private async Task<JsonElement> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        if (_token.Length > 0)
        {
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _token);
        }

        HttpResponseMessage response;

        try
        {
            response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException e)
        {
            throw new AgentException($"the portal at {Describe()} is not answering: {e.Message}", e);
        }

        using (response)
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            {
                throw new AgentException(
                    $"the portal at {Describe()} refused the token. Use the link the session logged, with its ?k= on it.");
            }

            JsonElement body;

            try
            {
                body = text.Length > 0 ? JsonDocument.Parse(text).RootElement.Clone() : default;
            }
            catch (JsonException)
            {
                throw new AgentException($"the portal at {Describe()} answered {(int)response.StatusCode} with something that is not JSON");
            }

            if (!response.IsSuccessStatusCode)
            {
                var error = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("error", out var why)
                    ? why.GetString()
                    : null;

                throw new AgentException(error ?? $"the portal answered {(int)response.StatusCode}");
            }

            return body;
        }
    }

    public void Dispose() => _http.Dispose();
}
