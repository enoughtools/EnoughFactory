<#
.SYNOPSIS
    Install, update, or remove envmux on Windows.

.DESCRIPTION
    Builds envmux from this repository and installs it per-user, with no
    administrator rights and nothing written outside your profile.

    This is a source installer. cargo-dist produces the signed, downloadable
    installers for tagged releases, and those need a published release to pull
    from; until one exists, this is how you run envmux on Windows.

    Installs:
      %LOCALAPPDATA%\Programs\envmux\envmux.exe

    The one binary is the CLI, the daemon, and the TUI.

    It also builds the default development image under the tag
    `envmux config generate` writes into a new .envmux.toml, so a project in
    an adjacent directory starts without pulling anything. See
    scripts\build-default-image.ps1.

.PARAMETER Update
    Fetch the latest commit on the current branch, rebuild, and reinstall.

.PARAMETER Uninstall
    Remove the installed files and the PATH entry.

.PARAMETER InstallDir
    Override the install location.

.PARAMETER SkipImage
    Do not build the default image. The binary install is unaffected; projects
    referencing the default tag will then try to pull it.

.PARAMETER RebuildImage
    Rebuild the default image even when the tag is already present — what you
    want after images\default.Dockerfile or images\dev-common.sh changes.

.EXAMPLE
    .\scripts\install.ps1
    .\scripts\install.ps1 -Update
    .\scripts\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Update,
    [switch]$Uninstall,
    [switch]$SkipImage,
    [switch]$RebuildImage,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\envmux')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ManifestPath = Join-Path $InstallDir 'install.json'
# Set by Test-Prerequisites: whether the engine answered, which decides
# whether the default image can be built at all.
$script:DockerReady = $false
# Set by the update path when the pull moved images/, so the fixed default tag
# is rebuilt rather than left pointing at the previous definition.
$script:ImageStale = $false

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Note { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }

function Stop-RunningDaemon {
    # Windows will not let a running executable be overwritten, so a daemon
    # left from a previous install has to go first. Ask it to shut down
    # gracefully before resorting to killing it.
    $installed = Join-Path $InstallDir 'envmux.exe'
    if (Test-Path $installed) {
        try { & $installed down 2>$null | Out-Null } catch { }
        Start-Sleep -Milliseconds 500
    }

    # The daemon runs as `envmux daemon`, so it shares the CLI's process name.
    # Match on the command line rather than killing every envmux invocation.
    $daemons = Get-CimInstance Win32_Process -Filter "Name = 'envmux.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match '\bdaemon\b' }
    foreach ($d in $daemons) {
        Write-Note "stopping running daemon (pid $($d.ProcessId))"
        try { Stop-Process -Id $d.ProcessId -Force -ErrorAction Stop } catch { }
    }

    # Older installs shipped a separate daemon executable.
    $legacy = Get-Process envmux-daemon -ErrorAction SilentlyContinue
    if ($legacy) {
        Write-Note 'stopping daemon from a previous two-binary install'
        try { Stop-Process -Name envmux-daemon -Force -ErrorAction Stop } catch { }
    }
    if ($daemons -or $legacy) { Start-Sleep -Milliseconds 700 }
}

function Initialize-MsvcEnvironment {
    param([switch]$Force)

    # rustc finds an MSVC install by itself, but it takes the first one it
    # likes — which on a machine with several can be an installation carrying
    # only the onecore libs. Linking then fails with
    # "LNK1104: cannot open file 'msvcrt.lib'", which reads like a missing
    # toolchain rather than the wrong one of two.
    #
    # So: find an install that actually has the x64 CRT, and import its
    # environment. Nothing happens if the active toolchain is not MSVC.
    $target = (rustc -vV 2>$null | Select-String '^host:').ToString() -replace '^host:\s*', ''
    if ($target -notlike '*msvc*' -and -not $Force) {
        Write-Note "toolchain $target (not MSVC; skipping Visual Studio setup)"
        return
    }

    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) {
        Write-Warn 'vswhere not found; relying on rustc to locate MSVC'
        return
    }

    $candidates = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    foreach ($root in @($candidates)) {
        if (-not $root) { continue }
        # A complete toolset has the x64 CRT import library. A partial install
        # has only lib\onecore, which is what produces LNK1104.
        $crt = Get-ChildItem "$root\VC\Tools\MSVC\*\lib\x64\msvcrt.lib" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $crt) {
            Write-Note "skipping incomplete MSVC toolset: $root"
            continue
        }
        $vcvars = Join-Path $root 'VC\Auxiliary\Build\vcvars64.bat'
        if (-not (Test-Path $vcvars)) { continue }

        # Import the variables vcvars sets, so cargo links against this one.
        cmd /c "call `"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
            if ($_ -match '^(INCLUDE|LIB|LIBPATH|PATH|WindowsSdkDir|WindowsSDKVersion|VCToolsInstallDir)=(.*)$') {
                Set-Item -Path "env:$($matches[1])" -Value $matches[2]
            }
        }
        Write-Note "msvc     $root"
        return
    }
    Write-Warn 'no complete MSVC toolset found (need the "Desktop development with C++" workload).'
}

function Test-Prerequisites {
    Write-Step 'Checking prerequisites'

    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        throw "cargo not found. Install Rust from https://rustup.rs and reopen your terminal."
    }
    Write-Note "cargo    $((cargo --version) -replace '^cargo\s+','')"
    Initialize-MsvcEnvironment

    # envmux refuses to start below git 2.40.
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "git not found. Install Git for Windows 2.40 or newer."
    }
    $gitVersion = ((git --version) -split '\s+')[2]
    $gitParts = $gitVersion -split '\.'
    $gitMajorMinor = [version]"$($gitParts[0]).$($gitParts[1])"
    if ($gitMajorMinor -lt [version]'2.40') {
        throw "git $gitVersion is older than the 2.40 envmux requires."
    }
    Write-Note "git      $gitVersion"

    # Docker is a runtime requirement, not a build one: warn, do not block.
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        try {
            $server = docker version --format '{{.Server.Version}}' 2>$null
            if ($LASTEXITCODE -eq 0 -and $server) {
                $script:DockerReady = $true
                Write-Note "docker   $server (engine reachable)"
            }
        } catch { }
        if (-not $script:DockerReady) {
            Write-Warn 'Docker CLI found but the engine is not reachable. Start Docker Desktop before running envmux.'
        }
    } else {
        Write-Warn 'Docker not found. envmux needs Docker Desktop (Linux containers) at run time.'
    }
}

function Install-DefaultImage {
    # A generated .envmux.toml points at ghcr.io/strigops-io/envmux-default,
    # and the daemon pulls a reference only when nothing local carries that
    # tag. Building it here means the next project in a sibling directory runs
    # `envmux up` and gets a workspace instead of a registry error — and it
    # happens once, on a terminal that is already busy building, rather than
    # invisibly behind "preparing namespace..." in someone's first session.
    #
    # Never fatal: the binary is installed by this point, and an unbuilt image
    # costs a pull attempt later, not a broken install.
    if ($SkipImage) {
        Write-Note 'skipping the default image (-SkipImage)'
        return
    }
    if (-not $script:DockerReady) {
        Write-Warn 'skipping the default image: no reachable Docker engine.'
        Write-Note 'build it later with: .\scripts\build-default-image.ps1'
        return
    }

    Write-Step 'Preparing the default image'
    $builder = Join-Path $PSScriptRoot 'build-default-image.ps1'
    try {
        if ($RebuildImage -or $script:ImageStale) { & $builder -Force } else { & $builder }
        # `&` runs the builder in its own scope, so its `exit` lands here as an
        # exit code rather than ending this install.
        $code = if (Test-Path variable:LASTEXITCODE) { $LASTEXITCODE } else { 0 }
        if ($code -ne 0) { throw "build-default-image.ps1 exited $code" }
    } catch {
        Write-Warn "the default image was not built: $($_.Exception.Message)"
        Write-Note 'envmux is installed; retry with: .\scripts\build-default-image.ps1'
    }
}

function Invoke-Build {
    Write-Step 'Building release binaries'
    Push-Location $RepoRoot
    try {
        cargo build --release -p envmux-cli
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build failed. If linking failed with missing MSVC libraries, see the Windows notes in README.md."
        }
    } finally { Pop-Location }
}

function Install-Files {
    Write-Step "Installing to $InstallDir"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    foreach ($exe in 'envmux.exe') {
        $source = Join-Path $RepoRoot "target\release\$exe"
        if (-not (Test-Path $source)) { throw "missing build output: $source" }
        Copy-Item $source (Join-Path $InstallDir $exe) -Force
        Write-Note $exe
    }

    # Earlier installs shipped a separate daemon binary; it is now part of
    # envmux.exe, and leaving it behind would let a stale one be launched.
    $legacy = Join-Path $InstallDir 'envmux-daemon.exe'
    if (Test-Path $legacy) {
        Remove-Item $legacy -Force
        Write-Note 'removed envmux-daemon.exe (the daemon is now `envmux daemon`)'
    }

    $commit = ''
    try { Push-Location $RepoRoot; $commit = (git rev-parse HEAD).Trim() } catch { } finally { Pop-Location }
    [pscustomobject]@{
        version     = (& (Join-Path $InstallDir 'envmux.exe') --version) -replace '^envmux\s+', ''
        source      = $RepoRoot
        commit      = $commit
        installed   = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -Path $ManifestPath -Encoding utf8
}

function Add-ToPath {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @()
    if ($current) { $entries = $current -split ';' | Where-Object { $_ } }
    if ($entries -contains $InstallDir) {
        Write-Note 'PATH already contains the install directory'
        return $false
    }
    Write-Step 'Adding the install directory to your user PATH'
    [Environment]::SetEnvironmentVariable('Path', (($entries + $InstallDir) -join ';'), 'User')
    # Make it usable in this session too, without waiting for a new terminal.
    $env:Path = "$env:Path;$InstallDir"
    return $true
}

function Remove-FromPath {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $current) { return }
    $entries = $current -split ';' | Where-Object { $_ -and $_ -ne $InstallDir }
    [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
}

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
    Write-Step 'Uninstalling envmux'
    Stop-RunningDaemon
    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force
        Write-Note "removed $InstallDir"
    } else {
        Write-Note 'nothing installed at that location'
    }
    Remove-FromPath
    Write-Host ''
    Write-Host 'envmux removed. Your daemon state directory was left alone:' -ForegroundColor Green
    Write-Host "  $(Join-Path $env:LOCALAPPDATA 'envmux')" -ForegroundColor Green
    Write-Host 'Delete it yourself if you want the mirrors and shadow history gone.'
    Write-Host ''
    Write-Host 'The default image is a Docker image, not a file here. Remove it with:'
    Write-Host '  docker rmi ghcr.io/strigops-io/envmux-default:0.1.0'
    return
}

# ------------------------------------------------------------------- update
if ($Update) {
    Write-Step 'Updating from source'
    if (Test-Path $ManifestPath) {
        $manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
        if ($manifest.source -and (Test-Path $manifest.source)) { $RepoRoot = $manifest.source }
        Write-Note "installed $($manifest.version) from $($manifest.commit.Substring(0, [Math]::Min(12, $manifest.commit.Length)))"
    }
    Push-Location $RepoRoot
    try {
        $dirty = git status --porcelain
        if ($dirty) {
            Write-Warn 'the repository has uncommitted changes; pulling could conflict, so building what is here instead'
        } else {
            $before = (git rev-parse HEAD).Trim()
            git pull --ff-only
            if ($LASTEXITCODE -ne 0) {
                Write-Warn 'git pull failed; building the current checkout instead'
            } else {
                # The default image is tagged with a fixed reference, so a
                # changed Dockerfile produces no new tag to notice. Rebuild it
                # when the pull moved the files it is built from — otherwise
                # an update quietly leaves the old image in place forever.
                $after = (git rev-parse HEAD).Trim()
                if ($after -ne $before) {
                    $touched = git diff --name-only $before $after -- images/
                    if ($touched) {
                        Write-Note 'the image definition changed; the default image will be rebuilt'
                        $script:ImageStale = $true
                    }
                }
            }
        }
    } finally { Pop-Location }
}

# ------------------------------------------------------------------ install
Test-Prerequisites
Invoke-Build
Stop-RunningDaemon
Install-Files
$pathChanged = Add-ToPath
Install-DefaultImage

$manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
Write-Host ''
Write-Host "envmux $($manifest.version) installed to $InstallDir" -ForegroundColor Green
if ($pathChanged) {
    Write-Host 'Open a new terminal so PATH takes effect, then:' -ForegroundColor Green
} else {
    Write-Host 'Try it:' -ForegroundColor Green
}
Write-Host ''
Write-Host '  cd <your repo>'
Write-Host '  envmux config generate > .envmux.toml   # the default image is already built'
Write-Host '  envmux up                               # start the daemon, register the namespace'
Write-Host '  envmux create --wait                    # a workspace'
Write-Host '  envmux ls'
Write-Host ''
Write-Host 'Update later with:  .\scripts\install.ps1 -Update'
Write-Host 'Remove with:        .\scripts\install.ps1 -Uninstall'
Write-Host 'Rebuild the image:  .\scripts\build-default-image.ps1 -Force'
