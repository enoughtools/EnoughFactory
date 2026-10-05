using Envmux.Config;

namespace Envmux.Tests;

/// <summary>
/// The gitignored file a project's local secrets live in.
/// </summary>
/// <remarks>
/// The bundle carries what git tracks, so a <c>.env</c> git was told to ignore
/// does not cross — and the session gets the repository without what makes it
/// run. five80 found it: <c>bun install</c> died on <c>invalid _auth value,
/// expected valid base64</c>, because its <c>.npmrc</c> reads
/// <c>${ELMO_JFROG_AUTH}</c> and nothing had set it.
/// </remarks>
public class DotEnvTests
{
    private static string? Value(string line) => DotEnv.Parse(line)?.Value;

    private static string? Name(string line) => DotEnv.Parse(line)?.Key;

    /// <summary>The plain case.</summary>
    [Fact]
    public void AKeyAndAValue()
    {
        Assert.Equal("ELMO_JFROG_AUTH", Name("ELMO_JFROG_AUTH=abc123"));
        Assert.Equal("abc123", Value("ELMO_JFROG_AUTH=abc123"));
    }

    /// <summary>A .env that is also sourceable.</summary>
    [Fact]
    public void ExportIsNotPartOfTheName() =>
        Assert.Equal("TOKEN", Name("export TOKEN=abc"));

    /// <summary>Comments and blank lines carry nothing.</summary>
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("# a comment")]
    [InlineData("  # indented")]
    [InlineData("no-equals-sign")]
    public void NothingIsNothing(string line) =>
        Assert.Null(DotEnv.Parse(line));

    /// <summary>Quotes that wrap the value are not part of it.</summary>
    [Theory]
    [InlineData(@"A=""quoted""", "quoted")]
    [InlineData("A='quoted'", "quoted")]
    public void WrappingQuotesComeOff(string line, string expected) =>
        Assert.Equal(expected, Value(line));

    /// <summary>
    /// A quote inside the value stays.
    /// </summary>
    /// <remarks>
    /// These are secrets from an alphabet nobody constrained. Stripping a quote
    /// that is part of the value changes the secret, and the failure appears
    /// later as an authentication error nobody connects to a config parser.
    /// </remarks>
    [Theory]
    [InlineData(@"A=ab""cd", @"ab""cd")]
    [InlineData(@"A=""ab""cd", @"""ab""cd")]
    [InlineData("A=it's", "it's")]
    public void AQuoteInsideTheValueStays(string line, string expected) =>
        Assert.Equal(expected, Value(line));

    /// <summary>
    /// Base64 ends in '=' and that is not a separator.
    /// </summary>
    /// <remarks>
    /// The exact shape of the value that started this: an npm _auth token is
    /// base64 and very often padded.
    /// </remarks>
    [Fact]
    public void OnlyTheFirstEqualsSeparates()
    {
        Assert.Equal("ELMO_JFROG_AUTH", Name("ELMO_JFROG_AUTH=bWF0dDpzZWNyZXQ="));
        Assert.Equal("bWF0dDpzZWNyZXQ=", Value("ELMO_JFROG_AUTH=bWF0dDpzZWNyZXQ="));
    }

    /// <summary>A file that is not there is empty, not an error.</summary>
    [Fact]
    public void AMissingFileIsEmpty() =>
        Assert.Empty(DotEnv.Read(Path.Combine(Path.GetTempPath(), $"envmux-no-such-{Guid.NewGuid():N}.env")));

    /// <summary>A whole file, in the order it was written.</summary>
    [Fact]
    public void AFileReadsInOrder()
    {
        var path = Path.Combine(Path.GetTempPath(), $"envmux-{Guid.NewGuid():N}.env");

        File.WriteAllText(path, string.Join('\n',
        [
            "# five80's local secrets",
            "ELMO_JFROG_AUTH=bWF0dDpzZWNyZXQ=",
            "",
            "export AWS_REGION=ap-southeast-2",
            "QUOTED=\"with spaces\"",
        ]));

        try
        {
            var read = DotEnv.Read(path);

            Assert.Equal(["ELMO_JFROG_AUTH", "AWS_REGION", "QUOTED"], read.Select(p => p.Key));
            Assert.Equal("bWF0dDpzZWNyZXQ=", read[0].Value);
            Assert.Equal("with spaces", read[2].Value);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
