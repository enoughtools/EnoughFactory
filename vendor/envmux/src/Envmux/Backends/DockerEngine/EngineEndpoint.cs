using System.Globalization;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Envmux.Backends.DockerEngine;

/// <summary>How an engine is reached: a named pipe, a unix socket, or plain TCP.</summary>
internal enum EngineTransport
{
    Pipe,
    Unix,
    Tcp,
}

/// <summary>
/// Where a Docker engine listens, and how to open one connection to it.
/// </summary>
/// <remarks>
/// <para>
/// Resolved the way the <c>docker</c> CLI resolves it, without running the CLI:
/// what was asked for, then <c>DOCKER_HOST</c>, then the current context in
/// <c>~/.docker/config.json</c>, then the platform's default. The context
/// matters on Windows: Docker Desktop's own context points at
/// <c>dockerDesktopLinuxEngine</c>, and a machine switched to Windows
/// containers has a <c>docker_engine</c> pipe that is a different engine.
/// </para>
/// <para>
/// EnoughFactory's managed mode instead requires its explicit private engine
/// endpoint and never consults a backend record, ambient Docker settings,
/// the user's context or a platform default.
/// </para>
/// <para>
/// Not to be confused with <see cref="Envmux.Docker.ShimEndpoint"/>, which is
/// the pipe envmux <em>serves</em> for VS Code. This is the one it dials.
/// </para>
/// </remarks>
/// <param name="Transport">Which kind of connection.</param>
/// <param name="Address">The pipe's name, the socket's path, or <c>host:port</c>.</param>
internal sealed record EngineEndpoint(EngineTransport Transport, string Address)
{
    public const string DefaultPipe = "docker_engine";

    public const string DefaultSocket = "/var/run/docker.sock";

    public const int DefaultTcpPort = 2375;

    /// <summary>The endpoint as <c>DOCKER_HOST</c> would spell it.</summary>
    public string Display => Transport switch
    {
        EngineTransport.Pipe => $"npipe:////./pipe/{Address}",
        EngineTransport.Unix => $"unix://{Address}",
        _ => $"tcp://{Address}",
    };

    /// <summary>What an HTTP request is addressed to. Only TCP has a real authority; the others need a placeholder.</summary>
    public Uri BaseAddress => Transport == EngineTransport.Tcp ? new Uri($"http://{Address}") : new Uri("http://docker");

    /// <summary>The <c>Host</c> header of a request written by hand.</summary>
    public string HostHeader => Transport == EngineTransport.Tcp ? Address : "docker";

    /// <summary>Resolve against this process's environment and this user's home.</summary>
    public static EngineEndpoint Resolve(string? endpoint = null) =>
        Resolve(
            endpoint,
            Environment.GetEnvironmentVariable,
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            OperatingSystem.IsWindows());

    /// <summary>The same, with the environment, the home directory and the platform handed in.</summary>
    /// <exception cref="DockerEngineException">An endpoint envmux cannot speak to, said plainly.</exception>
    public static EngineEndpoint Resolve(string? endpoint, Func<string, string?> environment, string home, bool windows)
    {
        var managed = environment("ENVMUX_MANAGED_DOCKER");
        if (!string.IsNullOrEmpty(managed))
        {
            if (managed != "1")
            {
                throw new DockerEngineException("ENVMUX_MANAGED_DOCKER must be 1 when EnoughFactory owns the engine; unset it for ordinary envmux resolution.");
            }

            return Managed(environment("ENVMUX_DOCKER_HOST"), windows);
        }

        if (!string.IsNullOrWhiteSpace(endpoint))
        {
            return Parse(endpoint, "the configured endpoint");
        }

        if (environment("DOCKER_HOST") is { Length: > 0 } host)
        {
            RefuseTls(environment, "DOCKER_HOST");
            return Parse(host, "DOCKER_HOST");
        }

        // DOCKER_CONTEXT beats the file, as it does for the CLI.
        var context = environment("DOCKER_CONTEXT") is { Length: > 0 } named ? named : CurrentContext(home);

        if (context is not null && !context.Equals("default", StringComparison.Ordinal) &&
            ContextHost(home, context) is { } fromContext)
        {
            return Parse(fromContext, $"the docker context '{context}'");
        }

        return windows
            ? new EngineEndpoint(EngineTransport.Pipe, DefaultPipe)
            : new EngineEndpoint(EngineTransport.Unix, DefaultSocket);
    }

    /// <summary>Read the required manager endpoint without Docker's fallback resolution.</summary>
    private static EngineEndpoint Managed(string? endpoint, bool windows)
    {
        const string Scheme = "unix://";
        if (windows)
        {
            throw new DockerEngineException("EnoughFactory's managed Docker engine currently requires Mac or Linux and an absolute unix socket.");
        }

        if (string.IsNullOrWhiteSpace(endpoint) || endpoint != endpoint.Trim() ||
            !endpoint.StartsWith(Scheme, StringComparison.OrdinalIgnoreCase))
        {
            throw new DockerEngineException("ENVMUX_DOCKER_HOST is required in managed mode and must name an absolute unix socket; Docker configuration and defaults are not used.");
        }

        var path = endpoint[Scheme.Length..];
        if (!path.StartsWith('/') || path.Length < 2 || path.Any(char.IsControl) ||
            path.Contains('?') || path.Contains('#') || path.Split('/').Skip(1).Any(part => part.Length == 0 || part is "." or ".."))
        {
            throw new DockerEngineException("ENVMUX_DOCKER_HOST must name an absolute, unambiguous unix socket path; managed mode has no default endpoint.");
        }

        return new EngineEndpoint(EngineTransport.Unix, path);
    }

    /// <summary>Read one <c>DOCKER_HOST</c>-shaped value.</summary>
    /// <exception cref="DockerEngineException">A scheme envmux does not speak, or a value with nothing in it.</exception>
    public static EngineEndpoint Parse(string value, string source)
    {
        var text = value.Trim();

        if (text.StartsWith("npipe://", StringComparison.OrdinalIgnoreCase))
        {
            // npipe:////./pipe/docker_engine — and, because people type it, npipe://./pipe/… and backslashes.
            var rest = text["npipe://".Length..].Replace('\\', '/').TrimStart('/');
            const string Prefix = "./pipe/";

            if (rest.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase) && rest.Length > Prefix.Length)
            {
                return new EngineEndpoint(EngineTransport.Pipe, rest[Prefix.Length..]);
            }

            throw new DockerEngineException(
                $"{source} is '{value}', which does not name a pipe. It looks like npipe:////./pipe/docker_engine.");
        }

        if (text.StartsWith("unix://", StringComparison.OrdinalIgnoreCase))
        {
            var path = text["unix://".Length..];

            return path.Length > 0
                ? new EngineEndpoint(EngineTransport.Unix, path)
                : new EngineEndpoint(EngineTransport.Unix, DefaultSocket);
        }

        if (text.StartsWith("tcp://", StringComparison.OrdinalIgnoreCase) ||
            text.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
        {
            var authority = text[(text.IndexOf("://", StringComparison.Ordinal) + 3)..].TrimEnd('/');

            if (authority.Length == 0)
            {
                throw new DockerEngineException($"{source} is '{value}', which names no host.");
            }

            if (!Uri.TryCreate($"http://{authority}", UriKind.Absolute, out var local) ||
                local.UserInfo.Length > 0 || local.AbsolutePath != "/" || local.Query.Length > 0 || local.Fragment.Length > 0 ||
                !(string.Equals(local.Host, "localhost", StringComparison.OrdinalIgnoreCase) ||
                  (System.Net.IPAddress.TryParse(local.Host.Trim('[', ']'), out var address) && System.Net.IPAddress.IsLoopback(address))))
            {
                throw new DockerEngineException($"{source} must name a loopback Docker engine; remote plain TCP exposes engine control and credentials. Use a local pipe or socket, or the pinned Incus backend.");
            }

            // A port is what follows the last colon — unless that colon is inside an IPv6 literal.
            var colon = authority.LastIndexOf(':');
            var hasPort = colon > authority.LastIndexOf(']');

            return new EngineEndpoint(
                EngineTransport.Tcp,
                hasPort ? authority : $"{authority}:{DefaultTcpPort.ToString(CultureInfo.InvariantCulture)}");
        }

        if (text.StartsWith("ssh://", StringComparison.OrdinalIgnoreCase))
        {
            throw new DockerEngineException(
                $"{source} is '{value}'. envmux speaks to a Docker engine on this machine — a pipe, a socket or tcp:// — and not over ssh.");
        }

        throw new DockerEngineException(
            $"{source} is '{value}', which is not an endpoint envmux understands. It wants npipe://, unix:// or tcp://.");
    }

    /// <summary>
    /// Open one connection.
    /// </summary>
    /// <exception cref="DockerEngineException">Nothing is listening there — the one sentence a person needs.</exception>
    public async ValueTask<Stream> ConnectAsync(CancellationToken ct)
    {
        try
        {
            switch (Transport)
            {
                case EngineTransport.Pipe:
                    return await ConnectPipeAsync(ct).ConfigureAwait(false);

                case EngineTransport.Unix:
                    {
                        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);

                        try
                        {
                            await socket.ConnectAsync(new UnixDomainSocketEndPoint(Address), ct).ConfigureAwait(false);
                            return new NetworkStream(socket, ownsSocket: true);
                        }
                        catch
                        {
                            socket.Dispose();
                            throw;
                        }
                    }

                default:
                    {
                        var colon = Address.LastIndexOf(':');
                        var host = Address[..colon].Trim('[', ']');
                        var port = int.Parse(Address[(colon + 1)..], CultureInfo.InvariantCulture);
                        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };

                        try
                        {
                            await socket.ConnectAsync(host, port, ct).ConfigureAwait(false);
                            return new NetworkStream(socket, ownsSocket: true);
                        }
                        catch
                        {
                            socket.Dispose();
                            throw;
                        }
                    }
            }
        }
        catch (Exception e) when (e is SocketException or IOException or TimeoutException or UnauthorizedAccessException or FormatException)
        {
            throw NotAnswering(e);
        }
    }

    /// <summary>The sentence for "nothing is there", which is nearly always Docker Desktop not running.</summary>
    public DockerEngineException NotAnswering(Exception? inner = null)
    {
        var hint = Transport switch
        {
            EngineTransport.Pipe => "is Docker Desktop running?",
            EngineTransport.Unix => "is the Docker daemon running, and may this user open its socket?",
            _ => "is the engine listening there?",
        };

        return inner is UnauthorizedAccessException
            ? new DockerEngineException($"Docker refused this user on {Display} — access to the engine is denied.", inner)
            : new DockerEngineException($"Docker is not answering on {Display} — {hint}", inner);
    }

    private async ValueTask<Stream> ConnectPipeAsync(CancellationToken ct)
    {
        // A pipe exists exactly while a server is listening on it, and
        // NamedPipeClientStream waits out its whole timeout for one that does
        // not. Looking first turns "Docker Desktop is not running" from a
        // pause into an answer. A listing, and not File.Exists, which would
        // open the pipe and use up one of the server's instances.
        if (OperatingSystem.IsWindows() && !PipeExists(Address))
        {
            throw NotAnswering();
        }

        // Asynchronous is not optional: a hijacked exec reads and writes at
        // once, and a synchronous pipe handle serialises the two — the read
        // that is waiting for output blocks the write that would produce it.
        var pipe = new NamedPipeClientStream(".", Address, PipeDirection.InOut, PipeOptions.Asynchronous);

        try
        {
            // The pipe is there, so what is being waited for is a free
            // instance of it while the engine is busy.
            await pipe.ConnectAsync(TimeSpan.FromSeconds(10), ct).ConfigureAwait(false);
            return pipe;
        }
        catch
        {
            await pipe.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private static bool PipeExists(string name)
    {
        try
        {
            return Directory.EnumerateFiles(@"\\.\pipe\")
                .Any(p => string.Equals(Path.GetFileName(p), name, StringComparison.OrdinalIgnoreCase));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Could not look; let the connect be what decides.
            return true;
        }
    }

    /// <summary>
    /// TLS to an engine is a certificate directory and a verification policy,
    /// and nothing here needs it: the engine is on this machine. Saying so beats
    /// speaking plain HTTP at a TLS listener and reporting the garbage.
    /// </summary>
    private static void RefuseTls(Func<string, string?> environment, string source)
    {
        if (environment("DOCKER_TLS_VERIFY") is { Length: > 0 })
        {
            throw new DockerEngineException(
                $"{source} is set together with DOCKER_TLS_VERIFY. envmux speaks to a local engine without TLS; " +
                "unset them, or name the endpoint in the backend's record.");
        }
    }

    private static string? CurrentContext(string home)
    {
        try
        {
            var path = Path.Combine(home, ".docker", "config.json");

            if (!File.Exists(path))
            {
                return null;
            }

            using var document = JsonDocument.Parse(File.ReadAllBytes(path));

            return document.RootElement.ValueKind == JsonValueKind.Object &&
                   document.RootElement.TryGetProperty("currentContext", out var current) &&
                   current.ValueKind == JsonValueKind.String &&
                   current.GetString() is { Length: > 0 } name
                ? name
                : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            // A config file the CLI wrote and this cannot read is not a reason
            // to refuse to try the default.
            return null;
        }
    }

    /// <summary>A context's endpoint: <c>contexts/meta/&lt;sha256 of its name&gt;/meta.json</c>, which is where the CLI keeps it.</summary>
    private static string? ContextHost(string home, string context)
    {
        try
        {
            var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(context)));
            var path = Path.Combine(home, ".docker", "contexts", "meta", digest, "meta.json");

            if (!File.Exists(path))
            {
                return null;
            }

            using var document = JsonDocument.Parse(File.ReadAllBytes(path));

            return document.RootElement.TryGetProperty("Endpoints", out var endpoints) &&
                   endpoints.ValueKind == JsonValueKind.Object &&
                   endpoints.TryGetProperty("docker", out var docker) &&
                   docker.ValueKind == JsonValueKind.Object &&
                   docker.TryGetProperty("Host", out var host) &&
                   host.ValueKind == JsonValueKind.String &&
                   host.GetString() is { Length: > 0 } value
                ? value
                : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }
}
