# Docker

**A session on this machine's Docker, reached the same way as one on Incus.**

```console
$ envmux feat-login
```

Docker is the default, even on a machine with an Incus host set up; that one
is `--backend incus` or `"backend": "incus"` in `.envmux.json`.

There is nothing to install. envmux finds the engine the way the `docker` CLI
does — `DOCKER_HOST`, then the current context, then Docker Desktop's pipe —
and talks to its API directly.

## What a session is here

- **A container** from the golden image, named for the instance
  (`myproj-feat-login`), with a volume for `/home` and one for the workdir, so
  stopping it loses nothing.
- **The golden image** is built on this engine the first time a session needs
  it: a couple of minutes, once, from a build context inside envmux itself
  (`envmux-golden:<hash>`). A project with `features` gets its own image on
  top, built once per toolchain.
- **One network, `envmux`,** for every session and service. A service is
  reached from the session by the name it has under the session's domain, as
  on Incus.
- **Nothing published.** No port is mapped to this machine, no loopback
  address is claimed, no name is resolved here. A session is looked at in its
  [browser](browser.md): `localhost` there is the container, carried over a
  Docker exec — 50 ms or so per new connection — so a dev server bound to the
  container's own `127.0.0.1` works as it is.

That last point is why Docker is back. Every earlier Docker version of envmux
had to publish ports, and fought over them, or give each session a block of
loopback addresses, or resolve names on this machine. The browser proxy needs
none of it.

## The editor

`e` attaches VS Code to the container directly, as a Dev Containers
"attached container" — it is a real container on your Docker, so there is no
endpoint of envmux's in between.

## Ending

The same as anywhere: commits come back onto `envmux/<session>`, and the
container is kept unless `git.keepOnExit` is false and nothing is uncommitted.
Removing it takes its two volumes with it.

## Not yet

- `envmux prune` does not sweep Docker yet; remove a kept session's container
  and its `<instance>-home` and `<instance>-work` volumes by hand.
- `envmux ssh`'s aliases reach Incus sessions only; attach the editor to a
  Docker session with `e`.
