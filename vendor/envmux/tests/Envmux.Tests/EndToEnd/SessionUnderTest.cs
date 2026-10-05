using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace Envmux.Tests.EndToEnd;

/// <summary>
/// A real envmux session, headless, on a throwaway copy of the proof-of-life app.
/// </summary>
/// <remarks>
/// <para>
/// The session is the envmux this tree built, run as a separate process
/// exactly as a person would run it — so what is tested is the program, not a
/// harness around its insides. Its log is read off stdout; everything the tests
/// need is in it: the proxy URL with its credentials, the portal link with its
/// token, and the instance's name.
/// </para>
/// <para>
/// The repository is a copy of <c>tests/proof-of-life</c> in a temporary
/// directory, with its own <c>.envmux.json</c>: Node installed by a task, the
/// app bound to the instance's own 127.0.0.1:5174, and <c>keepOnExit: false</c>
/// so the instance and branch go when the session does. Stopped through the
/// portal's <c>/api/stop</c>, which ends it the way <c>q</c> would.
/// </para>
/// </remarks>
internal sealed partial class SessionUnderTest : IAsyncDisposable
{
    private readonly System.Diagnostics.Process _process;
    private readonly List<string> _lines = [];
    private readonly string _directory;

    private SessionUnderTest(System.Diagnostics.Process process, string directory)
    {
        _process = process;
        _directory = directory;

        process.OutputDataReceived += (_, e) => Add(e.Data);
        process.ErrorDataReceived += (_, e) => Add(e.Data);
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
    }

    /// <summary>Every line the session has written so far.</summary>
    public IReadOnlyList<string> Lines
    {
        get
        {
            lock (_lines)
            {
                return [.. _lines];
            }
        }
    }

    public bool HasExited => _process.HasExited;

    public int ExitCode => _process.ExitCode;

    /// <summary>Run another command against the same disposable repository and binary.</summary>
    public async Task<(int Code, string Output)> CommandAsync(params string[] arguments)
    {
        var binary = Environment.GetEnvironmentVariable("ENVMUX_E2E_BINARY");
        var start = new ProcessStartInfo(binary ?? "dotnet")
        {
            WorkingDirectory = _directory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        if (binary is null)
        {
            start.ArgumentList.Add(Built(RepositoryRoot()));
        }

        foreach (var argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }

        if (_process.StartInfo.Environment.TryGetValue("ENVMUX_HOME", out var home))
        {
            start.Environment["ENVMUX_HOME"] = home;
        }

        using var command = System.Diagnostics.Process.Start(start)!;
        var output = command.StandardOutput.ReadToEndAsync();
        var error = command.StandardError.ReadToEndAsync();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        await command.WaitForExitAsync(deadline.Token);
        return (command.ExitCode, await output + await error);
    }

    private void Add(string? line)
    {
        if (line is null)
        {
            return;
        }

        lock (_lines)
        {
            _lines.Add(line);
        }
    }

    /// <summary>Make the repository and start the session on it.</summary>
    public static async Task<SessionUnderTest> StartAsync(Target target, string session, bool chef = false)
    {
        var root = RepositoryRoot();
        var directory = Directory.CreateTempSubdirectory("envmux-e2e-").FullName;

        CopyApp(Path.Combine(root, "tests", "proof-of-life"), Path.Combine(directory, "tests", "proof-of-life"));
        await File.WriteAllTextAsync(Path.Combine(directory, ".envmux.json"), Config(target, chef));
        await File.WriteAllTextAsync(Path.Combine(directory, ".gitignore"), "node_modules/\n");

        await Git(directory, "init", "-q", "-b", "main");
        await Git(directory, "add", "-A");
        await Git(directory, "-c", "user.email=e2e@envmux.test", "-c", "user.name=envmux e2e", "commit", "-qm", "proof of life");

        // Release verification runs the extracted self-contained executable.
        // Otherwise this harness proves only the SDK build beside the tests.
        var binary = Environment.GetEnvironmentVariable("ENVMUX_E2E_BINARY");
        var start = new ProcessStartInfo(binary ?? "dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        if (binary is null)
        {
            start.ArgumentList.Add(Built(root));
        }

        foreach (var argument in new[]
                 {
                     session, "--directory", directory, "--headless", "--backend", target.Backend,
                 })
        {
            start.ArgumentList.Add(argument);
        }

        if (target.Home is { } home)
        {
            start.Environment["ENVMUX_HOME"] = home;
        }

        var process = System.Diagnostics.Process.Start(start)
                      ?? throw new InvalidOperationException("envmux did not start");

        return new SessionUnderTest(process, directory);
    }

    /// <summary>
    /// The first line matching, waiting for it — or a failure that shows the
    /// log, because a session that did not come up says why in it.
    /// </summary>
    public async Task<Match> WaitForAsync(Regex pattern, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;

        while (DateTime.UtcNow < deadline)
        {
            foreach (var line in Lines)
            {
                if (pattern.Match(line) is { Success: true } match)
                {
                    return match;
                }
            }

            if (_process.HasExited)
            {
                break;
            }

            await Task.Delay(250);
        }

        throw new TimeoutException(
            $"no line matching /{pattern}/ in {timeout.TotalSeconds:0}s " +
            $"(envmux {(_process.HasExited ? $"exited {_process.ExitCode}" : "still running")}). The log:\n" +
            string.Join('\n', Lines.TakeLast(60).Select(Redact)));
    }

    /// <summary>The proxy URL, credentials and all.</summary>
    public async Task<Uri> ProxyAsync(TimeSpan timeout) =>
        new((await WaitForAsync(ProxyLine(), timeout)).Groups[1].Value.Replace("socks5h://", "socks5://", StringComparison.Ordinal));

    /// <summary>The portal's port and token.</summary>
    public async Task<(int Port, string Token)> PortalAsync(TimeSpan timeout)
    {
        var match = await WaitForAsync(PortalLine(), timeout);
        return (int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture), match.Groups[2].Value);
    }

    /// <summary>The instance's name, as the log states it.</summary>
    public async Task<string> InstanceAsync(TimeSpan timeout) =>
        (await WaitForAsync(InstanceLine(), timeout)).Groups[1].Value;

    /// <summary>
    /// End it through the portal and wait for the process, which is the
    /// teardown: commits back, instance removed.
    /// </summary>
    public async Task<bool> StopAsync(TimeSpan timeout)
    {
        if (_process.HasExited)
        {
            return true;
        }

        try
        {
            var (port, token) = await PortalAsync(TimeSpan.FromSeconds(1));
            using var http = new HttpClient();
            using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{port}/api/stop");
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            using var _ = await http.SendAsync(request);
        }
        catch (Exception e) when (e is HttpRequestException or TimeoutException)
        {
            // The portal never came up, or is already gone: the kill below is all there is.
        }

        using var wait = new CancellationTokenSource(timeout);

        try
        {
            await _process.WaitForExitAsync(wait.Token);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (!_process.HasExited)
        {
            await StopAsync(TimeSpan.FromMinutes(2));
        }

        if (!_process.HasExited)
        {
            _process.Kill(entireProcessTree: true);
        }

        _process.Dispose();

        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // git leaves read-only pack files; a stray temp directory is not a failure.
        }
    }

    /// <summary>The project's config: Node, the app, and nothing kept afterwards.</summary>
    private static string Config(Target target, bool chef) =>
        $$"""
        {
          "name": "{{(chef ? "proof-" + Guid.NewGuid().ToString("N")[..10] : "proof")}}",
          "chef": {{(chef ? "true" : "false")}},
          "backend": "{{target.Backend}}",
          "routes": { "proof": 5174 },
          "tasks": {
            "node": {
              "command": "command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs; }",
              "kind": "once"
            },
            "proof-install": { "command": "npm ci --prefix tests/proof-of-life", "kind": "once", "dependsOn": "node" },
            "proof": { "command": "npm run dev --prefix tests/proof-of-life", "dependsOn": "proof-install", "ready": 5174 }
          },
          "browser": { "open": "proof" },
          "git": { "keepOnExit": false }
        }
        """;

    private static void CopyApp(string from, string to)
    {
        Directory.CreateDirectory(to);

        foreach (var file in Directory.EnumerateFiles(from))
        {
            File.Copy(file, Path.Combine(to, Path.GetFileName(file)));
        }
    }

    private static async Task Git(string directory, params string[] arguments)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = directory, UseShellExecute = false };

        foreach (var argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }

        using var git = System.Diagnostics.Process.Start(start)!;
        await git.WaitForExitAsync();

        if (git.ExitCode != 0)
        {
            throw new InvalidOperationException($"git {string.Join(' ', arguments)} exited {git.ExitCode}");
        }
    }

    /// <summary>The repository this test assembly was built from.</summary>
    internal static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "envmux.slnx")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("not inside the envmux repository");
    }

    /// <summary>
    /// The envmux this tree built, in the configuration the tests were built in:
    /// what was just changed, never an installed copy.
    /// </summary>
    private static string Built(string root)
    {
        var configuration = AppContext.BaseDirectory.Contains($"{Path.DirectorySeparatorChar}Release{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            ? "Release"
            : "Debug";

        return Path.Combine(root, "src", "Envmux", "bin", configuration, "net10.0", "envmux.dll");
    }

    [GeneratedRegex(@"browser proxy \S+ (socks5h://\S+)")]
    private static partial Regex ProxyLine();

    [GeneratedRegex(@"http://127\.0\.0\.1:(\d+)/\?k=([A-Za-z0-9_-]+)")]
    private static partial Regex PortalLine();

    [GeneratedRegex(@"instance (\S+) (?:copied|created|adopted)")]
    private static partial Regex InstanceLine();

    private static string Redact(string line) =>
        SocksCredential().Replace(PortalCredential().Replace(line, "$1[redacted]"), "socks5://[redacted]@");

    [GeneratedRegex(@"(\?k=)[A-Za-z0-9_-]+")]
    private static partial Regex PortalCredential();

    [GeneratedRegex(@"socks5h?://[^ @]+@")]
    private static partial Regex SocksCredential();
}
