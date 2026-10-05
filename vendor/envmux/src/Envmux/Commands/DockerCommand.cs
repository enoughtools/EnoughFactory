using Envmux.Docker;
using Envmux.Host;
using Envmux.Incus;

namespace Envmux.Commands;

/// <summary>
/// The Docker-compatible endpoint that lets VS Code's Dev Containers extension
/// attach to a session's instance.
/// </summary>
/// <remarks>
/// <para>
/// docs/vscode-remote.md, brought inside. <c>envmux docker</c> serves the
/// endpoint until interrupted; <c>--print</c> writes what to point the editor
/// at and exits. The endpoint is loopback/filesystem only — a per-user pipe on
/// Windows, a private unix socket on macOS and Linux — because the Docker API is
/// unauthenticated and this one can start execs on every target.
/// </para>
/// <para>
/// This is the daemonless design's one long-running foreground process, and it
/// is opt-in: nothing starts it at login. It runs while an editor is attached
/// and is closed with the terminal it was started in.
/// </para>
/// </remarks>
internal static class DockerCommand
{
    public static async Task<int> RunAsync(string directory, bool print, bool auto, CancellationToken ct = default)
    {
        var host = HostConfig.Load();

        if (!host.IsProvisioned)
        {
            Console.Error.WriteLine("envmux: there is no IncusOS host configured. `envmux host` lists the steps.");
            return 1;
        }

        if (print)
        {
            return Print(directory);
        }

        // Machine-wide singleton: two listeners on one pipe name would both
        // accept and neither would be whole. Whoever holds this lock is the
        // endpoint; anyone else steps aside — silently for the auto-launched
        // one, which is racing several clients, and with a word for a person who
        // typed the command and might wonder why nothing happened. A file lock
        // rather than a mutex, because this is held across awaits and frees
        // itself if the process dies (DockerEndpoint.MachineLock).
        using var singleton = MachineLock.TryAcquire(DockerEndpoint.SingletonLockPath);

        if (singleton is null)
        {
            if (!auto)
            {
                Console.WriteLine("envmux: the Docker endpoint is already running.");
            }

            return 0;
        }

        return await ServeAsync(host, auto, ct).ConfigureAwait(false);
    }

    private static async Task<int> ServeAsync(HostConfig host, bool auto, CancellationToken ct)
    {
        using var client = IncusClient.Connect(host);
        var api = new IncusApi(client);

        // Fail fast, and with the host's own message, rather than at the first
        // request an editor makes minutes later.
        try
        {
            await api.ServerAsync(ct).ConfigureAwait(false);
        }
        catch (IncusException e)
        {
            Console.Error.WriteLine($"envmux: {e.Message}");
            return 1;
        }

        // The auto-launched endpoint has no console to write to; its trace goes
        // to a file beside the leases. The manual one talks to the terminal.
        var report = auto ? FileLogger() : line => Console.Error.WriteLine($"envmux docker: {line}");

        await using var server = ShimServer.Start(api, host, report);

        if (!auto)
        {
            Console.WriteLine($"envmux: Docker endpoint on {server.Address}");
            Console.WriteLine($"        point a docker context at it — `{CommandName.Current} docker --print` shows how.");
            Console.WriteLine("        Ctrl-C to stop.");
        }

        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            stop.Cancel();
        };

        try
        {
            await server.RunAsync(stop.Token, autoShutdown: auto).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Ctrl-C, or the auto endpoint deciding it is no longer needed.
        }

        return 0;
    }

    /// <summary>Where the auto-launched endpoint writes its trace, since it has no terminal.</summary>
    private static Action<string> FileLogger()
    {
        var path = Path.Combine(DockerLease.Directory, "..", "endpoint.log");

        return line =>
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.AppendAllText(
                    path,
                    $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}{Environment.NewLine}");
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // A log is a nicety; losing a line of it changes nothing.
            }
        };
    }

    private static int Print(string directory)
    {
        // The endpoint's address, for anyone wiring a docker CLI up by hand.
        // Nothing has to be set for the editor buttons, though: the URI they
        // build carries this address itself (Editor.DockerUri), so VS Code
        // reaches the endpoint with nothing in settings.json.
        Console.WriteLine($"DOCKER_HOST={ShimEndpoint.DockerHost}");
        Console.WriteLine();
        Console.WriteLine("The editor buttons (`envmux code`, `e`, the portal) need no VS Code settings —");
        Console.WriteLine("the attach URI carries this address. They do need a real `docker` on PATH, which");
        Console.WriteLine("the Dev Containers extension requires regardless (Docker Desktop provides it).");
        Console.WriteLine();
        Console.WriteLine("To point a plain `docker` CLI here yourself:");
        Console.WriteLine($"  DOCKER_HOST={ShimEndpoint.DockerHost} docker ps");

        return 0;
    }
}
