using System.Net.WebSockets;
using System.Text;

using Envmux.Incus;
using Envmux.Session;

namespace Envmux.Docker;

/// <summary>
/// One Incus exec, with its websockets left raw for the shim to bridge.
/// </summary>
/// <remarks>
/// <para>
/// Not <see cref="ExecSession"/>. That one is interactive-only and wraps its
/// single PTY socket in a <see cref="System.IO.Stream"/> for the terminal and
/// the tasks. The shim needs both shapes — a TTY exec's one bidirectional
/// socket, and a non-TTY exec's separate <c>stdin</c>/<c>stdout</c>/<c>stderr</c>,
/// because Docker's stdcopy framing (§6.2) exists precisely to keep the two
/// output streams apart — and it needs the frames, not a decoded stream, so it
/// can re-frame them and notice Incus' empty-message EOF. So it dials the same
/// operation's sockets itself.
/// </para>
/// <para>
/// The <c>runuser</c> drop and the <c>$HOME</c> fill-in are the same ones
/// <see cref="Command"/> applies, shared through it so the shim's execs behave
/// exactly like envmux's own.
/// </para>
/// </remarks>
internal sealed class DockerExec : IAsyncDisposable
{
    private readonly IncusApi _api;

    private DockerExec(IncusApi api, string operationId, bool tty, IReadOnlyDictionary<string, ClientWebSocket> sockets)
    {
        _api = api;
        OperationId = operationId;
        Tty = tty;
        Sockets = sockets;
    }

    public string OperationId { get; }

    public bool Tty { get; }

    /// <summary>
    /// The operation's sockets, by descriptor.
    /// </summary>
    /// <remarks>
    /// <c>"0"</c> is stdin — and for a TTY exec, the whole terminal in both
    /// directions. <c>"1"</c> and <c>"2"</c> are stdout and stderr, present
    /// only when not a TTY. <c>"control"</c> carries resize and signals.
    /// </remarks>
    public IReadOnlyDictionary<string, ClientWebSocket> Sockets { get; }

    public ClientWebSocket Stdin => Sockets["0"];

    public static async Task<DockerExec> StartAsync(
        IncusApi api,
        string instance,
        IReadOnlyList<string> command,
        bool tty,
        IReadOnlyDictionary<string, string>? environment = null,
        string? user = null,
        string? cwd = null,
        int width = 80,
        int height = 24,
        CancellationToken ct = default)
    {
        var environmentForExec = Command.EnvironmentFor(user, environment);

        if (tty && !environmentForExec.ContainsKey("TERM"))
        {
            environmentForExec = new Dictionary<string, string>(environmentForExec, StringComparer.Ordinal)
            {
                ["TERM"] = "xterm-256color",
            };
        }

        var request = new ExecPost
        {
            Command = Command.AsUser(user, command),
            Environment = environmentForExec,
            Cwd = cwd,
            Interactive = tty,
            WaitForWebsocket = true,
            Width = width,
            Height = height,
        };

        var response = await api.Client
            .PostAsync($"{IncusClient.V1}/instances/{instance}/exec", request, ct)
            .ConfigureAwait(false);

        if (!response.IsAsync)
        {
            throw new IncusException($"exec in '{instance}' did not start an operation");
        }

        var id = response.OperationId;
        var fds = (response.As<IncusOperation>() ?? new IncusOperation { Metadata = response.Metadata }).Fds();

        var sockets = new Dictionary<string, ClientWebSocket>(StringComparer.Ordinal);

        try
        {
            foreach (var (descriptor, secret) in fds)
            {
                sockets[descriptor] = await api.Client.ConnectAsync(id, secret, ct).ConfigureAwait(false);
            }
        }
        catch
        {
            foreach (var socket in sockets.Values)
            {
                socket.Dispose();
            }

            throw;
        }

        return new DockerExec(api, id, tty, sockets);
    }

    public async Task ResizeAsync(int width, int height, CancellationToken ct = default)
    {
        if (!Sockets.TryGetValue("control", out var control) || control.State != WebSocketState.Open)
        {
            return;
        }

        var message = WireJson.SerializeToUtf8Bytes(
            ExecControl.Resize(width, height),
            IncusJson.Options);

        try
        {
            await control.SendAsync(message, WebSocketMessageType.Text, endOfMessage: true, ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is WebSocketException or ObjectDisposedException or InvalidOperationException)
        {
            // The exec ended between the resize arriving and it being sent.
        }
    }

    /// <summary>What the command exited with, waiting server-side for it to finish.</summary>
    public async Task<int> WaitAsync(CancellationToken ct = default)
    {
        while (true)
        {
            ct.ThrowIfCancellationRequested();

            var response = await _api.Client
                .GetAsync($"{IncusClient.V1}/operations/{OperationId}/wait?timeout=20", ct)
                .ConfigureAwait(false);

            var operation = response.As<IncusOperation>();

            if (operation is null)
            {
                return 1;
            }

            if (IncusStatus.IsFinished(operation.StatusCode))
            {
                return operation.ReturnCode ?? (operation.Succeeded ? 0 : 1);
            }
        }
    }

    /// <summary>Read to the end of a non-TTY exec, collecting the two streams interleaved.</summary>
    public async Task<RunResult> CollectAsync(CancellationToken ct = default)
    {
        if (Tty)
        {
            throw new InvalidOperationException("CollectAsync is for non-tty execs");
        }

        var output = new StringBuilder();

        async Task DrainAsync(string descriptor)
        {
            var socket = Sockets[descriptor];
            var buffer = new byte[16 * 1024];

            while (socket.State == WebSocketState.Open)
            {
                WebSocketReceiveResult result;

                try
                {
                    result = await socket.ReceiveAsync(buffer, ct).ConfigureAwait(false);
                }
                catch (WebSocketException)
                {
                    break;
                }

                if (result.MessageType == WebSocketMessageType.Close || result.Count == 0)
                {
                    break;
                }

                lock (output)
                {
                    output.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                }
            }
        }

        await Task.WhenAll(DrainAsync("1"), DrainAsync("2")).ConfigureAwait(false);
        var code = await WaitAsync(ct).ConfigureAwait(false);

        return new RunResult(code, output.ToString());
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var socket in Sockets.Values)
        {
            try
            {
                if (socket.State == WebSocketState.Open)
                {
                    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, deadline.Token)
                        .ConfigureAwait(false);
                }
            }
            catch (Exception e) when (e is WebSocketException or OperationCanceledException or ObjectDisposedException)
            {
                // Closing a socket the far end already dropped.
            }

            socket.Dispose();
        }
    }
}
