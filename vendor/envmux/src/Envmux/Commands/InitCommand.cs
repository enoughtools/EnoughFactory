using System.Text;
using System.Text.Json;

using Envmux.Config;
using Envmux.Session;

namespace Envmux.Commands;

/// <summary>
/// Writes a <c>.envmux.json</c> that fits the repository it is run in.
/// </summary>
/// <remarks>
/// envmux works with no config at all, so this is a convenience rather than a
/// requirement — its job is to show you what the defaults were and give you
/// something to edit, with the tools it found already filled in.
/// </remarks>
internal static class InitCommand
{
    /// <summary>
    /// Stacks worth recognising, and what they imply.
    /// </summary>
    /// <remarks>
    /// The toolchain and the install are guesses that are nearly always right;
    /// the command that starts a dev server is a guess that nearly never is,
    /// because it depends on a script name only the repository knows. So this
    /// writes the first two and leaves the third as a commented example — a wrong
    /// task that looks authoritative is worse than an obvious blank.
    /// </remarks>
    private static readonly (string Marker, string? Toolchain, string? Install, (string Name, int Port)[] Routes)[]
        Stacks =
    [
        ("package.json",
            "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs",
            "npm ci",
            [("vite", 5173), ("api", 3000)]),
        ("Cargo.toml", "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y", null, []),
        ("go.mod", "sudo apt-get update && sudo apt-get install -y golang-go", "go mod download",
            [("api", 8080)]),
        ("pyproject.toml", "sudo apt-get update && sudo apt-get install -y python3 python3-venv python3-pip",
            null, [("api", 8000)]),
        ("requirements.txt", "sudo apt-get update && sudo apt-get install -y python3 python3-venv python3-pip",
            "pip install --break-system-packages -r requirements.txt", [("api", 8000)]),
    ];

    public static async Task<int> RunAsync(string directory, bool force, string? skills = null)
    {
        var path = Path.Combine(directory, SessionConfig.FileName);

        if (skills is not null)
        {
            await Agents.ProjectSkills.InstallAsync(directory, skills).ConfigureAwait(false);
            Console.WriteLine($"installed {skills} project skills");
            if (File.Exists(path) && !force)
            {
                return 0;
            }
        }

        if (File.Exists(path) && !force)
        {
            Console.Error.WriteLine($"envmux: {SessionConfig.FileName} already exists (use --force to replace it)");
            return 2;
        }

        var (toolchain, install, routes) = Detect(directory);
        var tools = ToolMounts.Detect();

        await File.WriteAllTextAsync(path, Render(Slug.FromDirectory(directory), toolchain, install, routes, tools))
            .ConfigureAwait(false);

        Console.WriteLine($"wrote {SessionConfig.FileName}");
        Console.WriteLine(routes.Length == 0
            ? "  routes none detected — add them and they become URLs"
            : $"  routes {string.Join(", ", routes.Select(r => $"{r.Name}:{r.Port}"))}");
        Console.WriteLine(toolchain is null
            ? "  tasks  none — add the commands that run in the instance"
            : $"  tasks  toolchain, install — add the dev server that serves your routes");
        // git is always written and never detected, so it is named here rather
        // than left out of a summary of a file it is in.
        Console.WriteLine(tools.Count == 0
            ? "  tools  git — this machine's credential, so a push from inside works"
            : $"  tools  {string.Join(", ", tools)}, git — copied in, so they arrive signed in");

        await EnsureGitignoreAsync(directory).ConfigureAwait(false);

        Console.WriteLine();
        Console.WriteLine($"Run `{CommandName.Current}` to start a session.");
        return 0;
    }

    private static (string? Toolchain, string? Install, (string Name, int Port)[] Routes) Detect(string directory)
    {
        foreach (var (marker, toolchain, install, routes) in Stacks)
        {
            if (File.Exists(Path.Combine(directory, marker)))
            {
                return (toolchain, install, routes);
            }
        }

        return (null, null, []);
    }

    /// <summary>
    /// Written by hand rather than serialised, because the comments are most of
    /// the value: a generated file nobody can read is a file nobody edits.
    /// </summary>
    private static string Render(
        string name,
        string? toolchain,
        string? install,
        (string Name, int Port)[] routes,
        IReadOnlyList<string> tools)
    {
        var json = new StringBuilder();
        json.AppendLine("{");
        json.AppendLine("  // Every field here is optional, and so is this file.");
        json.AppendLine("  // https://github.com/envmux/envmux/blob/main/docs/pages/configuration.md");
        json.AppendLine(Line("name", name) + ",");

        json.AppendLine();
        json.AppendLine("  // A port this session serves, per name. Each opens at http://localhost:<port>/");
        json.AppendLine("  // in the session's own browser (b, or Enter on it), whose localhost is the");
        json.AppendLine("  // instance, so a server bound to 127.0.0.1 inside needs no --host.");
        if (routes.Length == 0)
        {
            json.AppendLine("  \"routes\": {},");
        }
        else
        {
            json.AppendLine("  \"routes\": {");
            for (var i = 0; i < routes.Length; i++)
            {
                var comma = i == routes.Length - 1 ? "" : ",";
                json.AppendLine($"    \"{routes[i].Name}\": {routes[i].Port}{comma}");
            }

            json.AppendLine("  },");
        }

        json.AppendLine();
        json.AppendLine("  // Everything that runs inside the instance. A \"once\" task is expected");
        json.AppendLine("  // to finish; the rest keep running and their output is a pane you watch.");
        json.AppendLine("  // \"dependsOn\" names tasks and services alike.");
        json.AppendLine("  //");
        json.AppendLine("  // A session starts from a plain Debian instance, so the toolchain is a");
        json.AppendLine("  // task like any other — visible, pinned, and changed where you can see it.");
        json.AppendLine("  // For anything slow, see \"features\" below: that is installed once into");
        json.AppendLine("  // an image every session copies, rather than once per session.");
        json.AppendLine("  \"tasks\": {");

        if (toolchain is not null)
        {
            json.AppendLine(
                $"    \"toolchain\": {{ \"command\": {WireJson.Serialize(toolchain)}, \"kind\": \"once\" }},");
        }

        if (install is not null)
        {
            json.Append($"    \"install\": {{ \"command\": {WireJson.Serialize(install)}, \"kind\": \"once\"");
            json.AppendLine(toolchain is null ? " }" : ", \"dependsOn\": \"toolchain\" }");
        }

        // The command that starts a dev server depends on a script name only
        // this repository knows, so it is shown rather than guessed at.
        var first = routes.Length > 0 ? routes[0] : (Name: "dev", Port: 3000);
        json.AppendLine(
            $"    // \"{first.Name}\": {{ \"command\": \"npm run dev\"{(install is null ? "" : ", \"dependsOn\": \"install\"")}, " +
            $"\"ready\": {first.Port} }}");

        json.AppendLine("  },");

        json.AppendLine();
        json.AppendLine("  // Machines this session depends on — each with an address and a name of");
        json.AppendLine("  // its own, so two sessions both get a Postgres on 5432. envmux generates");
        json.AppendLine("  // the credentials, puts them on both sides, and gives you");
        json.AppendLine("  // ConnectionStrings__<name> plus <NAME>_HOST/_PORT/_USER/_PASSWORD/_DATABASE.");
        json.AppendLine("  // \"services\": { \"db\": { \"type\": \"postgres\" }, \"cache\": { \"type\": \"redis\" } },");
        json.AppendLine();
        json.AppendLine("  // Values envmux makes up once per session, and never writes down.");
        json.AppendLine("  // \"generate\": { \"SESSION_SECRET\": \"password\" },");
        json.AppendLine();
        json.AppendLine("  // Dev container features, spelled exactly as devcontainer.json spells");
        json.AppendLine("  // them — if this project has one, its \"features\" block pastes in");
        json.AppendLine("  // unedited. Installed once into an image every session is copied from,");
        json.AppendLine("  // so a .NET SDK or a browser costs its minutes once and not per session.");
        json.AppendLine("  // \"features\": { \"ghcr.io/devcontainers/features/node:1\": { \"version\": \"lts\" } },");
        json.AppendLine();
        json.AppendLine("  // Files on THIS machine to read the environment from. For the");
        json.AppendLine("  // gitignored .env holding local secrets: the repository crosses as a git");
        json.AppendLine("  // bundle, so what git ignores does not travel with it.");
        json.AppendLine("  // \"envFile\": \".env\",");
        json.AppendLine();
        json.AppendLine("  // Each session is a branch in this repository. Its commits are fetched");
        json.AppendLine("  // back here when it ends; its uncommitted work stays in the instance.");
        json.AppendLine("  \"git\": {");
        json.AppendLine($"    \"branchPrefix\": \"{GitConfig.DefaultBranchPrefix}\",");
        json.AppendLine($"    \"base\": \"{GitConfig.DefaultBase}\",");
        json.AppendLine("    // Instances are kept, so starting this session again picks one up where");
        json.AppendLine("    // you left it. `envmux prune` clears out the ones nothing is using.");
        json.AppendLine("    \"keepOnExit\": true");
        json.Append("  }");

        // Always, even with no coding tool on this machine: "git" is not found by
        // looking for a directory, so it would never appear in the detected list
        // — and a repository with a remote is the common case.
        {
            json.AppendLine(",");
            json.AppendLine();
            json.AppendLine("  // Host tool state, copied in so these arrive already signed in.");
            json.AppendLine("  // This puts real credentials inside the instance. Set any to \"off\".");
            json.AppendLine("  //");
            json.AppendLine("  // \"git\" is not a file: it asks git for the credential its own helper");
            json.AppendLine("  // holds, for this repository's remotes, so a push from inside works.");
            json.AppendLine("  \"tools\": {");
            for (var i = 0; i < tools.Count; i++)
            {
                json.AppendLine($"    \"{tools[i]}\": \"auto\",");
            }

            // Always offered, because every repository with a remote wants it
            // and it is the one tool that is not found by looking for a
            // directory — so it would never appear in the detected list.
            json.AppendLine("    \"git\": \"auto\"");
            json.Append("  }");
        }

        json.AppendLine();
        json.AppendLine("}");
        return json.ToString();

        static string Line(string key, string value) =>
            $"  \"{key}\": {WireJson.Serialize(value)}";
    }

    /// <summary>
    /// Keep <c>.envmux/</c> out of the repository.
    /// </summary>
    /// <remarks>
    /// It holds whatever envmux has to put in the project directory — at the
    /// moment, only a bundle kept behind when a session's commits could not be
    /// merged, which is a copy of part of the repository.
    /// </remarks>
    private static async Task EnsureGitignoreAsync(string directory)
    {
        var path = Path.Combine(directory, ".gitignore");
        var entry = SessionConfig.StateDirectory + "/";

        if (File.Exists(path))
        {
            var lines = await File.ReadAllLinesAsync(path).ConfigureAwait(false);
            if (lines.Any(l => l.Trim().TrimEnd('/') == SessionConfig.StateDirectory))
            {
                return;
            }

            var needsNewline = lines.Length > 0 && lines[^1].Length > 0;
            await File.AppendAllTextAsync(
                path,
                $"{(needsNewline ? Environment.NewLine : "")}# envmux session state{Environment.NewLine}{entry}{Environment.NewLine}")
                .ConfigureAwait(false);
        }
        else
        {
            await File.WriteAllTextAsync(
                path,
                $"# envmux session state{Environment.NewLine}{entry}{Environment.NewLine}")
                .ConfigureAwait(false);
        }

        Console.WriteLine($"  added {entry} to .gitignore");
    }
}
