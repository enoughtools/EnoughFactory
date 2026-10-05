using Envmux.Docker;

namespace Envmux.Tests;

/// <summary>
/// The lease that keeps the on-demand Docker endpoint alive: taken, seen,
/// released, handed off, and expired.
/// </summary>
/// <remarks>
/// In the <see cref="HostHome"/> collection because it moves <c>ENVMUX_HOME</c>,
/// which is one variable for the whole process — the lease directory hangs off
/// it, and a stray landing in the developer's real <c>~/.envmux</c> is exactly
/// what that collection exists to prevent.
/// </remarks>
[Collection(HostHome.Name)]
public class DockerLeaseTests : IDisposable
{
    private readonly string? _previousHome;
    private readonly string _home;

    public DockerLeaseTests()
    {
        _previousHome = Environment.GetEnvironmentVariable("ENVMUX_HOME");
        _home = Path.Combine(Path.GetTempPath(), "envmux-lease-" + Guid.NewGuid().ToString("N"));
        Environment.SetEnvironmentVariable("ENVMUX_HOME", _home);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("ENVMUX_HOME", _previousHome);

        try
        {
            if (Directory.Exists(_home))
            {
                Directory.Delete(_home, recursive: true);
            }
        }
        catch (IOException)
        {
        }

        GC.SuppressFinalize(this);
    }

    [Fact]
    public void NothingIsLiveWithNoLeases()
    {
        Assert.False(DockerLease.AnyLive());
    }

    [Fact]
    public async Task AHeldLeaseIsLive()
    {
        var lease = DockerLease.Acquire();

        Assert.True(DockerLease.AnyLive());

        await lease.DisposeAsync();
    }

    [Fact]
    public async Task DisposingReleasesTheClaim()
    {
        var lease = DockerLease.Acquire();
        await lease.DisposeAsync();

        Assert.False(DockerLease.AnyLive());
    }

    [Fact]
    public async Task LingeringLeavesTheLeaseToExpire()
    {
        var lease = DockerLease.Acquire();
        lease.Linger();
        await lease.DisposeAsync();

        // Still there — the hand-off window that lets VS Code connect before the
        // endpoint decides it is unneeded.
        Assert.True(DockerLease.AnyLive());
    }

    [Fact]
    public async Task AStaleLeaseDoesNotCount()
    {
        var lease = DockerLease.Acquire();
        lease.Linger();
        await lease.DisposeAsync();

        // Age every lease past its TTL, the way a crashed client's would.
        foreach (var file in Directory.EnumerateFiles(DockerLease.Directory))
        {
            File.SetLastWriteTimeUtc(file, DateTime.UtcNow - DockerLease.Ttl - TimeSpan.FromSeconds(5));
        }

        Assert.False(DockerLease.AnyLive());
    }
}
