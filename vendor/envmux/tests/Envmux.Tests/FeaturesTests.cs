using System.Text.Json;

using Envmux.Config;
using Envmux.Incus;

namespace Envmux.Tests;

/// <summary>
/// Dev container features, as a devcontainer.json spells them.
/// </summary>
/// <remarks>
/// The whole point is that a project's toolchain is already written down. If a
/// <c>features</c> block cannot be copied out of a devcontainer.json and pasted
/// into a <c>.envmux.json</c> unedited, this has failed at the only thing it was
/// for — so the references and option types here are taken verbatim from real
/// ones.
/// </remarks>
public class FeaturesTests
{
    private static Dictionary<string, FeatureConfig> Parse(string json) =>
        JsonSerializer.Deserialize<Dictionary<string, FeatureConfig>>(json, IncusJson.Options)!;

    /// <summary>A reference splits into registry, repository and tag.</summary>
    [Fact]
    public void AReferenceIsRegistryRepositoryAndTag()
    {
        var feature = Features.Resolve(Parse(
            """{"ghcr.io/devcontainers/features/dotnet:2": {"version": "10.0"}}"""))[0];

        Assert.Equal("ghcr.io", feature.Registry);
        Assert.Equal("devcontainers/features/dotnet", feature.Repository);
        Assert.Equal("2", feature.Tag);
        Assert.Equal("dotnet", feature.Name);
        Assert.Equal("10.0", feature.Options["version"]);
    }

    /// <summary>No tag means latest, which is what a registry means by it.</summary>
    [Fact]
    public void NoTagIsLatest() =>
        Assert.Equal("latest", Features.Resolve(Parse(
            """{"ghcr.io/devcontainers/features/git-lfs": {}}"""))[0].Tag);

    /// <summary>
    /// A registry with a port is not a tag.
    /// </summary>
    /// <remarks>
    /// The colon that separates a tag is the one in the last segment. Splitting
    /// on the first would turn <c>registry:5000/x/y:1</c> into a registry called
    /// "registry" with a tag of "5000/x/y:1".
    /// </remarks>
    [Fact]
    public void APortInTheRegistryIsNotATag()
    {
        var feature = Features.Resolve(Parse(
            """{"registry.internal:5000/team/features/thing:3": {}}"""))[0];

        Assert.Equal("registry.internal:5000", feature.Registry);
        Assert.Equal("team/features/thing", feature.Repository);
        Assert.Equal("3", feature.Tag);
    }

    /// <summary>
    /// Options arrive as whatever JSON type they were written as.
    /// </summary>
    /// <remarks>
    /// Copied from five80's devcontainer.json and footprint's config: strings,
    /// booleans, and a bare number for a version. All three reach install.sh as
    /// environment variables, so all three become strings — and a number has to
    /// become "22" rather than "22.0", which would match no version anywhere.
    /// </remarks>
    [Fact]
    public void OptionsBecomeStringsWhateverTheyWereWrittenAs()
    {
        var feature = Features.Resolve(Parse(
            """
            {"ghcr.io/devcontainers/features/node:1": {
              "version": 22,
              "nodeGypDependencies": false,
              "pnpmVersion": "latest"
            }}
            """))[0];

        Assert.Equal("22", feature.Options["version"]);
        Assert.Equal("false", feature.Options["nodeGypDependencies"]);
        Assert.Equal("latest", feature.Options["pnpmVersion"]);
    }

    /// <summary>An option's environment variable is its name, uppercased.</summary>
    [Theory]
    [InlineData("version", "VERSION")]
    [InlineData("nodeGypDependencies", "NODEGYPDEPENDENCIES")]
    [InlineData("install-zsh", "INSTALL_ZSH")]
    public void AnOptionIsAnUppercasedVariable(string option, string expected) =>
        Assert.Equal(expected, Features.Variable(option));

    /// <summary>
    /// The fingerprint changes when the toolchain does, and not otherwise.
    /// </summary>
    /// <remarks>
    /// This is what stops an image drifting from the config that describes it. A
    /// stale toolchain does not present as a stale toolchain — it presents as
    /// the project failing to build — so the two must not be able to disagree.
    /// </remarks>
    [Fact]
    public void TheFingerprintFollowsTheToolchain()
    {
        var one = Features.Resolve(Parse("""{"ghcr.io/devcontainers/features/node:1": {"version": "22"}}"""));
        var same = Features.Resolve(Parse("""{"ghcr.io/devcontainers/features/node:1": {"version": "22"}}"""));
        var moved = Features.Resolve(Parse("""{"ghcr.io/devcontainers/features/node:1": {"version": "24"}}"""));
        var added = Features.Resolve(Parse(
            """
            {"ghcr.io/devcontainers/features/node:1": {"version": "22"},
             "ghcr.io/devcontainers-extra/features/bun:1": {}}
            """));

        Assert.Equal(Features.Fingerprint("debian/13/cloud", one), Features.Fingerprint("debian/13/cloud", same));
        Assert.NotEqual(Features.Fingerprint("debian/13/cloud", one), Features.Fingerprint("debian/13/cloud", moved));
        Assert.NotEqual(Features.Fingerprint("debian/13/cloud", one), Features.Fingerprint("debian/13/cloud", added));

        // The base counts too: the same features on a different image are a
        // different image.
        Assert.NotEqual(Features.Fingerprint("debian/13/cloud", one), Features.Fingerprint("ubuntu/24.04", one));
    }

    /// <summary>
    /// Options typed in a different order are the same image.
    /// </summary>
    /// <remarks>
    /// Otherwise editing a config without changing what it means rebuilds a
    /// toolchain, which is minutes of somebody's afternoon for nothing.
    /// </remarks>
    [Fact]
    public void ReorderingOptionsIsNotAChange()
    {
        var one = Features.Resolve(Parse(
            """{"ghcr.io/x/y/z:1": {"version": "1", "extra": "yes"}}"""));

        var other = Features.Resolve(Parse(
            """{"ghcr.io/x/y/z:1": {"extra": "yes", "version": "1"}}"""));

        Assert.Equal(Features.Fingerprint("base", one), Features.Fingerprint("base", other));
    }

    /// <summary>A fingerprint goes in an instance name, so it has to be a name.</summary>
    [Fact]
    public void TheFingerprintIsShortAndNameable()
    {
        var print = Features.Fingerprint("debian/13/cloud", Features.Resolve(Parse(
            """{"ghcr.io/devcontainers/features/node:1": {}}""")));

        Assert.Equal(8, print.Length);
        Assert.All(print, c => Assert.True(char.IsAsciiLetterOrDigit(c), $"'{c}' is not name-safe"));
        Assert.StartsWith("envmux-image-planno-", ProjectImage.InstanceName("planno", print), StringComparison.Ordinal);
    }

    /// <summary>Nothing declared is nothing built.</summary>
    [Fact]
    public void NoFeaturesIsNoImage()
    {
        Assert.Empty(Features.Resolve(null));
        Assert.Empty(Features.Resolve(new Dictionary<string, FeatureConfig>(StringComparer.Ordinal)));
    }

    /// <summary>
    /// The install script fetches, unpacks and runs, in that order.
    /// </summary>
    /// <remarks>
    /// The <c>tar -xf</c> is the one worth asserting. A feature's layer is
    /// <c>application/vnd.devcontainers.layer.v1+tar</c> — a plain tar, no gzip,
    /// whatever the .tgz in its annotation suggests — and <c>-xzf</c> fails on it
    /// with "not in gzip format", which reads like a corrupt download.
    /// </remarks>
    [Fact]
    public void TheInstallScriptIsWhatARegistryNeeds()
    {
        var feature = Features.Resolve(Parse(
            """{"ghcr.io/devcontainers/features/dotnet:2": {"version": "10.0"}}"""))[0];

        var script = Features.InstallScript(feature, "matt");

        Assert.DoesNotContain('\r', script);
        Assert.Contains("/token?scope=repository:", script, StringComparison.Ordinal);
        Assert.Contains("/manifests/", script, StringComparison.Ordinal);
        Assert.Contains("/blobs/", script, StringComparison.Ordinal);
        Assert.Contains("tar -xf", script, StringComparison.Ordinal);
        Assert.DoesNotContain("tar -xzf", script, StringComparison.Ordinal);
        Assert.Contains("./install.sh", script, StringComparison.Ordinal);

        // The option, and the account a per-user feature installs into.
        Assert.Contains("export VERSION='10.0'", script, StringComparison.Ordinal);
        Assert.Contains("export _REMOTE_USER='matt'", script, StringComparison.Ordinal);
        Assert.Contains("export _CONTAINER_USER='matt'", script, StringComparison.Ordinal);
    }

    /// <summary>
    /// An option value cannot break out of its quoting.
    /// </summary>
    /// <remarks>
    /// These values come from a file in the repository, so this is not a
    /// hostile-input story so much as a "somebody put a quote in a version
    /// string" one — but the mistake is the same either way, and a value that
    /// ends the quote turns the rest of itself into script.
    /// </remarks>
    [Fact]
    public void AnOptionCannotEscapeIntoTheScript()
    {
        var feature = Features.Resolve(Parse(
            """{"ghcr.io/x/y/z:1": {"version": "'; touch /tmp/pwned; '"}}"""))[0];

        var script = Features.InstallScript(feature, "matt");

        // Every quote in the value is closed, escaped and reopened, so the whole
        // thing stays one word. The dangerous substring is present -- it is the
        // value -- and being inside quotes is what makes it inert.
        Assert.Contains(
            @"export VERSION=''\''; touch /tmp/pwned; '\'''",
            script,
            StringComparison.Ordinal);

        // And there is no bare quote anywhere: an unescaped one is exactly how
        // a value would get out.
        var line = script
            .Split('\n')
            .Single(l => l.StartsWith("export VERSION=", StringComparison.Ordinal));

        Assert.Equal(0, Quotes(line) % 2);
    }

    /// <summary>How many single quotes a line has, which must be even.</summary>
    private static int Quotes(string line) => line.Count(c => c == '\'');

    /// <summary>A reference with no registry says so, rather than half-working.</summary>
    [Fact]
    public void ABareNameIsNotAReference() =>
        Assert.Throws<ConfigException>(() => Features.Resolve(Parse("""{"node": {}}""")));
}
