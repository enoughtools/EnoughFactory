# envmux @@VERSION@@ — @@RID@@

Development sessions on their own branches inside Docker containers, with a
terminal UI, browser portal and a browser whose `localhost` reaches the session.
This archive contains the Native AOT executable, MIT license and agent skills.
You do not need .NET, Node or PowerShell to use envmux.

## Before installing

- Install Git and ensure `git --version` works in your terminal.
- Windows/macOS: start Docker Desktop in Linux-container mode.
- Linux: start Docker Engine and ensure your account can access its socket.
- Use the archive matching your operating system and architecture. Linux and
  macOS support is experimental; macOS binaries are unsigned and unnotarized.

Download `SHA256SUMS.txt` alongside the archive from
[GitHub Releases](https://github.com/envmux/envmux/releases) and compare the
archive's SHA-256 with its entry before extracting it:

```powershell
# Windows PowerShell, before extracting
Get-FileHash .\@@ARCHIVE@@ -Algorithm SHA256
```

```sh
# Linux (use shasum -a 256 on macOS)
sha256sum @@ARCHIVE@@
tar -xzf @@ARCHIVE@@
```

## Install

Open a terminal in the extracted directory. On Windows:

```powershell
.\envmux.exe --version
.\envmux.exe install
```

On Linux or macOS:

```sh
./envmux --version
./envmux install
```

`install` checks Git and the Linux Docker engine, copies this native executable
to `~/.envmux/bin`, and adds that directory to your user PATH. It needs no
administrator privileges. Windows updates the user PATH; Unix adds a PATH block
to your bash/zsh startup file or fish configuration. **Open a new terminal**,
then check `envmux --version` reports `@@VERSION@@`.

Use `install --check` to check prerequisites without writing anything, or
`install --no-path` to copy the executable and manage PATH yourself. You can
also run the extracted executable by its full path without installing it.
If updating fails because another envmux process holds the executable open,
close those sessions and run the new download's `install` again.

On macOS, use the system's security approval flow for this unsigned download
if it is blocked; verify its checksum before approving it.

## Start your first session

In your project's Git repository with at least one commit:

```sh
envmux init --skills both
envmux config validate
envmux --dry-run
envmux first-session
```

Edit `.envmux.json` before starting the session: declare your project toolchain,
dependency-install command and development tasks. `init --skills both` installs
the setup, chef and delegate skills for Claude Code and Codex into the project.
Use `--skills claude` or `--skills codex` if you want only one set. Existing
customized skills and config are preserved.

The first session builds the embedded golden image and downloads its packages;
later sessions reuse it. Project tools run inside the container, so installing
Node on your workstation does not supply the session's toolchain.

- **b** opens the session browser; its `localhost` reaches the container.
- **p** opens the portal with tasks, logs and shells.
- **e** opens VS Code; install its Dev Containers extension first.
- **c** opens a shell.

Session commits return to the `envmux/first-session` branch in your repository.
For optional Incus/Hyper-V hosts, see
`envmux install --provider incus --help` or
`envmux install --provider hyperv --help`.

## Chef and support

Enable `"chef": true` in your project config and run `envmux chef` to start
the head agent's kitchen. Follow the bundled `envmux-chef` skill. Enable only
the tool accounts you intend to use; workers currently run Claude Code and
consume that account. Kept containers and volumes retain sign-in state and
uncommitted work. Docker containers share a kernel and network: use trusted
development projects.

For support, include the platform, `envmux --version` and redacted error text.
Do not share portal token URLs, sign-in state or environment dumps.

[Project and documentation](https://github.com/envmux/envmux) ·
[Issues](https://github.com/envmux/envmux/issues)

## macOS release candidate

Use the `osx-arm64` archive on an Apple Silicon Mac with Git and Docker Desktop's
Linux engine running. Run `./envmux install --check`, then `./envmux install`,
and open a new terminal. No .NET SDK is required for the native release.

Install Chrome, Firefox or Edge in `/Applications` or `~/Applications` for the
session browser. envmux launches its app-bundle executable with a separate
profile and authenticates proxy connections using macOS `lsof` and `ps`.
Safari is not supported. VS Code Dev Containers uses a private Unix socket;
explicit SSH attach remains available. The macOS binary is unsigned and
unnotarized: verify the release checksum before approving it through macOS.

For a first check, run `envmux init --skills both`, `envmux config validate`,
`envmux --dry-run`, then `envmux mac-smoke` in a Git project with a commit.
Check that the portal opens, the session browser reaches your development task,
and VS Code attaches. Report the command, envmux version and error text, without
credentials, tokens or private repository contents.
