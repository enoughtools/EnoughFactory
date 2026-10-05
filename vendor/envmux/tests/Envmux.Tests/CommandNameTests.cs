using Envmux.Commands;

namespace Envmux.Tests;

public sealed class CommandNameTests
{
    [Theory]
    [InlineData(@"C:\Users\someone\.envmux\bin\envmux.exe", "envmux")]
    [InlineData("/home/someone/.dotnet/tools/devenvmux", "devenvmux")]
    [InlineData(@"C:\tools\em.exe", "em")]
    public void ItIsWhateverTheBinaryIsCalled(string processPath, string expected) =>
        Assert.Equal(expected, CommandName.From(processPath));

    [Theory]
    [InlineData(@"C:\Program Files\dotnet\dotnet.exe")]
    [InlineData("/usr/share/dotnet/dotnet")]
    [InlineData(@"C:\Program Files\dotnet\DOTNET.EXE")]
    public void TheRuntimeHostIsNeverTheCommandToRun(string processPath) =>
        Assert.Equal("envmux", CommandName.From(processPath));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void WithNoProcessPathItIsTheProductsName(string? processPath) =>
        Assert.Equal("envmux", CommandName.From(processPath));
}
