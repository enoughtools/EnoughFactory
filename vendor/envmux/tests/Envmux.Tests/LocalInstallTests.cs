using Envmux.Commands;

namespace Envmux.Tests;

public sealed class LocalInstallTests
{
    [Fact]
    public void RepeatedAndSelfInstallPreserveTheExecutableAndOtherState()
    {
        var root = Path.Combine(Path.GetTempPath(), "envmux-install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var source = Path.Combine(root, "download");
            var bin = Path.Combine(root, "bin");
            File.WriteAllText(source, "first release");
            File.WriteAllText(Path.Combine(root, "host.json"), "existing host state");
            var installed = LocalInstall.CopyExecutable(source, bin);
            var before = File.GetLastWriteTimeUtc(installed);
            Assert.Equal(installed, LocalInstall.CopyExecutable(source, bin));
            Assert.Equal(before, File.GetLastWriteTimeUtc(installed));
            Assert.Equal(installed, LocalInstall.CopyExecutable(installed, bin));

            File.WriteAllText(source, "next release");
            LocalInstall.CopyExecutable(source, bin);
            Assert.Equal("next release", File.ReadAllText(installed));
            Assert.Equal("existing host state", File.ReadAllText(Path.Combine(root, "host.json")));
            Assert.Single(Directory.GetFiles(bin));
            if (!OperatingSystem.IsWindows())
            {
                Assert.True(File.GetUnixFileMode(installed).HasFlag(UnixFileMode.UserExecute));
            }
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void AFailedCopyLeavesThePreviousExecutableIntact()
    {
        var root = Path.Combine(Path.GetTempPath(), "envmux-install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var source = Path.Combine(root, "download");
            var bin = Path.Combine(root, "bin");
            File.WriteAllText(source, "existing release");
            var installed = LocalInstall.CopyExecutable(source, bin);
            Assert.Throws<FileNotFoundException>(() => LocalInstall.CopyExecutable(Path.Combine(root, "missing"), bin));
            Assert.Equal("existing release", File.ReadAllText(installed));
            Assert.Single(Directory.GetFiles(bin));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("zsh", ".zshrc")]
    [InlineData("sh", ".profile")]
    public void PosixStartupPathsAreLiteralEvenWithShellSyntax(string shell, string profile)
    {
        var (file, content) = LocalInstall.ShellPath("/home/person", shell, "/home/it's $HOME;`whoami`/bin");
        Assert.Equal(Path.Combine("/home/person", profile), file);
        Assert.Equal("export PATH='/home/it'\\''s $HOME;`whoami`/bin':\"$PATH\"", content);
    }

    [Fact]
    public void ShellConfigurationPreservesExistingContentAndDoesNotAppendTwice()
    {
        var root = Path.Combine(Path.GetTempPath(), "envmux-install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var profile = Path.Combine(root, ".zshrc");
            var bin = Path.Combine(root, "bin");
            var (_, disabled) = LocalInstall.ShellPath(root, "zsh", bin);
            File.WriteAllText(profile, "# existing setup\nexport EDITOR=vim\n# " + disabled + "\n");
            Assert.Equal(profile, LocalInstall.WriteShellPath(root, "zsh", bin));
            var once = File.ReadAllText(profile);
            Assert.StartsWith("# existing setup\nexport EDITOR=vim\n", once, StringComparison.Ordinal);
            Assert.Contains(disabled, File.ReadLines(profile));
            LocalInstall.WriteShellPath(root, "zsh", bin);
            Assert.Equal(once, File.ReadAllText(profile));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void FishStartupEscapesQuotesAndBackslashes()
    {
        var (file, content) = LocalInstall.ShellPath("/home/person", "fish", "/home/it'\\s $HOME/bin");
        Assert.Equal(Path.Combine("/home/person", ".config", "fish", "conf.d", "envmux.fish"), file);
        Assert.Equal("fish_add_path --move -- '/home/it\\'\\\\s $HOME/bin'", content);
    }
}
