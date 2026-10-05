using Envmux.Config;

namespace Envmux.Tests;

/// <summary>
/// Path canonicalisation, against real links on disk.
/// </summary>
/// <remarks>
/// The behaviour only matters where a link is involved, so a fake would test
/// nothing. Skipped where this account may not create one — Windows without
/// developer mode.
/// </remarks>
public sealed class PhysicalPathTests : IDisposable
{
    private readonly string _root = PhysicalPath.Of(Directory.CreateTempSubdirectory("envmux-ln-").FullName);

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>Creates a link, or skips the test where that is not allowed.</summary>
    private string Link(string name, string target)
    {
        var path = Path.Combine(_root, name);
        try
        {
            Directory.CreateSymbolicLink(path, target);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Skip.If(true, "this account may not create symbolic links");
        }

        return path;
    }

    [Fact]
    public void LeavesAnOrdinaryPathAlone()
    {
        var real = Directory.CreateDirectory(Path.Combine(_root, "real")).FullName;
        Assert.Equal(real, PhysicalPath.Of(real));
    }

    [Fact]
    public void NormalisesWithoutNeedingThePathToExist()
    {
        // It is a normalisation, not a check: a path that is not there yet still
        // comes back as an absolute one rather than throwing.
        var missing = Path.Combine(_root, "not", "here", "yet");
        Assert.Equal(missing, PhysicalPath.Of(missing));
    }

    [SkippableFact]
    public void ResolvesALinkedComponentInTheMiddleOfAPath()
    {
        // The macOS case exactly: /var is a link, and the path we care about is
        // several components below it.
        var real = Directory.CreateDirectory(Path.Combine(_root, "real")).FullName;
        Directory.CreateDirectory(Path.Combine(real, "worktrees", "amber-fox"));
        var link = Link("link", real);

        Assert.Equal(
            Path.Combine(real, "worktrees", "amber-fox"),
            PhysicalPath.Of(Path.Combine(link, "worktrees", "amber-fox")));
    }

    [SkippableFact]
    public void FollowsALinkToALink()
    {
        var real = Directory.CreateDirectory(Path.Combine(_root, "real")).FullName;
        var first = Link("first", real);
        var second = Link("second", first);

        Assert.Equal(real, PhysicalPath.Of(second));
    }

    [SkippableFact]
    public void ARelativeTargetIsRelativeToTheLinkAndNotToUs()
    {
        var real = Directory.CreateDirectory(Path.Combine(_root, "real")).FullName;
        var link = Link("link", "real");

        Assert.Equal(real, PhysicalPath.Of(link));
    }

    [SkippableFact]
    public void TwoSpellingsOfOneDirectoryAreTheSameDirectory()
    {
        var real = Directory.CreateDirectory(Path.Combine(_root, "real")).FullName;
        var link = Link("link", real);

        Assert.True(PhysicalPath.Same(link, real));
        Assert.False(PhysicalPath.Same(real, Path.Combine(real, "elsewhere")));
    }

    /// <summary>A link target's parents must be resolved too, even when the leaf exists.</summary>
    [SkippableFact]
    public void ResolvesLinkedParentsInsideAnAbsoluteTarget()
    {
        var real = Directory.CreateDirectory(Path.Combine(_root, "real")).FullName;
        Directory.CreateDirectory(Path.Combine(real, "child"));
        var parent = Link("parent", real);
        var leaf = Link("leaf", Path.Combine(parent, "child"));

        Assert.Equal(Path.Combine(real, "child"), PhysicalPath.Of(leaf));
        Assert.True(PhysicalPath.Same(leaf, Path.Combine(real, "child")));
    }

    [SkippableFact]
    public void ALinkThatPointsAtNothingIsLeftAsItIs()
    {
        // Broken links are not ours to complain about, and a path we cannot
        // resolve is still a path the caller can use.
        var link = Link("dangling", Path.Combine(_root, "gone"));

        Assert.Equal(Path.Combine(_root, "gone"), PhysicalPath.Of(link));
    }
}
