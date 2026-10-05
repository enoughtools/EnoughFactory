using Envmux;

namespace Envmux.Tests;

/// <summary>
/// What <c>--version</c> answers.
/// </summary>
/// <remarks>
/// Canary builds are stamped with a UTC timestamp — <c>2026.08.16.0025</c> —
/// and the point of the stamp is that somebody holding a binary can match it
/// against a release. That only works if it comes back out the way it went in.
/// </remarks>
public sealed class VersionTests
{
    [Theory]
    [InlineData("2026.08.16.0025", "2026.08.16.0025")]
    [InlineData("2026.08.16.0025+abc1234", "2026.08.16.0025")]
    [InlineData("0.1.0", "0.1.0")]
    [InlineData("  0.1.0  ", "0.1.0")]
    public void KeepsTheStampAndDropsTheCommit(string informational, string expected) =>
        Assert.Equal(expected, ThisAssembly.Clean(informational));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("+abc1234")]
    public void NothingToReadFallsBackRatherThanReturningEmpty(string? informational) =>
        Assert.Null(ThisAssembly.Clean(informational));

    [Fact]
    public void TheLeadingZeroesSurvive()
    {
        // The whole reason this does not read the assembly version: that one
        // parses the stamp into numbers and gives back 2026.8.16.25.
        Assert.Equal("2026.08.16.0025", ThisAssembly.Clean("2026.08.16.0025"));
        Assert.NotEqual("2026.8.16.25", ThisAssembly.Clean("2026.08.16.0025"));
    }

    [Fact]
    public void AlwaysAnswersSomething()
    {
        Assert.False(string.IsNullOrWhiteSpace(ThisAssembly.Version));
        Assert.DoesNotContain("+", ThisAssembly.Version, StringComparison.Ordinal);
    }
}
