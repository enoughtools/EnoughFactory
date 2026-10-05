# envmux 0.1.0-rc.1 — Mac testing release

Native AOT archives for Windows x64, Linux x64/ARM64 and macOS Apple Silicon.
The portal is embedded; no .NET SDK or Node installation is needed.

This RC adds Mac Chrome/Firefox/Edge discovery and SOCKS process authentication,
plus a private Unix socket for VS Code Dev Containers. Mac platform tests and
native archive checks run on GitHub's macOS runner. Real Docker proof-of-life
and scoped chef API checks passed on Windows; interactive Mac testing is the
purpose of this RC.

## Apple Silicon Mac quick start

1. Install Git and start Docker Desktop with its Linux engine running.
2. Download `envmux-0.1.0-rc.1-osx-arm64.tar.gz` and `SHA256SUMS.txt`.
3. Check `shasum -a 256 envmux-0.1.0-rc.1-osx-arm64.tar.gz` against its entry.
4. Extract with `tar -xzf envmux-0.1.0-rc.1-osx-arm64.tar.gz`.
5. From the extracted directory, run `./envmux install --check`, then
   `./envmux install`, and open a new terminal.
6. In a committed Git project, run `envmux init --skills both`, configure your
   tasks in `.envmux.json`, run `envmux config validate`, then `envmux mac-smoke`.

The Mac executable is unsigned and unnotarized. Verify the checksum before
approving it through macOS security settings. Use Chrome, Firefox or Edge in
`/Applications` or `~/Applications`; Safari is unsupported. Press `b` for the
session browser, `p` for the portal, `e` for VS Code and `c` for a shell.
Each archive's README includes installation and setup instructions.

Please report envmux/macOS/Docker versions and redacted command errors. Never
share credentials, portal token URLs, sign-in state or environment dumps.
