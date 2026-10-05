using System.Text;

using Envmux.Config;
using Envmux.Session;

namespace Envmux.Commands;

/// <summary>
/// Emits a prompt that gets an agent to write this repository's
/// <c>.envmux.json</c>.
/// </summary>
/// <remarks>
/// <para>
/// The declaration is meant to be generated. Something that has read the
/// repository — its lockfiles, its compose file, its README's getting-started
/// section — will infer the ports and the commands better than any template,
/// and envmux is not going to out-guess it.
/// </para>
/// <para>
/// So envmux ships the instructions rather than the inference: the prompt goes
/// to stdout and the agent is whatever you pipe it to. That also means every
/// agent works, including ones that did not exist when this was written.
/// </para>
/// </remarks>
internal static class AutoconfigureCommand
{
    public static int Run(string directory)
    {
        Console.Write(Prompt(directory));

        // Only when a person is looking. Piped, this would be noise on stderr
        // at best and inside the prompt at worst.
        if (!Console.IsOutputRedirected)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine("— that is a prompt, not a config. Hand it to an agent:");
            Console.Error.WriteLine();
            Console.Error.Write(Invocations(CommandName.Current));
            Console.Error.WriteLine();
            Console.Error.WriteLine($"Then check what it wrote:  {CommandName.Current} config validate");
        }

        return 0;
    }

    /// <summary>
    /// The ways to get this prompt into an agent.
    /// </summary>
    /// <remarks>
    /// Claude is given the prompt as an argument rather than on stdin, so it
    /// opens an interactive session with the prompt already in it. Writing this
    /// file is a conversation — which script starts the dev server, is that
    /// database real — and a one-shot with a closed stdin has nowhere to ask.
    /// The others are shown in the form each of them documents.
    /// </remarks>
    internal static string Invocations(string command) =>
        $"""
            claude "$({command} autoconfigure)"      interactive, prompt already in
            {command} autoconfigure | codex exec
            {command} autoconfigure | gemini -p
            {command} autoconfigure | opencode run

        """;

    /// <summary>Build the prompt, including what envmux can already see.</summary>
    internal static string Prompt(string directory)
    {
        var text = new StringBuilder();

        // Every instruction below names the command that printed this, not
        // "envmux". A development build is installed as `devenvmux`, and an
        // unrelated older envmux may be on the PATH — a prompt that says
        // "envmux" sends the reader to the wrong program, which is exactly
        // what happened the first time this was tried.
        var command = CommandName.Current;
        var existing = File.Exists(Path.Combine(directory, SessionConfig.FileName));

        text.AppendLine(existing
            ? $"Update this repository's `{SessionConfig.FileName}`, then check it."
            : $"Write an `{SessionConfig.FileName}` for this repository, then check it.");

        text.AppendLine();

        if (existing)
        {
            text.AppendLine($"**There is already an `{SessionConfig.FileName}`. Read it before you change anything.**");
            text.AppendLine("Someone wrote it deliberately. Keep what is right, keep the comments, and change");
            text.AppendLine("only what the repository shows to be wrong or missing. Do not replace it wholesale,");
            text.AppendLine("and do not remove a field because you cannot see why it is there — say what you");
            text.AppendLine("would remove and why, and let the user decide.");
            text.AppendLine();
        }

        text.AppendLine("You are in the repository root. Read it first — do not guess from convention.");
        text.AppendLine();
        text.AppendLine($"The tool is `{command}` — that is what printed this and what you must check");
        text.AppendLine("your work with. It reads `.envmux.json`. Anything that reads `.envmux.toml` is");
        text.AppendLine("a different, older tool that may also be on this machine; ignore it.");
        text.AppendLine();

        Observed(text, directory);

        text.Append($"""
            ## What envmux is, in one paragraph

            One process. Run it in a project directory and it makes a branch, creates one
            instance — a machine on an Incus host, or a container on this machine's Docker —
            clones the repository into it, and starts what you declared. Every port that
            instance listens on is opened at `http://localhost:<port>/` in the session's own
            browser, whose `localhost` is the instance — so nothing is published or
            translated, and two sessions can both bind 3000. It is not
            Docker Compose and it is not a CI file: it describes how a developer works on
            this repository, interactively.

            ## What to work out, and where to look

            1. **The toolchain, and where it is installed.** There is no image build here
               and no Dockerfile equivalent: a session is a copy of a golden Debian
               instance, and whatever this repository needs is installed by a `once` task
               inside it. So the question is not "which image" but "what has to be
               installed first".

               Read `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `*.csproj`,
               `Gemfile`, `.nvmrc`, `.tool-versions`. Match the version the repository
               pins, not the newest one, and install it the way its own documentation says
               to — `apt-get install`, a version manager, the vendor's install script.
               Leave `image` alone unless there is a specific reason to want something
               other than Debian.

            2. **Routes.** Which ports does a developer actually open in a browser? Look at
               dev-server config (`vite.config.*`, `next.config.*`, `webpack.config.*`,
               `launchSettings.json`, `application.yml`), `README` getting-started sections,
               `compose.yaml` port mappings, and `.env.example`. Name each one for what it
               is — `web`, `api`, `docs` — not for its port number. Ports nothing serves on
               are worse than no routes at all.

               A route is a name and a port, and nothing else: the port a server binds is
               the port it is opened on, at `http://localhost:<port>/` in the session's
               browser. There is no rewriting and nothing to declare about it.

               Two things follow, and both mean leaving the project as it is. A dev server
               that binds `127.0.0.1` or `localhost` — the default for most of them — is
               reachable, because the browser's `localhost` is the instance: do not add
               `--host 0.0.0.0`. And the `Host` header a server sees is `localhost:<port>`,
               which every dev server already allows: do not touch `allowedHosts`,
               `ALLOWED_HOSTS` or host authorization.

            3. **Tasks.** Everything that runs inside the container — there is no separate
               `setup` field, and if you are thinking of one you are thinking of a task.

               Two kinds. `"kind": "once"` is expected to finish and exit zero: `npm ci`,
               `bundle install`, `uv sync`, `dotnet restore`, a migration, a seed. The
               default kind keeps running: the dev servers behind the routes you declared.

               One ongoing task per route, named the same, is the usual shape — a `tasks`
               entry called `web` running `npm run dev`, beside a `routes` entry called
               `web` on 3000. Read `package.json` scripts, `Procfile`, `compose.yaml`
               commands, `Makefile` targets. A route with no task is a route the developer
               has to start by hand.

               `dependsOn` names tasks *and* services, so the migration depends on the
               database and the web server depends on the migration. Use it rather than
               hoping about order. `"ready": <port>` on an ongoing task is what makes
               something depending on it wait until it is answering rather than merely
               launched — set it on anything other tasks depend on.

               A server whose URL carries a secret it made up — .NET Aspire's dashboard
               prints `Login to the dashboard at https://localhost:17178/login?t=…` — needs
               `"url"` on its task: a regular expression whose first group is the URL, like
               `"Login to the dashboard at (https://\\S+)"`. envmux reads it from the
               task's output, puts it on `localhost` with its path kept, and shows that on
               the route with the same port as the task's `ready` (or the same name).
               Without it the route is a login page asking for the token.

               Do not background anything with `&` or `nohup`: each task runs latched in a
               multiplexer session of its own with its output captured to a file, and a
               task that backgrounds itself hides that output and exits immediately.

            4. **Services.** Does this repository need a database, a cache, a queue? Evidence
               only: a `DATABASE_URL` in `.env.example`, a `compose.yaml` with Postgres, an
               ORM config, a migrations directory. Declaring a service nothing connects to
               costs an instance and a pull for no reason. Each service is a machine of its
               own with a name that resolves, so two sessions in one directory both get a
               Postgres on 5432. envmux generates the credentials and injects them into both
               sides, so declare the service and let the app read `DATABASE_URL` /
               `ConnectionStrings__<name>`.

            5. **Tools.** If the developer will run a coding agent inside the session, add it
               to `tools` so it arrives signed in. Only add what is plausible; each one
               copies real credentials from the host into the instance, where they stay
               until the instance is removed.

               One case is decided for you: if the developer will delegate to remote agents
               (`{command} agent start`), `claude` has to be in `tools` — the agent runs
               `claude` inside the instance and arrives signed out without it. Do not add it
               speculatively for that reason either; ask whether they intend to.

            ## When to ask rather than guess

            Stop and ask the user if any of these is not clear from the repository:

            - **How the app is actually started in development** — if there is no obvious
              dev script, or several and no way to tell which is the usual one.
            - **Which ports matter** — if a monorepo serves four things and it is not clear
              which the developer wants in a browser.
            - **Whether a database is really needed** — if the connection string could just
              as easily point at something they already run.
            One round of short, specific questions beats a config that looks plausible and
            does not work. If everything IS clear, do not ask; just write it.

            ## Rules that matter

            - **Every field is optional and the file is optional.** Do not write a field
              just because it exists. A four-line config that is right beats a
              thirty-line one that is guessing.
            - **Unknown fields are rejected**, not ignored. If you are unsure a field
              exists, check the reference below.
            - **Pin what you install.** A task that installs "the latest" of something
              makes sessions differ from each other over time.
            - **This file is committed.** No secrets, no absolute paths from this machine,
              nothing that is true only of one developer's setup.
            - **Comments and trailing commas are allowed.** Use comments to say why a
              non-obvious choice was made.

            ## Check your work

            Use `{command}` — the command that printed this. Not `envmux`, unless that is
            also `{command}`: an unrelated or older envmux may be on the PATH, and it will
            not understand this file. If a command you run mentions `.envmux.toml`, TOML,
            namespaces, or workspaces, you have reached a different tool — go back to
            `{command}`.

            These need neither an IncusOS host nor a running session, so run them as you go:

            ```
            {command} config validate    parse it, resolve it, and report what is wrong
            {command} config show        the resolved result, with defaults applied
            {command} config schema      every field it accepts
            {command} --dry-run          the whole session it would start, without starting it
            ```

            `{command} config validate` exits 0 when the file is good and 2 when it is not,
            and prints the specific problem. It also warns about things that parse but are
            probably wrong — a task that backgrounds something, a route on a privileged
            port, services with no routes. Iterate until it is clean.

            When you are done, tell the user in two or three sentences what you declared and
            why, and name anything you guessed at.


            """);

        text.AppendLine("---");
        text.AppendLine();
        text.Append(ConfigReference.Render());
        text.AppendLine();
        text.AppendLine("---");
        text.AppendLine();
        text.AppendLine("## A worked example");
        text.AppendLine();
        text.Append("""
            ```jsonc
            {
              // A Next.js app with Postgres behind it. The image is left alone: a
              // session is a copy of the golden Debian instance, and Node is put
              // in by a task, pinned, where it can be read and changed.
              "name": "storefront",

              "routes": {
                // The port the server binds is the port it is opened on:
                // http://localhost:3000/ in the session's browser
                "web": 3000
              },

              "tasks": {
                // Expected to finish. Everything else waits for it.
                "node": {
                  "command": "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs",
                  "kind": "once"
                },

                "install": { "command": "npm ci", "kind": "once", "dependsOn": "node" },

                // Needs the database up as well as the install done.
                "migrate": {
                  "command": "npx prisma migrate deploy",
                  "kind": "once",
                  "dependsOn": ["install", "db"]
                },

                // One ongoing task per route, named the same. No --hostname: the
                // session's browser reaches the instance's own localhost.
                "web": {
                  "command": "npm run dev -- --port 3000",
                  "dependsOn": "migrate",
                  "ready": 3000
                }
              },

              "services": {
                // Its own machine, with its own name. The app reads
                // ConnectionStrings__db, which envmux injects on both sides.
                "db": { "type": "postgres", "user": "app", "database": "storefront" }
              },

              "tools": { "claude": "auto" }
            }
            ```

            """);

        return text.ToString();
    }

    /// <summary>
    /// What envmux can see without reading any code.
    /// </summary>
    /// <remarks>
    /// A starting point, explicitly not an answer — the agent is better at this
    /// than the file-existence check below, and telling it what has already been
    /// noticed saves it a round of looking.
    /// </remarks>
    private static readonly string[] MarkerFiles =
    [
        "package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json",
        "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "Gemfile",
        "compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml",
        "Dockerfile", ".devcontainer", ".env.example", "Makefile", "justfile",
    ];

    private static void Observed(StringBuilder text, string directory)
    {
        var markers = MarkerFiles.Where(m => File.Exists(Path.Combine(directory, m)) || Directory.Exists(Path.Combine(directory, m)))
         .ToList();

        var projects = Directory.Exists(directory)
            ? Directory.GetFiles(directory, "*.csproj", SearchOption.TopDirectoryOnly).Select(Path.GetFileName).ToList()
            : [];

        var tools = ToolMounts.Detect();

        text.AppendLine("## What envmux already noticed");
        text.AppendLine();
        text.AppendLine($"- Directory name (the default project name): `{Slug.FromDirectory(directory)}`");

        text.AppendLine(markers.Count > 0 || projects.Count > 0
            ? $"- Files in the root worth reading: {string.Join(", ", markers.Concat(projects!).Select(m => $"`{m}`"))}"
            : "- No familiar marker files in the root — look deeper, this may be a monorepo.");

        text.AppendLine(tools.Count > 0
            ? $"- Coding tools with state on this host: {string.Join(", ", tools)} — candidates for `tools`."
            : "- No coding-tool state found on this host; leave `tools` out.");

        text.AppendLine();
        text.AppendLine("That is a starting point from file names alone. You can do better by reading them.");
        text.AppendLine();
    }
}
