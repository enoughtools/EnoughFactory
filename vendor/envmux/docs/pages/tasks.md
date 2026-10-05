# Tasks

**Services are external. Tasks are internal.**

A [service](services.md) is another machine beside this one — a
Postgres, a Redis — reached by name, with credentials envmux generated.

A task is a long-running command in the instance *you work in*. It has the
repository, the environment the session was given, and the same loopback
forwards to. A dev server, a bundler in watch mode, a queue worker.

```jsonc
{
  "tasks": {
    "web":    "npm run dev",
    "api":    "dotnet watch --project src/Api",
    "worker": { "command": "rake jobs:work", "restart": "on-failure" },
    "seed":   { "command": "rake db:seed", "autostart": false }
  }
}
```

envmux starts each one with `docker exec` and holds both of its streams for the
life of the session. That is the whole point: a task's output is a pane you can
watch, not something to go and find in another terminal.

## Two kinds

```jsonc
{ "command": "npm run dev" }                        // ongoing — the default
{ "command": "npm ci", "kind": "once" }             // once — expected to finish
```

**Ongoing** is a dev server, a watcher, a worker. It is expected *not* to
finish, and if it does, that is worth seeing.

**Once** is an install, a migration, a seed. It is expected to finish and to
exit zero, and anything depending on it waits until it has.

## Depending on things

```jsonc
{
  "services": { "db": { "type": "postgres", "user": "app", "database": "app" } },

  "tasks": {
    "install": { "command": "npm ci",          "kind": "once" },
    "migrate": { "command": "npm run migrate", "kind": "once",
                 "dependsOn": ["install", "db"] },
    "api":     { "command": "npm run api",     "dependsOn": "migrate", "ready": 3000 },
    "web":     { "command": "npm run dev",     "dependsOn": "api" }
  }
}
```

`dependsOn` names **tasks and services alike**. That is deliberate: the
dependency a person actually has is "the migration needs the database up and
the web server needs the migration done", and splitting that across two fields
would be describing envmux's internal categories rather than the thing being
said.

What "up" means, per kind of dependency:

| Depending on | Satisfied when |
|---|---|
| a **service** | it accepts a connection on its port |
| a **`once` task** | it has finished and exited zero |
| an **ongoing task** | it is running — or, with `ready`, when that port is accepting |

**`ready` is what makes an ongoing dependency mean anything.** Without it, "up"
can only mean "the command was launched", which for a dev server is several
seconds before it is any use. With `"ready": 3000`, anything downstream waits
until something is actually answering on 3000.

A service instance is already running by the time a task waits on it.
`dependsOn` is the stronger statement — an image that
declares no healthcheck reports nothing at all, and "running" is not "accepting
connections".

Each task does its own waiting and they are all launched at once, so the tree
resolves concurrently: two tasks that both depend on the database start together
as soon as it answers, not one after the other in the order the file listed them.

A dependency that fails **blocks** what depends on it rather than starting it
anyway — a migration against a database that never came up produces an error
about the migration, and the cause is two panes away.

Cycles, misspelled names, and a task that autostarts while waiting on one that
does not are all rejected by `envmux config validate`, before anything runs.
The alternative is a task that silently never starts.

## There is no `setup`

There was, and it is gone. It ran one command before the tasks, which sounds
like a shortcut and was three limitations: it could not depend on a service, its
output had nowhere to go, and it left people writing two things that were
obviously one.

```jsonc
// before
{ "setup": "npm ci" }

// now
{ "tasks": { "install": { "command": "npm ci", "kind": "once" } } }
```

Longer, and it earns the extra words: `install` gets its own pane, other tasks
name it in `dependsOn`, and `k` restarts it without restarting the instance.

Do not background anything with `&` or `nohup`. There is no need — envmux holds
each task open and shows its output — and a task that backgrounds itself hides
that output and exits immediately. `envmux config validate` warns about it.

## A toolchain is a task, until it is slow

Installing what a project needs is a task like anything else — visible, pinned,
and changed where you can see it:

```jsonc
{ "tasks": { "node": { "command": "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs", "kind": "once" } } }
```

That is right for a package or two and wrong for a .NET SDK and a browser, which
is minutes, every session. Those go in
[`features`](configuration.md#features-installs-a-toolchain-once) instead: they
install once into a project image every session is a copy of, so the first
session pays and the rest do not.

The line between them is how long it takes and how often it changes, not what
kind of thing it is. `npm ci` stays a task — it depends on the lockfile in the
repository, which is what a session is for.

## The long form

```jsonc
{
  "tasks": {
    "worker": {
      "command": "rake jobs:work",     // or ["rake", "jobs:work"]
      "kind": "ongoing",               // ongoing (default) | once
      "dependsOn": ["db", "migrate"],  // tasks and services
      "ready": 9292,                   // ongoing only: the port that means "up"
      "url": "Listening at (\\S+)",   // regex: where its URL is in its output
      "workdir": "/work/api",          // default: the session's workdir
      "env": { "QUEUE": "default" },   // on top of the session's own
      "autostart": true,               // default
      "restart": "on-failure"          // never (default) | on-failure | always
    }
  }
}
```

**A string is shell form** — `"npm run dev && echo up"` is handed to a login
shell, so pipelines, `&&` and whatever a project's profile puts on `PATH` all
work. **A list is exec form** — `["npm", "run", "dev"]` — where nothing is
interpreted and an argument may contain spaces.

`autostart: false` declares a task without running it. It appears in the list
and starts when you ask. For the ones you need occasionally and do not want
competing for a port every session.

`restart` defaults to `never`, so a task that dies stays dead and says so. That
is usually what you want while you are working on why it died. `on-failure` and
`always` wait a couple of seconds between attempts so a task that fails
instantly does not fill the pane faster than it can be read.

`url` is for the server whose URL is more than a port — see
[A URL with a secret in it](#a-url-with-a-secret-in-it).

## Watching them

```
 tasks ─────────────────────────────────────────────────────────
   install      done       added 412 packages
   migrate      running    ── waiting for db (db:5432) ──
   web          waiting    ── waiting for migrate ──
   worker       exit 1     rake aborted!
   seed         idle       rake db:seed
   e2e          blocked    ── worker did not come up; not starting ──
```

| Key | |
|---|---|
| `tab` | move between the routes and tasks panes |
| `v` | put the selected task's output in the bottom pane, or the log back |
| `k` | restart the selected task |
| `x` | stop it, or start one that is not running — still waiting on its `dependsOn` |

A `*` marks a task envmux declared rather than the config. Nothing does at
present. The relay used to: it ran in the container, it had output worth reading,
and it could be restarted, which is the whole definition of a task — so it was
one rather than something hidden inside the routing. There is no relay.

Running `--headless`, task output is interleaved into the console and labelled:

```
       web | ready in 412 ms
    ticker | tick 1
```

## The latch

**A task is not envmux's child.** It is started detached inside a `tmux` session
named after it, and left there. What envmux holds is a second exec following its
log file.

That is not decoration. An interactive exec is a pty owned by its websocket, so a
task started directly down one dies the moment the connection does - and envmux
deliberately does not use Incus' `record-output`, so its output would die with
it. The multiplexer stands between those two facts, which is why `tmux` is baked
into the golden instance rather than assumed.

What it buys:

- **Quitting costs the following and nothing else.** The build carries on, its
  output carries on being written, and starting the session again reattaches.
- **So does losing the connection**, or closing the laptop, or restarting envmux.
- **The whole output is on disk in the instance**, at
  `/var/log/envmux/<project>-<session>-<task>.log`, whether or not anybody was
  watching when it was written.

## Stopping one

`tmux kill-session -t <task>`. One call, and it reaches the workers a bundler
spawned, because a multiplexer session is a process group with a name.

This used to be considerably worse. Killing a `docker exec` client detached
envmux from the output and left the process running, so restarting a dev server
left the old one holding the port; there was no pid to signal, because the engine
does not report an exec's pid and a pidfile stops being true the moment the task
forks. Every task carried `ENVMUX_TASK=<name>` in its environment and stopping
one meant walking `/proc` looking for it - as the task's own user, because
reading another user's `environ` needs a capability Docker drops.

The marker is still there. It is now only the answer to "what started this?" from
a shell inside the instance.

## How readiness is asked

From inside the instance, through bash's `/dev/tcp`:

```
(exec 3<>/dev/tcp/127.0.0.1/5173)                  # this machine's own loopback
(exec 3<>/dev/tcp/myproj-sess-db.envmux/5432)      # a service, by name
```

Inside, because that is where the question means something: a task's port is on
the instance's loopback, which nothing outside reaches by design.

Through bash rather than `nc` or `curl` because the image is not required to
carry a networking tool - that would be the "add this to your image" this design
refuses - and bash is already required, since every latched task is started
through one.

A readiness probe gives up after 90 seconds and lets whatever was waiting start
anyway, with a warning. A mistyped `ready` port should cost a wait, not a session
that never finishes coming up.

## A URL with a secret in it

A route is a port on the instance's own address, and for most servers that is
the whole address. It is not for a server whose URL carries something it made up
on the way in. The canonical one is .NET Aspire's dashboard, which prints

```
Login to the dashboard at https://localhost:17178/login?t=8c4f1c8a2f4e4d2b9a0c...
```

on every start. The port alone gets you a login page asking for the token that
was on that line, and the line is in a pane you have to go and read.

So a task can say where in its output its URL is:

```jsonc
{
  "routes": { "dashboard": { "port": 17178, "tls": true } },
  "tasks": {
    "aspire": {
      "command": "dotnet run --project src/AppHost",
      "ready": 17178,
      "url": "Login to the dashboard at (https://\\S+)"
    }
  }
}
```

`url` is a regular expression, matched against each line as it arrives. The
first capture group is the URL — or the whole match, if there is no group. The
first line that matches wins: a server prints its address once, as it comes up,
and a later match in the same run is far more likely to be a request log quoting
the URL than a new one. A restart clears it, because a restarted server prints a
new token, and the route shows its bare port again until the new line arrives.

What the server printed is `localhost`, because that is what it bound, and
`localhost` is the wrong machine from where you are sitting. envmux swaps the
host for the session's own name and keeps everything else — scheme, port, path,
and the query byte for byte, because the query is where the token is:

```
https://myproj-feat-login.envmux:17178/login?t=8c4f1c8a2f4e4d2b9a0c...
```

That is what the routes pane shows, what `o` opens, and what the portal links
to. Only a host that means "this machine" is replaced — `localhost`,
`127.0.0.1`, `0.0.0.0`, `[::]`, and the `+` and `*` Kestrel echoes back. A
server that printed a real hostname was telling the truth about where it is,
and is left alone.

**Which route shows it** is not a third field. A task with `ready: 17178` and a
route on 17178 are the same server, so the URL that task prints is that route's
URL. Failing that, a task and a route with the same name are the same thing,
which is the one-task-per-route shape `autoconfigure` asks for anyway. A `url`
that pins neither is refused by `envmux config validate`, as is a pattern that
does not parse. The alternative is a pattern that matched, a token that was
captured, and a pane that went on showing the bare port.

The pattern is yours, and it runs against every line the build prints — which
means it runs against the stack traces too. It is given a quarter of a second
per line and a line that takes longer is treated as one that did not match.

## What runs as PID 1

The instance's own init. There is nothing to configure and nothing to override.

This used to be a whole section, because a Docker container runs one program and
envmux had to force a keepalive past the image's `ENTRYPOINT` - without it
`alpine/git` became `git sleep ...`, exited instantly, and the session came up
around a container that was already dead. A system container boots like a
machine, so the question does not arise.
