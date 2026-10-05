using System.Reflection;
using System.Text;

namespace Envmux.Agents;

/// <summary>The product skills carried by an installed executable.</summary>
/// <remarks>
/// Skills are project instructions, not sign-in state. Every destination is
/// checked before any write so a customized skill cannot be partly replaced.
/// Links are refused because project initialization must stay in that project.
/// </remarks>
internal static class ProjectSkills
{
    private const string Prefix = "Envmux.Skills/";

    public static bool IsSelection(string value) => value is "claude" or "codex" or "both";

    /// <summary>Give guest agents the same product instructions without requiring a repo commit.</summary>
    /// <remarks>Runs as the guest account and leaves existing user skills intact.</remarks>
    public static string GuestScript(string user)
    {
        var assembly = typeof(ProjectSkills).Assembly;
        var script = new StringBuilder();
        script.Line("set -eu");
        foreach (var resource in assembly.GetManifestResourceNames().Order(StringComparer.Ordinal))
        {
            if (!resource.StartsWith(Prefix, StringComparison.Ordinal))
            {
                continue;
            }

            using var source = assembly.GetManifestResourceStream(resource)!;
            using var reader = new StreamReader(source, Encoding.UTF8);
            var content = reader.ReadToEnd().ReplaceLineEndings("\n");
            var delimiter = "ENVMUX_SKILL_" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(content)));
            foreach (var root in new[] { ".claude/skills", ".agents/skills" })
            {
                var relative = resource[Prefix.Length..].Replace('\\', '/');
                var path = $"/home/{user}/{root}/{relative}";
                script.Line($"if [ ! -e {Session.Workspace.Quote(path)} ]; then");
                script.Line($"mkdir -p {Session.Workspace.Quote(path[..path.LastIndexOf('/')])}");
                script.Line($"cat > {Session.Workspace.Quote(path)} <<'{delimiter}'");
                script.Line(content.TrimEnd('\n'));
                script.Line(delimiter);
                script.Line("fi");
            }
        }

        return script.ToString();
    }

    public static async Task InstallAsync(string directory, string selection, CancellationToken ct = default)
    {
        if (!IsSelection(selection))
        {
            throw new Config.ConfigException("--skills is claude, codex, or both");
        }

        var assembly = typeof(ProjectSkills).Assembly;
        var files = new List<(string Path, byte[] Bytes)>();
        string[] roots = selection switch
        {
            "claude" => [".claude/skills"],
            "codex" => [".agents/skills"],
            _ => [".claude/skills", ".agents/skills"],
        };

        foreach (var resource in assembly.GetManifestResourceNames().Order(StringComparer.Ordinal))
        {
            if (!resource.StartsWith(Prefix, StringComparison.Ordinal))
            {
                continue;
            }

            await using var source = assembly.GetManifestResourceStream(resource)!;
            using var buffer = new MemoryStream();
            await source.CopyToAsync(buffer, ct).ConfigureAwait(false);
            var bytes = buffer.ToArray();
            foreach (var root in roots)
            {
                var path = Path.Combine(directory, root, resource[Prefix.Length..]);
                CheckLinks(directory, path);
                if (File.Exists(path) &&
                    !(await File.ReadAllBytesAsync(path, ct).ConfigureAwait(false)).AsSpan().SequenceEqual(bytes))
                {
                    throw new Config.ConfigException($"skill already customized at {path}; keep it or move it before running init --skills again");
                }

                files.Add((path, bytes));
            }
        }

        foreach (var (path, bytes) in files)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            if (!File.Exists(path))
            {
                await File.WriteAllBytesAsync(path, bytes, ct).ConfigureAwait(false);
            }
        }
    }

    private static void CheckLinks(string directory, string path)
    {
        var root = Path.GetFullPath(directory);
        for (var current = path; current is not null; current = Path.GetDirectoryName(current))
        {
            if ((File.Exists(current) || Directory.Exists(current)) &&
                (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
            {
                throw new Config.ConfigException($"skill destination is a link at {current}; choose a project directory without links");
            }

            if (string.Equals(current, root, StringComparison.Ordinal))
            {
                return;
            }
        }

        throw new Config.ConfigException("skill destination is outside the project directory");
    }
}
