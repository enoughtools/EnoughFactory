# Services

A session can bring up machines it depends on — a database, a cache, a queue —
each with an address and a name of its own, with credentials envmux generates and
hands to both sides.

**A service is a machine; [a task](tasks.md) is a process.** A service is another
instance beside the one you work in. A task runs inside the one you work in — and
a task can `dependsOn` a service, which waits until that service is actually
accepting connections rather than merely running.

```jsonc
{
  "services": {
    "db":    { "type": "postgres", "user": "app", "database": "app" },
    "cache": { "type": "redis" }
  }
}
```

That is the whole declaration. envmux generates a password, starts Postgres with
it in an instance of its own, and puts the same password in the session's
environment.

Two sessions in one directory both get a Postgres on 5432, because they are two
machines. That is the whole of what the port arithmetic used to be for.

## What the session gets

Three shapes of the same fact, because three kinds of consumer read three
different things. The password is the same string in all of them, and the same
string the service instance was started with.

```console
ConnectionStrings__db=Host=myproj-feat-login-db.envmux;Port=5432;Database=app;Username=app;Password=cVD5iu...
services__db__tcp__0=myproj-feat-login-db.envmux:5432
DB_HOST=myproj-feat-login-db.envmux
DB_PORT=5432
DB_USER=app
DB_PASSWORD=cVD5iu...
DB_DATABASE=app
DB_URL=postgresql://app:cVD5iu...@myproj-feat-login-db.envmux:5432/app
```

That hostname resolves from your workstation too, which was never true when a
service was an alias on a private bridge nothing outside could see. The
connection string envmux writes into the session is the one you can paste into a
database client.

- **`ConnectionStrings__<name>`** is what .NET configuration binds on its own,
  and what [.NET Aspire](https://aspire.dev) injects. If your app already reads
  `builder.Configuration.GetConnectionString("db")`, it needs no changes.
- **`<NAME>_HOST`** and friends are for everything that is not .NET.
- **`services__<name>__tcp__0`** is Aspire's service discovery shape, for
  anything already speaking it.

The naming is Aspire's on purpose. It is a convention that already exists, a lot
of code already reads it, and inventing a fourth one would have been a decision
with nothing behind it.

## Kinds

| `type` | Image | Port | Credentials |
|---|---|---|---|
| `postgres` | `postgres:17-alpine` | 5432 | yes |
| `mysql` | `mysql:8` | 3306 | yes |
| `mariadb` | `mariadb:11` | 3306 | yes |
| `mongo` | `mongo:7` | 27017 | yes |
| `redis` | `redis:7-alpine` | 6379 | no |
| `container` | *required* | *required* | no |

Every field is overridable, and `container` is the escape hatch — any image, any
port, no assumptions:

```jsonc
{
  "services": {
    "queue": { "type": "container", "image": "nats:2", "port": 4222 }
  }
}
```

That escape hatch is what stops the table above from having to grow every time
somebody needs something not on it.

## The network

Everything is on the one bridge — `envmux0`, or the network the host adopted —
and dnsmasq on it answers for every instance by name. A service is `{project}-{session}-{service}.{domain}`.

**Nothing is published, because nothing has to be.** Reaching a service means
resolving its name and connecting to its port, which works from the session and
from another session on the host. Nothing on your workstation resolves the name;
from there, a client that speaks SOCKS5 — a database GUI, `psql` behind a
proxy wrapper, a script — reaches it through the session's proxy, whose URL and
credentials are in the log: names under the session's domain are dialled from
inside the instance whatever `browser.egress` says.

That is a deliberate loosening. Under Docker each session had a private network
and one session could not see another's database; now they can. Nothing a session runs is authenticated, so
it is the same trust boundary as every route — which is to say, the workstation
and whatever else can route to the range. If that is not the boundary you want,
the range is where to change it, not the service.

## Credentials, and why they do not persist

A generated password lives for one session and is never written down. There is no
state directory to persist it into, and a secret on disk would be the first
durable thing envmux owned.

The consequence: **a service's data does not outlive its password.** An ephemeral
Postgres is fine — it comes up empty, your migrations run, it goes away. If you
want a database you can come back to, say so explicitly:

```jsonc
{
  "services": {
    "db": {
      "type": "postgres",
      "persist": true,
      "password": "something-you-chose"
    }
  }
}
```

`persist` keeps the service's instance when the session ends, whatever
`git.keepOnExit` says. envmux **refuses `persist` without an explicit
`password`**, because the
alternative is a volume nobody can open again — and finding that out a week later
is worse than being told now.

Keep an explicit password out of a committed file. There is no secret store here:
put it in a `.envmux.json` you do not commit, and see
[Configuration](configuration.md#interpolation-secrets-and-the-things-that-are-not-here).

## Generated values

The same mechanism, without a service attached:

```jsonc
{
  "generate": {
    "SESSION_SECRET": "password",
    "API_TOKEN": { "kind": "token", "length": 48 },
    "RUN_ID": "uuid"
  }
}
```

| Kind | What you get |
|---|---|
| `password` | 32 characters, no quotes, backslashes, dollars, or backticks |
| `token` | 48 URL-safe characters |
| `hex` | 32 hex characters |
| `uuid` | a UUID |

The password alphabet is deliberately narrow. That value travels through a
connection string, a shell, a YAML file somebody pastes it into, and a URL, and
the characters that break each of those are not worth the entropy they add when
length is free.

## Precedence

Lowest to highest: **service references → generated values → `env`**.

Service references come first because they are derived rather than chosen;
literal `env` wins over everything, which is also the escape hatch when a
generated name collides with something real.

## The images are OCI ones

`postgres:17-alpine` means what it has always meant. Incus runs OCI images as
application containers directly, so a service is the image its documentation
tells you to run — there is no system-container equivalent to go and find.

Their address is pinned at creation, below the DHCP range, which is what makes
the connection string writable before the instance has booted.

## Startup, and waiting

Services start before the workspace is sent in, so the session's environment can
name things that already exist.

An instance being "running" is a long way from a Postgres in it accepting a
connection, so `dependsOn` does not ask the host — it connects, from inside the
session, through bash's `/dev/tcp`. A migration that runs against a Postgres
still initialising fails in a way that looks like a configuration problem rather
than a timing one, and that is the failure this exists to prevent. See
[Tasks](tasks.md).

## Teardown

Services are stopped after the session's own instance, and kept rather than
deleted for the same reason it is: `git.keepOnExit` covers them too, and a
**persisted** service is always kept. Starting the session again picks them all
up with their data in place.

`envmux prune` collects them, and does not ask a service instance whether its
tree is dirty — there is no repository in it, so there is nothing to lose.
