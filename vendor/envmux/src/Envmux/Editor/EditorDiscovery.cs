using System.Runtime.InteropServices;

namespace Envmux.Editor;

/// <summary>An editor that was found, and anything worth saying about it.</summary>
/// <param name="Path">What to execute.</param>
/// <param name="Hint">
/// A caveat that does not stop the launch. VSCodium's marketplace may not carry
/// the Remote-SSH extension; a flatpak VS Code has its own SSH configuration
/// inside its sandbox. Both produce a failure inside the editor rather than
/// here, so both are worth a sentence before it happens.
/// </param>
internal sealed record Discovered(string Path, string? Hint);

/// <summary>Everything discovery consults, injected so a test can fabricate a machine.</summary>
internal sealed record DiscoveryInputs
{
    /// <summary>
    /// <c>editor.path</c> from the config. Authoritative: set but missing is an
    /// error, because somebody who named an editor does not want a different one.
    /// </summary>
    public string? ConfigPath { get; init; }

    /// <summary><c>$VSCODE_BIN</c>. Also explicit, also authoritative.</summary>
    public string? VsCodeBin { get; init; }

    /// <summary>The entries of <c>PATH</c>, already split.</summary>
    public required IReadOnlyList<string> PathDirectories { get; init; }

    /// <summary>Executable extensions to try per entry. Windows editors ship <c>code.cmd</c>.</summary>
    public required IReadOnlyList<string> Extensions { get; init; }

    /// <summary>Where installers put editors when <c>PATH</c> does not say.</summary>
    public required IReadOnlyList<string> WellKnown { get; init; }

    /// <summary>Whether a candidate is there. The seam that makes the rest of this pure.</summary>
    public required Func<string, bool> Exists { get; init; }
}

/// <summary>
/// Finding a VS Code-family editor to launch.
/// </summary>
/// <remarks>
/// Order: the config's <c>editor.path</c>, then <c>$VSCODE_BIN</c>, then names
/// on <c>PATH</c>, then the platform's well-known install locations. The core
/// takes its environment as inputs, so the tests are tables rather than
/// fixtures — which matters for a search whose interesting cases are all about
/// machines the test machine is not.
/// </remarks>
internal static class EditorDiscovery
{
    /// <summary>
    /// The editors probed on <c>PATH</c>, stable deliberately before insiders.
    /// </summary>
    /// <remarks>
    /// The search is name-major: <c>code</c> anywhere on <c>PATH</c> beats
    /// <c>code-insiders</c> everywhere. Somebody with both installed meant the
    /// stable one unless they said otherwise.
    /// </remarks>
    public static readonly string[] Names = ["code", "code-insiders", "codium", "cursor", "windsurf"];

    /// <summary>Discover using this machine.</summary>
    public static Discovered Find(string? configPath) => Find(RealInputs(configPath));

    /// <summary>The pure core: walk the order, return the first hit.</summary>
    /// <exception cref="EditorException">Nothing was found, listing everything tried.</exception>
    public static Discovered Find(DiscoveryInputs inputs)
    {
        var tried = new List<string>();

        // Explicit configuration first, and a miss there is fatal rather than a
        // fallthrough: launching a different editor than the one that was named
        // is a silent surprise.
        foreach (var (path, source) in ((string?, string)[])
                 [(inputs.ConfigPath, "editor.path"), (inputs.VsCodeBin, "$VSCODE_BIN")])
        {
            if (path is null)
            {
                continue;
            }

            return inputs.Exists(path)
                ? Describe(path)
                : throw new EditorException($"{source} is {path}, which is not there");
        }

        foreach (var name in Names)
        {
            foreach (var directory in inputs.PathDirectories)
            {
                foreach (var candidate in Candidates(directory, name, inputs.Extensions))
                {
                    if (inputs.Exists(candidate))
                    {
                        return Describe(candidate);
                    }
                }
            }

            tried.Add($"{name} (on PATH)");
        }

        foreach (var candidate in inputs.WellKnown)
        {
            if (inputs.Exists(candidate))
            {
                return Describe(candidate);
            }

            tried.Add(candidate);
        }

        throw new EditorException(
            "no VS Code-family editor found. Tried: " + string.Join(", ", tried) +
            ". Set editor.path in .envmux.json, or $VSCODE_BIN.");
    }

    private static IEnumerable<string> Candidates(string directory, string name, IReadOnlyList<string> extensions) =>
        extensions.Count == 0
            ? [Path.Combine(directory, name)]
            : extensions.Select(e => Path.Combine(directory, name + e));

    private static Discovered Describe(string path) => new(path, Hint(path));

    private static string? Hint(string path)
    {
        var text = path.ToLowerInvariant();

        if (text.Contains("flatpak", StringComparison.Ordinal))
        {
            return "this is a flatpak VS Code, whose sandbox has its own SSH configuration — " +
                   "the attach may fail inside it";
        }

        return Path.GetFileNameWithoutExtension(text).StartsWith("codium", StringComparison.Ordinal)
            ? "VSCodium's marketplace may not carry the Remote-SSH extension the attach depends on"
            : null;
    }

    private static DiscoveryInputs RealInputs(string? configPath) => new()
    {
        ConfigPath = configPath,
        VsCodeBin = Environment.GetEnvironmentVariable("VSCODE_BIN") is { Length: > 0 } bin ? bin : null,
        PathDirectories = (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries),
        Extensions = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? [".cmd", ".exe", ".bat"] : [],
        WellKnown = WellKnown(),
        Exists = File.Exists,
    };

    private static IReadOnlyList<string> WellKnown()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return
            [
                .. from root in (string[])["/Applications", Path.Combine(home, "Applications")]
                   from bundle in (string[])["Visual Studio Code.app", "Visual Studio Code - Insiders.app"]
                   select Path.Combine(root, bundle, "Contents/Resources/app/bin/code"),
            ];
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return
            [
                .. from root in (string?[])
                   [
                       Environment.GetEnvironmentVariable("LOCALAPPDATA") is { Length: > 0 } local
                           ? Path.Combine(local, "Programs")
                           : null,
                       Environment.GetEnvironmentVariable("ProgramFiles"),
                   ]
                   where root is not null
                   select Path.Combine(root, "Microsoft VS Code", "bin", "code.cmd"),
            ];
        }

        return
        [
            "/usr/share/code/bin/code",
            "/snap/bin/code",
            "/var/lib/flatpak/exports/bin/com.visualstudio.code",
            Path.Combine(home, ".local/share/flatpak/exports/bin/com.visualstudio.code"),
        ];
    }
}
