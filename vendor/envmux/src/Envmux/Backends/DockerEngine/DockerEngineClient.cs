using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Envmux.Backends.DockerEngine;

/// <summary>
/// The Docker Engine API over the engine's own pipe or socket.
/// </summary>
/// <remarks>
/// <para>
/// Ordinary requests go through one <see cref="HttpClient"/> whose connections
/// are opened by <see cref="EngineEndpoint.ConnectAsync"/> — the handler does
/// not care that the "socket" is a named pipe. The one thing that does not go
/// through it is a hijacked exec: see <see cref="HijackedStream"/>.
/// </para>
/// <para>
/// <b>The API version is negotiated once, lazily,</b> from the unversioned
/// <c>GET /version</c>, and every other path is prefixed with it. envmux asks
/// for <see cref="PreferredApi"/> — the version this was written and tested
/// against — so that an engine upgrade does not silently change the shape of
/// an answer; an engine that no longer offers it is spoken to at the oldest
/// version it does; and one older than <see cref="OldestApi"/> is refused with
/// the reason.
/// </para>
/// <para>
/// <b>What is an answer and what is an exception</b> follows the interface:
/// "no such thing" on a read or a remove is null or false, a network name
/// already taken is false, and everything else the engine refuses is a
/// <see cref="DockerEngineException"/> carrying its status and its own sentence.
/// </para>
/// </remarks>
internal sealed class DockerEngineClient : IDockerEngine
{
    /// <summary>Docker 25 (January 2024). Network names are checked for duplicates without being asked.</summary>
    public const string PreferredApi = "1.44";

    /// <summary>Docker 20.10 (December 2020). Older than this and envmux has never seen it work.</summary>
    public const string OldestApi = "1.41";

    /// <summary>How long a request that is not a stream may take. A stop waits out its own grace period on top.</summary>
    private static readonly TimeSpan UnaryTimeout = TimeSpan.FromSeconds(60);

    private readonly EngineEndpoint _endpoint;
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _negotiating = new(1, 1);
    private string? _api;
    private EngineVersion? _version;
    private bool _disposed;

    private DockerEngineClient(EngineEndpoint endpoint)
    {
        _endpoint = endpoint;

        var handler = new SocketsHttpHandler
        {
            ConnectCallback = async (_, ct) => await endpoint.ConnectAsync(ct).ConfigureAwait(false),

            // "http://docker" is a placeholder, and a system proxy would
            // cheerfully try to resolve it.
            UseProxy = false,

            // Docker Desktop restarts under people. A pooled connection to the
            // old engine fails the next request rather than reconnecting.
            PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
        };

        _http = new HttpClient(handler, disposeHandler: true)
        {
            BaseAddress = endpoint.BaseAddress,

            // A pull and a build take as long as they take; the requests that
            // should not are bounded one at a time, in SendAsync.
            Timeout = Timeout.InfiniteTimeSpan,
        };

        _http.DefaultRequestHeaders.UserAgent.ParseAdd("envmux");
    }

    /// <summary>
    /// A client for the engine at <paramref name="endpoint"/>, or the one the <c>docker</c> CLI would find.
    /// </summary>
    /// <remarks>
    /// Nothing is dialled here: resolving is reading two small files at most.
    /// The first request is what discovers whether anything is listening, and
    /// says so in one sentence when nothing is.
    /// </remarks>
    /// <param name="endpoint"><c>npipe://</c>, <c>unix://</c> or <c>tcp://</c>; null to resolve from <c>DOCKER_HOST</c>, the current docker context, then the platform's default.</param>
    /// <exception cref="DockerEngineException">The endpoint is not one envmux can speak to.</exception>
    public static DockerEngineClient Connect(string? endpoint = null) => new(EngineEndpoint.Resolve(endpoint));

    /// <summary>The same, for an endpoint already resolved.</summary>
    public static DockerEngineClient Connect(EngineEndpoint endpoint) => new(endpoint);

    public string Endpoint => _endpoint.Display;

    public async Task<EngineVersion> VersionAsync(CancellationToken ct = default)
    {
        await ApiAsync(ct).ConfigureAwait(false);
        return _version!;
    }

    /// <summary>
    /// Which API version to speak, given what the engine offers.
    /// </summary>
    /// <param name="newest">The engine's <c>ApiVersion</c>.</param>
    /// <param name="oldest">Its <c>MinAPIVersion</c>, when it said.</param>
    /// <param name="engine">Its product version, for the sentence.</param>
    /// <exception cref="DockerEngineException">The engine is older than envmux can use.</exception>
    public static string Negotiate(string newest, string? oldest, string engine)
    {
        if (!TryVersion(newest, out var offered))
        {
            throw new DockerEngineException(
                $"what answered did not say which Docker API it speaks (ApiVersion '{newest}') — is that a Docker engine?");
        }

        TryVersion(OldestApi, out var floor);
        TryVersion(PreferredApi, out var preferred);

        if (offered.CompareTo(floor) < 0)
        {
            throw new DockerEngineException(
                $"Docker {engine} speaks API {newest}, and envmux needs {OldestApi} or newer — that is Docker 20.10. Update Docker and try again.");
        }

        if (offered.CompareTo(preferred) < 0)
        {
            return newest;
        }

        // An engine that has retired the version envmux prefers is spoken to at
        // the oldest one it still has, which is the nearest to what was tested.
        return oldest is not null && TryVersion(oldest, out var minimum) && minimum.CompareTo(preferred) > 0
            ? oldest
            : PreferredApi;
    }

    // Containers.

    public async Task<IReadOnlyList<ContainerSummary>> ContainersAsync(
        IReadOnlyDictionary<string, string>? labels = null,
        bool all = true,
        CancellationToken ct = default)
    {
        var query = new List<string> { $"all={Bool(all)}" };
        AddFilter(query, labels);

        var reply = await SendAsync(HttpMethod.Get, Query("/containers/json", query), null, ct).ConfigureAwait(false);

        return [.. EngineJson.Items(reply.Json).Select(EngineJson.Summary)];
    }

    public async Task<ContainerInspect?> InspectAsync(string container, CancellationToken ct = default)
    {
        var reply = await SendAsync(HttpMethod.Get, $"/containers/{Escape(container)}/json", null, ct, tolerate: 404)
            .ConfigureAwait(false);

        return reply.Status == 404 ? null : EngineJson.Inspect(reply.Json);
    }

    public async Task<string> CreateContainerAsync(string name, ContainerCreate body, CancellationToken ct = default)
    {
        var reply = await SendAsync(
            HttpMethod.Post,
            $"/containers/create?name={Escape(name)}",
            Json(EngineJson.CreateBody(body)),
            ct).ConfigureAwait(false);

        return EngineJson.Text(reply.Json, "Id")
            ?? throw new DockerEngineException($"the engine created '{name}' and did not say what its id is");
    }

    public async Task StartAsync(string container, CancellationToken ct = default)
    {
        // 304 is "already started", which is what was wanted.
        await SendAsync(HttpMethod.Post, $"/containers/{Escape(container)}/start", null, ct, tolerate: 304)
            .ConfigureAwait(false);
    }

    public async Task StopAsync(string container, int timeoutSeconds = 10, CancellationToken ct = default)
    {
        // The engine holds the request open for the grace period, so the
        // request is allowed that long on top of its own.
        await SendAsync(
            HttpMethod.Post,
            $"/containers/{Escape(container)}/stop?t={timeoutSeconds.ToString(CultureInfo.InvariantCulture)}",
            null,
            ct,
            extra: TimeSpan.FromSeconds(Math.Max(0, timeoutSeconds)),
            tolerate: 304).ConfigureAwait(false);
    }

    public async Task<bool> RemoveAsync(
        string container,
        bool force = true,
        bool volumes = false,
        CancellationToken ct = default)
    {
        try
        {
            var reply = await SendAsync(
                HttpMethod.Delete,
                $"/containers/{Escape(container)}?force={Bool(force)}&v={Bool(volumes)}",
                null,
                ct,
                tolerate: 404).ConfigureAwait(false);

            return reply.Status != 404;
        }
        catch (DockerEngineException e) when (e.IsConflict && e.Message.Contains("already in progress", StringComparison.OrdinalIgnoreCase))
        {
            // Somebody else is removing it this instant. It is going, which is the answer.
            return true;
        }
    }

    public async Task<string> CommitAsync(string container, string repository, string tag, CancellationToken ct = default)
    {
        var reply = await SendAsync(
            HttpMethod.Post,
            $"/commit?container={Escape(container)}&repo={Escape(repository)}&tag={Escape(tag)}",
            Json(new JsonObject()),
            ct,
            extra: TimeSpan.FromMinutes(10)).ConfigureAwait(false);

        return EngineJson.Text(reply.Json, "Id")
            ?? throw new DockerEngineException($"the engine committed '{container}' and did not say what the image's id is");
    }

    public async Task<int> WaitAsync(string container, CancellationToken ct = default)
    {
        // As long as the container runs, so not through SendAsync and its clock.
        using var response = await OpenAsync(
            HttpMethod.Post,
            $"/containers/{Escape(container)}/wait?condition=not-running",
            null,
            ct).ConfigureAwait(false);

        await ThrowUnlessSuccessAsync(response, ct).ConfigureAwait(false);

        var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        try
        {
            using var document = JsonDocument.Parse(text);

            if (EngineJson.Text(EngineJson.Child(document.RootElement, "Error"), "Message") is { Length: > 0 } error)
            {
                throw new DockerEngineException($"waiting for '{container}' failed: {error}");
            }

            return EngineJson.Child(document.RootElement, "StatusCode").TryGetInt32(out var code)
                ? code
                : throw new DockerEngineException($"the engine waited for '{container}' and did not say how it ended");
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException)
        {
            throw new DockerEngineException($"the engine waited for '{container}' and answered with something that is not an exit code", e);
        }
    }

    // Exec.

    public async Task<string> ExecCreateAsync(string container, ExecCreate body, CancellationToken ct = default)
    {
        if (body.Cmd.Count == 0)
        {
            throw new DockerEngineException("an exec needs a command");
        }

        var api = await ApiAsync(ct).ConfigureAwait(false);

        var reply = await SendAsync(
            HttpMethod.Post,
            $"/containers/{Escape(container)}/exec",
            Json(EngineJson.ExecBody(body, consoleSize: AtLeast(api, "1.42"))),
            ct).ConfigureAwait(false);

        return EngineJson.Text(reply.Json, "Id")
            ?? throw new DockerEngineException("the engine created an exec and did not say what its id is");
    }

    public async Task<Stream> ExecStartAsync(string execId, bool tty, CancellationToken ct = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        var api = await ApiAsync(ct).ConfigureAwait(false);
        var body = new JsonObject { ["Detach"] = false, ["Tty"] = tty };

        return await HijackedStream
            .OpenAsync(_endpoint, $"/v{api}/exec/{Escape(execId)}/start", body.ToJsonString(), ct)
            .ConfigureAwait(false);
    }

    public async Task ExecResizeAsync(string execId, int columns, int rows, CancellationToken ct = default)
    {
        await SendAsync(
            HttpMethod.Post,
            $"/exec/{Escape(execId)}/resize?h={rows.ToString(CultureInfo.InvariantCulture)}&w={columns.ToString(CultureInfo.InvariantCulture)}",
            null,
            ct).ConfigureAwait(false);
    }

    public async Task<ExecInspect> ExecInspectAsync(string execId, CancellationToken ct = default)
    {
        var reply = await SendAsync(HttpMethod.Get, $"/exec/{Escape(execId)}/json", null, ct).ConfigureAwait(false);
        return EngineJson.Exec(reply.Json);
    }

    // Files.

    public async Task PutArchiveAsync(string container, string directory, Stream tar, CancellationToken ct = default)
    {
        var content = new StreamContent(tar);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/x-tar");

        using var response = await OpenAsync(
            HttpMethod.Put,
            $"/containers/{Escape(container)}/archive?path={Escape(directory)}",
            content,
            ct).ConfigureAwait(false);

        await ThrowUnlessSuccessAsync(response, ct).ConfigureAwait(false);
    }

    public async Task<Stream?> GetArchiveAsync(string container, string path, CancellationToken ct = default)
    {
        var response = await OpenAsync(
            HttpMethod.Get,
            $"/containers/{Escape(container)}/archive?path={Escape(path)}",
            null,
            ct).ConfigureAwait(false);

        try
        {
            if ((int)response.StatusCode == 404)
            {
                var failure = await FailureAsync(response, ct).ConfigureAwait(false);

                // Two different 404s behind one status. No such path is an
                // answer; no such container is somebody's mistake.
                if (failure.Message.Contains("No such container", StringComparison.OrdinalIgnoreCase))
                {
                    throw failure;
                }

                response.Dispose();
                return null;
            }

            await ThrowUnlessSuccessAsync(response, ct).ConfigureAwait(false);

            var body = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            return new ResponseStream(body, response);
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    // Networks.

    public async Task<IReadOnlyList<NetworkSummary>> NetworksAsync(
        IReadOnlyDictionary<string, string>? labels = null,
        CancellationToken ct = default)
    {
        var query = new List<string>();
        AddFilter(query, labels);

        var reply = await SendAsync(HttpMethod.Get, Query("/networks", query), null, ct).ConfigureAwait(false);

        return [.. EngineJson.Items(reply.Json).Select(EngineJson.Network)];
    }

    public Task<bool> CreateNetworkAsync(
        string name,
        IReadOnlyDictionary<string, string> labels,
        CancellationToken ct = default) =>
        CreateNetworkAsync(name, labels, subnet: null, gateway: null, ct);

    public async Task<bool> CreateNetworkAsync(
        string name,
        IReadOnlyDictionary<string, string> labels,
        string? subnet,
        string? gateway = null,
        CancellationToken ct = default)
    {
        var api = await ApiAsync(ct).ConfigureAwait(false);

        var body = new JsonObject
        {
            ["Name"] = name,
            ["Driver"] = "bridge",
        };

        if (!AtLeast(api, "1.44"))
        {
            // Before 1.44 a second network of the same name was allowed unless
            // this was said. After it, the check is not optional and the field
            // is deprecated.
            body["CheckDuplicate"] = true;
        }

        if (subnet is { Length: > 0 })
        {
            var pool = new JsonObject { ["Subnet"] = subnet };

            if (gateway is { Length: > 0 })
            {
                pool["Gateway"] = gateway;
            }

            body["IPAM"] = new JsonObject { ["Driver"] = "default", ["Config"] = new JsonArray(pool) };
        }

        if (labels.Count > 0)
        {
            var map = new JsonObject();

            foreach (var pair in labels)
            {
                map[pair.Key] = pair.Value;
            }

            body["Labels"] = map;
        }

        var reply = await SendAsync(HttpMethod.Post, "/networks/create", Json(body), ct, tolerate: 409)
            .ConfigureAwait(false);

        return reply.Status != 409;
    }

    public async Task<bool> RemoveNetworkAsync(string name, CancellationToken ct = default)
    {
        var reply = await SendAsync(HttpMethod.Delete, $"/networks/{Escape(name)}", null, ct, tolerate: 404)
            .ConfigureAwait(false);

        return reply.Status != 404;
    }

    // Volumes.

    public async Task<IReadOnlyList<VolumeSummary>> VolumesAsync(
        IReadOnlyDictionary<string, string>? labels = null,
        CancellationToken ct = default)
    {
        var query = new List<string>();
        AddFilter(query, labels);

        var reply = await SendAsync(HttpMethod.Get, Query("/volumes", query), null, ct).ConfigureAwait(false);

        return [.. EngineJson.Items(EngineJson.Child(reply.Json, "Volumes")).Select(EngineJson.Volume)];
    }

    public async Task CreateVolumeAsync(
        string name,
        IReadOnlyDictionary<string, string> labels,
        CancellationToken ct = default)
    {
        var map = new JsonObject();

        foreach (var pair in labels)
        {
            map[pair.Key] = pair.Value;
        }

        // Creating a volume that exists is not an error to the engine: it
        // answers with the one that is there, labels unchanged.
        await SendAsync(
            HttpMethod.Post,
            "/volumes/create",
            Json(new JsonObject { ["Name"] = name, ["Labels"] = map }),
            ct).ConfigureAwait(false);
    }

    public async Task<bool> RemoveVolumeAsync(string name, CancellationToken ct = default)
    {
        var reply = await SendAsync(HttpMethod.Delete, $"/volumes/{Escape(name)}", null, ct, tolerate: 404)
            .ConfigureAwait(false);

        return reply.Status != 404;
    }

    // Images.

    public async Task<ImageInspect?> ImageAsync(string reference, CancellationToken ct = default)
    {
        var reply = await SendAsync(HttpMethod.Get, $"/images/{Reference(reference)}/json", null, ct, tolerate: 404)
            .ConfigureAwait(false);

        return reply.Status == 404 ? null : EngineJson.Image(reply.Json);
    }

    public async Task<IReadOnlyList<ImageInspect>> ImagesAsync(
        IReadOnlyDictionary<string, string>? labels = null,
        CancellationToken ct = default)
    {
        var query = new List<string>();
        AddFilter(query, labels);

        var reply = await SendAsync(HttpMethod.Get, Query("/images/json", query), null, ct).ConfigureAwait(false);

        return [.. EngineJson.Items(reply.Json).Select(EngineJson.ImageRow)];
    }

    public async Task PullAsync(string reference, Action<string>? report = null, CancellationToken ct = default)
    {
        var (repository, tag) = EngineJson.SplitReference(reference);

        using var response = await OpenAsync(
            HttpMethod.Post,
            $"/images/create?fromImage={Escape(repository)}&tag={Escape(tag)}",
            null,
            ct).ConfigureAwait(false);

        await ThrowUnlessSuccessAsync(response, ct).ConfigureAwait(false);

        // A pull that fails half way has already answered 200. The failure is
        // a line in the stream, and ProgressAsync is what turns it back into one.
        await ProgressAsync(response, $"pulling {reference}", report, ct).ConfigureAwait(false);
    }

    public async Task BuildAsync(
        Stream tarContext,
        string tag,
        IReadOnlyDictionary<string, string>? labels = null,
        Action<string>? report = null,
        CancellationToken ct = default)
    {
        // version=1 is the classic builder. BuildKit wants a gRPC session
        // tunnelled back over a second hijacked connection, which is a client
        // library's worth of protocol; the classic one is a tar in and lines out.
        var query = new List<string> { $"t={Escape(tag)}", "rm=1", "forcerm=1", "version=1" };

        if (labels is { Count: > 0 })
        {
            var map = new JsonObject();

            foreach (var pair in labels)
            {
                map[pair.Key] = pair.Value;
            }

            query.Add($"labels={Escape(map.ToJsonString())}");
        }

        var content = new StreamContent(tarContext);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/x-tar");

        using var response = await OpenAsync(HttpMethod.Post, Query("/build", query), content, ct).ConfigureAwait(false);

        await ThrowUnlessSuccessAsync(response, ct).ConfigureAwait(false);
        await ProgressAsync(response, $"building {tag}", report, ct).ConfigureAwait(false);
    }

    public async Task<bool> RemoveImageAsync(string reference, CancellationToken ct = default)
    {
        var reply = await SendAsync(HttpMethod.Delete, $"/images/{Reference(reference)}", null, ct, tolerate: 404)
            .ConfigureAwait(false);

        return reply.Status != 404;
    }

    public ValueTask DisposeAsync()
    {
        if (!_disposed)
        {
            _disposed = true;
            _http.Dispose();
            _negotiating.Dispose();
        }

        return ValueTask.CompletedTask;
    }

    // The wire.

    private readonly record struct Reply(int Status, JsonElement Json);

    /// <summary>The version prefix, asking the engine the first time.</summary>
    private async ValueTask<string> ApiAsync(CancellationToken ct)
    {
        if (_api is { } known)
        {
            return known;
        }

        ObjectDisposedException.ThrowIf(_disposed, this);
        await _negotiating.WaitAsync(ct).ConfigureAwait(false);

        try
        {
            if (_api is null)
            {
                var reply = await SendRawAsync(HttpMethod.Get, "/version", null, ct).ConfigureAwait(false);
                var version = EngineJson.Version(reply.Json);

                var api = Negotiate(version.ApiVersion, EngineJson.Text(reply.Json, "MinAPIVersion"), version.Version);
                _version = version;
                _api = api;
            }

            return _api;
        }
        finally
        {
            _negotiating.Release();
        }
    }

    /// <summary>One request and its whole answer, read as JSON.</summary>
    /// <param name="tolerate">Statuses that are answers here rather than failures; the caller reads <c>Status</c>.</param>
    private async Task<Reply> SendAsync(
        HttpMethod method,
        string path,
        HttpContent? content,
        CancellationToken ct,
        TimeSpan extra = default,
        params int[] tolerate)
    {
        var api = await ApiAsync(ct).ConfigureAwait(false);
        return await SendRawAsync(method, $"/v{api}{path}", content, ct, extra, tolerate).ConfigureAwait(false);
    }

    private async Task<Reply> SendRawAsync(
        HttpMethod method,
        string path,
        HttpContent? content,
        CancellationToken ct,
        TimeSpan extra = default,
        params int[] tolerate)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        using var patience = CancellationTokenSource.CreateLinkedTokenSource(ct);
        patience.CancelAfter(UnaryTimeout + extra);

        try
        {
            using var request = new HttpRequestMessage(method, path) { Content = content };
            using var response = await DispatchAsync(request, HttpCompletionOption.ResponseContentRead, patience.Token).ConfigureAwait(false);

            var status = (int)response.StatusCode;
            var text = await response.Content.ReadAsStringAsync(patience.Token).ConfigureAwait(false);

            if (Array.IndexOf(tolerate, status) >= 0)
            {
                return new Reply(status, default);
            }

            if (!response.IsSuccessStatusCode)
            {
                throw Failure(method, path, status, text);
            }

            if (text.Length == 0)
            {
                return new Reply(status, default);
            }

            try
            {
                using var document = JsonDocument.Parse(text);
                return new Reply(status, document.RootElement.Clone());
            }
            catch (JsonException e)
            {
                throw new DockerEngineException(
                    $"{method} {path} answered with something that is not JSON — is that a Docker engine on {Endpoint}?", e)
                {
                    Status = status,
                };
            }
        }
        catch (OperationCanceledException e) when (!ct.IsCancellationRequested)
        {
            throw new DockerEngineException($"Docker on {Endpoint} did not answer {method} {path} in time", e);
        }
    }

    /// <summary>A request whose body is a stream: the caller owns the response and reads it as it arrives.</summary>
    private async Task<HttpResponseMessage> OpenAsync(HttpMethod method, string path, HttpContent? content, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        var api = await ApiAsync(ct).ConfigureAwait(false);

        using var request = new HttpRequestMessage(method, $"/v{api}{path}") { Content = content };
        return await DispatchAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
    }

    private async Task<HttpResponseMessage> DispatchAsync(
        HttpRequestMessage request,
        HttpCompletionOption completion,
        CancellationToken ct)
    {
        try
        {
            return await _http.SendAsync(request, completion, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException e)
        {
            // The connect callback has already said it in a sentence; the
            // handler wraps that sentence in one of its own.
            for (Exception? inner = e; inner is not null; inner = inner.InnerException)
            {
                if (inner is DockerEngineException said)
                {
                    throw new DockerEngineException(said.Message, e);
                }
            }

            throw new DockerEngineException($"Docker is not answering on {Endpoint}: {e.Message}", e);
        }
        catch (IOException e)
        {
            throw new DockerEngineException($"the connection to Docker on {Endpoint} broke: {e.Message}", e);
        }
    }

    private static async Task ThrowUnlessSuccessAsync(HttpResponseMessage response, CancellationToken ct)
    {
        if (!response.IsSuccessStatusCode)
        {
            throw await FailureAsync(response, ct).ConfigureAwait(false);
        }
    }

    private static async Task<DockerEngineException> FailureAsync(HttpResponseMessage response, CancellationToken ct)
    {
        var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        var request = response.RequestMessage;

        return Failure(request?.Method ?? HttpMethod.Get, request?.RequestUri?.PathAndQuery ?? "", (int)response.StatusCode, text);
    }

    /// <summary>The engine's refusal as an exception: its own sentence, and the status control flow reads.</summary>
    public static DockerEngineException Failure(HttpMethod method, string path, int status, string body) =>
        new(EngineJson.ErrorMessage(body) ?? $"{method} {path} answered {status.ToString(CultureInfo.InvariantCulture)}")
        {
            Status = status,
        };

    /// <summary>
    /// Read a pull's or a build's line-delimited JSON to its end.
    /// </summary>
    /// <remarks>
    /// Both answer 200 before any work is done, so a failure arrives as a line
    /// with an <c>errorDetail</c> in it and is thrown from here. A layer's
    /// download reports dozens of times a second; what is passed on is each
    /// layer's change of status, which is what a person reads.
    /// </remarks>
    private static async Task ProgressAsync(
        HttpResponseMessage response,
        string doing,
        Action<string>? report,
        CancellationToken ct)
    {
        var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);

        await foreach (var line in ProgressLinesAsync(stream, doing, ct).ConfigureAwait(false))
        {
            report?.Invoke(line);
        }
    }

    /// <summary>The lines worth showing out of a progress stream; throws on the line that is a failure.</summary>
    public static async IAsyncEnumerable<string> ProgressLinesAsync(
        Stream stream,
        string doing,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var last = new Dictionary<string, string>(StringComparer.Ordinal);

        while (await reader.ReadLineAsync(ct).ConfigureAwait(false) is { } raw)
        {
            if (raw.Length == 0)
            {
                continue;
            }

            JsonDocument document;

            try
            {
                document = JsonDocument.Parse(raw);
            }
            catch (JsonException)
            {
                continue;
            }

            using (document)
            {
                var root = document.RootElement;

                var error = EngineJson.Text(EngineJson.Child(root, "errorDetail"), "message") ?? EngineJson.Text(root, "error");

                if (error is not null)
                {
                    throw new DockerEngineException($"{doing} failed: {error.Trim()}");
                }

                // A build speaks in "stream", a chunk of its console at a time.
                if (EngineJson.Text(root, "stream") is { } console)
                {
                    foreach (var piece in console.ReplaceLineEndings("\n").Split('\n'))
                    {
                        if (piece.Trim().Length > 0)
                        {
                            yield return piece.TrimEnd();
                        }
                    }

                    continue;
                }

                // A pull speaks in "status", per layer.
                if (EngineJson.Text(root, "status") is { Length: > 0 } status)
                {
                    var id = EngineJson.Text(root, "id") ?? "";

                    if (last.TryGetValue(id, out var previous) && previous.Equals(status, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    last[id] = status;
                    yield return id.Length == 0 ? status : $"{id}: {status}";
                }
            }
        }
    }

    private static StringContent Json(JsonNode body) =>
        new(body.ToJsonString(), Encoding.UTF8, "application/json");

    private static string Escape(string value) => Uri.EscapeDataString(value);

    /// <summary>An image reference in a path: its slashes are the path's, as the CLI sends them.</summary>
    private static string Reference(string reference) =>
        string.Join('/', reference.Split('/').Select(Uri.EscapeDataString));

    private static string Bool(bool value) => value ? "true" : "false";

    private static string Query(string path, List<string> query) =>
        query.Count == 0 ? path : $"{path}?{string.Join('&', query)}";

    private static void AddFilter(List<string> query, IReadOnlyDictionary<string, string>? labels)
    {
        if (EngineJson.LabelFilter(labels) is { } filter)
        {
            query.Add($"filters={Escape(filter)}");
        }
    }

    private static bool AtLeast(string api, string wanted) =>
        TryVersion(api, out var have) && TryVersion(wanted, out var want) && have.CompareTo(want) >= 0;

    /// <summary>"1.44" as something that compares: 1.9 is older than 1.10, which a string does not know.</summary>
    private static bool TryVersion(string text, out (int Major, int Minor) version)
    {
        version = default;
        var parts = text.Split('.');

        if (parts.Length == 2 &&
            int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var major) &&
            int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var minor))
        {
            version = (major, minor);
            return true;
        }

        return false;
    }

    /// <summary>A response's body as a stream that takes the response with it when it goes.</summary>
    private sealed class ResponseStream(Stream body, HttpResponseMessage response) : Stream
    {
        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => body.Read(buffer, offset, count);

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            body.ReadAsync(buffer, cancellationToken);

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            body.ReadAsync(buffer, offset, count, cancellationToken);

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                body.Dispose();
                response.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}
