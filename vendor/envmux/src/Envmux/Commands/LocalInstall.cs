using System.Globalization;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using Envmux.Backends;
using Envmux.Backends.DockerEngine;
using Envmux.Host;
using Envmux.Process;

namespace Envmux.Commands;

/// <summary>Install the downloaded native executable and check its local prerequisites.</summary>
/// <remarks>
/// Docker needs no host provisioning. Installation copies only the running
/// executable; project skills are embedded and belong to init. Existing host
/// records, certificates and sessions are never involved. SDK apphosts are
/// refused because copying one without its adjacent assemblies cannot work.
/// </remarks>
internal static class LocalInstall
{
    private static string Usage => $"""
        envmux install — install the native executable and check Git and Docker.

        usage:
          {CommandName.Current} install [--provider docker] [--no-path] [--check]
          {CommandName.Current} install --provider incus|hyperv [options]

        options:
          --no-path       Copy to ~/.envmux/bin without changing PATH or shell files
          --check         Check Git and the Linux Docker engine; write nothing
          -h, --help      Show this help

        Windows updates your user PATH. Unix adds a PATH block to your bash or
        zsh startup file (fish uses conf.d). Open a new terminal after installing.
        No administrator privileges, .NET SDK or Node installation are needed.
        ENVMUX_HOME overrides ~/.envmux; only its bin directory is written.

        In a committed git repository, run:
          {CommandName.Current} init --skills both
          {CommandName.Current} config validate
          {CommandName.Current} first-session

        Optional remote hosts: {CommandName.Current} install --provider incus|hyperv --help
        """;

    public static async Task<int> RunAsync(List<string> args, CancellationToken ct)
    {
        if (args.Contains("--help") || args.Contains("-h"))
        {
            Console.WriteLine(Usage);
            return 0;
        }

        var options = args.ToList();
        var provider = options.IndexOf("--provider");
        if (provider >= 0 && provider + 1 < options.Count &&
            options[provider + 1].Equals("docker", StringComparison.OrdinalIgnoreCase))
        {
            options.RemoveRange(provider, 2);
        }

        if (options.Any(a => a is not ("--no-path" or "--check" or "--yes" or "-y")))
        {
            Console.Error.WriteLine($"envmux: unknown install option; run {CommandName.Current} install --help");
            return 2;
        }

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(20));
        try
        {
            var git = await ProcessRunner.CheckedAsync("git", ["--version"], ct: deadline.Token).ConfigureAwait(false);
            Console.WriteLine(git.Output);
            var engine = DockerEngineClient.Connect();
            await using var lifetime = engine.ConfigureAwait(false);
            var version = await engine.VersionAsync(deadline.Token).ConfigureAwait(false);
            if (!version.Os.Equals("linux", StringComparison.OrdinalIgnoreCase))
            {
                Console.Error.WriteLine("envmux: Docker is running Windows containers. Switch Docker Desktop to Linux containers and try again.");
                return 1;
            }

            Console.WriteLine($"Docker {version.Version} ({version.Os}/{version.Arch}) is ready");
            if (options.Contains("--check"))
            {
                return 0;
            }

            if (RuntimeFeature.IsDynamicCodeSupported || Environment.ProcessPath is not { } source)
            {
                Console.Error.WriteLine("envmux: download a native release from https://github.com/envmux/envmux/releases to install; SDK builds use scripts/dev-install instead.");
                return 1;
            }

            var bin = Path.GetFullPath(Path.Combine(HostConfig.Directory, "bin"));
            var installed = CopyExecutable(source, bin);
            Console.WriteLine($"installed {installed}");
            if (!options.Contains("--no-path"))
            {
                AddToPath(bin);
                Console.WriteLine("Open a new terminal to use the updated PATH.");
            }

            Console.WriteLine($"In your repository: {CommandName.Current} init --skills both, then {CommandName.Current} config validate and {CommandName.Current} first-session");
            return 0;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            Console.Error.WriteLine($"envmux: Git or Docker did not answer within 20 seconds. Start your Linux Docker engine, then run {CommandName.Current} install again.");
            return 1;
        }
        catch (Exception e) when (e is ProcessException or BackendException or IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"envmux: {e.Message}");
            Console.Error.WriteLine($"Check Git and your Linux Docker engine. If replacing an installed executable, close other envmux sessions and run {CommandName.Current} install again.");
            return 1;
        }
    }

    /// <summary>Replace the executable atomically, or leave an identical installation alone.</summary>
    /// <remarks>
    /// Hashing before replacement lets install run from its own location and
    /// avoids fighting Windows' executable lock on a repeated identical install.
    /// A failed copy or rename leaves the previous executable intact.
    /// </remarks>
    internal static string CopyExecutable(string source, string bin)
    {
        var destination = Path.Combine(bin, OperatingSystem.IsWindows() ? "envmux.exe" : "envmux");
        if (File.Exists(destination))
        {
            using var original = File.OpenRead(source);
            using var existing = File.OpenRead(destination);
            if (SHA256.HashData(original).AsSpan().SequenceEqual(SHA256.HashData(existing)))
            {
                return destination;
            }
        }

        Directory.CreateDirectory(bin);
        var temporary = Path.Combine(bin, ".envmux-" + Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture));
        try
        {
            File.Copy(source, temporary);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                    UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
            }

            File.Move(temporary, destination, overwrite: true);
            return destination;
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }

    private static void AddToPath(string bin)
    {
        if (OperatingSystem.IsWindows())
        {
            var path = Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User) ?? "";
            var entries = path.Split(';', StringSplitOptions.RemoveEmptyEntries);
            if (!entries.Any(p => p.Trim().TrimEnd('\\').Equals(bin.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)))
            {
                Environment.SetEnvironmentVariable("PATH", bin + (path.Length > 0 ? ";" + path : ""), EnvironmentVariableTarget.User);
            }

            return;
        }

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var shell = Path.GetFileName(Environment.GetEnvironmentVariable("SHELL") ?? "/bin/sh");
        Console.WriteLine($"PATH configured in {WriteShellPath(home, shell, bin)}");
    }

    /// <summary>Append one PATH block, preserving the user's startup file and repeated installs.</summary>
    internal static string WriteShellPath(string home, string shell, string bin)
    {
        var (file, content) = ShellPath(home, shell, bin);
        if (File.Exists(file) && File.ReadLines(file).Any(line => line.Equals(content, StringComparison.Ordinal)))
        {
            return file;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.AppendAllText(file, "\n# envmux executable\n" + content + "\n");
        return file;
    }

    /// <summary>A literal, quoted path in the interactive shell's startup file.</summary>
    /// <remarks>
    /// Quoting is load-bearing: spaces, quotes and dollar signs in a home path
    /// must stay filenames rather than becoming shell commands on the next login.
    /// Unknown shells use the POSIX login profile and get the file named in output.
    /// </remarks>
    internal static (string File, string Content) ShellPath(string home, string shell, string bin)
    {
        var quoted = "'" + bin.Replace("'", "'\\''", StringComparison.Ordinal) + "'";
        return shell switch
        {
            "fish" => (Path.Combine(home, ".config", "fish", "conf.d", "envmux.fish"),
                "fish_add_path --move -- '" + bin.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("'", "\\'", StringComparison.Ordinal) + "'"),
            "zsh" => (Path.Combine(home, ".zshrc"), $"export PATH={quoted}:\"$PATH\""),
            "bash" => (Path.Combine(home, OperatingSystem.IsMacOS() ? ".bash_profile" : ".bashrc"), $"export PATH={quoted}:\"$PATH\""),
            _ => (Path.Combine(home, ".profile"), $"export PATH={quoted}:\"$PATH\""),
        };
    }
}
