using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

using Envmux.Process;

namespace Envmux.Tests;

/// <summary>
/// Every PowerShell script embedded in the code, checked against the PowerShell
/// that will actually run it.
/// </summary>
/// <remarks>
/// <para>
/// This exists because of a bug that nothing else could have caught.
/// <c>ConvertTo-Json -AsArray</c> compiles, parses, reads correctly and is
/// wrong: the parameter arrived in PowerShell 6 and envmux deliberately runs
/// Windows PowerShell 5.1, so it fails at parameter binding — at runtime, in the
/// middle of a host build, after a six hundred megabyte download.
/// </para>
/// <para>
/// A parse check would not have found it, because binding happens later than
/// parsing. So this parses each block for syntax <em>and</em> asks the live
/// session whether every command exists and every parameter it names is one that
/// command has.
/// </para>
/// <para>
/// It reads the source files, which is unusual for a test and is the point:
/// the scripts are string literals inside private methods and there is nothing
/// else to enumerate. It skips rather than fails when the source is not beside
/// it, or when this is not Windows.
/// </para>
/// </remarks>
public partial class PowershellScriptTests
{
    [SkippableFact]
    public async Task EveryEmbeddedScriptRunsOnThisPowershell()
    {
        Skip.IfNot(OperatingSystem.IsWindows(), "PowerShell is the Windows half");

        var source = FindSource();
        Skip.If(source is null, "the source tree is not beside this test");

        var blocks = Extract(source!);

        Assert.True(blocks.Count > 5, $"only found {blocks.Count} scripts — the extraction has stopped working");

        var payload = Path.Combine(Path.GetTempPath(), $"envmux-psaudit-{Guid.NewGuid():N}.json");
        await File.WriteAllTextAsync(payload, JsonSerializer.Serialize(blocks));

        try
        {
            var result = await ProcessRunner.RunAsync(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-EncodedCommand", Encoded(payload)]);

            var problems = result.Output.ReplaceLineEndings("\n").Trim();

            Assert.True(
                problems.Length == 0,
                $"{blocks.Count} embedded scripts, and these do not work here:\n{problems}\n{result.Error}");
        }
        finally
        {
            File.Delete(payload);
        }
    }

    /// <summary>
    /// The audit itself, which has to run inside PowerShell to be able to ask it
    /// anything.
    /// </summary>
    /// <remarks>
    /// Prefix matching on parameters, because that is how PowerShell binds them:
    /// <c>-Conf</c> is <c>-Confirm</c>, and a checker stricter than the binder
    /// would report working code as broken.
    /// </remarks>
    private static string Audit(string payload) =>
        $$"""
          $ErrorActionPreference = 'Stop'
          $blocks = Get-Content -Raw '{{payload}}' | ConvertFrom-Json

          foreach ($b in $blocks) {
              $tokens = $null; $errors = $null
              $ast = [System.Management.Automation.Language.Parser]::ParseInput(
                  $b.body, [ref]$tokens, [ref]$errors)

              foreach ($e in $errors) { "$($b.file):$($b.line)  PARSE  $($e.Message)" }

              $commands = $ast.FindAll(
                  { param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)

              foreach ($c in $commands) {
                  $name = $c.GetCommandName()
                  if (-not $name) { continue }

                  $cmd = Get-Command $name -ErrorAction SilentlyContinue
                  if (-not $cmd) { "$($b.file):$($b.line)  MISSING COMMAND  $name"; continue }

                  while ($cmd.CommandType -eq 'Alias') { $cmd = $cmd.ResolvedCommand }

                  # A native executable has no parameters PowerShell knows about,
                  # so every switch on it would read as a bad one. route.exe -p
                  # is the case in point, and it is only there because
                  # New-NetRoute cannot write a persistent route on Windows 11.
                  # That the command exists is still worth knowing, so the check
                  # above stands and only the binding check is skipped.
                  if ($cmd.CommandType -eq 'Application') { continue }

                  $valid = @($cmd.Parameters.Keys) +
                           @($cmd.Parameters.Values | ForEach-Object { $_.Aliases }) |
                           Where-Object { $_ }

                  foreach ($el in $c.CommandElements) {
                      if ($el -isnot [System.Management.Automation.Language.CommandParameterAst]) { continue }

                      $p = $el.ParameterName
                      if (-not ($valid | Where-Object { $_ -like "$p*" })) {
                          "$($b.file):$($b.line)  BAD PARAMETER  $name -$p"
                      }
                  }
              }
          }
          """;

    private static string Encoded(string payload) =>
        Convert.ToBase64String(Encoding.Unicode.GetBytes(Audit(payload)));

    /// <summary>Every raw string literal that looks like PowerShell, with where it came from.</summary>
    private static List<Block> Extract(string source)
    {
        var blocks = new List<Block>();

        foreach (var file in Directory.EnumerateFiles(source, "*.cs", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
                file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            {
                continue;
            }

            var text = File.ReadAllText(file);
            var relative = Path.GetRelativePath(source, file).Replace('\\', '/');

            foreach (Match match in Literal().Matches(text))
            {
                var body = match.Groups[1].Value;

                if (!Cmdlet().IsMatch(body))
                {
                    continue;
                }

                blocks.Add(new Block(
                    relative,
                    text[..match.Index].Count(c => c == '\n') + 1,
                    Dedent(body)));
            }
        }

        return blocks;
    }

    /// <summary>
    /// Take the literal's own indentation back off.
    /// </summary>
    /// <remarks>
    /// A raw string literal is already dedented by the compiler against its
    /// closing quotes; this regex does not see that, and a here-string whose
    /// terminator ends up indented is a parse error rather than a script.
    /// </remarks>
    private static string Dedent(string body)
    {
        var lines = body.ReplaceLineEndings("\n").Split('\n');

        var pad = lines
            .Where(l => l.Trim().Length > 0)
            .Select(l => l.Length - l.TrimStart().Length)
            .DefaultIfEmpty(0)
            .Min();

        return string.Join('\n', lines.Select(l => l.Length >= pad ? l[pad..] : l));
    }

    /// <summary>Where the source is, walking up from wherever the test binary landed.</summary>
    private static string? FindSource()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);

        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, "src", "Envmux");

            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            directory = directory.Parent;
        }

        return null;
    }

    private sealed record Block(string File, int Line, string Body);

    [GeneratedRegex("\"\"\"\r?\n(.*?)\r?\n\\s*\"\"\"", RegexOptions.Singleline)]
    private static partial Regex Literal();

    [GeneratedRegex(@"(Get-|Set-|New-|Add-|Remove-|Stop-|Start-|Enable-|Find-|Convert(To|From)-)\w+")]
    private static partial Regex Cmdlet();
}
