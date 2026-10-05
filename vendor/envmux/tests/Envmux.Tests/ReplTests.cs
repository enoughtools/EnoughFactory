using Envmux.Lean;

using Envmux.Ui;

namespace Envmux.Tests;

/// <summary>
/// What a typed command means.
/// </summary>
/// <remarks>
/// Parsing is separate from doing so that <c>/task restart web</c> can be
/// checked without an instance to restart anything in.
/// </remarks>
public class ReplTests
{
    [Theory]
    [InlineData("/shell", "Shell")]
    [InlineData("/attach", "Shell")]
    [InlineData("/code", "Code")]
    [InlineData("/open", "Open")]
    [InlineData("/portal", "Portal")]
    [InlineData("/po", "Portal")]
    [InlineData("/screen", "Screen")]
    [InlineData("/task", "Task")]
    [InlineData("/restart", "Restart")]
    [InlineData("/status", "Status")]
    [InlineData("/help", "Help")]
    [InlineData("/quit", "Quit")]
    public void EveryCommandInTheHelpIsACommand(string typed, string expected)
    {
        // The enum is internal, so the case names it and the test resolves it.
        Assert.Equal(expected, Repl.Parse(typed).Verb.ToString());
    }

    [Fact]
    public void TheSlashIsOptional()
    {
        // Somebody who pressed a key to reach a command line has already said
        // they want a command. Making them type a slash to prove it is a toll.
        Assert.Equal(ReplVerb.Shell, Repl.Parse("shell").Verb);
        Assert.Equal(ReplVerb.Shell, Repl.Parse("/shell").Verb);
        Assert.Equal(ReplVerb.Shell, Repl.Parse(":shell").Verb);
    }

    [Fact]
    public void AnUnambiguousPrefixIsEnough()
    {
        // `/sc` is /screen because nothing else starts that way.
        Assert.Equal(ReplVerb.Screen, Repl.Parse("/sc").Verb);
        Assert.Equal(ReplVerb.Quit, Repl.Parse("/q").Verb);

        // `/s` is not, because three commands do.
        Assert.Equal(ReplVerb.Unknown, Repl.Parse("/s").Verb);
    }

    [Fact]
    public void NothingTypedIsNotAnError()
    {
        Assert.Equal(ReplVerb.Nothing, Repl.Parse("").Verb);
        Assert.Equal(ReplVerb.Nothing, Repl.Parse("   ").Verb);
        Assert.Equal(ReplVerb.Nothing, Repl.Parse(null).Verb);
        Assert.Equal(ReplVerb.Nothing, Repl.Parse("/").Verb);
    }

    [Fact]
    public void SomethingElseIsSaidBackWithWhatWasTyped()
    {
        var command = Repl.Parse("/wat is this");

        Assert.Equal(ReplVerb.Unknown, command.Verb);
        Assert.Equal("/wat is this", command.Typed);
    }

    [Fact]
    public void ArgumentsSurviveIntact()
    {
        var command = Repl.Parse("/task restart web");

        Assert.Equal(ReplVerb.Task, command.Verb);
        Assert.Equal(["restart", "web"], command.Arguments);
        Assert.Equal("restart", command.Argument);
    }

    [Fact]
    public void AShellCommandKeepsItsSpaces()
    {
        // `/shell npm run build` is one command with arguments, not three.
        var command = Repl.Parse("/shell npm run build");

        Assert.Equal(ReplVerb.Shell, command.Verb);
        Assert.Equal("npm run build", command.Rest);
    }

    [Fact]
    public void CommandsAreCaseInsensitive()
    {
        Assert.Equal(ReplVerb.Shell, Repl.Parse("/SHELL").Verb);
        Assert.Equal(ReplVerb.Screen, Repl.Parse("/Screen").Verb);
    }

    [Fact]
    public void ExtraSpacesAreNotAnArgument()
    {
        var command = Repl.Parse("  /task    stop    web  ");

        Assert.Equal(ReplVerb.Task, command.Verb);
        Assert.Equal(["stop", "web"], command.Arguments);
    }

    [Fact]
    public void EveryCommandIsInTheHelpAndTheHelpIsAllCommands()
    {
        // A command that works but is not listed is a command nobody finds.
        var help = string.Join('\n', Repl.Help());

        foreach (var (name, _, _, _) in Repl.Commands)
        {
            Assert.Contains($"/{name}", help, StringComparison.Ordinal);
        }

        Assert.Equal(Repl.Commands.Count, Repl.Help().Count());
        Assert.Equal(Repl.Commands.Count, Repl.Names.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void NoTwoCommandsShareAName()
    {
        Assert.Equal(
            Repl.Commands.Count,
            Repl.Commands.Select(c => c.Name).Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void EveryLayoutCanBeNamed()
    {
        // /screen takes one of these, and a layout that cannot be named is one
        // that can only be reached by pressing a key the right number of times.
        foreach (var screen in Screens.Names)
        {
            var command = Repl.Parse($"/screen {screen}");

            Assert.Equal(ReplVerb.Screen, command.Verb);
            Assert.Equal(screen, command.Argument);
        }
    }
}
