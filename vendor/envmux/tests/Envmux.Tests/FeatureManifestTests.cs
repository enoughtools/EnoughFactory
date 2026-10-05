using Envmux.Config;
using Envmux.Incus;

namespace Envmux.Tests;

/// <summary>
/// What a feature declares about itself, and why it has to be read.
/// </summary>
/// <remarks>
/// The manifest below is the real one for
/// <c>ghcr.io/devcontainers/features/node:1</c>, trimmed. It matters that this
/// is real: the metadata is a JSON document inside a string inside a JSON
/// document, and the shape is the only thing this code depends on.
/// </remarks>
public class FeatureManifestTests
{
    private const string NodeManifest =
        """
        {"schemaVersion":2,
         "mediaType":"application/vnd.oci.image.manifest.v1+json",
         "config":{"mediaType":"application/vnd.devcontainers","digest":"sha256:4413","size":2},
         "layers":[{"mediaType":"application/vnd.devcontainers.layer.v1+tar",
                    "digest":"sha256:fdb79b02","size":28160,
                    "annotations":{"org.opencontainers.image.title":"devcontainer-feature-node.tgz"}}],
         "annotations":{
           "dev.containers.metadata":"{\"id\":\"node\",\"version\":\"1.7.1\",\"options\":{\"version\":{\"type\":\"string\",\"default\":\"lts\"},\"nodeGypDependencies\":{\"type\":\"boolean\",\"default\":true},\"nvmInstallPath\":{\"type\":\"string\",\"default\":\"/usr/local/share/nvm\"}},\"containerEnv\":{\"NVM_DIR\":\"/usr/local/share/nvm\",\"PATH\":\"/usr/local/share/nvm/current/bin:${PATH}\"}}",
           "com.github.package.type":"devcontainer_feature"}}
        """;

    /// <summary>Every option's default, whatever type it was declared as.</summary>
    [Fact]
    public void TheDefaultsComeOutOfTheAnnotation()
    {
        var metadata = FeatureManifest.Parse(NodeManifest)!;

        Assert.Equal("node", metadata.Id);
        Assert.Equal("1.7.1", metadata.Version);
        Assert.Equal("lts", metadata.Defaults["version"]);
        Assert.Equal("/usr/local/share/nvm", metadata.Defaults["nvmInstallPath"]);

        // A boolean default has to reach install.sh as the string it compares
        // against, not as True.
        Assert.Equal("true", metadata.Defaults["nodeGypDependencies"]);
    }

    /// <summary>
    /// The environment, in the order the feature wrote it.
    /// </summary>
    /// <remarks>
    /// The order is load-bearing, not cosmetic. dotnet declares
    /// <c>DOTNET_ROOT</c> and then <c>PATH</c> as <c>$PATH:$DOTNET_ROOT</c>, so
    /// sorting these by name sets PATH against a variable that does not exist
    /// yet — and the result is a toolchain that installed and cannot be found.
    /// </remarks>
    [Fact]
    public void TheContainerEnvComesOutInOrder()
    {
        var metadata = FeatureManifest.Parse(NodeManifest)!;

        Assert.Equal(["NVM_DIR", "PATH"], metadata.ContainerEnv.Select(e => e.Key));
        Assert.Equal("/usr/local/share/nvm", metadata.ContainerEnv[0].Value);
        Assert.Equal("/usr/local/share/nvm/current/bin:${PATH}", metadata.ContainerEnv[1].Value);
    }

    /// <summary>A manifest with no metadata is a null, not a throw.</summary>
    [Fact]
    public void NoMetadataIsNoMetadata()
    {
        Assert.Null(FeatureManifest.Parse("""{"schemaVersion":2,"layers":[]}"""));
        Assert.Null(FeatureManifest.Parse("""{"annotations":{"other":"thing"}}"""));
    }

    /// <summary>
    /// The defaults reach install.sh, and the config still wins.
    /// </summary>
    /// <remarks>
    /// The failure this prevents: <c>dotnet:2</c> given only a version ran
    /// <c>dotnet-install.sh --install-dir</c> with nothing after it, and died on
    /// <c>mkdir: cannot create directory ''</c>. The option that was never set
    /// is not named anywhere in that.
    /// </remarks>
    [Fact]
    public void UnsetOptionsGetTheirDeclaredDefault()
    {
        var metadata = FeatureManifest.Parse(NodeManifest);

        var feature = Features.Resolve(
            System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, FeatureConfig>>(
                """{"ghcr.io/devcontainers/features/node:1": {"version": "22"}}""",
                IncusJson.Options)!)[0];

        var script = Features.InstallScript(feature, "matt", metadata);

        // Set here, so the config wins over the default.
        Assert.Contains("export VERSION='22'", script, StringComparison.Ordinal);
        Assert.DoesNotContain("export VERSION='lts'", script, StringComparison.Ordinal);

        // Not set here, so the feature's own default is used rather than "".
        Assert.Contains("export NVMINSTALLPATH='/usr/local/share/nvm'", script, StringComparison.Ordinal);
        Assert.Contains("export NODEGYPDEPENDENCIES='true'", script, StringComparison.Ordinal);
    }

    /// <summary>
    /// containerEnv is written for later shells, unexpanded.
    /// </summary>
    /// <remarks>
    /// <c>${PATH}</c> has to survive into the profile script. Expanding it while
    /// installing would bake in the PATH of the install shell, and every login
    /// afterwards would get that instead of its own.
    /// </remarks>
    [Fact]
    public void ContainerEnvBecomesAProfileScript()
    {
        var feature = Features.Resolve(
            System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, FeatureConfig>>(
                """{"ghcr.io/devcontainers/features/node:1": {}}""",
                IncusJson.Options)!)[0];

        var script = Features.InstallScript(feature, "matt", FeatureManifest.Parse(NodeManifest));

        Assert.Contains("/etc/profile.d/envmux-feature-node.sh", script, StringComparison.Ordinal);
        Assert.Contains(@"export PATH=""/usr/local/share/nvm/current/bin:${PATH}""", script, StringComparison.Ordinal);

        // A quoted heredoc, so nothing in the value is expanded on the way in.
        Assert.Contains("<<'ENVMUX_FEATURE_ENV'", script, StringComparison.Ordinal);
        Assert.DoesNotContain('\r', script);

        // And set before install.sh as well as after it: a feature reads its own
        // declared environment during its own installation. dotnet's install
        // script runs --install-dir "$DOTNET_ROOT", which it declares itself.
        var lines = script.Split('\n').ToList();
        var install = lines.FindIndex(l => l.Trim() == "./install.sh");
        var exported = lines.FindIndex(l => l.StartsWith(@"export NVM_DIR=", StringComparison.Ordinal));

        Assert.True(exported >= 0 && exported < install,
            $"NVM_DIR is exported at line {exported} and install.sh runs at {install}");
    }

    /// <summary>
    /// A later feature sees what earlier ones put on the PATH.
    /// </summary>
    /// <remarks>
    /// A toolchain installs in order and the later parts assume the earlier
    /// ones: a feature running `dotnet tool install` needs the dotnet feature's
    /// DOTNET_ROOT, and what runs here is not a login shell.
    /// </remarks>
    [Fact]
    public void EarlierFeaturesEnvironmentIsSourcedFirst()
    {
        var feature = Features.Resolve(
            System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, FeatureConfig>>(
                """{"ghcr.io/devcontainers/features/node:1": {}}""",
                IncusJson.Options)!)[0];

        var script = Features.InstallScript(feature, "matt", FeatureManifest.Parse(NodeManifest));

        Assert.Contains("/etc/profile.d/envmux-feature-*.sh", script, StringComparison.Ordinal);
    }

    /// <summary>Without metadata it still installs, with what was given.</summary>
    [Fact]
    public void NoMetadataStillProducesAScript()
    {
        var feature = Features.Resolve(
            System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, FeatureConfig>>(
                """{"ghcr.io/devcontainers/features/node:1": {"version": "22"}}""",
                IncusJson.Options)!)[0];

        var script = Features.InstallScript(feature, "matt", null);

        Assert.Contains("export VERSION='22'", script, StringComparison.Ordinal);
        Assert.Contains("./install.sh", script, StringComparison.Ordinal);

        // It still reads what earlier features left, because that does not
        // depend on knowing anything about this one — but it writes no profile
        // of its own, having nothing to put in it.
        Assert.Contains("/etc/profile.d/envmux-feature-*.sh", script, StringComparison.Ordinal);
        Assert.DoesNotContain("envmux-feature-node.sh", script, StringComparison.Ordinal);
    }
}
