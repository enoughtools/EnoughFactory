using Envmux.Backends;
using Envmux.Config;
using Envmux.Host;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// Which backend a session runs on, when nothing says and when something does.
/// </summary>
/// <remarks>
/// The default is the decision worth pinning: the Docker engine on this
/// machine, even where an Incus host is set up — that one is asked for.
/// </remarks>
[Collection(HostHome.Name)]
public class BackendCatalogTests
{
    [Fact]
    public void DefaultsToDockerEvenWithAnIncusHost()
    {
        // Provisioned means the client certificate is on disk too, so this
        // runs against a scratch home rather than whatever this machine has.
        var home = Directory.CreateTempSubdirectory("envmux-home-");

        try
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", home.FullName);
            File.WriteAllText(HostConfig.CertificatePath, "not a real certificate");
            File.WriteAllText(HostConfig.KeyPath, "not a real key");

            var provisioned = new HostConfig { Api = "192.168.19.43:8443", Fingerprint = new string('a', 64) };

            Assert.True(provisioned.IsProvisioned);
            Assert.Equal(BackendKind.Docker, BackendCatalog.Default);
            Assert.IsType<DockerBackend>(BackendCatalog.Open(requested: null, provisioned), exactMatch: false);
        }
        finally
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", null);
            home.Delete(recursive: true);
        }
    }

    [Theory]
    [InlineData("incus", "Incus")]
    [InlineData("Docker", "Docker")]
    [InlineData(" docker ", "Docker")]
    public void ReadsABackendByName(string name, string kind)
    {
        Assert.Equal(kind, BackendCatalog.Parse(name)?.ToString());
    }

    [Theory]
    [InlineData("podman")]
    [InlineData("")]
    [InlineData(null)]
    public void ReadsNothingElse(string? name)
    {
        Assert.Null(BackendCatalog.Parse(name));
    }
}

/// <summary>The <c>backend</c> field, as a plan resolves it.</summary>
public sealed class BackendPlanTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("envmux-test-").FullName;

    public void Dispose()
    {
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
            // A leaked temp directory is not worth failing a test over.
        }
    }

    private SessionPlan Plan(string json)
    {
        File.WriteAllText(Path.Combine(_dir, SessionConfig.FileName), json);
        return SessionPlan.Resolve(SessionConfig.Load(_dir), _dir, "amber-fox");
    }

    [Fact]
    public void LeavesTheChoiceOpenWhenNothingIsSaid()
    {
        Assert.Null(Plan("{}").Backend);
    }

    [Fact]
    public void TakesTheOneTheConfigNames()
    {
        Assert.Equal(BackendKind.Docker, Plan("""{"backend":"docker"}""").Backend);
    }

    [Fact]
    public void RefusesOneItDoesNotKnow()
    {
        var e = Assert.Throws<ConfigException>(() => Plan("""{"backend":"podman"}"""));

        Assert.Contains("incus", e.Message, StringComparison.Ordinal);
        Assert.Contains("docker", e.Message, StringComparison.Ordinal);
    }
}
