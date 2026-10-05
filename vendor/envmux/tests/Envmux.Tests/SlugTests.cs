using Envmux.Config;

namespace Envmux.Tests;

public class SlugTests
{
    [Theory]
    [InlineData("envmux", "envmux")]
    [InlineData("EnvMux", "envmux")]
    [InlineData("my project", "my-project")]
    [InlineData("my_project", "my-project")]
    [InlineData("my.project", "my-project")]
    [InlineData("my---project", "my-project")]
    [InlineData("  spaced  ", "spaced")]
    [InlineData("-leading", "leading")]
    [InlineData("trailing-", "trailing")]
    [InlineData("v2.1-beta", "v2-1-beta")]
    [InlineData("123", "123")]
    public void Slugs(string input, string expected) =>
        Assert.Equal(expected, Slug.From(input));

    [Theory]
    [InlineData("")]
    [InlineData("---")]
    [InlineData("!!!")]
    [InlineData("   ")]
    public void FallsBackWhenNothingSurvives(string input) =>
        Assert.Equal("envmux", Slug.From(input));

    [Fact]
    public void TruncatesToADnsLabel()
    {
        var slug = Slug.From(new string('a', 100));
        Assert.Equal(63, slug.Length);
    }

    [Fact]
    public void TruncationNeverLeavesATrailingHyphen()
    {
        // The 63rd character is where the cut lands, and it is a separator.
        var slug = Slug.From(new string('a', 62) + " tail");
        Assert.DoesNotContain("--", slug, StringComparison.Ordinal);
        Assert.False(slug.EndsWith('-'));
    }

    [Fact]
    public void NonAsciiIsASeparator()
    {
        // Deliberate: hostnames are matched byte-for-byte against a Host header,
        // and punycode is a bigger commitment than a session name is worth.
        Assert.Equal("caf", Slug.From("café"));
    }

    [Fact]
    public void FromDirectoryUsesTheLeafName()
    {
        var path = Path.Combine(Path.GetTempPath(), "Some Project");
        Assert.Equal("some-project", Slug.FromDirectory(path));
    }

    [Fact]
    public void FromDirectoryIgnoresATrailingSeparator()
    {
        var path = Path.Combine(Path.GetTempPath(), "leaf") + Path.DirectorySeparatorChar;
        Assert.Equal("leaf", Slug.FromDirectory(path));
    }
}
