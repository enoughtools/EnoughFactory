using Envmux.Portal;

namespace Envmux.Tests;

public class PortalRepositoryTests
{
    [Fact]
    public void PreservesRenamesSpacesAndNewlinesInFilenames()
    {
        var entries = PortalRepository.ParseStatus("R  new\nname.cs\0old name.cs\0?? trailing space \0 M :literal.txt\0");

        Assert.Collection(entries,
            renamed =>
            {
                Assert.Equal("new\nname.cs", renamed.Path);
                Assert.Equal("old name.cs", renamed.OriginalPath);
                Assert.Equal("R", renamed.IndexStatus);
            },
            untracked =>
            {
                Assert.Equal("trailing space ", untracked.Path);
                Assert.Equal("?", untracked.WorkingTreeStatus);
            },
            modified => Assert.Equal(":literal.txt", modified.Path));
    }

    [Fact]
    public void ReconnectsTheSameTerminalWithoutAliasingDifferentIds()
    {
        var first = PortalRepository.TerminalLatch("project", "session", null, "tab.one");
        Assert.Equal(first, PortalRepository.TerminalLatch("project", "session", null, "tab.one"));
        Assert.NotEqual(first, PortalRepository.TerminalLatch("project", "session", null, "tab-one"));
        Assert.NotEqual(first, PortalRepository.TerminalLatch("project", "session", "codex", "tab.one"));
        Assert.DoesNotContain('.', first);
        Assert.DoesNotContain(':', first);
        Assert.Equal("project-session-web", PortalRepository.TerminalLatch("project", "session", null, null));
    }
}
