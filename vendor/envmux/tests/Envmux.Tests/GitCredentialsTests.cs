using Envmux.Git;

namespace Envmux.Tests;

/// <summary>
/// The credential file a session is given, and what must never be in it.
/// </summary>
/// <remarks>
/// The lookup itself is not tested here — it shells out to whatever helper the
/// machine has, and a test that asserts on this machine's stored tokens would
/// pass for the wrong reason and fail on anyone else's. What is tested is the
/// part with rules: the file git parses, and the fact that a token never reaches
/// a log.
/// </remarks>
public class GitCredentialsTests
{
    private static GitCredential Credential(string user = "MattOfNZ", string password = "ghp_secret") =>
        new("https", "github.com", user, password);

    /// <summary>The line git's store helper expects, and nothing else on it.</summary>
    [Fact]
    public void TheLineIsAUrlWithTheCredentialInIt() =>
        Assert.Equal("https://MattOfNZ:ghp_secret@github.com", Credential().Line);

    /// <summary>
    /// A password with a punctuation mark in it is still one field.
    /// </summary>
    /// <remarks>
    /// git parses this file as a URL, so an unescaped <c>@</c> or <c>:</c> moves
    /// the host boundary and the credential silently stops matching the host it
    /// was for — which presents as a push that asks for a password on a machine
    /// that was told one.
    /// </remarks>
    [Fact]
    public void PunctuationInACredentialIsEscaped()
    {
        var line = Credential("user@example.com", "p@ss:w/rd").Line;

        Assert.Equal("https://user%40example.com:p%40ss%3Aw%2Frd@github.com", line);

        // The host is still the last thing after the last @, which is the whole
        // reason for escaping the rest.
        Assert.EndsWith("@github.com", line, StringComparison.Ordinal);
    }

    /// <summary>One line each, LF, and a trailing newline git will not trip on.</summary>
    [Fact]
    public void TheFileIsOneLinePerHost()
    {
        var file = GitCredentials.File([
            Credential(),
            new GitCredential("https", "gitlab.com", "matt", "token"),
        ]);

        Assert.Equal(
            "https://MattOfNZ:ghp_secret@github.com\nhttps://matt:token@gitlab.com\n",
            file);

        Assert.DoesNotContain('\r', file);
    }

    /// <summary>Nothing to carry is an empty file, not a file with an empty line.</summary>
    [Fact]
    public void NoCredentialsIsNoFile() =>
        Assert.Equal("", GitCredentials.File([]));

    /// <summary>
    /// Saying what was carried must not say the token.
    /// </summary>
    /// <remarks>
    /// The session log is the first thing anybody pastes into a bug report, and
    /// this record goes into it by name. A default record's ToString prints
    /// every property, which would put the token there — so it is overridden,
    /// and this is what stops that coming back.
    /// </remarks>
    [Fact]
    public void ItNeverPrintsTheToken()
    {
        var said = Credential().ToString();

        Assert.Equal("MattOfNZ@github.com", said);
        Assert.DoesNotContain("ghp_secret", said, StringComparison.Ordinal);
    }
}
