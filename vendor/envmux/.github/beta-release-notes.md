MIT-licensed beta archives: Windows x64 (`win-x64.zip`), Linux x64 and ARM64
(`linux-x64.tar.gz`, `linux-arm64.tar.gz`), and macOS Apple Silicon
(`osx-arm64.tar.gz`). Linux/macOS are experimental pending real Docker-session
rehearsals. macOS binaries are unsigned and unnotarized.

Requires Git and a local Linux-container Docker engine: Docker Desktop on
Windows/macOS, or Docker Engine with socket access on Linux. Download the
archive for your platform and SHA256SUMS.txt, verify its hash, then extract.
Use `tar -xzf <archive>` on Unix to preserve executable permissions. Run
`./envmux` on Unix or `envmux.exe` on Windows. Each executable is compiled with Native AOT, trimmed and optimized for size,
with the portal embedded; host .NET and Node are not needed. builds.json records
the source commit, native compilation, binary/archive sizes and build tools for all four archives.

Each archive includes README.md with installation and first-session instructions.
From the extracted directory, run `.\envmux.exe install` on Windows or
`./envmux install` on Unix, then open a new terminal. This checks Git/Docker,
installs to `~/.envmux/bin` and configures your user PATH.

In a committed git repository, run `envmux init --skills both`, edit and validate
`.envmux.json`, then `envmux first-session`. Press b for the session browser,
p for the portal, e for VS Code (Dev Containers extension), and c for a shell.

Chef dispatch is opt-in (`"chef": true`, then `envmux chef`). Workers currently
run Claude Code and consume the tool account you explicitly enable. Credentials
and uncommitted work persist in kept Docker volumes. Containers share a kernel
and network; use them for trusted development work.

Maintainer draft gate: attach successful local Docker and extracted-archive
verification evidence, finish the clean second-machine and real kitchen
rehearsals, and review the source/secret audit before making this release public.
CI unit tests alone do not establish these gates.

For Discord support, include versions and redacted errors. Never share portal
token URLs, sign-in state, transcripts, or environment dumps.

## macOS RC

Apple Silicon native AOT release with app-bundle browser discovery, macOS SOCKS process authentication and a private Unix socket for VS Code Dev Containers. Includes platform regression tests and archive setup instructions. Git and Docker Desktop with its Linux engine running are required. macOS binaries are unsigned and unnotarized.
