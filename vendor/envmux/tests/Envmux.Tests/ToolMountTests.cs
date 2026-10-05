using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// What a tool's state carries into a session, and what it must not.
/// </summary>
/// <remarks>
/// Measured on a working machine, <c>~/.claude</c> was 676 MB across 8,160
/// files, and 590 MB of that was <c>projects</c> — every transcript of every
/// other repository on the host. It cost a minute per session, and it handed a
/// session opened for one project the conversation history of all the others.
/// Neither is what carrying a credential was for.
/// </remarks>
public class ToolMountTests
{
    /// <summary>The credential and the settings, which are the point.</summary>
    [Theory]
    [InlineData(".credentials.json")]
    [InlineData("settings.json")]
    [InlineData("CLAUDE.md")]
    [InlineData("plugins/repos/some-plugin/skill.md")]
    [InlineData("plans/a-plan.md")]
    public void ConfigurationTravels(string path) =>
        Assert.False(ToolMounts.IsHistory("claude", path));

    /// <summary>Everything that accumulates, which is not.</summary>
    [Theory]
    [InlineData("projects/Z--other/conversation.jsonl")]
    [InlineData("file-history/abc123/file.ts")]
    [InlineData("history.jsonl")]
    [InlineData("paste-cache/1.txt")]
    [InlineData("shell-snapshots/snapshot.sh")]
    public void HistoryStaysOnTheHost(string path) =>
        Assert.True(ToolMounts.IsHistory("claude", path));

    /// <summary>
    /// The daemon's files, which would matter even at a byte.
    /// </summary>
    /// <remarks>
    /// A lock and a status file describing a process on a different machine,
    /// landing exactly where a fresh daemon will look for its own.
    /// </remarks>
    [Theory]
    [InlineData("daemon.lock")]
    [InlineData("daemon.log")]
    [InlineData("daemon.status.json")]
    [InlineData("daemon/state.json")]
    public void TheDaemonsFilesStayOnTheHost(string path) =>
        Assert.True(ToolMounts.IsHistory("claude", path));

    /// <summary>
    /// Only the first segment counts.
    /// </summary>
    /// <remarks>
    /// These are top-level names. A directory called <c>cache</c> inside a
    /// plugin belongs to that plugin, and dropping it would break the thing the
    /// mount exists to carry.
    /// </remarks>
    [Fact]
    public void OnlyTheTopLevelNamesAreSkipped()
    {
        Assert.False(ToolMounts.IsHistory("claude", "plugins/thing/cache/data.json"));
        Assert.False(ToolMounts.IsHistory("claude", "plugins/projects/index.js"));
    }

    /// <summary>
    /// A tool nobody has measured is carried whole.
    /// </summary>
    /// <remarks>
    /// The previous behaviour, and the right default: guessing which of another
    /// tool's directories are disposable is how a tool arrives subtly broken.
    /// </remarks>
    [Fact]
    public void AnUnmeasuredToolIsCarriedWhole()
    {
        Assert.False(ToolMounts.IsHistory("codex", "projects/whatever.jsonl"));
        Assert.False(ToolMounts.IsHistory("gh", "hosts.yml"));
    }

    [Theory]
    [InlineData("sessions/project.jsonl")]
    [InlineData("archived_sessions/project.jsonl")]
    [InlineData("memories/private.md")]
    [InlineData("state_5.sqlite")]
    [InlineData("history.jsonl")]
    public void CodexHistoryDoesNotTravel(string path) => Assert.True(ToolMounts.IsHistory("codex", path));
}
