using Envmux.Config;
using Envmux.Session;

namespace Envmux.Tests;

public class SessionNameTests
{
    [Fact]
    public void GeneratedNamesAreValidHostnameLabels()
    {
        // The name becomes a hostname label, a branch, and a directory. A
        // generator that can emit something git or DNS rejects is a generator
        // that fails on the hundredth run rather than the first.
        for (var i = 0; i < 200; i++)
        {
            var name = SessionName.Generate();
            Assert.Equal(name, Slug.From(name));
            Assert.InRange(name.Length, 3, 63);
        }
    }

    [Fact]
    public void GeneratedNamesVary()
    {
        var names = Enumerable.Range(0, 40).Select(_ => SessionName.Generate()).ToHashSet();

        // Four concurrent sessions is the design target; a generator that
        // repeats itself constantly would collide on worktree directories.
        Assert.True(names.Count > 20, $"only {names.Count} distinct names in 40 draws");
    }

    [Theory]
    [InlineData("feat/login", "feat-login")]
    [InlineData("Feature Login", "feature-login")]
    [InlineData("  trim  ", "trim")]
    public void ARequestedNameIsCleanedNotRejected(string requested, string expected) =>
        Assert.Equal(expected, SessionName.Resolve(requested));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void NoRequestedNameMeansGenerateOne(string? requested) =>
        Assert.NotEmpty(SessionName.Resolve(requested));

    [Fact]
    public void BranchesCarryThePrefix() =>
        Assert.Equal("envmux/amber-fox", SessionName.Branch("envmux/", "amber-fox"));
}
