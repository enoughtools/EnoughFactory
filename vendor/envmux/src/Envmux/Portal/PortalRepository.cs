using System.Security.Cryptography;
using System.Text;

using Envmux.Incus;

namespace Envmux.Portal;

/// <summary>A filename-safe working tree entry from Git's NUL-delimited status.</summary>
internal sealed record PortalRepositoryEntry(string Path, string? OriginalPath, string IndexStatus, string WorkingTreeStatus);

/// <summary>Small wire helpers for the desktop workbench's repository and terminals.</summary>
internal static class PortalRepository
{
    public static IReadOnlyList<PortalRepositoryEntry> ParseStatus(string output)
    {
        var fields = output.Split('\0');
        var entries = new List<PortalRepositoryEntry>();

        for (var i = 0; i < fields.Length; i++)
        {
            var field = fields[i];
            if (field.Length < 4 || field[2] != ' ')
            {
                continue;
            }

            var index = field[0];
            var worktree = field[1];
            string? original = null;
            if ((index is 'R' or 'C' || worktree is 'R' or 'C') && i + 1 < fields.Length)
            {
                original = fields[++i];
            }

            entries.Add(new PortalRepositoryEntry(field[3..], original, index.ToString(), worktree.ToString()));
        }

        return entries;
    }

    public static string TerminalLatch(string project, string session, string? tool, string? terminal)
    {
        var task = tool is { Length: > 0 } ? $"tool-{tool}" : "web";
        if (terminal is not null)
        {
            // Slugging arbitrary IDs aliases distinct tabs. A hash is stable,
            // bounded and contains no tmux target separators.
            task += "-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(terminal))).ToLowerInvariant()[..32];
        }

        return Latch.Id(project, session, task);
    }
}
