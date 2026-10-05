using Envmux.Backends.DockerEngine;

namespace Envmux.Tests;

public class ManagedEngineEndpointTests
{
    [Fact]
    public void ManagedBridgeOverridesOnlyItsExactHostAlias()
    {
        Assert.Equal("host.docker.internal:192.168.5.2", DockerSpec.BridgeHost(true, "192.168.5.2"));
        Assert.Equal(DockerSpec.HostGateway, DockerSpec.BridgeHost(false, "192.168.5.2"));
        Assert.Equal(DockerSpec.HostGateway, DockerSpec.BridgeHost(true, null));
        Assert.Throws<Envmux.Backends.BackendException>(() => DockerSpec.BridgeHost(true, "host; arbitrary-command"));
    }

    private static EngineEndpoint Resolve(string? managedEndpoint, bool windows = false) => EngineEndpoint.Resolve(
        "unix:///host-user-record/docker.sock",
        name => name switch
        {
            "ENVMUX_MANAGED_DOCKER" => "1",
            "ENVMUX_DOCKER_HOST" => managedEndpoint,
            _ => throw new InvalidOperationException("managed mode read ambient Docker configuration"),
        },
        "/home/ambient-user",
        windows);

    [Fact]
    public void ManagedEndpointOverridesConfiguredAndAmbientEndpoints()
    {
        var endpoint = Resolve("unix:///var/lib/enoughfactory/engine/docker.sock");
        Assert.Equal(EngineTransport.Unix, endpoint.Transport);
        Assert.Equal("/var/lib/enoughfactory/engine/docker.sock", endpoint.Address);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("unix://")]
    [InlineData("unix://relative/docker.sock")]
    [InlineData("unix:///")]
    [InlineData("unix:///run/../docker.sock")]
    [InlineData("unix:////run/docker.sock")]
    [InlineData("unix:///run/docker.sock/")]
    [InlineData("unix:///run/docker.sock?other=engine")]
    [InlineData("unix:///run/docker.sock#other")]
    [InlineData("unix:///run/docker.sock\n")]
    [InlineData(" unix:///run/docker.sock")]
    [InlineData("tcp://127.0.0.1:2375")]
    [InlineData("npipe:////./pipe/docker_engine")]
    public void MissingOrMalformedManagedEndpointNeverFallsBack(string? endpoint)
    {
        var refused = Assert.Throws<DockerEngineException>(() => Resolve(endpoint));
        Assert.Contains("ENVMUX_DOCKER_HOST", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ManagedEngineIsUnavailableOnWindowsRatherThanUsingAHostPipe()
    {
        var refused = Assert.Throws<DockerEngineException>(() => Resolve("unix:///run/owned/docker.sock", windows: true));
        Assert.Contains("Mac or Linux", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnInvalidManagedModeFlagDoesNotFallThroughToTheHostEngine()
    {
        Assert.Throws<DockerEngineException>(() => EngineEndpoint.Resolve(null,
            name => name == "ENVMUX_MANAGED_DOCKER" ? "true" : "unix:///var/run/docker.sock", "/home/user", false));
    }

    [Fact]
    public void OrdinaryEnvmuxKeepsItsExistingResolutionWhenManagedModeIsAbsent()
    {
        var endpoint = EngineEndpoint.Resolve(null, _ => null, "/nonexistent-home", false);
        Assert.Equal(new EngineEndpoint(EngineTransport.Unix, EngineEndpoint.DefaultSocket), endpoint);
    }
}
