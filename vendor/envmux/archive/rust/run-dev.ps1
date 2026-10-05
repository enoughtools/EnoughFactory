# Build the current tree and run it.
#
# Two builds, deliberately: the in-container agent first (a static musl
# binary the daemon copies into workspaces - without it the credential shim
# silently does not exist), then the envmux binary itself. Then hand over to
# the fresh build with whatever arguments you gave - none means a session in
# the directory you invoked this from.
#
#   .\run-dev.ps1              # session here, current code
#   .\run-dev.ps1 manage       # management view
#   .\run-dev.ps1 daemon --state-dir C:\tmp\x --grace-secs 30   # foreground daemon
$ErrorActionPreference = "Stop"

$root = $PSScriptRoot

$muslInstalled = (& rustup target list --installed 2>$null) -contains "x86_64-unknown-linux-musl"
if ($muslInstalled) {
    $env:CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER = "rust-lld"
    cargo build --manifest-path "$root\Cargo.toml" -p envmux-agent --release --target x86_64-unknown-linux-musl
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
    Write-Warning "x86_64-unknown-linux-musl not installed; the credential shim will be absent."
    Write-Warning "fix: rustup target add x86_64-unknown-linux-musl"
}

cargo build --manifest-path "$root\Cargo.toml" -p envmux-cli
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Front-load the image build where you can watch it: same tag the daemon
# expects, docker CLI progress on this terminal, skipped when already built.
# Without this, a first session builds it invisibly behind "preparing
# namespace...". Skipped when the current directory has no config yet -
# onboarding inside the session handles that case.
if (Test-Path ".envmux.toml") {
    & "$root\target\debug\envmux.exe" image build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& "$root\target\debug\envmux.exe" @args
exit $LASTEXITCODE
