using Envmux.Backends;
using Envmux.Backends.DockerEngine;

namespace Envmux.Tests.DockerEngine;

/// <summary><see cref="DockerFiles"/> against the fake engine: the archive it sends, and what it makes of the one it gets.</summary>
public sealed class DockerFilesTests
{
    private const string Container = "swarmtest-files-fake";

    private static async Task<FakeDockerEngine> EngineAsync()
    {
        var engine = new FakeDockerEngine { ImagesMustExist = false };
        await engine.CreateContainerAsync(Container, new ContainerCreate { Image = "golden" });
        return engine;
    }

    [Fact]
    public async Task APushLandsTheFileAtItsPathWithItsMode()
    {
        await using var engine = await EngineAsync();
        var files = new DockerFiles(engine);

        await files.PushAsync(Container, "/home/matt/.config/envmux/token", "secret\n"u8.ToArray(), "0600");

        var file = engine.FileIn(Container, "/home/matt/.config/envmux/token");

        Assert.NotNull(file);
        Assert.Equal("secret\n", file.Text);
        Assert.Equal(Convert.ToInt32("600", 8), file.Mode);

        // Unpacked at the root, whole path in the entry: the engine makes the directories.
        Assert.Equal(("PutArchive", Container), engine.Calls.Last(c => c.Operation == "PutArchive"));
    }

    [Fact]
    public async Task APushIsOneEntryRootedAtSlashOwnedByRoot()
    {
        var entry = TarEntry.File("/work/.envmux/seed.bundle", new byte[] { 1, 2, 3 }, "0644");

        Assert.Equal("work/.envmux/seed.bundle", entry.Name);
        Assert.Equal(0, entry.Uid);
        Assert.Equal(0, entry.Gid);
        Assert.Equal(Convert.ToInt32("644", 8), (int)entry.Mode);
        Assert.Equal(3, entry.Length);

        // The seam's spelling, and what is not a mode is the usual one.
        Assert.Equal(Convert.ToInt32("755", 8), (int)TarEntry.Mode(" 0755 "));
        Assert.Equal(Convert.ToInt32("644", 8), (int)TarEntry.Mode("rw-r--r--"));
        Assert.Equal(Convert.ToInt32("644", 8), (int)TarEntry.Mode("0789"));
        Assert.Equal(Convert.ToInt32("644", 8), (int)TarEntry.Mode(""));

        await Task.CompletedTask;
    }

    [Theory]
    [InlineData("")]
    [InlineData("relative/file")]
    [InlineData("/a/directory/")]
    public async Task APushToSomethingThatIsNotAFilesAbsolutePathIsRefusedBeforeTheEngineIsAsked(string path)
    {
        await using var engine = await EngineAsync();

        var refused = await Assert.ThrowsAsync<BackendException>(
            () => new DockerFiles(engine).PushAsync(Container, path, "x"u8.ToArray()));

        Assert.Contains(Container, refused.Message, StringComparison.Ordinal);
        Assert.Equal(0, engine.Count("PutArchive"));
    }

    [Fact]
    public async Task APullIsTheFilesBytesAndNothingIsNull()
    {
        await using var engine = await EngineAsync();
        var files = new DockerFiles(engine);

        engine.AddFile(Container, "/etc/hostname", "proj-sess\n");

        Assert.Equal("proj-sess\n"u8.ToArray(), await files.PullAsync(Container, "/etc/hostname"));
        Assert.Null(await files.PullAsync(Container, "/etc/not-there"));

        // What went in comes back out.
        await files.PushAsync(Container, "/tmp/round", new byte[] { 0, 255, 10, 13 });
        Assert.Equal(new byte[] { 0, 255, 10, 13 }, await files.PullAsync(Container, "/tmp/round"));
    }

    [Fact]
    public async Task AContainerThatIsNotThereIsTheEnginesRefusalAsABackendException()
    {
        await using var engine = await EngineAsync();
        var files = new DockerFiles(engine);

        var push = await Assert.ThrowsAsync<BackendException>(() => files.PushAsync("swarmtest-files-nowhere", "/x", "x"u8.ToArray()));
        Assert.Contains("swarmtest-files-nowhere", push.Message, StringComparison.Ordinal);

        var pull = await Assert.ThrowsAsync<BackendException>(() => files.PullAsync("swarmtest-files-nowhere", "/x"));
        Assert.Contains("swarmtest-files-nowhere", pull.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("/etc/alternatives/vi", "/usr/bin/vim.basic", "/usr/bin/vim.basic")]
    [InlineData("/usr/bin/vi", "../lib/x/vi", "/usr/lib/x/vi")]
    [InlineData("/home/matt/link", "./real", "/home/matt/real")]
    [InlineData("/a/b/c", "../../../../d", "/d")]
    public void ALinkIsResolvedBesideItself(string at, string target, string expected) =>
        Assert.Equal(expected, DockerFiles.Resolve(at, target));
}
