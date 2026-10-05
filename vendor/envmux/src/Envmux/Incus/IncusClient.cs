using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Security;
using System.Net.WebSockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.Json.Serialization;

using Envmux.Host;

namespace Envmux.Incus;

/// <summary>The host answered, and the answer was not what was asked for.</summary>
internal sealed class IncusException(string message, Exception? inner = null)
    : Backends.BackendException(message, inner)
{
    /// <summary>Incus' own error code, when it gave one.</summary>
    public int Code { get; init; }

    /// <summary>Whether this is "there is no such thing", which is often not a failure.</summary>
    public bool IsNotFound => Code == 404;
}

/// <summary>
/// One response from incusd, before anything has been made of it.
/// </summary>
/// <param name="Type">"sync", "async" or "error".</param>
/// <param name="StatusCode">Incus' own code, which is what control flow reads.</param>
/// <param name="Operation">The operation's URL, on an async response.</param>
/// <param name="Metadata">The payload, whatever it is this time.</param>
internal readonly record struct IncusResponse(
    string Type,
    int StatusCode,
    string Operation,
    JsonElement Metadata)
{
    public bool IsAsync => Type.Equals("async", StringComparison.Ordinal);

    /// <summary>The operation's id, which is the last segment of its URL.</summary>
    public string OperationId =>
        Operation.Length == 0 ? "" : Operation[(Operation.LastIndexOf('/') + 1)..];

    /// <summary>The metadata as something typed.</summary>
    /// <remarks>
    /// The failure is worth naming rather than letting through. Every model here
    /// is a partial view of what a daemon sends, and a daemon that changes the
    /// shape of a field nothing reads still throws when it lands — which is how
    /// `host trust` came to pin a fingerprint, print that it had worked, and then
    /// end in a stack trace about <c>storage_supported_drivers</c>. A message
    /// that says which field and which version is the difference between a bug
    /// report and a mystery.
    /// </remarks>
    public T? As<T>()
    {
        if (Metadata.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
        {
            return default;
        }

        try
        {
            return WireJson.Deserialize<T>(Metadata, IncusJson.Options);
        }
        catch (JsonException e)
        {
            throw new IncusException(
                $"incusd sent a {typeof(T).Name} envmux could not read: {e.Message} " +
                "This usually means the daemon is a newer version that has changed the shape of a field.",
                e);
        }
    }
}

/// <summary>How everything on the wire is shaped.</summary>
internal static class IncusJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        TypeInfoResolver = WireJsonContext.Default,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

/// <summary>
/// The authenticated connection to incusd, and the only place trust is decided.
/// </summary>
/// <remarks>
/// <para>
/// Two certificates, in opposite directions. Ours is pre-seeded into the host at
/// install time, so there is no trust-token exchange and no
/// <c>POST /1.0/certificates</c> in any normal path — the client is trusted
/// before the host has ever been booted. Theirs is self-signed, so there is no
/// chain to validate and the fingerprint is the whole of the decision.
/// </para>
/// <para>
/// Validation is never disabled. A callback that returns true is a client with
/// no authentication of the server at all, on a connection that carries the
/// credentials to create privileged containers — so the callback compares a
/// hash and refuses everything else, including on the very first connection.
/// Learning a fingerprint is a separate, explicit act:
/// <see cref="LearnFingerprintAsync"/>, reached only from <c>envmux host trust</c>.
/// </para>
/// </remarks>
internal sealed class IncusClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly X509Certificate2 _certificate;
    private readonly string _fingerprint;
    private bool _disposed;

    /// <summary>Where this is talking to, for a log line.</summary>
    public Uri BaseAddress { get; }

    /// <summary>The API version prefix everything but the OS endpoints sits under.</summary>
    public const string V1 = "/1.0";

    /// <summary>IncusOS' own endpoints, proxied through the same listener and the same trust.</summary>
    public const string Os = "/os/1.0";

    public const int DefaultPort = 8443;

    private IncusClient(Uri baseAddress, X509Certificate2 certificate, string fingerprint, TimeSpan timeout)
    {
        BaseAddress = baseAddress;
        _certificate = certificate;
        _fingerprint = fingerprint;

        var handler = new SocketsHttpHandler
        {
            SslOptions = new SslClientAuthenticationOptions
            {
                ClientCertificates = [certificate],
                RemoteCertificateValidationCallback = (_, presented, _, _) => Matches(presented, fingerprint),
            },

            // The exec path opens websockets against the same host and the
            // connection pool is shared with them. A pooled connection that has
            // been idle across a host reboot fails the next request rather than
            // reconnecting, and forty seconds is short enough that it does not.
            PooledConnectionIdleTimeout = TimeSpan.FromSeconds(40),
        };

        _http = new HttpClient(handler)
        {
            BaseAddress = baseAddress,
            Timeout = timeout,
        };

        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    }

    /// <summary>
    /// Open a connection from the host configuration.
    /// </summary>
    /// <exception cref="IncusException">There is no host configured yet.</exception>
    public static IncusClient Connect(HostConfig config, TimeSpan? timeout = null)
    {
        if (config.Api.Length == 0)
        {
            throw new IncusException(
                "no IncusOS host is configured. Run `envmux host build` and `envmux host trust` first.");
        }

        if (config.Fingerprint.Length == 0)
        {
            throw new IncusException(
                $"the certificate {config.Api} presents has never been pinned. " +
                "Run `envmux host trust` to look at it and decide.");
        }

        var certificate = ClientCertificate.Load(HostConfig.CertificatePath, HostConfig.KeyPath);

        return new IncusClient(
            new Uri($"https://{Authority(config.Api)}"),
            certificate,
            Normalise(config.Fingerprint),
            timeout ?? TimeSpan.FromSeconds(30));
    }

    /// <summary>The address with a port on it, since <c>host.json</c> may hold either form.</summary>
    public static string Authority(string api)
    {
        var value = api.Trim();

        if (value.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            value = value["https://".Length..].TrimEnd('/');
        }

        // A bare IPv6 address needs bracketing before a port can be appended,
        // and one that is already bracketed must not be bracketed twice.
        if (value.Contains(':', StringComparison.Ordinal) && !value.StartsWith('['))
        {
            return IPAddress.TryParse(value, out var v6) &&
                   v6.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6
                ? $"[{value}]:{DefaultPort.ToString(CultureInfo.InvariantCulture)}"
                : value;
        }

        return value.Contains(':', StringComparison.Ordinal)
            ? value
            : $"{value}:{DefaultPort.ToString(CultureInfo.InvariantCulture)}";
    }

    /// <summary>
    /// Look at what a host presents, without trusting it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The one call that connects without a pinned fingerprint, and it does
    /// nothing with the connection but read the certificate off it. Nothing is
    /// sent — not the client certificate, not a request, never a trust token —
    /// so an impostor answering here learns nothing and is handed nothing.
    /// </para>
    /// <para>
    /// What comes back is a fingerprint to be <em>checked</em>, by one of two
    /// things and never by this call. A person, shown it and asked. Or a trust
    /// token, which carries the fingerprint of the daemon that minted it:
    /// <c>envmux install --token</c> compares the two, pins on a match without
    /// asking, and refuses on a mismatch without asking. That is not a weaker
    /// check than the person. The token did not arrive over this connection — it
    /// came out of band, from the daemon's own command line, in the hands of
    /// whoever has a shell on that machine — so whatever answers here cannot
    /// have chosen the value it is being held to; and sixty-four hex digits
    /// compared by a machine are compared, where by eye they are mostly glanced
    /// at. What stays true either way is that the certificate learned here is
    /// trusted for nothing until something outside this connection has vouched
    /// for it.
    /// </para>
    /// </remarks>
    public static async Task<X509Certificate2> LearnFingerprintAsync(
        string api,
        CancellationToken ct = default)
    {
        var authority = Authority(api);
        var colon = authority.LastIndexOf(':');
        var host = authority[..colon].Trim('[', ']');
        var port = int.Parse(authority[(colon + 1)..], CultureInfo.InvariantCulture);

        using var tcp = new System.Net.Sockets.TcpClient();
        await tcp.ConnectAsync(host, port, ct).ConfigureAwait(false);

        X509Certificate2? presented = null;

        // The one place validation is skipped, and it is skipped because there
        // is nothing yet to validate against: this call exists to *obtain* the
        // fingerprint that a person, or a trust token's own copy of it, is then
        // asked to approve. Nothing is sent down this connection — no client
        // certificate, no request, no token — so an impostor answering here is
        // handed nothing and learns nothing, and what comes back is only ever
        // held up against something that arrived another way.
#pragma warning disable CA5359
        await using var tls = new SslStream(
            tcp.GetStream(),
            leaveInnerStreamOpen: false,
            (_, certificate, _, _) =>
            {
                presented = certificate is null
                    ? null
                    : X509CertificateLoader.LoadCertificate(certificate.GetRawCertData());

                return true;
            });
#pragma warning restore CA5359

        await tls.AuthenticateAsClientAsync(
            new SslClientAuthenticationOptions { TargetHost = host },
            ct).ConfigureAwait(false);

        return presented ?? throw new IncusException($"{api} completed a handshake without presenting a certificate");
    }

    /// <summary>Whether the certificate on the wire is the one that was pinned.</summary>
    private static bool Matches(X509Certificate? presented, string fingerprint) =>
        presented is not null &&
        Convert.ToHexStringLower(SHA256.HashData(presented.GetRawCertData()))
            .Equals(fingerprint, StringComparison.Ordinal);

    /// <summary>Fingerprints as Incus writes them: lowercase hex, no separators.</summary>
    public static string Normalise(string fingerprint) =>
        fingerprint.Replace(":", "", StringComparison.Ordinal)
                   .Replace(" ", "", StringComparison.Ordinal)
                   .Trim()
                   .ToLowerInvariant();

    public Task<IncusResponse> GetAsync(string path, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Get, path, null, ct);

    public Task<IncusResponse> PostAsync(string path, object? body, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, path, body, ct);

    public Task<IncusResponse> PutAsync(string path, object? body, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Put, path, body, ct);

    public Task<IncusResponse> PatchAsync(string path, object? body, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Patch, path, body, ct);

    public Task<IncusResponse> DeleteAsync(string path, object? body = null, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Delete, path, body, ct);

    /// <summary>
    /// One request, and its envelope unwrapped.
    /// </summary>
    /// <remarks>
    /// Incus answers everything in the same envelope — a type, a status code of
    /// its own, and a metadata blob — so the HTTP status is only ever a hint. An
    /// error is reported through <c>type: "error"</c> with a code and a
    /// sentence, and that sentence is nearly always the useful one.
    /// </remarks>
    private async Task<IncusResponse> SendAsync(
        HttpMethod method,
        string path,
        object? body,
        CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        using var request = new HttpRequestMessage(method, path);

        if (body is not null)
        {
            request.Content = WireJson.Content(body, IncusJson.Options);
        }

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException e) when (e.InnerException is AuthenticationException)
        {
            throw new IncusException(
                $"{BaseAddress.Authority} presented a certificate that is not the pinned one. " +
                "Either the host was rebuilt — run `envmux host trust` again — or this is not the host.",
                e);
        }
        catch (HttpRequestException e)
        {
            throw new IncusException($"{BaseAddress.Authority} is not answering: {e.Message}", e);
        }

        using (response)
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            if (text.Length == 0)
            {
                throw new IncusException(
                    $"{method} {path} answered {(int)response.StatusCode} with an empty body")
                {
                    Code = (int)response.StatusCode,
                };
            }

            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;

            var type = Text(root, "type") ?? "";

            // Incus reports an error two ways that mean the same thing: a
            // `type: "error"` envelope, and a non-zero `error_code` on any
            // envelope. Read the code once, and treat either signal as the error
            // it is.
            var errorCode = root.TryGetProperty("error_code", out var code) &&
                            code.ValueKind == JsonValueKind.Number
                ? code.GetInt32()
                : 0;

            if (type.Equals("error", StringComparison.Ordinal) || errorCode != 0)
            {
                throw new IncusException(Text(root, "error") ?? $"{method} {path} failed")
                {
                    Code = errorCode != 0 ? errorCode : (int)response.StatusCode,
                };
            }

            return new IncusResponse(
                type,
                root.TryGetProperty("status_code", out var status) && status.ValueKind == JsonValueKind.Number
                    ? status.GetInt32()
                    : (int)response.StatusCode,
                Text(root, "operation") ?? "",
                root.TryGetProperty("metadata", out var metadata) ? metadata.Clone() : default);
        }
    }

    /// <summary>
    /// Fetch a path as bytes, with its headers — for the files API.
    /// </summary>
    /// <remarks>
    /// The one family of endpoints that does not answer in the envelope: a file
    /// pull is the file, and the type of the thing pulled is in an
    /// <c>X-Incus-type</c> header rather than in a body.
    /// </remarks>
    public async Task<(byte[] Body, HttpResponseHeaders Headers)> GetRawAsync(
        string path,
        CancellationToken ct = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        using var response = await _http.GetAsync(path, ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw new IncusException(Explain(text, response.StatusCode)) { Code = (int)response.StatusCode };
        }

        return (await response.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false), response.Headers);
    }

    /// <summary>Send bytes to a path, with the headers the files API reads instead of a body.</summary>
    public async Task PostRawAsync(
        string path,
        ReadOnlyMemory<byte> body,
        IReadOnlyDictionary<string, string> headers,
        CancellationToken ct = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        using var content = new ReadOnlyMemoryContent(body);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = content };

        foreach (var (name, value) in headers)
        {
            request.Headers.TryAddWithoutValidation(name, value);
        }

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw new IncusException(Explain(text, response.StatusCode)) { Code = (int)response.StatusCode };
        }
    }

    /// <summary>
    /// Dial one of an operation's websockets.
    /// </summary>
    /// <remarks>
    /// The same client certificate and the same pinned fingerprint: the secrets
    /// in <c>metadata.fds</c> are one-time and scoped to the operation, but they
    /// are not authentication — the connection still has to be one incusd would
    /// have accepted anyway.
    /// </remarks>
    public async Task<ClientWebSocket> ConnectAsync(
        string operationId,
        string secret,
        CancellationToken ct = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        var socket = new ClientWebSocket();
        socket.Options.ClientCertificates.Add(_certificate);
        socket.Options.RemoteCertificateValidationCallback =
            (_, presented, _, _) => Matches(presented, _fingerprint);

        // Sixty seconds of silence on a PTY is a person thinking, not a dead
        // connection. The keepalive is what keeps a NAT between here and the VM
        // from reaping it while they do.
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);

        var uri = new Uri(
            $"wss://{BaseAddress.Authority}{V1}/operations/{operationId}/websocket?secret={Uri.EscapeDataString(secret)}");

        try
        {
            await socket.ConnectAsync(uri, ct).ConfigureAwait(false);
            return socket;
        }
        catch (WebSocketException e)
        {
            socket.Dispose();
            throw new IncusException($"could not attach to operation {operationId}: {e.Message}", e);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private static string Explain(string body, HttpStatusCode status)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            return Text(document.RootElement, "error") ?? $"{(int)status} {status}";
        }
        catch (JsonException)
        {
            return body.Length > 0 ? body.ReplaceLineEndings(" ").Trim() : $"{(int)status} {status}";
        }
    }

    private static string? Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _http.Dispose();
        _certificate.Dispose();
    }
}
